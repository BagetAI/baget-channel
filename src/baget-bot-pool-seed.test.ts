/**
 * Tests for POST /baget/bot-pool/seed.
 *
 * Covers:
 *   - 401 without bearer
 *   - 400 on missing/empty bots array, oversized batch
 *   - 200 inserted on a valid token (mocked Telegram getMe)
 *   - 200 rotated on re-seed of the same username with a new token
 *   - 200 with skipped per-row reasons:
 *       missing_botUsername, missing_botToken,
 *       telegram_getMe_status_*, telegram_getMe_invalid_response,
 *       telegram_getMe_threw, telegram_username_mismatch
 *   - Mixed-batch run: partial failure does NOT bail; each row's
 *     outcome is reported individually and successful rows still land.
 *   - Auto-mints webhook secret when not supplied.
 *   - Trims whitespace and case-insensitive username compare against
 *     Telegram's canonical casing.
 *   - Pool depth in response reflects post-seed state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBagetAdminServer } from './baget-admin-server.js';
import { closeDb, getDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { countActiveBots, getBotPoolEntryByUsername } from './db/baget-bot-pool.js';

const ADMIN_TOKEN = 'test-admin-token-1234567890abcdef';

interface SeedResp {
  ok: boolean;
  error?: string;
  message?: string;
  requested?: number;
  inserted?: number;
  rotated?: number;
  skipped?: number;
  poolDepth?: number;
  results?: Array<{ botUsername: string; outcome: 'inserted' | 'rotated' | 'skipped'; reason?: string }>;
}

describe('POST /baget/bot-pool/seed', () => {
  let port: number;
  let baseUrl: string;
  let server: ReturnType<typeof createBagetAdminServer> | null = null;

  // Per-test mock for Telegram getMe — keyed by token, returns a
  // fake getMe response. Default behavior: return a username derived
  // from the token (mock-bot-<token>) so happy-path tests don't need
  // a per-test setup.
  let getMeOverrides: Map<string, () => Response | Promise<Response>>;

  function defaultGetMeFor(token: string): Response {
    const username = `mock_for_${token.replace(/[^a-z0-9]/gi, '').slice(0, 8)}_bot`;
    return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, username, first_name: 'Mock' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  beforeEach(async () => {
    initTestDb();
    runMigrations(getDb());
    getMeOverrides = new Map();
    port = 35000 + Math.floor(Math.random() * 1000);
    baseUrl = `http://127.0.0.1:${port}`;

    server = createBagetAdminServer({
      port,
      adminToken: ADMIN_TOKEN,
      telegramBotUsername: 'baget_test_bot',
      generateAgentGroupId: () => 'unused',
      telegramApiBaseUrl: 'https://api.telegram.test',
      telegramFetchImpl: async (url: string | URL | Request) => {
        const u = String(url);
        // Match `/bot<token>/getMe` and pull the token.
        const m = /\/bot([^/]+)\/getMe$/.exec(u);
        if (!m) {
          return new Response('not-found', { status: 404 });
        }
        const token = m[1]!;
        const override = getMeOverrides.get(token);
        if (override) return override();
        return defaultGetMeFor(token);
      },
    });
    await server.listen();
  });

  afterEach(async () => {
    await server?.close();
    closeDb();
    server = null;
  });

  async function postSeed(body: unknown, withAuth = true): Promise<{ status: number; json: SeedResp }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (withAuth) headers.Authorization = `Bearer ${ADMIN_TOKEN}`;
    const resp = await fetch(`${baseUrl}/baget/bot-pool/seed`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return { status: resp.status, json: (await resp.json()) as SeedResp };
  }

  it('returns 401 without a bearer token', async () => {
    const { status, json } = await postSeed({ bots: [{ botUsername: 'x', botToken: 'y' }] }, false);
    expect(status).toBe(401);
    expect(json.error).toBe('unauthorized');
  });

  it('returns 400 when bots is missing or empty', async () => {
    const r1 = await postSeed({});
    expect(r1.status).toBe(400);
    expect(r1.json.error).toBe('invalid_body');
    const r2 = await postSeed({ bots: [] });
    expect(r2.status).toBe(400);
    expect(r2.json.error).toBe('invalid_body');
  });

  it('returns 400 when bots array exceeds 50', async () => {
    const bots = Array.from({ length: 51 }, (_, i) => ({ botUsername: `b${i}`, botToken: `t${i}` }));
    const { status, json } = await postSeed({ bots });
    expect(status).toBe(400);
    expect(json.message).toMatch(/max 50/);
  });

  it('inserts a valid token (Telegram getMe mocked)', async () => {
    // Mock getMe to claim username "fresh_bot_001"
    getMeOverrides.set(
      'token-fresh-001',
      () =>
        new Response(JSON.stringify({ ok: true, result: { username: 'fresh_bot_001' } }), {
          status: 200,
        }),
    );
    const { status, json } = await postSeed({
      bots: [{ botUsername: 'fresh_bot_001', botToken: 'token-fresh-001' }],
    });
    expect(status).toBe(200);
    expect(json.inserted).toBe(1);
    expect(json.skipped).toBe(0);
    expect(json.poolDepth).toBe(1);
    const row = getBotPoolEntryByUsername('fresh_bot_001');
    expect(row).toBeDefined();
    expect(row?.bot_token_value).toBe('token-fresh-001');
    expect(row?.webhook_secret.length).toBeGreaterThan(20); // auto-minted
    // Post-020: fresh rows land active (retired_at IS NULL). The
    // 1:1 `status` field is gone.
    expect(row?.retired_at).toBeNull();
  });

  it('rotates token on re-seed of the same username', async () => {
    getMeOverrides.set(
      'token-v1',
      () => new Response(JSON.stringify({ ok: true, result: { username: 'rotate_bot' } }), { status: 200 }),
    );
    const r1 = await postSeed({
      bots: [{ botUsername: 'rotate_bot', botToken: 'token-v1' }],
    });
    expect(r1.json.inserted).toBe(1);

    getMeOverrides.set(
      'token-v2',
      () => new Response(JSON.stringify({ ok: true, result: { username: 'rotate_bot' } }), { status: 200 }),
    );
    const r2 = await postSeed({
      bots: [{ botUsername: 'rotate_bot', botToken: 'token-v2' }],
    });
    expect(r2.json.rotated).toBe(1);
    expect(r2.json.inserted).toBe(0);
    expect(getBotPoolEntryByUsername('rotate_bot')?.bot_token_value).toBe('token-v2');
    expect(countActiveBots()).toBe(1); // still 1, not 2
  });

  it('skips rows missing botUsername or botToken', async () => {
    const { json } = await postSeed({
      bots: [
        { botUsername: '', botToken: 'tok' },
        { botUsername: 'ok_bot', botToken: '' },
      ],
    });
    expect(json.skipped).toBe(2);
    expect(json.results?.[0]?.reason).toBe('missing_botUsername');
    expect(json.results?.[1]?.reason).toBe('missing_botToken');
  });

  it('skips when Telegram getMe returns non-2xx', async () => {
    getMeOverrides.set('bad-token', () => new Response('Unauthorized', { status: 401 }));
    const { json } = await postSeed({
      bots: [{ botUsername: 'will_fail_bot', botToken: 'bad-token' }],
    });
    expect(json.skipped).toBe(1);
    expect(json.results?.[0]?.reason).toBe('telegram_getMe_status_401');
  });

  it('skips when Telegram getMe response is malformed', async () => {
    getMeOverrides.set('malformed-token', () => new Response(JSON.stringify({ ok: false }), { status: 200 }));
    const { json } = await postSeed({
      bots: [{ botUsername: 'whatever_bot', botToken: 'malformed-token' }],
    });
    expect(json.skipped).toBe(1);
    expect(json.results?.[0]?.reason).toBe('telegram_getMe_invalid_response');
  });

  it('skips when getMe throws (network error)', async () => {
    getMeOverrides.set('throws-token', () => {
      throw new Error('connection refused');
    });
    const { json } = await postSeed({
      bots: [{ botUsername: 'whatever_bot', botToken: 'throws-token' }],
    });
    expect(json.skipped).toBe(1);
    expect(json.results?.[0]?.reason).toBe('telegram_getMe_threw');
  });

  it('skips when claimed username does not match Telegram', async () => {
    getMeOverrides.set(
      'mismatched-token',
      () =>
        new Response(JSON.stringify({ ok: true, result: { username: 'actual_username' } }), {
          status: 200,
        }),
    );
    const { json } = await postSeed({
      bots: [{ botUsername: 'claimed_username', botToken: 'mismatched-token' }],
    });
    expect(json.skipped).toBe(1);
    expect(json.results?.[0]?.reason).toMatch(/telegram_username_mismatch/);
  });

  it('username compare is case-insensitive AND stores Telegram canonical casing', async () => {
    getMeOverrides.set(
      'tok-case',
      () =>
        new Response(JSON.stringify({ ok: true, result: { username: 'lowercase_bot' } }), {
          status: 200,
        }),
    );
    const { json } = await postSeed({
      bots: [{ botUsername: 'LowerCase_BOT', botToken: 'tok-case' }],
    });
    expect(json.inserted).toBe(1);
    // Stored under Telegram's canonical (lower-case) username.
    expect(getBotPoolEntryByUsername('lowercase_bot')).toBeDefined();
    // The original (mixed-case) lookup should miss.
    expect(getBotPoolEntryByUsername('LowerCase_BOT')).toBeUndefined();
  });

  it('partial failure does NOT bail: successful rows still land', async () => {
    getMeOverrides.set(
      'ok-tok',
      () => new Response(JSON.stringify({ ok: true, result: { username: 'good_bot' } }), { status: 200 }),
    );
    getMeOverrides.set('bad-tok', () => new Response('forbidden', { status: 403 }));
    const { json } = await postSeed({
      bots: [
        { botUsername: 'good_bot', botToken: 'ok-tok' },
        { botUsername: 'bad_bot', botToken: 'bad-tok' },
      ],
    });
    expect(json.inserted).toBe(1);
    expect(json.skipped).toBe(1);
    expect(json.poolDepth).toBe(1);
    expect(getBotPoolEntryByUsername('good_bot')).toBeDefined();
    expect(getBotPoolEntryByUsername('bad_bot')).toBeUndefined();
  });

  it('uses supplied webhookSecret when provided', async () => {
    getMeOverrides.set(
      'tok-secret',
      () =>
        new Response(JSON.stringify({ ok: true, result: { username: 'with_secret_bot' } }), {
          status: 200,
        }),
    );
    const { json } = await postSeed({
      bots: [
        {
          botUsername: 'with_secret_bot',
          botToken: 'tok-secret',
          webhookSecret: 'operator-supplied-secret-12345',
        },
      ],
    });
    expect(json.inserted).toBe(1);
    expect(getBotPoolEntryByUsername('with_secret_bot')?.webhook_secret).toBe('operator-supplied-secret-12345');
  });
});
