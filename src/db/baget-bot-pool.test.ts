/**
 * Tests for the bot-pool persistence layer — N:1 model (migration 020).
 *
 * Coverage rationale:
 *
 *   - Migration shape: post-020 table has the new column set (no
 *     status / assigned_agent_group_id / assigned_at; gained retired_at),
 *     the orphan trigger from 017 is dropped, and the junction table
 *     `baget_bot_pool_assignments` is in place with FK CASCADE.
 *   - `seedBotPoolEntry` rotation semantics: re-seed of an existing
 *     username UPDATEs credentials, returns 'rotated', leaves retired_at /
 *     webhook_registered_at / existing junction assignments intact.
 *   - `assignNextAvailableBot` allocation policy (N:1):
 *       - Returns null only when the pool has zero active bots.
 *       - Idempotent for already-assigned groups (junction PK).
 *       - Least-loaded with FIFO tiebreaker.
 *       - **N companies on one bot** — the headline change.
 *       - Same-founder preference: bots already serving the founder
 *         are deprioritized when alternatives exist.
 *       - Out-of-band junction INSERT is honored by step-0 idempotency.
 *   - `releaseBot` deletes the junction row but leaves the bot active.
 *   - Hard-delete of `agent_groups` cascades through the junction (the
 *     orphan trigger's old job, now done by ON DELETE CASCADE).
 *   - Retirement: `retired_at IS NOT NULL` excludes a bot from new
 *     assignments but keeps it serving its existing ones.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from './index.js';
import { migration020 } from './migrations/020-baget-bot-pool-assignments.js';
import {
  assignNextAvailableBot,
  countAssignmentsForBot,
  countActiveBots,
  getBotPoolEntryByAgentGroup,
  getBotPoolEntryByUsername,
  markWebhookRegistered,
  releaseBot,
  seedBotPoolEntry,
} from './baget-bot-pool.js';
import { createBagetAgentGroup } from './baget-agent-groups.js';

const NOW = '2026-05-04T09:00:00.000Z';

function nowIso(offsetMs = 0): string {
  return new Date(Date.parse(NOW) + offsetMs).toISOString();
}

/**
 * Seed an agent_group. `userId` defaults to `user-${id}` for tests
 * that don't care about ownership; explicit override for the
 * same-founder-preference tests.
 */
function seedAgentGroup(id: string, userId?: string): void {
  createBagetAgentGroup({
    id,
    name: id,
    folder: id,
    user_id: userId ?? `user-${id}`,
    company_id: `company-${id}`,
    baget_team_members: JSON.stringify({ cos: 'Louis' }),
    created_at: NOW,
  });
}

describe('baget_bot_pool migration shape (post-020)', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });
  afterEach(() => closeDb());

  it('post-020 bot table has the N:1 column set', () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info('baget_bot_pool')").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name).sort();
    // status / assigned_agent_group_id / assigned_at were dropped in
    // migration 020; retired_at was added.
    expect(colNames).toEqual(
      [
        'bot_token_value',
        'bot_username',
        'created_at',
        'retired_at',
        'source',
        'webhook_registered_at',
        'webhook_secret',
      ].sort(),
    );
  });

  it('the 1:1 UNIQUE index and the orphan trigger are gone; the N:1 active-bots index is in place', () => {
    const db = getDb();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='baget_bot_pool'")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((r) => r.name);
    expect(indexNames).not.toContain('idx_bot_pool_assigned_agent_group'); // dropped
    expect(indexNames).not.toContain('idx_bot_pool_available'); // dropped
    expect(indexNames).toContain('idx_bot_pool_active');

    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='baget_bot_pool'")
      .all() as Array<{ name: string }>;
    expect(triggers.map((t) => t.name)).not.toContain('trg_bot_pool_release_on_orphan');
  });

  it('junction table baget_bot_pool_assignments exists with PK on agent_group_id and FK CASCADE', () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info('baget_bot_pool_assignments')").all() as Array<{
      name: string;
      pk: number;
    }>;
    const colNames = cols.map((c) => c.name).sort();
    expect(colNames).toEqual(['agent_group_id', 'assigned_at', 'bot_username'].sort());
    // agent_group_id is the PK (pk > 0); bot_username and assigned_at are not.
    const pkCol = cols.find((c) => c.pk > 0);
    expect(pkCol?.name).toBe('agent_group_id');

    const fks = db.prepare("PRAGMA foreign_key_list('baget_bot_pool_assignments')").all() as Array<{
      table: string;
      from: string;
      on_delete: string;
    }>;
    const agentGroupFk = fks.find((f) => f.from === 'agent_group_id');
    expect(agentGroupFk?.table).toBe('agent_groups');
    expect(agentGroupFk?.on_delete).toBe('CASCADE');
  });
});

