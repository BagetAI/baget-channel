/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 *
 * Two modes, selected by the `RUNTIME` env var:
 *
 *   - 'docker' (default, upstream behavior) — host spawns one Docker container
 *     per session. Filesystem-isolated. Required when the agent has shell
 *     access (Bash tool).
 *
 *   - 'single-process' (Baget on Railway) — host spawns the agent runner as
 *     a child Node process in the same OS user/filesystem. No Docker needed,
 *     so it works on PaaS providers that block the Docker socket. Safe for
 *     Baget because the agent has NO shell — only the 19 baget-mcp tools
 *     plus web fetch/search, none of which can escalate beyond the founder's
 *     own bearer token. See BAGET-DEPLOY.md "Why we don't need DinD".
 */
import { execSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

export type RuntimeMode = 'docker' | 'single-process';

/**
 * Resolved at module load. Errors loudly on an unrecognized value rather
 * than silently defaulting — a typo like `RUNTIME=singleprocess` is much
 * easier to debug at startup than discovering at first inbound message
 * that the agent never spawned.
 */
export const RUNTIME_MODE: RuntimeMode = (() => {
  const raw = (process.env.RUNTIME || 'docker').toLowerCase();
  if (raw === 'docker' || raw === 'single-process') return raw;
  throw new Error(`Invalid RUNTIME env: "${raw}" — must be "docker" or "single-process"`);
})();

export function isSingleProcessMode(): boolean {
  return RUNTIME_MODE === 'single-process';
}

/** The container runtime binary name (only meaningful in docker mode). */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (isSingleProcessMode()) {
    // No-op — single-process mode tracks child processes by handle, not by
    // docker container name. The container-runner uses the handle to
    // SIGTERM/SIGKILL directly.
    return;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  if (isSingleProcessMode()) {
    log.info('Single-process runtime — skipping Docker readiness check');
    return;
  }
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('║                                                                ║');
    console.error('║  (Or set RUNTIME=single-process for the Docker-free mode.)     ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  if (isSingleProcessMode()) {
    // No persistent containers to clean up — child processes die with
    // the host process, and any leftover heartbeat / DB files are
    // harmless on next startup.
    return;
  }
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
