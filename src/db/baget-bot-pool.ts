/**
 * Baget Telegram bot-pool helpers — see migration 016 for the schema
 * + design context.
 *
 * Lifecycle (per bot row):
 *
 *   seedBotPoolEntry()    — operator inserts via /baget/bot-pool/seed.
 *                           status='available', no FK, no assigned_at.
 *   assignNextAvailableBot(agentGroupId)
 *                          — bind handler picks the oldest available
 *                            row, atomically flips status→'assigned',
 *                            stamps FK + assigned_at. Returns the row
 *                            so the bind handler can register the
 *                            webhook + setMyName.
 *   markWebhookRegistered(username, ts)
 *                          — first-bind-only: records that Telegram
 *                            accepted setWebhook for this URL. Skipped
 *                            on subsequent re-binds of the same group.
 *   getBotPoolEntryByAgentGroup(agentGroupId)
 *                          — adapter outbound path: looks up the
 *                            assigned bot to source the right token +
 *                            URL. Returns undefined for legacy
 *                            (non-pool) groups; adapter falls back to
 *                            cfg.botToken.
 *   getBotPoolEntryByUsername(username)
 *                          — webhook handler: secret-token check vs
 *                            the per-bot stored secret + agent_group
 *                            routing.
 *   releaseBot(agentGroupId)
 *                          — disconnect handler: flips status back to
 *                            'available' + clears the FK so the next
 *                            bind reuses this bot. Webhook stays
 *                            registered (Telegram accepts re-set
 *                            without restart, and the URL contains
 *                            the username — immutable per pool row).
 *   countAvailableBots()    — observability + 503 gate.
 *
 * Concurrency: every state transition is a single CAS UPDATE wrapped
 * in `getDb().transaction(...)` so two parallel binds against an
 * empty pool can never both grab the same row. The non-trivial case
 * is `assignNextAvailableBot`: SELECT-then-UPDATE under WAL would
 * race, so we wrap them in one transaction and the UPDATE's WHERE
 * clause re-asserts `status = 'available'` to defeat any reader that
 * snuck in between. better-sqlite3 transactions are synchronous, so
 * the race window is bounded to actual concurrent host calls — which
 * the bind endpoint receives one-at-a-time anyway, but we don't rely
 * on that.
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
  status: 'available' | 'assigned';
  assigned_agent_group_id: string | null;
  assigned_at: string | null;
  webhook_registered_at: string | null;
  created_at: string;
}

/**
 * Insert a fresh bot into the pool. Caller validates the token via
 * Telegram `getMe` before calling this — we trust the supplied
 * `botUsername` matches the token at insert time.
 *
 * Idempotent on the username PK: re-seeding the same bot is a no-op
 * (INSERT OR IGNORE) so the operator's `/baget/bot-pool/seed` stays
 * safe to retry. Returns true on a fresh insert, false on duplicate
 * — the seed endpoint surfaces that to the operator as `skipped`.
 */
export function seedBotPoolEntry(args: {
  botUsername: string;
  botTokenValue: string;
  webhookSecret: string;
  createdAt: string;
}): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO baget_bot_pool
         (bot_username, bot_token_value, webhook_secret, status,
          assigned_agent_group_id, assigned_at, webhook_registered_at, created_at)
       VALUES (?, ?, ?, 'available', NULL, NULL, NULL, ?)`,
    )
    .run(args.botUsername, args.botTokenValue, args.webhookSecret, args.createdAt);
  return result.changes === 1;
}

/**
 * Atomic CAS assignment. Returns the bot row that was just assigned,
 * or null if the pool has no available bots.
 *
 * Re-entrancy: if `agentGroupId` already has a bot assigned, this is
 * a no-op that returns the existing row. The bind handler relies on
 * that for idempotency — second bind for the same group returns the
 * same bot, never a fresh one.
 *
 * Race protection:
 *   - The FK partial UNIQUE index guarantees one bot per agent_group.
 *     If a concurrent caller also tries to assign for the same group,
 *     the UPDATE's WHERE clause filters by `status='available'` AND
 *     the candidate `bot_username`, and the FK uniqueness check fires
 *     at COMMIT time. better-sqlite3 raises SqliteError, which we
 *     convert to a re-read of the existing assignment.
 *   - Two callers picking different agent_groups against a 1-bot pool:
 *     the SELECT + UPDATE inside the transaction — only one's UPDATE
 *     finds `status='available'` for the candidate row; the loser's
 *     UPDATE returns `changes=0` and we re-attempt up to 3 times
 *     (defense; in practice contention on a 10-bot pool is essentially
 *     zero given baget.ai's request rate).
 */
export function assignNextAvailableBot(agentGroupId: string): BotPoolRow | null {
  const db = getDb();
  return db.transaction((): BotPoolRow | null => {
    // 0. If this group already has a bot, return it (idempotent).
    const existing = db
      .prepare(
        `SELECT bot_username, bot_token_value, webhook_secret, status,
                assigned_agent_group_id, assigned_at, webhook_registered_at, created_at
           FROM baget_bot_pool
          WHERE assigned_agent_group_id = ?`,
      )
      .get(agentGroupId) as BotPoolRow | undefined;
    if (existing) return existing;

    // 1. Pick the oldest available bot. The partial filtered index
    //    `idx_bot_pool_available` makes this O(1) past the first row.
    const candidate = db
      .prepare(
        `SELECT bot_username
           FROM baget_bot_pool
          WHERE status = 'available'
          ORDER BY created_at ASC
          LIMIT 1`,
      )
      .get() as { bot_username: string } | undefined;
    if (!candidate) return null;

    // 2. CAS flip. The WHERE clause re-asserts `status='available'`
    //    AND the username match so any concurrent assign that snuck
    //    in fails this UPDATE (changes=0) — at which point we'd
    //    fall through to "no rows" semantics. A retry loop above
    //    isn't needed because better-sqlite3 transactions serialize
    //    on the same DB handle.
    const assignedAt = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE baget_bot_pool
            SET status                  = 'assigned',
                assigned_agent_group_id = ?,
                assigned_at             = ?
          WHERE bot_username = ? AND status = 'available'`,
      )
      .run(agentGroupId, assignedAt, candidate.bot_username);
    if (result.changes !== 1) return null;

    // 3. Read back the freshly-assigned row.
    return db
      .prepare(
        `SELECT bot_username, bot_token_value, webhook_secret, status,
                assigned_agent_group_id, assigned_at, webhook_registered_at, created_at
           FROM baget_bot_pool
          WHERE bot_username = ?`,
      )
      .get(candidate.bot_username) as BotPoolRow;
  })();
}

