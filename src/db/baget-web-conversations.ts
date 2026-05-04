/**
 * Storage for the cross-channel conversation log.
 *
 * Schema lives in migration 018. The shape is two tables —
 * `baget_web_conversations` (1:1 with agent_groups) and
 * `baget_web_messages` (append-only history). See the migration file
 * for the rationale.
 *
 * Concurrency: better-sqlite3 is synchronous; transactions serialize
 * writes within the central DB. The hot paths here (`appendMessage`,
 * `getOrCreateConversation`) wrap their multi-statement work in a
 * single transaction so a partial-write window can never appear from
 * the perspective of `listMessages`.
 */
import { randomUUID } from 'crypto';

import { getDb } from './connection.js';

export interface BagetWebConversation {
  conversation_id: string;
  agent_group_id: string;
  created_at: string;
  last_message_at: string | null;
}

export type BagetWebMessageDirection = 'founder' | 'team';

export interface BagetWebMessage {
  id: string;
  conversation_id: string;
  direction: BagetWebMessageDirection;
  text: string | null;
  /** Parsed attachments — empty array when the message is text-only. */
  attachments: BagetWebMessageAttachment[];
  source_channel: string;
  source_message_id: string | null;
  timestamp: string;
  created_at: string;
}

/**
 * Mirror of `OutboundAttachment` in src/channels/adapter.ts, plus
 * `kind` widened so future inbound media (voice, video) round-trips
 * through the log even before the OutboundAttachment union catches up.
 * Stored as JSON because the dashboard renders the whole record as a
 * UI badge — no shape-aware queries.
 */
export interface BagetWebMessageAttachment {
  kind: string;
  path?: string;
  caption?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
}

interface ConversationRow {
  conversation_id: string;
  agent_group_id: string;
  created_at: string;
  last_message_at: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  direction: BagetWebMessageDirection;
  text: string | null;
  attachments_json: string | null;
  source_channel: string;
  source_message_id: string | null;
  timestamp: string;
  created_at: string;
}

/**
 * Fetch the conversation for an agent_group, creating one if missing.
 * Idempotent: a second call with the same agent_group_id returns the
 * pre-existing row. Race-safe via the UNIQUE(agent_group_id) constraint
 * — concurrent callers either both see an existing row, or one wins
 * the INSERT and the other re-SELECTs the winner.
 */
export function getOrCreateConversation(agentGroupId: string, nowIso: string): BagetWebConversation {
  const db = getDb();
  return db.transaction(() => {
    const existing = db
      .prepare('SELECT * FROM baget_web_conversations WHERE agent_group_id = ?')
      .get(agentGroupId) as ConversationRow | undefined;
    if (existing) return existing;

    const conversationId = `bwc-${randomUUID()}`;
    try {
      db.prepare(
        `INSERT INTO baget_web_conversations
           (conversation_id, agent_group_id, created_at, last_message_at)
         VALUES (?, ?, ?, NULL)`,
      ).run(conversationId, agentGroupId, nowIso);
      return {
        conversation_id: conversationId,
        agent_group_id: agentGroupId,
        created_at: nowIso,
        last_message_at: null,
      };
    } catch (err) {
      // UNIQUE collision — concurrent writer beat us. Re-read.
      const winner = db
        .prepare('SELECT * FROM baget_web_conversations WHERE agent_group_id = ?')
        .get(agentGroupId) as ConversationRow | undefined;
      if (winner) return winner;
      throw err;
    }
  })();
}

export interface AppendMessageInput {
  conversationId: string;
  direction: BagetWebMessageDirection;
  text?: string | null;
  attachments?: BagetWebMessageAttachment[];
  sourceChannel: string;
  sourceMessageId?: string | null;
  timestamp: string;
  /** Optional pre-generated id; defaults to a fresh `bwm-<uuid>`. */
  id?: string;
}

/**
 * Append a message to the conversation log AND update the
 * conversation's `last_message_at` to the message timestamp. Wrapped
 * in a single transaction so `listMessages` and the
 * `last_message_at` summary stay coherent.
 *
 * Returns the persisted row including the generated id and created_at.
 */
export function appendMessage(input: AppendMessageInput, nowIso: string): BagetWebMessage {
  const db = getDb();
  const id = input.id ?? `bwm-${randomUUID()}`;
  const text = input.text ?? null;
  const attachments = input.attachments ?? [];
  const attachmentsJson = attachments.length > 0 ? JSON.stringify(attachments) : null;
  const sourceMessageId = input.sourceMessageId ?? null;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO baget_web_messages
         (id, conversation_id, direction, text, attachments_json,
          source_channel, source_message_id, timestamp, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.conversationId,
      input.direction,
      text,
      attachmentsJson,
      input.sourceChannel,
      sourceMessageId,
      input.timestamp,
      nowIso,
    );
    // last_message_at MAX semantics so an out-of-order append (clock
    // skew between adapters) doesn't roll the summary backwards.
    db.prepare(
      `UPDATE baget_web_conversations
          SET last_message_at = CASE
            WHEN last_message_at IS NULL OR ? > last_message_at THEN ?
            ELSE last_message_at
          END
        WHERE conversation_id = ?`,
    ).run(input.timestamp, input.timestamp, input.conversationId);
  })();

  return {
    id,
    conversation_id: input.conversationId,
    direction: input.direction,
    text,
    attachments,
    source_channel: input.sourceChannel,
    source_message_id: sourceMessageId,
    timestamp: input.timestamp,
    created_at: nowIso,
  };
}

