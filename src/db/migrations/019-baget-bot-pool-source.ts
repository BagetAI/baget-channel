/**
 * Tag bot-pool rows with the channel they came in through, so a debugging
 * operator can tell at a glance whether a row was inserted by the admin
 * `POST /baget/bot-pool/seed` route or by the boot-time
 * `BAGET_BOT_POOL_SEED_JSON` env-var seeder added in this PR.
 *
 * Why this matters: when the SQLite volume is ever lost or replaced and
 * the env-var seeder rebuilds the pool from scratch, you want to be able
 * to confirm "yes, this is the env-seeded set, not a stale admin POST"
 * without grepping through deploy logs. Saved real time on similar
 * issues per the baget-backend-engineer review (2026-05-07).
 *
 * Default `'admin'` so existing rows don't need a back-fill — they all
 * came in through the admin POST before this column existed.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration019: Migration = {
  version: 19,
  name: 'baget-bot-pool-source',
  up: (db: Database.Database) => {
    db.exec(`
      ALTER TABLE baget_bot_pool
        ADD COLUMN source TEXT NOT NULL DEFAULT 'admin'
        CHECK (source IN ('admin', 'env'));
    `);
  },
};
