/**
 * Baget pairing tables — supports the single-shared-bot, multi-founder
 * routing model documented in BAGET-DEPLOY.md.
 *
 * Three additive pieces:
 *
 *   1. `agent_groups` — three new columns:
 *        - `user_id`     — Baget user UUID (NULL for non-Baget groups)
 *        - `company_id`  — Baget company UUID (NULL for non-Baget groups)
 *        - `archived_at` — ISO timestamp; soft-delete sentinel. The router
 *                         doesn't filter on this directly (it goes through
 *                         messaging_group_agents), but the admin DELETE
 *                         flow stamps it before unbinding so post-mortem
 *                         queries still see the group + its message
 *                         history.
 *      Backfilled `(user_id, company_id)` carries a UNIQUE index so a
 *      double-provision call can't insert a duplicate row. The renderer
 *      (src/baget-pairing.ts) is already idempotent on the FOLDER name
 *      via the deterministic slug; this index is the second-line
 *      guarantee.
 *
 *   2. `baget_pairing_tokens` — single-use Telegram pairing tokens.
 *      Stored as SHA256 of the raw token (so a DB compromise doesn't leak
 *      live tokens into the pairing endpoint), with TTL + used_at fields.
 *      Consume is a CAS UPDATE: `WHERE used_at IS NULL` makes the GETDEL
 *      semantics atomic without a transaction wrapper.
 *
 *      The spec called for Redis with GETDEL, but the fork has no Redis
 *      dep upstream — adding one would block local dev and inflate the
 *      Railway plan. SQLite gives the same single-use guarantee, and at
 *      ~hundreds of pairings per day even on a busy day the table stays
 *      tiny; a sweep that drops expired rows is in baget-pairing-tokens.ts.
 *
 *   3. `baget_seen_updates` — Telegram update_id dedup. Webhooks deliver
 *      at-least-once, so the same update_id can land twice if the bot
 *      ACKs but the response packet is dropped. INSERT OR IGNORE on the
 *      PK gives "first wins" semantics. Rows expire after 24h via a
 *      sweep — Telegram's own retry window is shorter than that, so 24h
 *      is generous defense-in-depth.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'baget-pairing',
  up: (db: Database.Database) => {
    // ── 1. Extend agent_groups with Baget identity + soft-delete ──
    const cols = db.prepare("PRAGMA table_info('agent_groups')").all() as Array<{ name: string }>;
    const has = (n: string) => cols.some((c) => c.name === n);

    // Idempotent — re-running the migration on a partially-applied DB
    // (e.g. after a crash mid-rollout) is a no-op for already-added cols.
    if (!has('user_id')) {
      db.exec(`ALTER TABLE agent_groups ADD COLUMN user_id TEXT`);
    }
    if (!has('company_id')) {
      db.exec(`ALTER TABLE agent_groups ADD COLUMN company_id TEXT`);
    }
    if (!has('archived_at')) {
      db.exec(`ALTER TABLE agent_groups ADD COLUMN archived_at TEXT`);
    }
    // Per-founder team names rendered into the persona prefix at deliver
    // time. Stored as JSON because the channel adapter only ever reads
    // them as a whole (no shape-aware queries) and the value is small
    // (six short strings, < 200 bytes uncompressed). Populated by the
    // admin server on POST / refresh-prompt; NULL for non-Baget rows.
    if (!has('baget_team_members')) {
      db.exec(`ALTER TABLE agent_groups ADD COLUMN baget_team_members TEXT`);
    }

    // Partial UNIQUE: only enforce on Baget-provisioned rows. Standard
    // (non-Baget) agent_groups have NULL user_id / company_id and aren't
    // affected. This is the second-line idempotency guarantee for the
    // admin POST endpoint — even if a caller bypasses the folder-slug
    // dedup, the index will reject the duplicate at INSERT time.
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_groups_baget_user_company
        ON agent_groups(user_id, company_id)
        WHERE user_id IS NOT NULL AND company_id IS NOT NULL
    `);

    // ── 2. baget_pairing_tokens ──
    db.exec(`
      CREATE TABLE IF NOT EXISTS baget_pairing_tokens (
        token_sha256    TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL,
        company_id      TEXT NOT NULL,
        agent_group_id  TEXT NOT NULL REFERENCES agent_groups(id),
        expires_at      TEXT NOT NULL,
        used_at         TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_baget_pairing_tokens_expires
        ON baget_pairing_tokens(expires_at);
    `);

    // ── 3. baget_seen_updates ──
    db.exec(`
      CREATE TABLE IF NOT EXISTS baget_seen_updates (
        update_id  INTEGER PRIMARY KEY,
        seen_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_baget_seen_updates_seen_at
        ON baget_seen_updates(seen_at);
    `);
  },
};
