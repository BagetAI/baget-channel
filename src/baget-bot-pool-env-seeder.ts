/**
 * Boot-time bot-pool self-seeder. Reads `BAGET_BOT_POOL_SEED_JSON`,
 * parses it as `[{ botUsername, botToken, webhookSecret? }, ...]`, and
 * upserts each row via `seedBotPoolEntry()` — same code path the admin
 * `POST /baget/bot-pool/seed` route uses, just without the Telegram
 * `getMe` round-trip (we trust the operator-provided env value).
 *
 * Why this exists: Railway containers have ephemeral filesystems. Even
 * with the persistent volume on `/app/data` (added in this PR), a
 * volume corruption / replacement / fresh-environment provisioning
 * leaves the SQLite pool empty and the operator scrambling to re-POST
 * tokens. Per the baget-backend-engineer review on 2026-05-07, the
 * env-var seeder is the recovery safety-net: set the JSON once in
 * Railway, never touch it again, the pool rebuilds itself on every
 * boot if (and only if) the table is empty.
 *
 * Empty-table gate is intentional. Re-seeding on every boot would
 * (a) hit Telegram's getMe rate limits when the pool is large,
 * (b) spam the logs on every redeploy with `rotated` outcomes that
 * mean "no change", and (c) silently undo any operator-driven
 * rotations made via the admin POST after the env was set. The gate
 * means: env-var rebuild ONLY when the volume truly lost everything.
 *
 * Deliberately NO Telegram getMe verification here — the admin POST
 * route validates because a typoed token from a human paste is the
 * common failure mode there. The env var, by contrast, is set once by
 * an operator who already has working tokens in hand; the validation
 * cost (one HTTP round-trip per bot per boot, blocking startup) is
 * not worth it. If a token is bad in the env, the founder's first
 * outbound 401's, the operator notices, fixes the env, redeploys.
 *
 * NEVER throws. The seeder runs in the boot path; a malformed JSON
 * env or transient DB error must not prevent the host from coming up.
 * All failure modes log and return — the host runs with whatever pool
 * state existed before, including empty (which already returns the
 * `503 pool_exhausted` message the founder sees today).
 */
import { countBotPoolEntries, seedBotPoolEntry, type SeedOutcome } from './db/baget-bot-pool.js';
import { log } from './log.js';

interface SeedJsonEntry {
  botUsername?: unknown;
  botToken?: unknown;
  webhookSecret?: unknown;
}

export interface EnvSeedSummary {
  /** True when the env var was unset / empty — no work attempted. */
  skipped: boolean;
  /** True when the table already had rows; env seed is a no-op by design. */
  poolNonEmpty: boolean;
  /** Number of inserted rows (brand-new usernames). */
  inserted: number;
  /** Number of rotated rows (usernames already known — kept for parity
   *  with the admin route, will always be 0 under the empty-table gate
   *  but useful if the gate is ever relaxed for testing). */
  rotated: number;
  /** Per-row error reasons (malformed entry, db throw). The seeder
   *  continues past errors so a single bad row in a 30-bot env doesn't
   *  prevent the other 29 from landing. */
  errors: Array<{ index: number; reason: string }>;
}

/**
 * Generate a 32-char hex secret when the operator omits `webhookSecret`.
 * Mirrors the admin POST route's mint logic so an env-seeded pool is
 * indistinguishable from a POST-seeded one once it's in the DB.
 */
function mintWebhookSecret(): string {
  // Bun + Node both expose globalThis.crypto.getRandomValues. Using
  // Web Crypto here keeps the seeder dependency-free vs `node:crypto`
  // (which would couple this module to a runtime). 16 bytes → 32 hex
  // chars, matching the admin route.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function maybeSeedBotPoolFromEnv(envValue: string | undefined, nowIso: string): EnvSeedSummary {
  if (!envValue || envValue.trim() === '') {
    return { skipped: true, poolNonEmpty: false, inserted: 0, rotated: 0, errors: [] };
  }

  // Empty-table gate. countBotPoolEntries throws only on a hard DB
  // failure; let it propagate so the boot crashes and Railway shows a
  // healthy red instead of starting up with a silently empty pool.
  const existing = countBotPoolEntries();
  if (existing > 0) {
    log.info('Bot pool env seeder: table non-empty, skipping', { existingRows: existing });
    return { skipped: false, poolNonEmpty: true, inserted: 0, rotated: 0, errors: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(envValue);
  } catch (err) {
    log.error('Bot pool env seeder: BAGET_BOT_POOL_SEED_JSON is not valid JSON', { err: String(err) });
    return {
      skipped: false,
      poolNonEmpty: false,
      inserted: 0,
      rotated: 0,
      errors: [{ index: -1, reason: 'env_not_valid_json' }],
    };
  }
  if (!Array.isArray(parsed)) {
    log.error('Bot pool env seeder: BAGET_BOT_POOL_SEED_JSON must be a JSON array');
    return {
      skipped: false,
      poolNonEmpty: false,
      inserted: 0,
      rotated: 0,
      errors: [{ index: -1, reason: 'env_not_array' }],
    };
  }

  const summary: EnvSeedSummary = {
    skipped: false,
    poolNonEmpty: false,
    inserted: 0,
    rotated: 0,
    errors: [],
  };

  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i] as SeedJsonEntry;
    const botUsername = typeof entry?.botUsername === 'string' ? entry.botUsername.trim() : '';
    const botToken = typeof entry?.botToken === 'string' ? entry.botToken.trim() : '';
    const suppliedSecret =
      typeof entry?.webhookSecret === 'string' && entry.webhookSecret.trim() !== ''
        ? entry.webhookSecret.trim()
        : mintWebhookSecret();

    if (!botUsername) {
      summary.errors.push({ index: i, reason: 'missing_botUsername' });
      continue;
    }
    if (!botToken) {
      summary.errors.push({ index: i, reason: 'missing_botToken' });
      continue;
    }

    try {
      const outcome: SeedOutcome = seedBotPoolEntry({
        botUsername,
        botTokenValue: botToken,
        webhookSecret: suppliedSecret,
        createdAt: nowIso,
        source: 'env',
      });
      if (outcome === 'inserted') summary.inserted += 1;
      else summary.rotated += 1;
    } catch (err) {
      log.warn('Bot pool env seeder: insert failed for one row', { index: i, botUsername, err: String(err) });
      summary.errors.push({ index: i, reason: 'db_insert_failed' });
    }
  }

  log.info('Bot pool env seeder: completed', {
    inserted: summary.inserted,
    rotated: summary.rotated,
    errors: summary.errors.length,
  });
  return summary;
}
