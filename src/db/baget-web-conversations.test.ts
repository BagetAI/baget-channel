import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from './index.js';
import { createBagetAgentGroup } from './baget-agent-groups.js';
import {
  appendMessage,
  findConversationByAgentGroup,
  findMessageBySource,
  getOrCreateConversation,
  listMessages,
} from './baget-web-conversations.js';

const AG = 'ag-baget-web-1';

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeAgentGroup(id = AG): void {
  createBagetAgentGroup({
    id,
    name: 'Baget Team',
    folder: `team-${id}`,
    user_id: `u-${id}`,
    company_id: `c-${id}`,
    baget_team_members: JSON.stringify({ cos: 'Louis' }),
    created_at: nowIso(),
  });
}

describe('migration 018 — baget-web-conversations', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });
  afterEach(() => closeDb());

  it('creates the conversations table with the expected columns', () => {
    const cols = getDb().prepare("PRAGMA table_info('baget_web_conversations')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(['agent_group_id', 'conversation_id', 'created_at', 'last_message_at']);
  });

  it('creates the messages table with the expected columns and direction CHECK', () => {
    const cols = getDb().prepare("PRAGMA table_info('baget_web_messages')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      'attachments_json',
      'conversation_id',
      'created_at',
      'direction',
      'id',
      'source_channel',
      'source_message_id',
      'text',
      'timestamp',
    ]);
    makeAgentGroup();
    const conv = getOrCreateConversation(AG, nowIso());
    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO baget_web_messages (id, conversation_id, direction, text, source_channel, timestamp, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('bwm-bad', conv.conversation_id, 'invalid_direction', 'x', 'baget-web', nowIso(), nowIso()),
    ).toThrow(/CHECK|constraint/i);
  });

  it('creates the (conversation_id, timestamp) index', () => {
    const idx = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'baget_web_messages'")
      .all() as Array<{ name: string }>;
    expect(idx.some((r) => r.name === 'idx_baget_web_messages_conv_ts')).toBe(true);
  });

  it('is idempotent on re-run (CREATE TABLE IF NOT EXISTS)', () => {
    // The migration runner skips applied versions via schema_version,
    // but the SQL itself must also be idempotent so a partially-applied
    // DB (crash mid-rollout) can recover.
    expect(() => runMigrations(getDb())).not.toThrow();
    // Schema is unchanged after the no-op re-run.
    const cols = getDb().prepare("PRAGMA table_info('baget_web_messages')").all() as Array<{ name: string }>;
    expect(cols.length).toBe(9);
  });

  it('cascades messages on agent_group hard delete (ON DELETE CASCADE)', () => {
    makeAgentGroup();
    const conv = getOrCreateConversation(AG, nowIso());
    appendMessage(
      {
        conversationId: conv.conversation_id,
        direction: 'founder',
        text: 'hi',
        sourceChannel: 'baget-telegram',
        timestamp: nowIso(),
      },
      nowIso(),
    );
    expect(listMessages(conv.conversation_id)).toHaveLength(1);

    getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run(AG);

    expect(findConversationByAgentGroup(AG)).toBeUndefined();
    expect(listMessages(conv.conversation_id)).toHaveLength(0);
  });
});

