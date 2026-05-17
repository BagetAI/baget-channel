/**
 * Baget Telegram bot-pool helpers — see migration 016 (initial pool) +
 * migration 020 (N:1 switch) for the schema + design context.
 *
 * Pool model: **N companies per bot.** A single Telegram bot can sit in
 * unlimited group chats, with `messaging_group_agents` routing each
 * `chat_id` to its owning `agent_group`. The legacy 1:1 model treated
 * the pool as a capacity-capped resource; the N:1 model treats it as a
 * load-distribution + branding resource where every active bot is
 * eligible to take new assignments.
 *
 * Lifecycle (per bot row):
 *
 *   seedBotPoolEntry()    — operator inserts via /baget/bot-pool/seed,
 *                           or the boot-time env-var seeder reads
 *                           BAGET_BOT_POOL_SEED_JSON. Row lands with
 *                           retired_at=NULL (active in rotation).
 *   assignNextAvailableBot(agentGroupId, ownerUserId?)
 *                          — bind handler creates a junction row
 *                            linking agent_group → bot. Picks the
 *                            least-loaded active bot, preferring one
 *                            that doesn't already serve any of the
 *                            same founder's other companies (best-
 *                            effort same-founder split). Returns the
 *                            bot row.
 *   markWebhookRegistered(username, ts)
 *                          — first-bind-only: records that Telegram
 *                            accepted setWebhook for this URL.
 *   getBotPoolEntryByAgentGroup(agentGroupId)
 *                          — adapter outbound path: JOIN through the
 *                            junction to source the right token + URL.
 *                            Returns undefined for legacy (non-pool)
 *                            groups; adapter falls back to cfg.botToken.
 *   getBotPoolEntryByUsername(username)
 *                          — webhook handler: secret-token check vs the
 *                            per-bot stored secret. Routing to a
 *                            specific agent_group happens downstream
 *                            via `chat_id` → `messaging_group_agents`.
 *   releaseBot(agentGroupId)
 *                          — disconnect handler: DELETEs the junction
 *                            row. Bot stays in pool with no status
 *                            change — it's still serving its other
 *                            assignments. Returns the username for log
 *                            lines.
 *   countActiveBots()    — "how many bots are eligible for new
 *                             assignments" (retired_at IS NULL). Used
 *                             by observability + the 503 gate.
 *
 * Concurrency: assignment is wrapped in `getDb().transaction(...)`. The
 * junction's PK on `agent_group_id` makes a SECOND parallel assign for
 * the same group race-safe — the loser hits SQLITE_CONSTRAINT_PRIMARYKEY
 * and falls through to re-read the winner. Two parallel assigns for
 * DIFFERENT agent_groups can land on the same or different bots; both
 * are valid in N:1.
 *
 * Logging discipline:
 *   `bot_token_value` and `webhook_secret` are SECRETS. Helper
 *   signatures intentionally omit them from any debug-friendly return
 *   shape unless a caller specifically needs the value (assign, get,
 *   webhook-handler lookup). NEVER include either in error messages,
 *   log fields, or telemetry breadcrumbs.
 */
import { getDb } from './connection.js';

export interface BotPoolRow {
  bot_username: string;
  bot_token_value: string;
  webhook_secret: string;
  webhook_registered_at: string | null;
  created_at: string;
  /** Non-NULL when the operator retired the bot. Retired bots keep
   *  serving their existing assignments but are skipped by
   *  `assignNextAvailableBot` for new ones. */
  retired_at: string | null;
  /** Provenance — `'admin'` for rows inserted via `POST /baget/bot-pool/seed`,
   *  `'env'` for rows inserted by the boot-time `BAGET_BOT_POOL_SEED_JSON`
   *  self-seeder. Default `'admin'` per migration #019, so legacy rows
   *  needed no back-fill. The tag records the FIRST insert path; rotation
   *  by the other path leaves the tag alone. */
  source: 'admin' | 'env';
}

/**
 * Column list for SELECTs that return a `BotPoolRow`. Prefixed with
 * `b.` so the same string works in both bare SELECTs from
 * `baget_bot_pool b` and JOINs against `baget_bot_pool_assignments`
 * (which also has a `bot_username` column — bare names would be
 * ambiguous under JOIN).
 */
const BOT_ROW_COLS =
  'b.bot_username, b.bot_token_value, b.webhook_secret, b.webhook_registered_at, b.created_at, b.retired_at, b.source';

