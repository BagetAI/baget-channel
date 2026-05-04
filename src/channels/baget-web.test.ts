import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createBagetAdminServer } from '../baget-admin-server.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';
import { createBagetAgentGroup, archiveBagetAgentGroup } from '../db/baget-agent-groups.js';
import { findConversationByAgentGroup } from '../db/baget-web-conversations.js';
import { _resetSubscribersForTest, subscriberCount } from '../baget-web-broadcast.js';
import { mirrorOutbound } from '../baget-web-mirror.js';
import { _testBuildBagetWebAdapter, BAGET_WEB_CHANNEL_TYPE } from './baget-web.js';
import type { ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';

const ADMIN_TOKEN = 'test-admin-token-1234567890abcdef';
const AG = 'ag-baget-web-1';

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeAgentGroup(id = AG, archived = false): void {
  createBagetAgentGroup({
    id,
    name: 'Baget Team',
    folder: `team-${id}`,
    user_id: `u-${id}`,
    company_id: `c-${id}`,
    baget_team_members: JSON.stringify({ cos: 'Louis' }),
    created_at: nowIso(),
  });
  if (archived) archiveBagetAgentGroup(id, nowIso());
}

async function fetchJson(
  baseUrl: string,
  path: string,
  init: RequestInit & { method?: string } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, init);
  let body: unknown = null;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function waitFor(condition: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe('baget-web adapter', () => {
  let port: number;
  let baseUrl: string;
  let inboundEvents: Array<{ platformId: string; threadId: string | null; message: InboundMessage }>;
  let adapter: ReturnType<typeof _testBuildBagetWebAdapter> | null = null;
  let server: ReturnType<typeof createBagetAdminServer> | null = null;

  beforeEach(async () => {
    initTestDb();
    runMigrations(getDb());
    _resetSubscribersForTest();
    inboundEvents = [];

    // Initial server is bound in `bootServerOnFreePort` once the
    // tests need it; deferring keeps the construction in a single
    // helper that knows the port.
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.teardown();
      adapter = null;
    }
    if (server) {
      await server.close();
      server = null;
    }
    closeDb();
    _resetSubscribersForTest();
  });

  // We can't read the random-bound port back easily — re-create the
  // server with a fixed port the OS reserves for us.
  async function bootServerOnFreePort(): Promise<void> {
    if (server) {
      await server.close();
      server = null;
    }
    const probe = await findFreePort();
    port = probe;
    baseUrl = `http://127.0.0.1:${port}`;
    server = createBagetAdminServer({
      adminToken: ADMIN_TOKEN,
      telegramBotUsername: 'baget_bot',
      port,
      generateAgentGroupId: () => `ag-test-${Math.random().toString(36).slice(2, 10)}`,
    });
    await server.listen();
  }

  async function bootAdapter(): Promise<void> {
    adapter = _testBuildBagetWebAdapter({ adminToken: ADMIN_TOKEN });
    const setup: ChannelSetup = {
      onInbound: (platformId, threadId, message) => {
        inboundEvents.push({ platformId, threadId, message });
      },
      onInboundEvent: () => undefined,
      onMetadata: () => undefined,
      onAction: () => undefined,
    };
    await adapter.setup(setup);
  }

  describe('HTTP routes', () => {
    beforeEach(async () => {
      await bootServerOnFreePort();
      await bootAdapter();
    });

    it('GET /api/channels/web/messages/:id returns 401 without bearer', async () => {
      makeAgentGroup();
      const res = await fetchJson(baseUrl, `/api/channels/web/messages/${AG}`);
      expect(res.status).toBe(401);
    });

    it('GET returns 404 for unknown agent_group', async () => {
      const res = await fetchJson(baseUrl, `/api/channels/web/messages/missing-ag`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('agent_group_not_found');
    });

    it('GET returns 404 for archived agent_group', async () => {
      makeAgentGroup(AG, true);
      const res = await fetchJson(baseUrl, `/api/channels/web/messages/${AG}`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(404);
    });

    it('GET returns empty list before any messages', async () => {
      makeAgentGroup();
      const res = await fetchJson(baseUrl, `/api/channels/web/messages/${AG}`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, conversationId: null, messages: [] });
    });

    it('POST → onInbound fires; subsequent GET returns the persisted message', async () => {
      makeAgentGroup();
      const post = await fetchJson(baseUrl, `/api/channels/web/messages/${AG}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello from dashboard', clientId: 'client-1' }),
      });
      expect(post.status).toBe(202);
      expect(post.body.ok).toBe(true);
      // onInbound is fired synchronously in the adapter — wait for it.
      await waitFor(() => inboundEvents.length === 1);
      expect(inboundEvents[0]!.platformId).toBe(`baget-web:${AG}`);
      expect(inboundEvents[0]!.threadId).toBeNull();
      expect((inboundEvents[0]!.message.content as { text: string }).text).toBe('hello from dashboard');
    });

    it('POST returns 400 on empty payload', async () => {
      makeAgentGroup();
      const post = await fetchJson(baseUrl, `/api/channels/web/messages/${AG}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(post.status).toBe(400);
      expect(post.body.error).toBe('empty_message');
    });

    it('POST returns 400 on invalid JSON body', async () => {
      makeAgentGroup();
      const res = await fetch(`${baseUrl}/api/channels/web/messages/${AG}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
        body: 'not json',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'invalid_json' });
    });
  });

  describe('history endpoint', () => {
    beforeEach(async () => {
      await bootServerOnFreePort();
      await bootAdapter();
    });

    it('GET reflects messages written by mirrorOutbound (cross-channel mirror smoke)', async () => {
      makeAgentGroup();
      // Direct-write a team message via the mirror without involving
      // a real channel adapter — exercises the cross-channel hook
      // surface that the dashboard reads back.
      mirrorOutbound(
        {
          channelType: 'baget-web',
          platformId: `baget-web:${AG}`,
          kind: 'chat',
          content: JSON.stringify({ text: 'team reply' }),
          platformMessageId: 'plat-1',
        },
        nowIso(),
      );
      const res = await fetchJson(baseUrl, `/api/channels/web/messages/${AG}`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(1);
      expect(res.body.messages[0].text).toBe('team reply');
      expect(res.body.messages[0].direction).toBe('team');
    });

    it('GET ?since=… returns only newer messages', async () => {
      makeAgentGroup();
      const t1 = nowIso(1000);
      const t2 = nowIso(2000);
      mirrorOutbound(
        {
          channelType: 'baget-web',
          platformId: `baget-web:${AG}`,
          kind: 'chat',
          content: JSON.stringify({ text: 'old' }),
        },
        t1,
      );
      mirrorOutbound(
        {
          channelType: 'baget-web',
          platformId: `baget-web:${AG}`,
          kind: 'chat',
          content: JSON.stringify({ text: 'new' }),
        },
        t2,
      );
      const res = await fetchJson(baseUrl, `/api/channels/web/messages/${AG}?since=${encodeURIComponent(t1)}`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.body.messages.map((m: { text: string }) => m.text)).toEqual(['new']);
    });
  });

  describe('WebSocket route', () => {
    beforeEach(async () => {
      await bootServerOnFreePort();
      await bootAdapter();
    });

    async function dialWs(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
      return new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(url, { headers, perMessageDeflate: false, handshakeTimeout: 1500 });
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
        ws.once('unexpected-response', (_req, res) => {
          reject(new Error(`unexpected-response status=${res.statusCode}`));
        });
      });
    }

    it('rejects an unauthenticated upgrade', async () => {
      makeAgentGroup();
      await expect(dialWs(`ws://127.0.0.1:${port}/api/channels/web/ws/${AG}`)).rejects.toThrow(/401|unexpected-response/);
    });

    it('rejects upgrade for an unknown agent_group', async () => {
      await expect(
        dialWs(`ws://127.0.0.1:${port}/api/channels/web/ws/missing-ag`, { Authorization: `Bearer ${ADMIN_TOKEN}` }),
      ).rejects.toThrow(/404|unexpected-response/);
    });

    it('accepts an authenticated upgrade and registers the subscriber', async () => {
      makeAgentGroup();
      const ws = await dialWs(`ws://127.0.0.1:${port}/api/channels/web/ws/${AG}`, {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      });
      try {
        await waitFor(() => subscriberCount(AG) === 1);
        expect(subscriberCount(AG)).toBe(1);
      } finally {
        ws.close();
      }
      await waitFor(() => subscriberCount(AG) === 0);
    });

    it('inbound message over WS calls onInbound with the parsed text', async () => {
      makeAgentGroup();
      const ws = await dialWs(`ws://127.0.0.1:${port}/api/channels/web/ws/${AG}`, {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      });
      try {
        ws.send(JSON.stringify({ type: 'message', text: 'hi from ws' }));
        await waitFor(() => inboundEvents.length === 1);
        expect((inboundEvents[0]!.message.content as { text: string }).text).toBe('hi from ws');
      } finally {
        ws.close();
      }
    });

    it('subscribed socket receives a broadcast event when a team reply is mirrored', async () => {
      makeAgentGroup();
      const ws = await dialWs(`ws://127.0.0.1:${port}/api/channels/web/ws/${AG}`, {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      });
      const received: string[] = [];
      ws.on('message', (data) => received.push(data.toString()));
      try {
        await waitFor(() => subscriberCount(AG) === 1);
        mirrorOutbound(
          {
            channelType: 'baget-telegram',
            platformId: 'baget-telegram:0', // no messaging_group → skip
            kind: 'chat',
            content: JSON.stringify({ text: 'should-not-broadcast' }),
          },
          nowIso(),
        );
        // The above SHOULD be skipped because there is no messaging_group.
        // Now test a direct baget-web mirror that DOES broadcast.
        mirrorOutbound(
          {
            channelType: 'baget-web',
            platformId: `baget-web:${AG}`,
            kind: 'chat',
            content: JSON.stringify({ text: 'team replied' }),
          },
          nowIso(),
        );
        await waitFor(() => received.length === 1);
        const event = JSON.parse(received[0]!);
        expect(event).toMatchObject({ type: 'message', direction: 'team', text: 'team replied' });
      } finally {
        ws.close();
      }
    });

    it('responds pong to a ping', async () => {
      makeAgentGroup();
      const ws = await dialWs(`ws://127.0.0.1:${port}/api/channels/web/ws/${AG}`, {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      });
      const replies: string[] = [];
      ws.on('message', (d) => replies.push(d.toString()));
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
        await waitFor(() => replies.length === 1);
        expect(JSON.parse(replies[0]!)).toEqual({ type: 'pong' });
      } finally {
        ws.close();
      }
    });

    it('disconnect removes the subscriber from the registry', async () => {
      makeAgentGroup();
      const ws = await dialWs(`ws://127.0.0.1:${port}/api/channels/web/ws/${AG}`, {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      });
      await waitFor(() => subscriberCount(AG) === 1);
      ws.close();
      await waitFor(() => subscriberCount(AG) === 0);
    });

    it('accepts bearer token via ?token=… query param fallback', async () => {
      makeAgentGroup();
      const ws = await dialWs(`ws://127.0.0.1:${port}/api/channels/web/ws/${AG}?token=${ADMIN_TOKEN}`);
      try {
        await waitFor(() => subscriberCount(AG) === 1);
      } finally {
        ws.close();
      }
    });

    it('valid header beats invalid query token; invalid header alone with valid query also passes', async () => {
      makeAgentGroup();
      // Header valid, query bad — header wins.
      const ws1 = await dialWs(`ws://127.0.0.1:${port}/api/channels/web/ws/${AG}?token=wrong`, {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      });
      ws1.close();
      // No header, query valid — query fallback wins.
      const ws2 = await dialWs(`ws://127.0.0.1:${port}/api/channels/web/ws/${AG}?token=${ADMIN_TOKEN}`);
      ws2.close();
      // Both invalid — reject.
      await expect(
        dialWs(`ws://127.0.0.1:${port}/api/channels/web/ws/${AG}?token=wrong`, {
          Authorization: 'Bearer not-the-token',
        }),
      ).rejects.toThrow(/401|unexpected-response/);
    });
  });

  describe('deliver()', () => {
    it('returns a synthetic id for baget-web platform; does NOT write directly (mirror handles it)', async () => {
      initTestDb();
      runMigrations(getDb());
      makeAgentGroup();
      const a = _testBuildBagetWebAdapter({ adminToken: ADMIN_TOKEN });
      const out: OutboundMessage = { kind: 'chat', content: { text: 'hi' } };
      const result = await a.deliver(`baget-web:${AG}`, null, out);
      expect(typeof result).toBe('string');
      // Direct deliver does NOT write to the log; the mirror is the
      // sole writer (called from the wrapped deliveryAdapter in
      // src/index.ts, not from the channel adapter itself).
      expect(findConversationByAgentGroup(AG)).toBeUndefined();
    });

    it('returns undefined for a foreign platform_id (defensive)', async () => {
      const a = _testBuildBagetWebAdapter({ adminToken: ADMIN_TOKEN });
      const out: OutboundMessage = { kind: 'chat', content: { text: 'hi' } };
      const result = await a.deliver('not-baget-web:99', null, out);
      expect(result).toBeUndefined();
    });
  });

  it('exposes the BAGET_WEB_CHANNEL_TYPE constant for cross-module imports', () => {
    expect(BAGET_WEB_CHANNEL_TYPE).toBe('baget-web');
  });
});

// ── Local helper ──

import net from 'net';

async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('no address'));
        return;
      }
      const p = addr.port;
      srv.close(() => resolve(p));
    });
  });
}