/**
 * Cursor for `listMessages` incremental polls. `timestamp` alone isn't
 * enough — multiple rows are routinely written with the same ISO
 * millisecond stamp under burst delivery, and a client that polls with
 * just the last timestamp would skip every same-stamp row. `(timestamp,
 * id)` is the same lex-ordered tuple the SELECT's ORDER BY uses, so
 * the filter and ordering stay consistent.
 */
export interface BagetWebMessageCursor {
  timestamp: string;
  id: string;
}

/**
 * List messages in a conversation ordered by `(timestamp, id)`
 * ascending. Three modes:
 *
 *   - No `since`: return the full conversation.
 *   - String `since`: legacy timestamp-only filter (`timestamp > since`).
 *     Backward-compatible with pre-cursor callers; subject to the
 *     same-millisecond-skip footgun if multiple messages share the
 *     boundary stamp.
 *   - Cursor `since` (`{ timestamp, id }`): tuple-strict filter using
 *     the same lex order as the SELECT's ORDER BY, so a same-stamp
 *     burst is paginated cleanly without skipping rows.
 *
 * Two prepared statements rather than one with NULL juggling — the
 * SQL stays readable and SQLite's prepared-statement cache keeps the
 * cost of two distinct shapes the same as one.
 */
export function listMessages(
  conversationId: string,
  since?: string | BagetWebMessageCursor,
): BagetWebMessage[] {
  const db = getDb();
  if (since === undefined) {
    const rows = db
      .prepare(
        `SELECT * FROM baget_web_messages
           WHERE conversation_id = ?
        ORDER BY timestamp ASC, id ASC`,
      )
      .all(conversationId) as MessageRow[];
    return rows.map(rowToMessage);
  }
  if (typeof since === 'string') {
    const rows = db
      .prepare(
        `SELECT * FROM baget_web_messages
           WHERE conversation_id = ? AND timestamp > ?
        ORDER BY timestamp ASC, id ASC`,
      )
      .all(conversationId, since) as MessageRow[];
    return rows.map(rowToMessage);
  }
  const rows = db
    .prepare(
      `SELECT * FROM baget_web_messages
         WHERE conversation_id = ?
           AND (timestamp > ? OR (timestamp = ? AND id > ?))
      ORDER BY timestamp ASC, id ASC`,
    )
    .all(conversationId, since.timestamp, since.timestamp, since.id) as MessageRow[];
  return rows.map(rowToMessage);
}

/**
 * Look up an existing message by its origin-channel coordinates.
 * Used by the cross-channel mirror to dedup retries — if the
 * dashboard POSTs the same `clientId` twice (network blip, reconnect)
 * the second mirror attempt finds the prior row and bails before
 * creating a duplicate. The (source_channel, source_message_id) pair
 * is intentionally a soft index — no UNIQUE constraint, since we
 * don't want a malformed payload to crash routing on the conflict;
 * the lookup is the sole dedup gate.
 */
export function findMessageBySource(
  sourceChannel: string,
  sourceMessageId: string,
): BagetWebMessage | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM baget_web_messages
         WHERE source_channel = ? AND source_message_id = ?
         LIMIT 1`,
    )
    .get(sourceChannel, sourceMessageId) as MessageRow | undefined;
  return row ? rowToMessage(row) : undefined;
}

/** Read the conversation row for an agent_group, or undefined if none. */
export function findConversationByAgentGroup(agentGroupId: string): BagetWebConversation | undefined {
  return getDb()
    .prepare('SELECT * FROM baget_web_conversations WHERE agent_group_id = ?')
    .get(agentGroupId) as BagetWebConversation | undefined;
}

function rowToMessage(row: MessageRow): BagetWebMessage {
  let attachments: BagetWebMessageAttachment[] = [];
  if (row.attachments_json) {
    try {
      const parsed = JSON.parse(row.attachments_json);
      if (Array.isArray(parsed)) attachments = parsed as BagetWebMessageAttachment[];
    } catch {
      // Treat malformed payloads as empty rather than failing the whole
      // history read — a single corrupt row shouldn't take down the
      // dashboard's load. The structured log surface is left to callers.
      attachments = [];
    }
  }
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    direction: row.direction,
    text: row.text,
    attachments,
    source_channel: row.source_channel,
    source_message_id: row.source_message_id,
    timestamp: row.timestamp,
    created_at: row.created_at,
  };
}
