/**
 * Unit tests for the boot-time `BAGET_BOT_POOL_SEED_JSON` self-seeder.
 *
 * Pinning these specific behaviors:
 *   1. Empty-table gate fires when the pool already has rows — env
 *      seed is a no-op (logged, not silent), so an operator-driven
 *      admin POST is never silently overwritten on next deploy.
 *   2. `skipped: true` when the env var is unset / empty — the boot
 *      path must be safe to run on hosts that don't use this feature.
 *   3. Malformed JSON does NOT throw — boot must continue with the
 *      pool in whatever state it was (likely empty → 503 on next
 *      bind, which is the same UX as before this PR).
 *   4. Per-row errors (missing fields, db throws) are collected, not
 *      fatal — a single bad entry in a 30-bot env doesn't lock out
 *      the other 29.
 *   5. Successfully seeded rows land with `source = 'env'` so a
 *      debugging operator can distinguish them from admin-POST rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { maybeSeedBotPoolFromEnv } from './baget-bot-pool-env-seeder.js';
import { closeDb, getDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { listAllBotPoolEntries, seedBotPoolEntry } from './db/baget-bot-pool.js';

const NOW = '2026-05-07T12:00:00.000Z';

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => closeDb());

describe('maybeSeedBotPoolFromEnv', () => {
  it('skips when the env var is undefined (host without this feature configured)', () => {
    const summary = maybeSeedBotPoolFromEnv(undefined, NOW);
    expect(summary.skipped).toBe(true);
    expect(summary.inserted).toBe(0);
    expect(listAllBotPoolEntries()).toHaveLength(0);
  });

  it('skips when the env var is empty string (Railway sometimes sets blanks)', () => {
    const summary = maybeSeedBotPoolFromEnv('   ', NOW);
    expect(summary.skipped).toBe(true);
    expect(listAllBotPoolEntries()).toHaveLength(0);
  });

  it('inserts every row in the JSON array on a fresh pool, tagged source=env', () => {
    const env = JSON.stringify([
      { botUsername: 'alpha_bot', botToken: '111:AAH-aaa', webhookSecret: 'secret-alpha' },
      { botUsername: 'beta_bot', botToken: '222:AAH-bbb' }, // no secret — minted
    ]);
    const summary = maybeSeedBotPoolFromEnv(env, NOW);

    expect(summary.skipped).toBe(false);
    expect(summary.poolNonEmpty).toBe(false);
    expect(summary.inserted).toBe(2);
    expect(summary.rotated).toBe(0);
    expect(summary.errors).toEqual([]);

    const rows = listAllBotPoolEntries();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.source).toBe('env');
      // Post-020: bot rows are active by default (retired_at IS NULL).
      // The 1:1 `status` and `assigned_agent_group_id` fields were
      // dropped; assignment lives in the junction table.
      expect(row.retired_at).toBeNull();
      expect(row.webhook_secret).toMatch(/^.+$/); // either supplied or minted
    }
    const alpha = rows.find((r) => r.bot_username === 'alpha_bot');
    expect(alpha?.webhook_secret).toBe('secret-alpha');
    const beta = rows.find((r) => r.bot_username === 'beta_bot');
    // Minted secret is 32 hex chars per `mintWebhookSecret()`.
    expect(beta?.webhook_secret).toMatch(/^[0-9a-f]{32}$/);
  });

  it('skips ALL inserts when the table is non-empty (empty-table gate)', () => {
    // Pre-populate with ONE admin-POST row.
    seedBotPoolEntry({
      botUsername: 'pre_existing_bot',
      botTokenValue: '999:AAH-pre',
      webhookSecret: 'pre-existing-secret',
      createdAt: NOW,
      source: 'admin',
    });

    const env = JSON.stringify([{ botUsername: 'gamma_bot', botToken: '333:AAH-ccc' }]);
    const summary = maybeSeedBotPoolFromEnv(env, NOW);

    expect(summary.skipped).toBe(false);
    expect(summary.poolNonEmpty).toBe(true);
    expect(summary.inserted).toBe(0);

    const rows = listAllBotPoolEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0].bot_username).toBe('pre_existing_bot');
    expect(rows[0].source).toBe('admin');
  });

  it('does not throw on malformed JSON; surfaces error in summary instead', () => {
    expect(() => maybeSeedBotPoolFromEnv('{this is not, json: ', NOW)).not.toThrow();
    const summary = maybeSeedBotPoolFromEnv('{this is not, json: ', NOW);
    expect(summary.skipped).toBe(false);
    expect(summary.errors).toEqual([{ index: -1, reason: 'env_not_valid_json' }]);
    expect(listAllBotPoolEntries()).toHaveLength(0);
  });

  it('does not throw when the JSON is valid but not an array (defensive parse)', () => {
    const summary = maybeSeedBotPoolFromEnv(JSON.stringify({ botUsername: 'oops' }), NOW);
    expect(summary.errors).toEqual([{ index: -1, reason: 'env_not_array' }]);
    expect(listAllBotPoolEntries()).toHaveLength(0);
  });

  it('continues past per-row errors so one bad entry does not lock the rest out', () => {
    const env = JSON.stringify([
      { botUsername: 'good1_bot', botToken: '111:AAH' },
      { botUsername: '', botToken: '222:AAH' }, // missing username
      { botToken: '333:AAH' }, // missing username (different shape)
      { botUsername: 'no_token_bot' }, // missing token
      { botUsername: 'good2_bot', botToken: '444:AAH' },
    ]);
    const summary = maybeSeedBotPoolFromEnv(env, NOW);

    expect(summary.inserted).toBe(2);
    expect(summary.errors.map((e) => e.reason).sort()).toEqual([
      'missing_botToken',
      'missing_botUsername',
      'missing_botUsername',
    ]);

    const usernames = listAllBotPoolEntries()
      .map((r) => r.bot_username)
      .sort();
    expect(usernames).toEqual(['good1_bot', 'good2_bot']);
  });
});