describe('migration 020 — backfill from 1:1 to N:1', () => {
  // Reviewer's H1+H2: the standard test suite always runs migrations
  // against a fresh DB, so the SELECT-INSERT backfill in migration 020
  // is never exercised against real pre-020 data. Production has live
  // 1:1 assignments — if the backfill is buggy the symptom is "every
  // paired company silently loses its bot post-deploy." H2 is the
  // companion concern: ALTER TABLE DROP COLUMN with foreign_keys=ON
  // can fail to apply if the rebuild trips integrity checks. The
  // canonical proof is to plant the pre-020 shape and run 020.
  //
  // Strategy: do NOT call runMigrations() (which runs all 18 in
  // order); instead run migrations 001-019 by calling runMigrations,
  // then BEFORE 020 runs, manually rewrite the bot pool table to its
  // pre-020 shape (the table created by 016 + 017 + 019), insert
  // 1:1 rows, then run migration 020 directly.
  beforeEach(() => {
    initTestDb();
  });
  afterEach(() => closeDb());

  function applyPre020Schema(): void {
    const db = getDb();
    // Recreate the agent_groups + baget_bot_pool tables in the
    // pre-020 shape that migrations 001-019 would leave them in.
    // We bypass the migration runner to avoid 020 firing automatically.
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_groups (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        folder       TEXT NOT NULL,
        user_id      TEXT,
        company_id   TEXT,
        archived_at  TEXT,
        baget_team_members TEXT,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS baget_bot_pool (
        bot_username             TEXT PRIMARY KEY,
        bot_token_value          TEXT NOT NULL,
        webhook_secret           TEXT NOT NULL,
        status                   TEXT NOT NULL CHECK (status IN ('available', 'assigned')),
        assigned_agent_group_id  TEXT REFERENCES agent_groups(id) ON DELETE SET NULL,
        assigned_at              TEXT,
        webhook_registered_at    TEXT,
        created_at               TEXT NOT NULL,
        source                   TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'env'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_pool_assigned_agent_group
        ON baget_bot_pool(assigned_agent_group_id)
        WHERE assigned_agent_group_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_bot_pool_available
        ON baget_bot_pool(status, created_at)
        WHERE status = 'available';

      CREATE TRIGGER IF NOT EXISTS trg_bot_pool_release_on_orphan
        AFTER UPDATE OF assigned_agent_group_id ON baget_bot_pool
        WHEN NEW.assigned_agent_group_id IS NULL
         AND OLD.assigned_agent_group_id IS NOT NULL
      BEGIN
        UPDATE baget_bot_pool
           SET status      = 'available',
               assigned_at = NULL
         WHERE bot_username = NEW.bot_username
           AND status = 'assigned';
      END;
    `);
  }

  it('preserves every 1:1 assignment as a junction row + drops the legacy columns/trigger/index without erroring (H1+H2)', () => {
    applyPre020Schema();
    const db = getDb();

    // Plant pre-020 fixtures: 3 agent_groups, 3 bots, 2 assignments,
    // 1 free bot. Mirror the shape Sam's production DB has today.
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, user_id, company_id, baget_team_members, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('ag-paired-1', 'Co1', 'co1', 'user-1', 'co-1', '{}', NOW);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, user_id, company_id, baget_team_members, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('ag-paired-2', 'Co2', 'co2', 'user-2', 'co-2', '{}', NOW);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, user_id, company_id, baget_team_members, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('ag-unpaired', 'Co3', 'co3', 'user-3', 'co-3', '{}', NOW);

    db.prepare(
      `INSERT INTO baget_bot_pool
         (bot_username, bot_token_value, webhook_secret, status, assigned_agent_group_id, assigned_at, webhook_registered_at, created_at, source)
       VALUES (?, ?, ?, 'assigned', ?, ?, ?, ?, ?)`,
    ).run('bot_1', 'tok-1', 'sec-1', 'ag-paired-1', nowIso(100), nowIso(150), NOW, 'admin');
    db.prepare(
      `INSERT INTO baget_bot_pool
         (bot_username, bot_token_value, webhook_secret, status, assigned_agent_group_id, assigned_at, webhook_registered_at, created_at, source)
       VALUES (?, ?, ?, 'assigned', ?, ?, ?, ?, ?)`,
    ).run('bot_2', 'tok-2', 'sec-2', 'ag-paired-2', nowIso(200), nowIso(250), nowIso(50), 'env');
    db.prepare(
      `INSERT INTO baget_bot_pool
         (bot_username, bot_token_value, webhook_secret, status, assigned_agent_group_id, assigned_at, webhook_registered_at, created_at, source)
       VALUES (?, ?, ?, 'available', NULL, NULL, NULL, ?, ?)`,
    ).run('bot_3_free', 'tok-3', 'sec-3', nowIso(75), 'admin');

    // Run migration 020 wrapped in a transaction (matches what
    // runMigrations does). With foreign_keys ON (the default per
    // connection.ts), this exercises the worst-case path for
    // ALTER TABLE DROP COLUMN against a real FK + populated table.
    expect(() => db.transaction(() => migration020.up(db))()).not.toThrow();

    // Backfill happened: 2 junction rows for the 2 previously-paired
    // bots. The free bot has no junction row.
    const junctionRows = db
      .prepare(`SELECT agent_group_id, bot_username, assigned_at FROM baget_bot_pool_assignments ORDER BY bot_username`)
      .all() as Array<{ agent_group_id: string; bot_username: string; assigned_at: string }>;
    expect(junctionRows).toHaveLength(2);
    expect(junctionRows[0]).toMatchObject({ agent_group_id: 'ag-paired-1', bot_username: 'bot_1' });
    expect(junctionRows[0]?.assigned_at).toBe(nowIso(100));
    expect(junctionRows[1]).toMatchObject({ agent_group_id: 'ag-paired-2', bot_username: 'bot_2' });

    // Bot rows preserved: all 3, with secrets + webhook_registered_at intact.
    const bots = db
      .prepare(`SELECT bot_username, bot_token_value, webhook_secret, webhook_registered_at, source, retired_at FROM baget_bot_pool ORDER BY bot_username`)
      .all() as Array<{
        bot_username: string;
        bot_token_value: string;
        webhook_secret: string;
        webhook_registered_at: string | null;
        source: string;
        retired_at: string | null;
      }>;
    expect(bots).toHaveLength(3);
    expect(bots[0]).toMatchObject({ bot_username: 'bot_1', bot_token_value: 'tok-1', webhook_registered_at: nowIso(150), source: 'admin', retired_at: null });
    expect(bots[1]).toMatchObject({ bot_username: 'bot_2', bot_token_value: 'tok-2', webhook_registered_at: nowIso(250), source: 'env', retired_at: null });
    expect(bots[2]).toMatchObject({ bot_username: 'bot_3_free', bot_token_value: 'tok-3', retired_at: null });

    // Dropped columns are GONE — selecting them should error.
    expect(() => db.prepare(`SELECT status FROM baget_bot_pool`).all()).toThrow(/no such column/);
    expect(() => db.prepare(`SELECT assigned_agent_group_id FROM baget_bot_pool`).all()).toThrow(/no such column/);
    expect(() => db.prepare(`SELECT assigned_at FROM baget_bot_pool`).all()).toThrow(/no such column/);

    // Old index + trigger are dropped.
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='baget_bot_pool'`).all() as Array<{ name: string }>;
    const indexNames = indexes.map((r) => r.name);
    expect(indexNames).not.toContain('idx_bot_pool_assigned_agent_group');
    expect(indexNames).not.toContain('idx_bot_pool_available');
    expect(indexNames).toContain('idx_bot_pool_active');

    const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='baget_bot_pool'`).all() as Array<{ name: string }>;
    expect(triggers.map((t) => t.name)).not.toContain('trg_bot_pool_release_on_orphan');

    // Post-migration: helpers work end-to-end.
    expect(getBotPoolEntryByAgentGroup('ag-paired-1')?.bot_username).toBe('bot_1');
    expect(getBotPoolEntryByAgentGroup('ag-unpaired')).toBeUndefined();
    expect(countActiveBots()).toBe(3);
  });

  it('migration 020 is a no-op when there were no 1:1 assignments to backfill', () => {
    applyPre020Schema();
    const db = getDb();
    db.prepare(
      `INSERT INTO baget_bot_pool
         (bot_username, bot_token_value, webhook_secret, status, assigned_agent_group_id, assigned_at, webhook_registered_at, created_at, source)
       VALUES (?, ?, ?, 'available', NULL, NULL, NULL, ?, ?)`,
    ).run('lonely_bot', 'tok', 'sec', NOW, 'admin');

    expect(() => db.transaction(() => migration020.up(db))()).not.toThrow();
    const junctionCount = db.prepare(`SELECT COUNT(*) AS n FROM baget_bot_pool_assignments`).get() as { n: number };
    expect(junctionCount.n).toBe(0);
    expect(countActiveBots()).toBe(1);
  });
});

describe('seedBotPoolEntry rotation semantics', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });
  afterEach(() => closeDb());

  it('first seed inserts a fresh active row', () => {
    const outcome = seedBotPoolEntry({
      botUsername: 'baget_alpha_bot',
      botTokenValue: 'token-A',
      webhookSecret: 'secret-A',
      createdAt: NOW,
    });
    expect(outcome).toBe('inserted');

    const row = getBotPoolEntryByUsername('baget_alpha_bot');
    expect(row).toMatchObject({
      bot_username: 'baget_alpha_bot',
      bot_token_value: 'token-A',
      webhook_secret: 'secret-A',
      retired_at: null,
      webhook_registered_at: null,
      created_at: NOW,
    });
  });

  it('re-seed updates credentials but preserves retired_at, webhook timestamps, and existing junction assignments', () => {
    seedAgentGroup('ag-alpha');
    seedBotPoolEntry({
      botUsername: 'baget_alpha_bot',
      botTokenValue: 'token-A-old',
      webhookSecret: 'secret-A-old',
      createdAt: NOW,
    });
    // Assign + register webhook so we can verify those fields survive the rotation.
    assignNextAvailableBot('ag-alpha');
    markWebhookRegistered('baget_alpha_bot', nowIso(1000));

    const outcome = seedBotPoolEntry({
      botUsername: 'baget_alpha_bot',
      botTokenValue: 'token-A-new',
      webhookSecret: 'secret-A-new',
      createdAt: nowIso(2000), // would-be created_at, must be ignored on rotate
    });
    expect(outcome).toBe('rotated');

    const row = getBotPoolEntryByUsername('baget_alpha_bot');
    expect(row).toMatchObject({
      bot_username: 'baget_alpha_bot',
      bot_token_value: 'token-A-new', // rotated
      webhook_secret: 'secret-A-new', // rotated
      retired_at: null, // preserved
      created_at: NOW, // preserved (NOT clobbered to nowIso(2000))
    });
    expect(row?.webhook_registered_at).not.toBeNull();

    // Junction assignment to ag-alpha survives rotation.
    expect(getBotPoolEntryByAgentGroup('ag-alpha')?.bot_username).toBe('baget_alpha_bot');
  });
});

describe('assignNextAvailableBot — N:1 allocation policy', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });
  afterEach(() => closeDb());

  it('returns null when pool has zero active bots', () => {
    seedAgentGroup('ag-alpha');
    expect(assignNextAvailableBot('ag-alpha')).toBeNull();
  });

  it('treats retired bots as unavailable for new assignments', () => {
    seedAgentGroup('ag-alpha');
    seedBotPoolEntry({
      botUsername: 'retired_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: NOW,
    });
    // Mark retired manually (no helper yet — operator path).
    getDb().prepare(`UPDATE baget_bot_pool SET retired_at = ? WHERE bot_username = ?`).run(nowIso(100), 'retired_bot');
    expect(assignNextAvailableBot('ag-alpha')).toBeNull();
  });

  it('two different agent_groups can share the same bot (N:1)', () => {
    seedAgentGroup('ag-alpha', 'founder-1');
    seedAgentGroup('ag-beta', 'founder-2');
    seedBotPoolEntry({
      botUsername: 'shared_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: NOW,
    });

    const first = assignNextAvailableBot('ag-alpha', 'founder-1');
    const second = assignNextAvailableBot('ag-beta', 'founder-2');
    expect(first?.bot_username).toBe('shared_bot');
    expect(second?.bot_username).toBe('shared_bot');
    expect(countAssignmentsForBot('shared_bot')).toBe(2);
  });

  it('idempotent for an already-assigned agent_group (junction PK)', () => {
    seedAgentGroup('ag-alpha');
    seedBotPoolEntry({
      botUsername: 'baget_alpha_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: NOW,
    });
    seedBotPoolEntry({
      botUsername: 'baget_beta_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(1000),
    });

    const first = assignNextAvailableBot('ag-alpha');
    const second = assignNextAvailableBot('ag-alpha');
    expect(first?.bot_username).toBe(second?.bot_username);
    expect(countAssignmentsForBot(first!.bot_username)).toBe(1);
  });

  it('picks the least-loaded bot when multiple are available', () => {
    seedAgentGroup('ag-1', 'founder-1');
    seedAgentGroup('ag-2', 'founder-2');
    seedAgentGroup('ag-3', 'founder-3');
    seedAgentGroup('ag-4', 'founder-4');
    seedBotPoolEntry({
      botUsername: 'a_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(0),
    });
    seedBotPoolEntry({
      botUsername: 'b_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(1000),
    });

    // Distinct founders so same-founder-preference is a no-op; round-robin
    // distribution should emerge from pure least-loaded.
    assignNextAvailableBot('ag-1', 'founder-1');
    assignNextAvailableBot('ag-2', 'founder-2');
    assignNextAvailableBot('ag-3', 'founder-3');
    assignNextAvailableBot('ag-4', 'founder-4');

    expect(countAssignmentsForBot('a_bot')).toBe(2);
    expect(countAssignmentsForBot('b_bot')).toBe(2);
  });

  it('FIFO tiebreaks when load is equal (oldest created_at wins)', () => {
    seedAgentGroup('ag-1');
    seedBotPoolEntry({
      botUsername: 'younger_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(1000),
    });
    seedBotPoolEntry({
      botUsername: 'older_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(0),
    });
    expect(assignNextAvailableBot('ag-1')?.bot_username).toBe('older_bot');
  });

  it('same-founder preference: founder with 2 companies on a 2-bot pool gets different bots', () => {
    seedAgentGroup('ag-A', 'founder-1');
    seedAgentGroup('ag-B', 'founder-1'); // same founder
    seedBotPoolEntry({
      botUsername: 'bot_one',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(0),
    });
    seedBotPoolEntry({
      botUsername: 'bot_two',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(1000),
    });

    const first = assignNextAvailableBot('ag-A', 'founder-1');
    const second = assignNextAvailableBot('ag-B', 'founder-1');
    expect(first?.bot_username).not.toBe(second?.bot_username);
  });

  it('same-founder preference falls back when every bot already serves the founder', () => {
    // 1 bot, founder spawns 2 companies → second has no preference-
    // compliant choice. Best-effort: assign anyway (the DM collapse
    // is the operator's problem to communicate, not a failure mode).
    seedAgentGroup('ag-A', 'solo-founder');
    seedAgentGroup('ag-B', 'solo-founder');
    seedBotPoolEntry({
      botUsername: 'only_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: NOW,
    });
    expect(assignNextAvailableBot('ag-A', 'solo-founder')?.bot_username).toBe('only_bot');
    expect(assignNextAvailableBot('ag-B', 'solo-founder')?.bot_username).toBe('only_bot');
    expect(countAssignmentsForBot('only_bot')).toBe(2);
  });

  it('omitted ownerUserId falls through to pure least-loaded (legacy / non-Baget callers)', () => {
    seedAgentGroup('ag-A');
    seedBotPoolEntry({
      botUsername: 'bot_one',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: NOW,
    });
    const result = assignNextAvailableBot('ag-A');
    expect(result?.bot_username).toBe('bot_one');
  });

  it('idempotent path returns existing assignment even when junction row was inserted out-of-band', () => {
    seedAgentGroup('ag-alpha');
    seedBotPoolEntry({
      botUsername: 'pre_assigned_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(0),
    });
    seedBotPoolEntry({
      botUsername: 'fresh_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(1000),
    });
    // Manually insert junction row WITHOUT going through assignNextAvailableBot.
    getDb()
      .prepare(`INSERT INTO baget_bot_pool_assignments (agent_group_id, bot_username, assigned_at) VALUES (?, ?, ?)`)
      .run('ag-alpha', 'pre_assigned_bot', NOW);

    const result = assignNextAvailableBot('ag-alpha');
    expect(result?.bot_username).toBe('pre_assigned_bot');
    // fresh_bot was not touched.
    expect(countAssignmentsForBot('fresh_bot')).toBe(0);
  });
});

describe('releaseBot', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });
  afterEach(() => closeDb());

  it('releaseBot deletes the junction row but leaves the bot active in the pool', () => {
    seedAgentGroup('ag-alpha');
    seedBotPoolEntry({
      botUsername: 'baget_alpha_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: NOW,
    });
    assignNextAvailableBot('ag-alpha');

    const released = releaseBot('ag-alpha');
    expect(released).toBe('baget_alpha_bot');

    // Bot row still present, still active.
    expect(getBotPoolEntryByUsername('baget_alpha_bot')?.retired_at).toBeNull();
    // Junction row gone.
    expect(getBotPoolEntryByAgentGroup('ag-alpha')).toBeUndefined();
    expect(countAssignmentsForBot('baget_alpha_bot')).toBe(0);
  });

  it('releaseBot of one company leaves the bot serving its other assignments', () => {
    seedAgentGroup('ag-A', 'founder-A');
    seedAgentGroup('ag-B', 'founder-B');
    seedBotPoolEntry({
      botUsername: 'shared_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: NOW,
    });
    assignNextAvailableBot('ag-A', 'founder-A');
    assignNextAvailableBot('ag-B', 'founder-B');
    expect(countAssignmentsForBot('shared_bot')).toBe(2);

    releaseBot('ag-A');
    expect(countAssignmentsForBot('shared_bot')).toBe(1);
    expect(getBotPoolEntryByAgentGroup('ag-B')?.bot_username).toBe('shared_bot');
  });

  it('releaseBot is a no-op (returns null) for groups without an assignment', () => {
    expect(releaseBot('ag-never-assigned')).toBeNull();
  });

  it('hard DELETE of agent_group cascades through the junction (replaces the orphan trigger)', () => {
    seedAgentGroup('ag-alpha');
    seedBotPoolEntry({
      botUsername: 'baget_alpha_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: NOW,
    });
    assignNextAvailableBot('ag-alpha');
    expect(countAssignmentsForBot('baget_alpha_bot')).toBe(1);

    getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run('ag-alpha');

    // Junction row cascaded; bot stays active.
    expect(countAssignmentsForBot('baget_alpha_bot')).toBe(0);
    expect(getBotPoolEntryByUsername('baget_alpha_bot')?.retired_at).toBeNull();
    // Active bot still pickable for a new group.
    seedAgentGroup('ag-new');
    expect(assignNextAvailableBot('ag-new')?.bot_username).toBe('baget_alpha_bot');
  });
});

describe('observability + lookup helpers', () => {
  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });
  afterEach(() => closeDb());

  it('countActiveBots = number of ACTIVE bots in the pool (not "free slots")', () => {
    expect(countActiveBots()).toBe(0);
    seedBotPoolEntry({
      botUsername: 'a_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: NOW,
    });
    seedBotPoolEntry({
      botUsername: 'b_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: nowIso(1000),
    });
    expect(countActiveBots()).toBe(2);

    // N:1 — assigning a group to a bot does NOT consume the bot.
    seedAgentGroup('ag-alpha');
    assignNextAvailableBot('ag-alpha');
    expect(countActiveBots()).toBe(2);

    // Retiring DOES drop the count.
    getDb().prepare(`UPDATE baget_bot_pool SET retired_at = ? WHERE bot_username = ?`).run(nowIso(2000), 'a_bot');
    expect(countActiveBots()).toBe(1);
  });

  it('getBotPoolEntryByAgentGroup returns the assigned row via the junction JOIN', () => {
    seedAgentGroup('ag-alpha');
    seedBotPoolEntry({
      botUsername: 'a_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: NOW,
    });
    assignNextAvailableBot('ag-alpha');

    const row = getBotPoolEntryByAgentGroup('ag-alpha');
    expect(row?.bot_username).toBe('a_bot');
    expect(row?.retired_at).toBeNull();
  });

  it('getBotPoolEntryByAgentGroup returns undefined when no assignment exists', () => {
    expect(getBotPoolEntryByAgentGroup('ag-never-assigned')).toBeUndefined();
  });

  it('markWebhookRegistered stamps the timestamp', () => {
    seedBotPoolEntry({
      botUsername: 'a_bot',
      botTokenValue: 't',
      webhookSecret: 's',
      createdAt: NOW,
    });
    expect(getBotPoolEntryByUsername('a_bot')?.webhook_registered_at).toBeNull();
    markWebhookRegistered('a_bot', nowIso(500));
    expect(getBotPoolEntryByUsername('a_bot')?.webhook_registered_at).toBe(nowIso(500));
  });
});