describe('baget-web conversations — DB helpers', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
    makeAgentGroup();
  });
  afterEach(() => closeDb());

  it('getOrCreateConversation is idempotent on the same agent_group', () => {
    const a = getOrCreateConversation(AG, nowIso());
    const b = getOrCreateConversation(AG, nowIso(1000));
    expect(a.conversation_id).toBe(b.conversation_id);
    expect(a.created_at).toBe(b.created_at);
  });

  it('appendMessage persists and updates last_message_at', () => {
    const conv = getOrCreateConversation(AG, nowIso());
    expect(conv.last_message_at).toBeNull();

    const t1 = nowIso(1000);
    appendMessage(
      {
        conversationId: conv.conversation_id,
        direction: 'founder',
        text: 'first',
        sourceChannel: 'baget-telegram',
        sourceMessageId: 'tg-1',
        timestamp: t1,
      },
      nowIso(1000),
    );
    const after1 = findConversationByAgentGroup(AG)!;
    expect(after1.last_message_at).toBe(t1);

    const t2 = nowIso(2000);
    appendMessage(
      {
        conversationId: conv.conversation_id,
        direction: 'team',
        text: 'reply',
        sourceChannel: 'baget-telegram',
        sourceMessageId: 'tg-msg-99',
        timestamp: t2,
      },
      nowIso(2000),
    );
    const after2 = findConversationByAgentGroup(AG)!;
    expect(after2.last_message_at).toBe(t2);
  });

  it('appendMessage out-of-order does NOT roll last_message_at backwards', () => {
    const conv = getOrCreateConversation(AG, nowIso());
    const t2 = nowIso(2000);
    const t1 = nowIso(1000);
    appendMessage(
      {
        conversationId: conv.conversation_id,
        direction: 'founder',
        text: 'newer',
        sourceChannel: 'baget-telegram',
        timestamp: t2,
      },
      nowIso(),
    );
    appendMessage(
      {
        conversationId: conv.conversation_id,
        direction: 'founder',
        text: 'older',
        sourceChannel: 'baget-telegram',
        timestamp: t1,
      },
      nowIso(),
    );
    const after = findConversationByAgentGroup(AG)!;
    expect(after.last_message_at).toBe(t2);
  });

  it('listMessages returns chronological order; sinceTimestamp is strict greater-than', () => {
    const conv = getOrCreateConversation(AG, nowIso());
    const t1 = nowIso(1000);
    const t2 = nowIso(2000);
    const t3 = nowIso(3000);
    appendMessage({ conversationId: conv.conversation_id, direction: 'founder', text: 'a', sourceChannel: 'x', timestamp: t1 }, nowIso());
    appendMessage({ conversationId: conv.conversation_id, direction: 'team', text: 'b', sourceChannel: 'x', timestamp: t2 }, nowIso());
    appendMessage({ conversationId: conv.conversation_id, direction: 'founder', text: 'c', sourceChannel: 'x', timestamp: t3 }, nowIso());

    const all = listMessages(conv.conversation_id);
    expect(all.map((m) => m.text)).toEqual(['a', 'b', 'c']);

    const after = listMessages(conv.conversation_id, t2);
    expect(after.map((m) => m.text)).toEqual(['c']);
  });

  it('appendMessage stores attachments JSON and listMessages parses them back', () => {
    const conv = getOrCreateConversation(AG, nowIso());
    appendMessage(
      {
        conversationId: conv.conversation_id,
        direction: 'team',
        text: 'see attached',
        attachments: [{ kind: 'document', filename: 'spec.pdf', sizeBytes: 1234 }],
        sourceChannel: 'baget-telegram',
        timestamp: nowIso(),
      },
      nowIso(),
    );
    const messages = listMessages(conv.conversation_id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.attachments).toEqual([{ kind: 'document', filename: 'spec.pdf', sizeBytes: 1234 }]);
  });

  it('listMessages with a cursor (timestamp + id) does NOT skip same-millisecond rows', () => {
    const conv = getOrCreateConversation(AG, nowIso());
    const sameTs = nowIso(1000);
    appendMessage({ conversationId: conv.conversation_id, direction: 'founder', text: 'a', sourceChannel: 'x', timestamp: sameTs, id: 'bwm-aaa' }, nowIso());
    appendMessage({ conversationId: conv.conversation_id, direction: 'founder', text: 'b', sourceChannel: 'x', timestamp: sameTs, id: 'bwm-bbb' }, nowIso());
    appendMessage({ conversationId: conv.conversation_id, direction: 'founder', text: 'c', sourceChannel: 'x', timestamp: sameTs, id: 'bwm-ccc' }, nowIso());

    // Plain string `since` is timestamp-only — it skips ALL three same-stamp rows (legacy semantic).
    expect(listMessages(conv.conversation_id, sameTs).map((m) => m.text)).toEqual([]);

    // Cursor form keeps the rest of the burst window — no skipping.
    const afterFirst = listMessages(conv.conversation_id, { timestamp: sameTs, id: 'bwm-aaa' });
    expect(afterFirst.map((m) => m.text)).toEqual(['b', 'c']);
  });

  it('findMessageBySource returns the row, or undefined when absent', () => {
    const conv = getOrCreateConversation(AG, nowIso());
    appendMessage(
      {
        conversationId: conv.conversation_id,
        direction: 'founder',
        text: 'tracked',
        sourceChannel: 'baget-web',
        sourceMessageId: 'bwm-client-XYZ',
        timestamp: nowIso(),
      },
      nowIso(),
    );
    const found = findMessageBySource('baget-web', 'bwm-client-XYZ');
    expect(found?.text).toBe('tracked');
    expect(findMessageBySource('baget-web', 'bwm-client-NOTFOUND')).toBeUndefined();
    expect(findMessageBySource('other-channel', 'bwm-client-XYZ')).toBeUndefined();
  });

  it('listMessages tolerates a malformed attachments_json row (returns empty)', () => {
    const conv = getOrCreateConversation(AG, nowIso());
    getDb()
      .prepare(
        `INSERT INTO baget_web_messages
           (id, conversation_id, direction, text, attachments_json, source_channel, timestamp, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('bwm-corrupt', conv.conversation_id, 'team', 'broken', '{not json', 'baget-telegram', nowIso(), nowIso());
    const messages = listMessages(conv.conversation_id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.attachments).toEqual([]);
  });
});