/**
 * Outcome of `seedBotPoolEntry`. `inserted` means a brand-new pool
 * row landed; `rotated` means the username was already known and we
 * UPDATEd `bot_token_value` + `webhook_secret` (the @BotFather
 * token-rotation flow). The seed admin endpoint surfaces these as
 * counts so the operator can tell which bots needed rotation.
 *
 * IMPORTANT: rotation does NOT touch `retired_at`,
 * `webhook_registered_at`, or `created_at`. A retired bot whose token
 * rotates stays retired; an active bot stays active and its existing
 * assignments seamlessly continue once the new token propagates.
 */
export type SeedOutcome = 'inserted' | 'rotated';

export type SeedSource = 'admin' | 'env';

/**
 * Upsert a bot into the pool. Caller validates the token via
 * Telegram `getMe` before calling this — we trust the supplied
 * `botUsername` matches the token at insert time.
 *
 * Idempotent on the username PK with sane rotation semantics:
 *
 *   - First seed of a username → INSERT a fresh active row
 *     (retired_at=NULL). Returns `'inserted'`.
 *
 *   - Re-seed of an existing username → UPDATE the credentials
 *     (`bot_token_value`, `webhook_secret`) only. `retired_at` and
 *     `webhook_registered_at` are preserved. Returns `'rotated'`.
 */
export function seedBotPoolEntry(args: {
  botUsername: string;
  botTokenValue: string;
  webhookSecret: string;
  createdAt: string;
  /** Optional — defaults to `'admin'` for back-compat with all
   *  existing callers (the operator POST route). The env-var
   *  self-seeder added in PR #56 passes `'env'` so a debugging
   *  operator can tell at a glance which channel inserted each row. */
  source?: SeedSource;
}): SeedOutcome {
  const db = getDb();
  const source: SeedSource = args.source ?? 'admin';
  return db.transaction((): SeedOutcome => {
    const existed = db.prepare('SELECT 1 AS one FROM baget_bot_pool WHERE bot_username = ?').get(args.botUsername) as
      | { one: number }
      | undefined;
    // On rotation we deliberately DO NOT touch `source` — a row that
    // came in via the admin POST stays tagged 'admin' even when the
    // env-var seeder later refreshes its token (and vice-versa). The
    // tag records "where did this entry first arrive?", not "what was
    // the most recent write?". Flipping it on rotation would make the
    // debugging signal noisy.
    db.prepare(
      `INSERT INTO baget_bot_pool
         (bot_username, bot_token_value, webhook_secret, webhook_registered_at, created_at, source, retired_at)
       VALUES (?, ?, ?, NULL, ?, ?, NULL)
       ON CONFLICT(bot_username) DO UPDATE SET
         bot_token_value = excluded.bot_token_value,
         webhook_secret  = excluded.webhook_secret`,
    ).run(args.botUsername, args.botTokenValue, args.webhookSecret, args.createdAt, source);
    return existed ? 'rotated' : 'inserted';
  })();
}

/**
 * Assign a pool bot to an agent_group. Returns the bot row, or null
 * if the pool has zero active bots (retired_at IS NULL) — which is
 * the only path that surfaces 'pool_exhausted' upstream in N:1.
 *
 * Re-entrancy: if `agentGroupId` already has a junction row, returns
 * the existing bot (idempotent). Same posture as the 1:1 era.
 *
 * Assignment policy:
 *   - **Step A — same-founder preference.** If `ownerUserId` is
 *     supplied, prefer a bot that doesn't already serve any of this
 *     founder's other companies. Mitigates the "Telegram (bot, user)
 *     → one DM" collapse for founders who run multiple companies on
 *     the platform.
 *   - **Step B — least-loaded.** Among the candidates after step A,
 *     pick the bot with the fewest current assignments.
 *   - **Step C — FIFO tiebreak.** Same load → oldest `created_at`
 *     first. Preserves operator's seeding order as a stable signal.
 *
 * All three are baked into a single ORDER BY so SQLite returns the
 * winner in one query.
 *
 * Concurrency:
 *   The host runs as a single Node process; better-sqlite3
 *   transactions serialize synchronously, so two parallel calls into
 *   this function from the same process can never overlap the
 *   SELECT-then-INSERT pair. The PK on `agent_group_id` is the
 *   second-line guarantee for any cross-process race (or operator
 *   manual INSERT): the loser catches `SQLITE_CONSTRAINT_PRIMARYKEY`
 *   and re-reads the winner's assignment.
 */
