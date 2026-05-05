/**
 * Cursor for the channel-completion polling loop.
 *
 * The loop polls baget.ai's `GET /api/companies/[id]/channel-completions?since=<iso>`
 * endpoint and pushes "task done — here's the summary" messages back to
 * Telegram (PR-D4-2 of the post-action summary push-back work; baget.ai's
 * server side shipped in PR #454).
 *
 * Cursor lives in `session_state` (outbound.db, container-owned). Single
 * row keyed `channel_completion_cursor`, value = ISO timestamp of the
 * latest event we've already delivered. The server uses strict `>`
 * comparison, so advancing to the latest event's `createdAt` guarantees
 * no replay across container restarts.
 *
 * First-run behaviour: caller seeds with `Date.now()` so a freshly-paired
 * container does NOT flood the founder with backlog history. The loop
 * starts watching forward from the moment it boots.
 */
import { getOutboundDb } from './connection.js';

const CURSOR_KEY = 'channel_completion_cursor';

export function getChannelCompletionCursor(): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT value FROM session_state WHERE key = ?')
    .get(CURSOR_KEY) as { value: string } | undefined;
  return row?.value;
}

export function setChannelCompletionCursor(isoTimestamp: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(CURSOR_KEY, isoTimestamp, new Date().toISOString());
}
