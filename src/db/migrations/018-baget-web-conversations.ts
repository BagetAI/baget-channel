/**
 * Baget cross-channel conversation log.
 *
 * Solves the conversation-amnesia gap: today, the founder's Telegram
 * thread and the dashboard chat panel are SEPARATE conversations
 * against the same agent_group. A founder typing "hey Louis" in the
 * dashboard cannot be seen in Telegram, and vice versa. This migration
 * adds a SHARED conversation log keyed on agent_group_id so both
 * surfaces (and any future surface — WhatsApp, Slack) read and write
 * to the same thread.
 *
 * Two tables:
 *
 *   1. `baget_web_conversations` — one row per agent_group (UNIQUE).
 *      The conversation is created lazily on the first cross-channel
 *      mirror append; agent_groups without any messaging activity stay
 *      absent. ON DELETE CASCADE on the agent_group FK so a hard delete
 *      cleans up the entire history; soft-delete (archived_at) leaves
 *      the conversation alone, since post-mortem queries still want
 *      message history.
 *
 *   2. `baget_web_messages` — append-only message log. `direction` is
 *      'founder' (inbound from any channel) or 'team' (outbound to any
 *      channel). `source_channel` records WHICH channel adapter
 *      received or delivered the message — the dashboard renders a
 *      per-message badge from this (📱 baget-telegram, 💻 baget-web,
 *      future channels). `source_message_id` is the platform-native id
 *      from the originating channel (Telegram update_id, etc.) — used
 *      for cross-surface dedup and for replying-to in future surface
 *      enhancements. `attachments_json` is a serialized array of
 *      OutboundAttachment-like records (kind, path, caption, …).
 *
 *      The `(conversation_id, timestamp)` index is the primary read
 *      pattern: dashboard loads "messages since T" or "last N", both
 *      of which scan within a single conversation by time.
 *
 * Why a separate log instead of folding into the existing per-session
 * inbound.db / outbound.db pair: those are scoped to a SINGLE session
 * (one container's IO surface), not to the founder's full conversation
 * history. A founder may run multiple sessions over time (rotating
 * agent_runners, reset, restart). The cross-channel log is keyed on
 * agent_group, which is the durable identity, and lives in the central
 * v2.db so every channel adapter on the host reads/writes the same
 * file without the per-session DB plumbing.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration018: Migration = {
  version: 18,
  name: 'baget-web-conversations',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS baget_web_conversations (
        conversation_id  TEXT PRIMARY KEY,
        agent_group_id   TEXT NOT NULL UNIQUE
                              REFERENCES agent_groups(id) ON DELETE CASCADE,
        created_at       TEXT NOT NULL,
        last_message_at  TEXT
      );

      CREATE TABLE IF NOT EXISTS baget_web_messages (
        id                 TEXT PRIMARY KEY,
        conversation_id    TEXT NOT NULL
                                REFERENCES baget_web_conversations(conversation_id)
                                ON DELETE CASCADE,
        direction          TEXT NOT NULL CHECK (direction IN ('founder', 'team')),
        text               TEXT,
        attachments_json   TEXT,
        source_channel     TEXT NOT NULL,
        source_message_id  TEXT,
        timestamp          TEXT NOT NULL,
        created_at         TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_baget_web_messages_conv_ts
        ON baget_web_messages(conversation_id, timestamp);
    `);
  },
};