export function assignNextAvailableBot(agentGroupId: string, ownerUserId?: string): BotPoolRow | null {
  const db = getDb();
  return db.transaction((): BotPoolRow | null => {
    // 0. Idempotency: if a junction row already exists, return that bot.
    const existing = db
      .prepare(
        `SELECT ${BOT_ROW_COLS}
           FROM baget_bot_pool b
           INNER JOIN baget_bot_pool_assignments a ON a.bot_username = b.bot_username
          WHERE a.agent_group_id = ?`,
      )
      .get(agentGroupId) as BotPoolRow | undefined;
    if (existing) return existing;

    // 1. Pick the winner per the policy in the doc-comment. The
    //    `ag.user_id = ?` predicate inside the SUM short-circuits to 0
    //    for any row that doesn't match — passing NULL for ownerUserId
    //    (legacy callers that don't supply it) makes the entire SUM
    //    zero for every bot, which collapses step A into a no-op and
    //    falls through to pure least-loaded behavior.
    //
    //    The `ag.archived_at IS NULL` clause in the JOIN-ON ensures
    //    archived agent_groups don't poison the same-founder count.
    //    Today, `releaseBot` runs atomically with archive, so phantom
    //    junction-rows-for-archived-groups don't happen on the happy
    //    path. The filter is defense-in-depth for any future code
    //    path that archives without releasing (cleanup jobs, manual
    //    operator queries).
    const candidate = db
      .prepare(
        `SELECT b.bot_username
           FROM baget_bot_pool b
           LEFT JOIN baget_bot_pool_assignments a ON a.bot_username = b.bot_username
           LEFT JOIN agent_groups ag
             ON ag.id = a.agent_group_id AND ag.archived_at IS NULL
          WHERE b.retired_at IS NULL
          GROUP BY b.bot_username
          ORDER BY (SUM(CASE WHEN ag.user_id = ? THEN 1 ELSE 0 END) > 0) ASC,
                   COUNT(a.agent_group_id) ASC,
                   b.created_at ASC
          LIMIT 1`,
      )
      .get(ownerUserId ?? null) as { bot_username: string } | undefined;
    if (!candidate) return null;

    // 2. Insert the junction row. On a SQLITE_CONSTRAINT_PRIMARYKEY
    //    race (another caller wrote the same agent_group_id between
    //    step 0 and step 2), re-read and return the winner.
    const assignedAt = new Date().toISOString();
    try {
      db.prepare(
        `INSERT INTO baget_bot_pool_assignments (agent_group_id, bot_username, assigned_at)
         VALUES (?, ?, ?)`,
      ).run(agentGroupId, candidate.bot_username, assignedAt);
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const raced = db
          .prepare(
            `SELECT ${BOT_ROW_COLS}
               FROM baget_bot_pool b
               INNER JOIN baget_bot_pool_assignments a ON a.bot_username = b.bot_username
              WHERE a.agent_group_id = ?`,
          )
          .get(agentGroupId) as BotPoolRow | undefined;
        if (raced) return raced;
      }
      throw err;
    }

    // 3. Read back the assigned bot row.
    return db
      .prepare(`SELECT ${BOT_ROW_COLS} FROM baget_bot_pool b WHERE b.bot_username = ?`)
      .get(candidate.bot_username) as BotPoolRow;
  })();
}

/**
 * Release the agent_group's assignment back to the pool. Called by the
 * disconnect handlers after the agent_group is archived + chats are
 * unbound.
 *
 * In N:1 this is a junction-row DELETE. The bot row stays in the pool
 * (it may still have other assignments). Returns the username that
 * was released (for logging) or null if the agent_group had no
 * assignment (legacy / Vela pairings never went through pool
 * assignment).
 *
 * Webhook stays registered. Telegram's setWebhook semantics allow
 * idempotent re-set; the cost of "leaving" the registration is one
 * orphan URL on Telegram's side until the next bind for that bot
 * lands (and even then, we register-once and skip if
 * webhook_registered_at is non-null). On operator bot retirement,
 * Telegram's bot deletion is the authoritative cleanup.
 */
