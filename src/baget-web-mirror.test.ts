import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createMessagingGroup, createMessagingGroupAgent, getDb, initTestDb, runMigrations } from './db/index.js';
import { archiveBagetAgentGroup, createBagetAgentGroup } from './db/baget-agent-groups.js';
import { findConversationByAgentGroup, listMessages } from './db/baget-web-conversations.js';
// Imported for cross-flow assertions in the Telegram → web mirror test.
import { _resetSubscribersForTest, addSubscriber, broadcastToAgentGroup } from './baget-web-broadcast.js';
import { mirrorInbound, mirrorOutbound } from './baget-web-mirror.js';
import type { InboundMessage } from './channels/adapter.js';

const AG = 'ag-mirror-1';
const TG_PLATFORM = 'baget-telegram:9988';
const TG_CHANNEL = 'baget-telegram';

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function bindTelegram(): void {
  createBagetAgentGroup({
    id: AG,
    name: 'Baget Team',
    folder: 'team-mirror',
    user_id: 'u-mirror',
    company_id: 'c-mirror',
    baget_team_members: JSON.stringify({ cos: 'Louis' }),
    created_at: nowIso(),
  });
  createMessagingGroup({
    id: 'mg-mirror-1',
    channel_type: TG_CHANNEL,
    platform_id: TG_PLATFORM,
    name: 'tg chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: nowIso(),
  });
  createMessagingGroupAgent({
    id: 'mga-mirror-1',
    messaging_group_id: 'mg-mirror-1',
    agent_group_id: AG,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: nowIso(),
  });
}

