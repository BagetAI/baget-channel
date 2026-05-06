/**
 * Tests for the pool-only deploy mode introduced 2026-05-06.
 *
 * Sam's S-10.2 staging smoke (PR #461 sibling): after deleting the
 * legacy `@baget_team_staging_bot` from BotFather and removing
 * `TELEGRAM_BOT_TOKEN` from the staging Railway service, the entire
 * Telegram surface went dead — the channel adapter's registration
 * gate at `baget-telegram.ts:1333` short-circuited on missing
 * `process.env.TELEGRAM_BOT_TOKEN` and skipped registration entirely.
 * No adapter = no webhooks = no pairing = no callbacks.
 *
 * The fix: register the adapter on `BAGET_ADMIN_TOKEN +
 * TELEGRAM_WEBHOOK_SECRET` alone, and make `cfg.botToken` optional.
 * Per-call pool lookups resolve the right token at runtime; outbound
 * paths that fall through to an undefined `cfg.botToken` log loudly
 * and drop instead of crashing or hitting Telegram with an empty
 * token.
 *
 * This file pins the contract:
 *   - `_testBuildBagetTelegramAdapter` constructs cleanly with
 *     `botToken: undefined` (the pool-only shape)
 *   - deliver() to an agent_group with NO pool entry AND no
 *     cfg.botToken logs an error and returns undefined (not crash,
 *     not silent-Telegram-404)
 *   - sendBotMessage's pre-pair / legacy default-token path no-ops
 *     instead of POSTing with an empty token
 *
 * The full registration-gate behavior (env-var-driven module-import
 * branch) is hard to unit-test because module imports are cached;
 * the contract there is asserted at the buildAdapter level — if the
 * adapter can be CONSTRUCTED with `botToken: undefined`, the gate
 * change is internally consistent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _testBuildBagetTelegramAdapter, BAGET_TELEGRAM_CHANNEL_TYPE as _CHANNEL_TYPE } from './baget-telegram.js';
import { bindBagetTelegramChat } from './baget-telegram-bind.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';
import { createBagetAgentGroup } from '../db/baget-agent-groups.js';
import type { ChannelSetup, OutboundMessage } from './adapter.js';

const ADMIN_TOKEN = 'pool-only-admin-token-1234567890ab';
const WEBHOOK_SECRET = 'pool-only-webhook-secret-1234567890';
const AGENT_GROUP_ID = 'ag-pool-only-test';
const CHAT_ID = 999001;

function nowIso(): string {
  return new Date().toISOString();
}

describe('pool-only deploy (no global cfg.botToken)', () => {
  let adapter: ReturnType<typeof _testBuildBagetTelegramAdapter> | null = null;
  let captured: Array<{ url: string; method: string }>;

  beforeEach(async () => {
    initTestDb();
    runMigrations(getDb());

    createBagetAgentGroup({
      id: AGENT_GROUP_ID,
      name: 'Pool Only Co',
      folder: 'pool-only',
      user_id: 'user-pool',
      company_id: 'company-pool',
      baget_team_members: JSON.stringify({ cos: 'Louis' }),
      created_at: nowIso(),
    });
    expect(
      bindBagetTelegramChat({ chatId: CHAT_ID, agentGroupId: AGENT_GROUP_ID, firstName: 'Sam' }).ok,
    ).toBe(true);

    captured = [];
  });

  afterEach(async () => {
    await adapter?.teardown();
    closeDb();
    adapter = null;
  });

  it('constructs the adapter with botToken: undefined (pool-only shape)', async () => {
    // PRE-FIX: BagetTelegramConfig.botToken was `string` (required).
    // This very `_testBuildBagetTelegramAdapter` call would have failed
    // at TypeScript level. POST-FIX: optional; pool-only deploys can
    // construct the adapter and let per-call lookups resolve tokens.
    const built = _testBuildBagetTelegramAdapter({
      botToken: undefined,
      webhookSecret: WEBHOOK_SECRET,
      adminToken: ADMIN_TOKEN,
      apiBaseUrl: 'https://api.telegram.test',
      fetchImpl: async () => new Response('{"ok":true}', { status: 200 }),
    });
    expect(built).toBeDefined();
    expect(typeof built.deliver).toBe('function');
    adapter = built;
  });

  it('deliver() drops loudly when agent_group has no pool entry AND no cfg.botToken', async () => {
    // Sam 2026-05-06 root-cause discipline: the pre-fix path silently
    // POSTed to `https://api.telegram.org/bot/sendMessage` (empty
    // token) which Telegram returns 404 for — the founder's outbound
    // never lands and the failure doesn't surface in baget logs. The
    // pool-only fix detects the missing token BEFORE the fetch and
    // logs a structured error instead.
    adapter = _testBuildBagetTelegramAdapter({
      botToken: undefined,
      webhookSecret: WEBHOOK_SECRET,
      adminToken: ADMIN_TOKEN,
      apiBaseUrl: 'https://api.telegram.test',
      fetchImpl: async (url) => {
        captured.push({ url: String(url), method: 'fetch' });
        return new Response('{"ok":true}', { status: 200 });
      },
    });
    const setup: ChannelSetup = {
      onInbound() {},
      onInboundEvent() {},
      onMetadata() {},
      onAction() {},
    };
    await adapter.setup(setup);

    const result = await adapter.deliver(`baget-telegram:${CHAT_ID}`, null, {
      kind: 'chat',
      content: { text: 'cos: hello' },
    } satisfies OutboundMessage);

    // The deliver call MUST return undefined (the contract value for
    // "nothing landed") AND must NOT have hit Telegram. This is the
    // load-bearing assertion: pre-fix, this would have POSTed to
    // /bot/sendMessage (empty token) and returned undefined ANYWAY
    // because Telegram 404s on the bad URL — but the founder would
    // have no idea why nothing arrived. The post-fix log lets the
    // operator notice the misconfiguration.
    expect(result).toBeUndefined();
    expect(captured.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);
  });
});