export function releaseBot(agentGroupId: string): string | null {
  const db = getDb();
  return db.transaction((): string | null => {
    const row = db
      .prepare(`SELECT bot_username FROM baget_bot_pool_assignments WHERE agent_group_id = ?`)
      .get(agentGroupId) as { bot_username: string } | undefined;
    if (!row) return null;
    // The SELECT above and this DELETE run inside the same
    // transaction on the single-process better-sqlite3 handle, so
    // the DELETE cannot return changes !== 1 after a successful read
    // (no concurrent writer can drop the row in between).
    db.prepare(`DELETE FROM baget_bot_pool_assignments WHERE agent_group_id = ?`).run(agentGroupId);
    return row.bot_username;
  })();
}

/**
 * Lookup by agent_group. Returns undefined when this group has no
 * pool assignment — the adapter then falls back to cfg.botToken
 * (legacy / Vela path).
 */
export function getBotPoolEntryByAgentGroup(agentGroupId: string): BotPoolRow | undefined {
  return getDb()
    .prepare(
      `SELECT ${BOT_ROW_COLS}
         FROM baget_bot_pool b
         INNER JOIN baget_bot_pool_assignments a ON a.bot_username = b.bot_username
        WHERE a.agent_group_id = ?`,
    )
    .get(agentGroupId) as BotPoolRow | undefined;
}

/**
 * Lookup by username. The per-bot webhook route (`/api/channels/
 * telegram/bot/:botUsername/webhook`) uses this to verify the
 * incoming `X-Telegram-Bot-Api-Secret-Token` against the stored
 * `webhook_secret`. In N:1 the bot may be serving multiple
 * agent_groups — chat routing happens downstream via the `chat_id`
 * → `messaging_group_agents` mapping.
 */
export function getBotPoolEntryByUsername(botUsername: string): BotPoolRow | undefined {
  return getDb().prepare(`SELECT ${BOT_ROW_COLS} FROM baget_bot_pool b WHERE b.bot_username = ?`).get(botUsername) as
    | BotPoolRow
    | undefined;
}

/**
 * Register-once gate: stamp `webhook_registered_at` after Telegram
 * accepts the setWebhook call. The bind handler reads
 * `webhook_registered_at` first; if non-null, skip the API call
 * because the URL has the (immutable) username and won't change.
 */
export function markWebhookRegistered(botUsername: string, registeredAt: string): void {
  getDb()
    .prepare(`UPDATE baget_bot_pool SET webhook_registered_at = ? WHERE bot_username = ?`)
    .run(registeredAt, botUsername);
}

/**
 * Count bots eligible for new assignments. In N:1 this is just "how
 * many active bots are in the pool" — not "how many free slots."
 * Used by the bind handler to surface `503 pool_exhausted` cleanly
 * when zero active bots exist (the pool was never seeded, or every
 * bot was retired).
 */
export function countActiveBots(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM baget_bot_pool WHERE retired_at IS NULL`).get() as {
    n: number;
  };
  return row.n;
}

/**
 * Total pool size including retired rows. Distinct from
 * `countActiveBots` because the env-var self-seeder gate keys on
 * "is the table EMPTY?", not "are there any ACTIVE bots?". An
 * operator who retired every bot still has rows in the table; the
 * self-seeder must not silently insert duplicates on top of them.
 */
export function countBotPoolEntries(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM baget_bot_pool`).get() as { n: number };
  return row.n;
}

/**
 * Per-bot assignment count. Surfaced in the admin export so operators
 * can see at a glance which pool bots are heavily loaded vs idle.
 * Replaces the old export's `_meta.assignedAgentGroupId` field (which
 * could only carry one value and is meaningless in N:1).
 */
export function countAssignmentsForBot(botUsername: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM baget_bot_pool_assignments WHERE bot_username = ?`)
    .get(botUsername) as { n: number };
  return row.n;
}

/**
 * Full-pool dump for the `GET /baget/bot-pool/export` admin route. The
 * export is the recovery artifact the operator stashes after each seed
 * so a lost-volume scenario can be restored from JSON without bouncing
 * back to BotFather for token retrieval. Includes secrets — the route
 * is bearer-gated like every other admin endpoint.
 *
 * Ordered by `created_at ASC` so a side-by-side diff of two exports
 * highlights what changed (rotated tokens stay in place, new rows
 * appear at the end).
 */
export function listAllBotPoolEntries(): BotPoolRow[] {
  return getDb()
    .prepare(`SELECT ${BOT_ROW_COLS} FROM baget_bot_pool b ORDER BY b.created_at ASC`)
    .all() as BotPoolRow[];
}