describe('baget-web mirror', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
    _resetSubscribersForTest();
  });
  afterEach(() => {
    closeDb();
    _resetSubscribersForTest();
  });

  describe('mirrorInbound', () => {
    it('persists a founder message from baget-telegram into the cross-channel log', () => {
      bindTelegram();
      const inbound: InboundMessage = {
        id: 'tg-77',
        kind: 'chat',
        timestamp: nowIso(1000),
        content: { text: 'hey Louis', sender: 'Sam', senderId: 'telegram:42' },
        isMention: true,
        isGroup: false,
      };
      mirrorInbound(TG_CHANNEL, TG_PLATFORM, inbound, nowIso());
      const conv = findConversationByAgentGroup(AG)!;
      expect(conv).toBeDefined();
      const messages = listMessages(conv.conversation_id);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.direction).toBe('founder');
      expect(messages[0]!.text).toBe('hey Louis');
      expect(messages[0]!.source_channel).toBe(TG_CHANNEL);
      expect(messages[0]!.source_message_id).toBe('tg-77');
    });

    it('skips when the chat is unpaired (no messaging_group)', () => {
      // Note: no createMessagingGroup. Resolves to null → no write.
      const inbound: InboundMessage = {
        id: 'tg-1',
        kind: 'chat',
        timestamp: nowIso(),
        content: { text: 'orphan' },
      };
      mirrorInbound(TG_CHANNEL, 'baget-telegram:0', inbound, nowIso());
      // Nothing to find — agent_group itself doesn't exist either.
      expect(findConversationByAgentGroup(AG)).toBeUndefined();
    });

    it('dedups by (channel, message.id) so a retry does not double-write', () => {
      bindTelegram();
      const inbound: InboundMessage = {
        id: 'tg-retry-1',
        kind: 'chat',
        timestamp: nowIso(),
        content: { text: 'send once' },
      };
      mirrorInbound(TG_CHANNEL, TG_PLATFORM, inbound, nowIso());
      mirrorInbound(TG_CHANNEL, TG_PLATFORM, inbound, nowIso(1000));
      const conv = findConversationByAgentGroup(AG)!;
      expect(listMessages(conv.conversation_id)).toHaveLength(1);
    });

    it('skips empty text + empty attachments', () => {
      bindTelegram();
      const inbound: InboundMessage = {
        id: 'tg-empty',
        kind: 'chat',
        timestamp: nowIso(),
        content: { text: '' },
      };
      mirrorInbound(TG_CHANNEL, TG_PLATFORM, inbound, nowIso());
      // The agent_group is bound but no message has been appended,
      // and getOrCreateConversation never fires for an empty payload.
      expect(findConversationByAgentGroup(AG)).toBeUndefined();
    });

    it('mirrors inbound attachments alongside text', () => {
      bindTelegram();
      const inbound: InboundMessage = {
        id: 'tg-photo',
        kind: 'chat',
        timestamp: nowIso(),
        content: { text: 'check this out' },
        attachments: [
          {
            kind: 'photo',
            path: '/tmp/x.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 1024,
            platformFileId: 'tg-file-1',
            originalName: 'x.jpg',
          },
        ],
      };
      mirrorInbound(TG_CHANNEL, TG_PLATFORM, inbound, nowIso());
      const conv = findConversationByAgentGroup(AG)!;
      const m = listMessages(conv.conversation_id)[0]!;
      expect(m.attachments).toEqual([
        { kind: 'photo', path: '/tmp/x.jpg', filename: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: 1024 },
      ]);
    });

    it('special-cases baget-web platformId resolution (no messaging_group needed)', () => {
      // Create the agent_group but NO messaging_group — baget-web
      // should still resolve via the platformId prefix.
      createBagetAgentGroup({
        id: AG,
        name: 'Baget Team',
        folder: 'team-web-only',
        user_id: 'u-web',
        company_id: 'c-web',
        baget_team_members: JSON.stringify({ cos: 'Louis' }),
        created_at: nowIso(),
      });
      const inbound: InboundMessage = {
        id: 'bwm-web-1',
        kind: 'chat',
        timestamp: nowIso(),
        content: { text: 'from dashboard' },
      };
      mirrorInbound('baget-web', `baget-web:${AG}`, inbound, nowIso());
      const conv = findConversationByAgentGroup(AG)!;
      expect(conv).toBeDefined();
      const messages = listMessages(conv.conversation_id);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.source_channel).toBe('baget-web');
      expect(messages[0]!.text).toBe('from dashboard');
    });

    it('skips a chat with multiple wired agents (single-bind enforced)', () => {
      bindTelegram();
      // Wire a second agent_group to the same chat — multi-bind config.
      createBagetAgentGroup({
        id: 'ag-other',
        name: 'Other Team',
        folder: 'team-other',
        user_id: 'u-other',
        company_id: 'c-other',
        baget_team_members: JSON.stringify({ cos: 'Marie' }),
        created_at: nowIso(),
      });
      createMessagingGroupAgent({
        id: 'mga-mirror-2',
        messaging_group_id: 'mg-mirror-1',
        agent_group_id: 'ag-other',
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'all',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: nowIso(),
      });
      const inbound: InboundMessage = {
        id: 'tg-multi',
        kind: 'chat',
        timestamp: nowIso(),
        content: { text: 'hi' },
      };
      mirrorInbound(TG_CHANNEL, TG_PLATFORM, inbound, nowIso());
      // Neither agent's conversation should have been created.
      expect(findConversationByAgentGroup(AG)).toBeUndefined();
      expect(findConversationByAgentGroup('ag-other')).toBeUndefined();
    });
  });

  describe('mirrorOutbound', () => {
    it('persists a team reply when delivered through baget-telegram', () => {
      bindTelegram();
      mirrorOutbound(
        {
          channelType: TG_CHANNEL,
          platformId: TG_PLATFORM,
          kind: 'chat',
          content: JSON.stringify({ text: 'on it' }),
          platformMessageId: 'tg-msg-99',
        },
        nowIso(),
      );
      const conv = findConversationByAgentGroup(AG)!;
      const messages = listMessages(conv.conversation_id);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.direction).toBe('team');
      expect(messages[0]!.text).toBe('on it');
      expect(messages[0]!.source_channel).toBe(TG_CHANNEL);
      expect(messages[0]!.source_message_id).toBe('tg-msg-99');
    });

    it('skips system kind and agent-to-agent channel_type', () => {
      bindTelegram();
      mirrorOutbound(
        {
          channelType: TG_CHANNEL,
          platformId: TG_PLATFORM,
          kind: 'system',
          content: JSON.stringify({ action: 'schedule_task' }),
        },
        nowIso(),
      );
      // agent-to-agent uses channel_type='agent', not kind='agent'.
      mirrorOutbound(
        {
          channelType: 'agent',
          platformId: 'agent:other',
          kind: 'chat',
          content: JSON.stringify({ text: 'a2a' }),
        },
        nowIso(),
      );
      expect(findConversationByAgentGroup(AG)).toBeUndefined();
    });

    it('skips ask_question rendering', () => {
      bindTelegram();
      mirrorOutbound(
        {
          channelType: TG_CHANNEL,
          platformId: TG_PLATFORM,
          kind: 'chat',
          content: JSON.stringify({ type: 'ask_question', questionId: 'q-1', title: 'Q', options: [] }),
        },
        nowIso(),
      );
      expect(findConversationByAgentGroup(AG)).toBeUndefined();
    });

    it('captures markdown when text is absent', () => {
      bindTelegram();
      mirrorOutbound(
        {
          channelType: TG_CHANNEL,
          platformId: TG_PLATFORM,
          kind: 'chat',
          content: JSON.stringify({ markdown: '**bold**' }),
        },
        nowIso(),
      );
      const conv = findConversationByAgentGroup(AG)!;
      expect(listMessages(conv.conversation_id)[0]!.text).toBe('**bold**');
    });

    it('captures attachments described in OutboundMessage.attachments[]', () => {
      bindTelegram();
      mirrorOutbound(
        {
          channelType: TG_CHANNEL,
          platformId: TG_PLATFORM,
          kind: 'chat',
          content: JSON.stringify({
            text: 'attached',
            attachments: [{ kind: 'document', path: '/tmp/x.pdf', filename: 'x.pdf', caption: 'spec' }],
          }),
        },
        nowIso(),
      );
      const conv = findConversationByAgentGroup(AG)!;
      const m = listMessages(conv.conversation_id)[0]!;
      expect(m.attachments).toEqual([{ kind: 'document', path: '/tmp/x.pdf', filename: 'x.pdf', caption: 'spec' }]);
    });

    it('skips when the agent_group is archived (no phantom team-replied row)', () => {
      bindTelegram();
      archiveBagetAgentGroup(AG, nowIso());
      mirrorOutbound(
        {
          channelType: TG_CHANNEL,
          platformId: TG_PLATFORM,
          kind: 'chat',
          content: JSON.stringify({ text: 'should not mirror' }),
        },
        nowIso(),
      );
      expect(findConversationByAgentGroup(AG)).toBeUndefined();
    });

    it('skips baget-web platformId for an archived / unknown agent_group (no FK noise)', () => {
      // Don't create the agent_group at all — the platform_id encodes
      // an arbitrary string. resolveAgentGroupId must reject before
      // any FK INSERT is attempted.
      mirrorOutbound(
        {
          channelType: 'baget-web',
          platformId: 'baget-web:ag-nonexistent',
          kind: 'chat',
          content: JSON.stringify({ text: 'phantom' }),
        },
        nowIso(),
      );
      expect(findConversationByAgentGroup('ag-nonexistent')).toBeUndefined();
    });

    it('mirror is silent for an unknown channel + ignores skip kinds', () => {
      // No bindTelegram() — no messaging_group anywhere.
      mirrorOutbound(
        {
          channelType: TG_CHANNEL,
          platformId: TG_PLATFORM,
          kind: 'chat',
          content: JSON.stringify({ text: 'orphan' }),
        },
        nowIso(),
      );
      // Nothing should be written; nothing should throw.
      expect(findConversationByAgentGroup(AG)).toBeUndefined();
    });
  });

  describe('broadcast registry', () => {
    it('addSubscriber rejects beyond the per-agent_group cap', () => {
      const accepted: number[] = [];
      // The cap (32) is module-internal; iterate generously to confirm
      // the cap kicks in regardless of its exact value.
      for (let i = 0; i < 64; i++) {
        const ws = { readyState: 1, send: () => {} };
        const ok = addSubscriber(AG, ws as unknown as import('ws').WebSocket);
        if (ok) accepted.push(i);
      }
      expect(accepted.length).toBeLessThan(64);
      expect(accepted.length).toBeGreaterThan(0);
    });

    it('broadcastToAgentGroup writes to OPEN sockets only', () => {
      const sent: string[] = [];
      const wsOpen = {
        readyState: 1, // OPEN
        send: (s: string) => sent.push(`open:${s}`),
      };
      const wsClosing = {
        readyState: 2, // CLOSING
        send: () => {
          throw new Error('should not be called');
        },
      };
      addSubscriber(AG, wsOpen as unknown as import('ws').WebSocket);
      addSubscriber(AG, wsClosing as unknown as import('ws').WebSocket);

      const delivered = broadcastToAgentGroup(AG, {
        type: 'message',
        id: 'bwm-1',
        direction: 'team',
        text: 'hi',
        attachments: [],
        sourceChannel: 'baget-telegram',
        sourceMessageId: null,
        timestamp: nowIso(),
      });
      expect(delivered).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('"text":"hi"');
    });

    it('Telegram outbound mirrors to a baget-web WS subscriber on the same agent_group', () => {
      // The canonical cross-channel flow: agent replies via Telegram,
      // dashboard reading the same agent_group sees it without
      // baget-web being on the delivery path.
      bindTelegram();
      const sent: string[] = [];
      const ws = { readyState: 1, send: (s: string) => sent.push(s) };
      addSubscriber(AG, ws as unknown as import('ws').WebSocket);

      mirrorOutbound(
        {
          channelType: TG_CHANNEL,
          platformId: TG_PLATFORM,
          kind: 'chat',
          content: JSON.stringify({ text: 'replying via tg' }),
          platformMessageId: 'tg-msg-42',
        },
        nowIso(),
      );
      // Persisted to log
      const conv = findConversationByAgentGroup(AG)!;
      expect(listMessages(conv.conversation_id)).toHaveLength(1);
      // Broadcast to web subscriber
      expect(sent).toHaveLength(1);
      const event = JSON.parse(sent[0]!);
      expect(event).toMatchObject({
        type: 'message',
        direction: 'team',
        text: 'replying via tg',
        sourceChannel: TG_CHANNEL,
        sourceMessageId: 'tg-msg-42',
      });
    });

    it('mirror does NOT crash the upstream pipeline when broadcast send throws', () => {
      bindTelegram();
      const ws = {
        readyState: 1,
        send: () => {
          throw new Error('socket exploded');
        },
      };
      addSubscriber(AG, ws as unknown as import('ws').WebSocket);
      // Append must still succeed and the function must not throw —
      // the per-socket catch in broadcastToAgentGroup absorbs the
      // throw and the close handler will clean up later.
      expect(() =>
        mirrorOutbound(
          {
            channelType: TG_CHANNEL,
            platformId: TG_PLATFORM,
            kind: 'chat',
            content: JSON.stringify({ text: 'will not crash' }),
          },
          nowIso(),
        ),
      ).not.toThrow();
      const conv = findConversationByAgentGroup(AG)!;
      expect(listMessages(conv.conversation_id)).toHaveLength(1);
    });

    it('append + broadcast on inbound: subscribers receive a JSON message event', () => {
      bindTelegram();
      const sent: string[] = [];
      const ws = { readyState: 1, send: (s: string) => sent.push(s) };
      addSubscriber(AG, ws as unknown as import('ws').WebSocket);

      const inbound: InboundMessage = {
        id: 'tg-broadcast',
        kind: 'chat',
        timestamp: nowIso(),
        content: { text: 'broadcast me' },
      };
      mirrorInbound(TG_CHANNEL, TG_PLATFORM, inbound, nowIso());
      expect(sent).toHaveLength(1);
      const event = JSON.parse(sent[0]!);
      expect(event).toMatchObject({
        type: 'message',
        direction: 'founder',
        text: 'broadcast me',
        sourceChannel: TG_CHANNEL,
        sourceMessageId: 'tg-broadcast',
      });
    });
  });
});

describe('baget-web mirror — appendMessage covered above; this block guards the table-missing skip', () => {
  // Cover the "migration not run yet" skip: initialize the DB without
  // running migrations, and confirm the mirror is a silent no-op.
  beforeEach(() => {
    initTestDb();
    // INTENTIONAL: do not call runMigrations.
  });
  afterEach(() => closeDb());

  it('mirrorInbound is a no-op when baget_web_messages is missing', () => {
    expect(() =>
      mirrorInbound(
        'baget-web',
        'baget-web:nope',
        { id: 'x', kind: 'chat', timestamp: nowIso(), content: { text: 'hi' } },
        nowIso(),
      ),
    ).not.toThrow();
  });

  it('mirrorOutbound is a no-op when baget_web_messages is missing', () => {
    expect(() =>
      mirrorOutbound(
        {
          channelType: 'baget-telegram',
          platformId: 'baget-telegram:1',
          kind: 'chat',
          content: JSON.stringify({ text: 'hi' }),
        },
        nowIso(),
      ),
    ).not.toThrow();
  });
});
