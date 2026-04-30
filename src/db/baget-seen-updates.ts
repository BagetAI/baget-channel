/**
 * Telegram update_id dedup. Telegram's webhook delivery is at-least-once:
 * if our handler returns 200 but the response packet is dropped, the same
 * update_id arrives again. INSERT OR IGNORE on the PK gives "first wins"
 * semantics — the second arrival's INSERT is a no-op, the caller sees
 * `changes === 0` and silently drops the message.
 *
 * Periodic sweep drops rows older than 24h. Telegram's own retry budget
 * is shorter than that, so 24h is comfortable defense-in-depth.
 */
import { getDb } from './connection.js';

/**
 * Returns true on first sighting (caller proceeds to process the update),
 * false on duplicate (caller drops silently). Only the host writes this
 * table — no contention.
 */
export function recordSeenUpdate(updateId: number, seenAt: string): boolean {
  const r = getDb()
    .prepare('INSERT OR IGNORE INTO baget_seen_updates (update_id, seen_at) VALUES (?, ?)')
    .run(updateId, seenAt);
  return r.changes === 1;
}

export function sweepOldSeenUpdates(olderThan: string): number {
  const r = getDb().prepare('DELETE FROM baget_seen_updates WHERE seen_at <= ?').run(olderThan);
  return r.changes;
}
