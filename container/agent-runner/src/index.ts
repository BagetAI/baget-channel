/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import { runChannelCompletionLoop } from './channel-completion-loop.js';
import { runPollLoop } from './poll-loop.js';
import { buildProviderSystemInstructions } from './system-prompt.js';
import { workspaceAgentDir, workspaceExtraDir } from './workspace-paths.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

// Strip the bearer token from error messages/stacks before logging.
// process.env.BAGET_CHANNEL_TOKEN is injected per-spawn by the host
// (see src/container-runner.ts in the parent repo) and could surface
// in any stack frame that captured it (env-cloning libraries, fetch
// wrappers, etc). The generic `Bearer …` regex catches anything else.
function scrubBearer(text: string): string {
  const token = process.env.BAGET_CHANNEL_TOKEN;
  let out = text;
  if (token) out = out.split(token).join('***SCRUBBED***');
  // Char class covers RFC 6750 b64token (URL-safe + standard base64 + ~).
  return out.replace(/Bearer\s+[A-Za-z0-9_\-=.+/~]+/g, 'Bearer ***SCRUBBED***');
}

// Bun ≤ 1.2.22 has a child_process cleanup-path crash: when a spawned
// child errors, Bun emits an uncaught `TypeError: this.input.pause is
// not a function` (readline:654) that kills the runner mid-stream. The
// Claude SDK's MCP stdio transport hits this every spawn. Dockerfile
// bump to 1.2.23 is the primary fix; this handler is the safety net.
// Predicate is narrow on purpose — anything OTHER than this specific
// Bun TypeError is a real bug we want to fail fast on.
const isBunReadlineCleanupCrash = (err: unknown): boolean =>
  err instanceof TypeError && /this\.input\.pause is not a function/.test(err.message);

process.on('uncaughtException', (err) => {
  if (!isBunReadlineCleanupCrash(err)) {
    log(
      `uncaughtException (fatal): ${err instanceof Error ? scrubBearer(err.stack ?? `${err.name}: ${err.message}`) : String(err)}`,
    );
    process.exit(1);
  }
  log(`uncaughtException (Bun readline cleanup; kept alive): ${scrubBearer((err as Error).message)}`);
});
process.on('unhandledRejection', (reason) => {
  if (!isBunReadlineCleanupCrash(reason)) {
    log(
      `unhandledRejection (fatal): ${reason instanceof Error ? scrubBearer(reason.stack ?? `${reason.name}: ${reason.message}`) : String(reason)}`,
    );
    process.exit(1);
  }
  log(`unhandledRejection (Bun readline cleanup; kept alive): ${scrubBearer((reason as Error).message)}`);
});

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Runtime-generated system-prompt addendum: agent identity (name) plus
  // the live destinations map. Everything else (capabilities, per-module
  // instructions, per-channel formatting) is loaded by Claude Code from
  // /workspace/agent/CLAUDE.md — the composed entry imports the shared
  // base (/app/CLAUDE.md) and each enabled module's fragment. Per-group
  // memory lives in /workspace/agent/CLAUDE.local.md (auto-loaded).
  const instructions = buildProviderSystemInstructions(
    providerName,
    buildSystemPromptAddendum(config.assistantName || undefined),
  );

  // Discover additional directories mounted at <workspace>/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = workspaceExtraDir();
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // Build MCP servers config: nanoclaw built-in + any from container.json
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
  };

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    mcpServers[name] = serverConfig;
    log(`Additional MCP server: ${name} (${serverConfig.command})`);
  }

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
  });

  // Run the agent's message-processing loop alongside the
  // channel-completion polling loop. The completion loop is a thin
  // background poller that pings baget.ai and writes outbound
  // notification messages — its failure modes are isolated (per-iteration
  // try/catch inside the loop), so Promise.all here just gives us a
  // single await with both lifecycles tied to the same process.
  await Promise.all([
    runPollLoop({
      provider,
      providerName,
      cwd: workspaceAgentDir(),
      systemContext: { instructions },
    }),
    runChannelCompletionLoop(),
  ]);
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
