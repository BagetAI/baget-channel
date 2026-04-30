/**
 * Workspace path resolution.
 *
 * In docker mode, the host bind-mounts the session dir at `/workspace` so
 * every path is fixed and absolute. In single-process mode (Baget on
 * Railway), there's no bind mount — the host spawns the runner with
 * `BAGET_WORKSPACE` pointing at the session dir on the host filesystem.
 *
 * Every callsite that previously hard-coded `/workspace/...` now goes
 * through these helpers so the same code runs in both runtimes. Default
 * (no env set) remains `/workspace` to preserve docker behavior.
 */

function workspaceRoot(): string {
  return process.env.BAGET_WORKSPACE || '/workspace';
}

/** `<workspace>/agent` — the agent group folder (CWD inside the runner). */
export function workspaceAgentDir(): string {
  return `${workspaceRoot()}/agent`;
}

/** `<workspace>/agent/container.json` — RO config from the host. */
export function workspaceContainerConfigPath(): string {
  return `${workspaceRoot()}/agent/container.json`;
}

/** `<workspace>/inbound.db` — host-owned, runner reads only. */
export function workspaceInboundDbPath(): string {
  return `${workspaceRoot()}/inbound.db`;
}

/** `<workspace>/outbound.db` — runner-owned. */
export function workspaceOutboundDbPath(): string {
  return `${workspaceRoot()}/outbound.db`;
}

/** `<workspace>/.heartbeat` — runner touches for liveness. */
export function workspaceHeartbeatPath(): string {
  return `${workspaceRoot()}/.heartbeat`;
}

/** `<workspace>/extra` — additional read-only mounts. */
export function workspaceExtraDir(): string {
  return `${workspaceRoot()}/extra`;
}

/** `<workspace>/outbox` — outbound file attachments. */
export function workspaceOutboxDir(): string {
  return `${workspaceRoot()}/outbox`;
}

/** `<workspace>/agent/conversations` — archived transcript markdown. */
export function workspaceConversationsDir(): string {
  return `${workspaceRoot()}/agent/conversations`;
}
