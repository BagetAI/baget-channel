/**
 * Per-(user, company) channel-token storage — see migration 015 for the
 * full architecture context.
 *
 * Single-process callsites:
 *   - `src/baget-admin-server.ts` writes (UPSERT) on POST /baget/agent-groups
 *     and POST /baget/agent-groups/bind-telegram. Re-pair from the
 *     dashboard rotates the token (the prior persisted_at is stamped into
 *     rotated_from_at so the audit timeline survives).
 *   - `src/container-runner.ts` reads on every spawnSingleProcessRunner
 *     and injects the value into the child Bun runner's env as
 *     BAGET_CHANNEL_TOKEN. The agent-runner's baget-mcp tools read it
 *     from process.env directly.
 *   - `src/baget-admin-server.ts` deletes on DELETE /baget/agent-groups
 *     so an archived group's token dies before the archive stamp lands.
 *
 * Logging discipline:
 *   `tokenValue` MUST NEVER be logged. Helper signatures intentionally
 *   omit it from any debug-friendly return shape. Callers serialize only
 *   `agentGroupId` and `persisted_at` for telemetry.
 */
import { getDb } from './connection.js';

export interface ChannelTokenRow {
  agent_group_id: string;
  token_value: string;
  persisted_at: string;
  rotated_from_at: string | null;
}

/**
 * UPSERT the channel token for an agent_group. On conflict (re-pair or
 * rotation), the prior `persisted_at` is preserved into `rotated_from_at`
 * so the audit timeline survives. Single statement — atomic by
 * better-sqlite3 default.
 *
 * Caller contract: `tokenValue` is the plaintext bearer baget.ai minted
 * via `rotateChannelToken`. Never log it. Validation of length/charset
 * is the caller's responsibility (validateCreateBody in
 * baget-admin-server.ts already enforces base64url + 30..256 chars).
 */
export function upsertChannelToken(args: { agentGroupId: string; tokenValue: string; now: string }): void {
  getDb()
    .prepare(
      `INSERT INTO baget_channel_tokens (agent_group_id, token_value, persisted_at, rotated_from_at)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(agent_group_id) DO UPDATE SET
         rotated_from_at = baget_channel_tokens.persisted_at,
         token_value     = excluded.token_value,
         persisted_at    = excluded.persisted_at`,
    )
    .run(args.agentGroupId, args.tokenValue, args.now);
}

/**
 * Spawn-time read. Returns the raw token verbatim so the host can inject
 * it into the child runner env. NEVER log the return value. Returns null
 * when no token exists for this agent_group — the agent-runner side
 * surfaces a clear "re-pair from dashboard" error to the founder.
 */
export function getChannelToken(agentGroupId: string): string | null {
  const row = getDb()
    .prepare('SELECT token_value FROM baget_channel_tokens WHERE agent_group_id = ?')
    .get(agentGroupId) as { token_value: string } | undefined;
  return row?.token_value ?? null;
}

/**
 * Hard-delete on agent_group archive (called from the admin DELETE
 * handler). Returns the change count — 0 is fine when the founder never
 * supplied a channel token (pre-bridge baget.ai builds).
 */
export function deleteChannelToken(agentGroupId: string): number {
  const r = getDb().prepare('DELETE FROM baget_channel_tokens WHERE agent_group_id = ?').run(agentGroupId);
  return r.changes;
}

/**
 * Sentinel-only metadata getter for telemetry. Returns the persisted_at
 * + rotated_from_at columns WITHOUT the token value — safe to log. Used
 * by the spawn path to emit a breadcrumb on first inject after rotation.
 */
export function getChannelTokenMeta(
  agentGroupId: string,
): { persisted_at: string; rotated_from_at: string | null } | null {
  const row = getDb()
    .prepare('SELECT persisted_at, rotated_from_at FROM baget_channel_tokens WHERE agent_group_id = ?')
    .get(agentGroupId) as { persisted_at: string; rotated_from_at: string | null } | undefined;
  return row ?? null;
}
