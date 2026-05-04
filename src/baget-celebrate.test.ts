/**
 * Tests for POST /baget/agent-groups/:agentGroupId/celebrate
 * and Telegram celebration rendering.
 *
 * Covers:
 *  - 401 without bearer token
 *  - 404 for unknown agentGroupId
 *  - 404 for archived agentGroupId
 *  - 200 { ok: true, deliveredTo: [] } when no chats are bound (unpaired)
 *  - 200 with deliveredTo entry when a Telegram chat is bound
 *  - Rendered Telegram text contains 🎉, batch number, summary, deliverables
 *  - Telegram delivery failure → best-effort (200, failed: true)
 *  - Deliverable rendering: empty list skips bullets, hrefs only when set
 *  - renderCelebrationText: streakDays present vs absent
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBagetAdminServer } from './baget-admin-server.js';
import { createBagetAgentGroup, archiveBagetAgentGroup } from './db/baget-agent-groups.js';
import { closeDb, getDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { bindBagetTelegramChat } from './channels/baget-telegram-bind.js';
import { _testRenderCelebrationText, BAGET_TELEGRAM_CHANNEL_TYPE } from './channels/baget-telegram.js';
import type { ChannelAdapter, OutboundMessage, CelebrationPayload } from './channels/adapter.js';
import type { CelebrateBody } from './baget-admin-server.js';

const ADMIN_TOKEN = 'test-admin-token-1234567890abcdef';
const AGENT_GROUP_ID = 'ag-celebrate-1';
const CHAT_ID = 777001;

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function setupAgentGroup(archived = false) {
  createBagetAgentGroup({
    id: AGENT_GROUP_ID,
    name: 'Celebrate Corp',
    folder: 'celebrate-test-corp',
    user_id: 'user-cel',
    company_id: 'company-cel',
    baget_team_members: JSON.stringify({ cos: 'Louis' }),
    created_at: nowIso(),
  });
  if (archived) {
    archiveBagetAgentGroup(AGENT_GROUP_ID, nowIso());
  }
}

function validBody(overrides: Partial<CelebrateBody> = {}): CelebrateBody {
  return {
    kind: 'batch-complete',
    batchNumber: 3,
    summary: 'The team shipped the new pricing page and three landing-page variants.',
    streakDays: 12,
    deliverables: [
      { label: '3 landing-page variants', href: 'https://app.baget.ai/batches/3' },
      { label: 'Pricing page redesign' },
    ],
    ...overrides,
  };
}

describe('POST /baget/agent-groups/:id/celebrate', () => {
  let port: number;
  let baseUrl: string;
  let server: ReturnType<typeof createBagetAdminServer> | null = null;

  // Captured deliver calls from the mock adapter
  let deliverCalls: Array<{ platformId: string; message: OutboundMessage }>;
  // Controls the mock adapter's deliver return value
  let mockMessageId: string | null;

  function makeMockAdapter(): ChannelAdapter {
    return {
      name: 'mock-telegram',
      channelType: BAGET_TELEGRAM_CHANNEL_TYPE,
      supportsThreads: false,
      async setup() {},
      async teardown() {},
      isConnected: () => true,
      async deliver(platformId, _threadId, message) {
        deliverCalls.push({ platformId, message });
        return mockMessageId ?? undefined;
      },
    };
  }

  beforeEach(async () => {
    initTestDb();
    runMigrations(getDb());

    deliverCalls = [];
    mockMessageId = 'msg-42';
    port = 34000 + Math.floor(Math.random() * 1000);
    baseUrl = `http://127.0.0.1:${port}`;

    const mockAdapter = makeMockAdapter();
    server = createBagetAdminServer({
      port,
      adminToken: ADMIN_TOKEN,
      telegramBotUsername: 'baget_test_bot',
      generateAgentGroupId: () => 'unused',
      getChannelAdapterFn: (channelType) => (channelType === BAGET_TELEGRAM_CHANNEL_TYPE ? mockAdapter : undefined),
    });
    await server.listen();
  });

  afterEach(async () => {
    await server?.close();
    closeDb();
    server = null;
  });

  it('returns 401 without a bearer token', async () => {
    setupAgentGroup();
    const resp = await fetch(`${baseUrl}/baget/agent-groups/${AGENT_GROUP_ID}/celebrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody()),
    });
    expect(resp.status).toBe(401);
    const json = (await resp.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('unauthorized');
  });

  it('returns 404 for unknown agentGroupId', async () => {
    const resp = await fetch(`${baseUrl}/baget/agent-groups/does-not-exist/celebrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify(validBody()),
    });
    expect(resp.status).toBe(404);
    const json = (await resp.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('group_not_found');
  });

  it('returns 404 for an archived agentGroupId', async () => {
    setupAgentGroup(true); // archived
    const resp = await fetch(`${baseUrl}/baget/agent-groups/${AGENT_GROUP_ID}/celebrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify(validBody()),
    });
    expect(resp.status).toBe(404);
    const json = (await resp.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('group_not_found');
  });

  it('returns 200 { ok: true, deliveredTo: [] } when no chats are bound (unpaired group)', async () => {
    setupAgentGroup(); // active but no Telegram bind
    const resp = await fetch(`${baseUrl}/baget/agent-groups/${AGENT_GROUP_ID}/celebrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify(validBody()),
    });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { ok: boolean; deliveredTo: unknown[] };
    expect(json.ok).toBe(true);
    expect(json.deliveredTo).toHaveLength(0);
    // Nothing was sent to Telegram
    expect(deliverCalls).toHaveLength(0);
  });

  it('delivers a celebration to a bound Telegram chat and returns deliveredTo', async () => {
    setupAgentGroup();
    bindBagetTelegramChat({ chatId: CHAT_ID, agentGroupId: AGENT_GROUP_ID });

    const body = validBody();
    const resp = await fetch(`${baseUrl}/baget/agent-groups/${AGENT_GROUP_ID}/celebrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as {
      ok: boolean;
      deliveredTo: Array<{ channelType: string; platformId: string; messageId: string | null; failed?: boolean }>;
    };
    expect(json.ok).toBe(true);
    expect(json.deliveredTo).toHaveLength(1);

    const entry = json.deliveredTo[0]!;
    expect(entry.channelType).toBe(BAGET_TELEGRAM_CHANNEL_TYPE);
    expect(entry.platformId).toBe(`baget-telegram:${CHAT_ID}`);
    expect(entry.messageId).toBe('msg-42');
    expect(entry.failed).toBeUndefined();

    // The adapter was called with the celebration OutboundMessage
    expect(deliverCalls).toHaveLength(1);
    const call = deliverCalls[0]!;
    expect(call.platformId).toBe(`baget-telegram:${CHAT_ID}`);
    expect(call.message.kind).toBe('celebration');
    const payload = call.message.content as CelebrationPayload;
    expect(payload.batchNumber).toBe(body.batchNumber);
    expect(payload.summary).toBe(body.summary);
    expect(payload.streakDays).toBe(body.streakDays);
    expect(payload.deliverables).toEqual(body.deliverables);
  });

  it('returns 200 best-effort when Telegram delivery fails (failed: true, messageId: null)', async () => {
    setupAgentGroup();
    bindBagetTelegramChat({ chatId: CHAT_ID, agentGroupId: AGENT_GROUP_ID });

    mockMessageId = null; // simulate deliver() returning undefined

    const resp = await fetch(`${baseUrl}/baget/agent-groups/${AGENT_GROUP_ID}/celebrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify(validBody()),
    });

    expect(resp.status).toBe(200);
    const json = (await resp.json()) as {
      ok: boolean;
      deliveredTo: Array<{ channelType: string; platformId: string; messageId: string | null; failed?: boolean }>;
    };
    expect(json.ok).toBe(true);
    expect(json.deliveredTo).toHaveLength(1);
    const entry = json.deliveredTo[0]!;
    expect(entry.messageId).toBeNull();
    expect(entry.failed).toBe(true);
  });

  it('returns 400 for invalid body (missing batchNumber)', async () => {
    setupAgentGroup();
    const resp = await fetch(`${baseUrl}/baget/agent-groups/${AGENT_GROUP_ID}/celebrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ kind: 'batch-complete', summary: 'shipped it' }), // missing batchNumber
    });
    expect(resp.status).toBe(400);
    const json = (await resp.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('invalid_body');
  });
});

describe('renderCelebrationText', () => {
  it('includes 🎉 Day N! prefix when streakDays set', () => {
    const text = _testRenderCelebrationText({
      batchNumber: 5,
      summary: 'Great batch.',
      streakDays: 10,
    });
    expect(text).toContain('🎉 Day 10!');
    expect(text).toContain('Batch 5 just landed.');
    expect(text).toContain('Great batch.');
  });

  it('uses plain 🎉 when streakDays absent', () => {
    const text = _testRenderCelebrationText({
      batchNumber: 1,
      summary: 'First batch!',
    });
    expect(text).toMatch(/^🎉 Batch 1 just landed\./);
    expect(text).not.toContain('Day');
  });

  it('includes deliverable labels with hrefs when present', () => {
    const text = _testRenderCelebrationText({
      batchNumber: 2,
      summary: 'Two items shipped.',
      deliverables: [
        { label: '3 landing-page variants', href: 'https://app.baget.ai/batches/2' },
        { label: 'Pricing page redesign' },
      ],
    });
    expect(text).toContain('• 3 landing-page variants → https://app.baget.ai/batches/2');
    expect(text).toContain('• Pricing page redesign');
    expect(text).not.toMatch(/Pricing page redesign →/); // no trailing arrow without href
  });

  it('skips the deliverable section when deliverables is empty', () => {
    const text = _testRenderCelebrationText({
      batchNumber: 3,
      summary: 'Shipped without extras.',
      deliverables: [],
    });
    expect(text).not.toContain('•');
    // Text should just be header + blank line + summary (3 logical lines)
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2); // header + summary
  });

  it('skips the deliverable section when deliverables is undefined', () => {
    const text = _testRenderCelebrationText({ batchNumber: 4, summary: 'Just a summary.' });
    expect(text).not.toContain('•');
  });
});