/**
 * Release the bot back to the pool. Called by the disconnect handlers
 * after the agent_group is archived + chats are unbound.
 *
 * Returns the username that was released (for logging) or null if
 * the agent_group had no bot assigned. The latter is the legacy /
 * Vela case — agent_group never went through pool assignment, so
 * there's nothing to release.
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
  const row = db
    .prepare(
      `SELECT bot_username
         FROM baget_bot_pool
        WHERE assigned_agent_group_id = ?`,
    )
    .get(agentGroupId) as { bot_username: string } | undefined;
  if (!row) return null;
  const result = db
    .prepare(
      `UPDATE baget_bot_pool
          SET status                  = 'available',
              assigned_agent_group_id = NULL,
              assigned_at             = NULL
        WHERE bot_username = ? AND assigned_agent_group_id = ?`,
    )
    .run(row.bot_username, agentGroupId);
  if (result.changes !== 1) return null;
  return row.bot_username;
}

/**
 * Lookup by agent_group. Returns undefined when this group has no
 * pool assignment — the adapter then falls back to cfg.botToken
 * (legacy / Vela path).
 */
export function getBotPoolEntryByAgentGroup(agentGroupId: string): BotPoolRow | undefined {
  return getDb()
    .prepare(
      `SELECT bot_username, bot_token_value, webhook_secret, status,
              assigned_agent_group_id, assigned_at, webhook_registered_at, created_at
         FROM baget_bot_pool
        WHERE assigned_agent_group_id = ?`,
    )
    .get(agentGroupId) as BotPoolRow | undefined;
}

/**
 * Lookup by username. The per-bot webhook route (`/api/channels/
 * telegram/bot/:botUsername/webhook`) uses this to verify the
 * incoming `X-Telegram-Bot-Api-Secret-Token` against the stored
 * `webhook_secret` and to resolve which `agent_group_id` should
 * route the update.
 */
export function getBotPoolEntryByUsername(botUsername: string): BotPoolRow | undefined {
  return getDb()
    .prepare(
      `SELECT bot_username, bot_token_value, webhook_secret, status,
              assigned_agent_group_id, assigned_at, webhook_registered_at, created_at
         FROM baget_bot_pool
        WHERE bot_username = ?`,
    )
    .get(botUsername) as BotPoolRow | undefined;
}

/**
 * Register-once gate: stamp `webhook_registered_at` after Telegram
 * accepts the setWebhook call. The bind handler reads
 * `webhook_registered_at` first; if non-null, skip the API call
 * because the URL has the (immutable) username and won't change.
 */
export function markWebhookRegistered(botUsername: string, registeredAt: string): void {
  getDb()
    .prepare(
      `UPDATE baget_bot_pool
          SET webhook_registered_at = ?
        WHERE bot_username = ?`,
    )
    .run(registeredAt, botUsername);
}

/**
 * Pool depth gauge — used by the bind handler to return
 * `503 pool_exhausted` cleanly + by the seed endpoint's response so
 * the operator sees the new total.
 */
export function countAvailableBots(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM baget_bot_pool WHERE status = 'available'`)
    .get() as { n: number };
  return row.n;
}
