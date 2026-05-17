/**
 * Switch the bot-pool from 1:1 (one company per bot) to N:1 (each pool
 * bot serves multiple companies). Telegram permits a single bot in
 * unlimited GROUP chats — routing is by `chat_id` via
 * `messaging_group_agents` — so the previous strict 1:1 was capping
 * capacity at `COUNT(*) FROM baget_bot_pool` for no protocol reason.
 *
 * The migration:
 *   1. Creates `baget_bot_pool_assignments(agent_group_id PK, bot_username FK)`
 *      — junction table whose PK preserves the "one bot per company"
 *      invariant (a company being bound to TWO bots simultaneously
 *      WOULD break founder DMs) while dropping the inverse constraint.
 *   2. Back-fills the junction from the existing 1:1 column so no
 *      paired company loses its bot.
 *   3. Drops the orphan-release trigger from migration 017 — its job is
 *      now done by `ON DELETE CASCADE` on the junction's FK to
 *      `agent_groups(id)`.
 *   4. Drops the partial UNIQUE index `idx_bot_pool_assigned_agent_group`
 *      (its raison d'être was 1:1 enforcement) and the `status`-
 *      filtered `idx_bot_pool_available` (filter column is going away).
 *   5. Drops three now-redundant columns from `baget_bot_pool`:
 *      - `assigned_agent_group_id` → moved to the junction
 *      - `assigned_at`             → moved to the junction
 *      - `status`                  → replaced by nullable `retired_at`
 *        (NULL = active in rotation; non-NULL = retired, don't assign
 *        new groups but keep existing ones serving). The status flip
 *        between 'available' and 'assigned' was the 1:1 state machine
 *        and has no meaning in N:1.
 *   6. Adds `retired_at TEXT` and a filtered index on it for the new
 *      "active bots" query path.
 *
 * Notes on the same-founder edge case the migration-016 doc-comment
 * cited: "Telegram (bot, user) → one DM" only collapses chats when
 * ONE founder runs N companies through the same bot. The new
 * assignment logic in `assignNextAvailableBot` mitigates this best-
 * effort by preferring bots that don't already serve any of the
 * founder's other companies; complete avoidance is impossible once
 * the founder owns more companies than the pool has bots, and the
 * dashboard accepts the collapse with a warn log rather than refusing
 * to pair.
 *
 * Backward-compat for `BotPoolRow`: the three dropped columns are
 * also removed from the TypeScript type in `db/baget-bot-pool.ts`.
 * The admin export endpoint's `_meta.assignedAgentGroupId` field is
 * replaced by `_meta.assignmentCount` (number of agent_groups bound
 * to this bot) — operators who diff exports will see the rename.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration020: Migration = {
  version: 20,
  name: 'baget-bot-pool-assignments',
  up: (db: Database.Database) => {
    db.exec(`
      -- 1. Junction table. PK on agent_group_id keeps "one bot per
      --    company"; lack of UNIQUE on bot_username is what unlocks
      --    N companies sharing a bot.
      CREATE TABLE IF NOT EXISTS baget_bot_pool_assignments (
        agent_group_id TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
        bot_username   TEXT NOT NULL REFERENCES baget_bot_pool(bot_username),
        assigned_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bbpa_bot_username
        ON baget_bot_pool_assignments(bot_username);

      -- 2. Back-fill from the legacy 1:1 column. COALESCE handles rows
      --    where assigned_at was somehow NULL (defensive — the helper
      --    always stamped it, but a manual UPDATE could have left it
      --    blank). Falling back to created_at preserves ordering.
      INSERT INTO baget_bot_pool_assignments (agent_group_id, bot_username, assigned_at)
        SELECT assigned_agent_group_id, bot_username, COALESCE(assigned_at, created_at)
          FROM baget_bot_pool
         WHERE assigned_agent_group_id IS NOT NULL;

      -- 3. The orphan-release trigger from migration 017 referenced
      --    assigned_agent_group_id — we're about to drop that column,
      --    and the trigger's job (auto-release on hard-delete of
      --    agent_group) is now handled by ON DELETE CASCADE on the
      --    junction's FK. Drop it first; ALTER TABLE DROP COLUMN
      --    otherwise errors on the trigger reference.
      DROP TRIGGER IF EXISTS trg_bot_pool_release_on_orphan;

      -- 4. Drop the 1:1 partial UNIQUE and the status-filtered index.
      DROP INDEX IF EXISTS idx_bot_pool_assigned_agent_group;
      DROP INDEX IF EXISTS idx_bot_pool_available;

      -- 5. Drop the now-redundant columns. SQLite >= 3.35 supports
      --    DROP COLUMN; better-sqlite3 bundles 3.45+.
      ALTER TABLE baget_bot_pool DROP COLUMN assigned_agent_group_id;
      ALTER TABLE baget_bot_pool DROP COLUMN assigned_at;
      ALTER TABLE baget_bot_pool DROP COLUMN status;

      -- 6. Replace status with retired_at. NULL = in active rotation
      --    (eligible for new assignments). Non-NULL = retired but
      --    keep serving existing assignments. Operator flips to retire
      --    a bot before deleting it from BotFather.
      ALTER TABLE baget_bot_pool ADD COLUMN retired_at TEXT;

      -- 7. Filtered index for the active-rotation query in
      --    assignNextAvailableBot. Mirrors the shape of the old
      --    idx_bot_pool_available — sorted by created_at so the
      --    operator's FIFO order is preserved as a tiebreaker.
      CREATE INDEX IF NOT EXISTS idx_bot_pool_active
        ON baget_bot_pool(retired_at, created_at)
        WHERE retired_at IS NULL;
    `);
  },
};
