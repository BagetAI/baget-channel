/**
 * Baget MCP tools — exposes founder actions on a Baget company to the
 * agent running in this container.
 *
 * All tools fan through Baget's public API (`*.baget.ai/api/...`)
 * using a per-(user, company) bearer token injected by OneCLI. The
 * container never holds raw credentials, never writes to the Baget
 * Postgres directly, and never calls third-party APIs (Apollo, Meta,
 * Resend) — every action goes through the same code path the dashboard
 * uses, which means identical auth + rate limit + tenant guard +
 * idempotency + credit deduction + audit log on both sides.
 *
 * This is the substrate the BagetAI/baget.ai team should have built
 * originally for the in-app Telegram bot. Migrating here cleans up the
 * "agent ≡ web client" property and unlocks Slack/WhatsApp/Discord for
 * free.
 *
 * Tool surface:
 *
 *   READ (6):
 *     - baget_get_company_overview
 *     - baget_query_metrics
 *     - baget_get_credits
 *     - baget_list_recent_activity
 *     - baget_list_documents
 *     - baget_read_document
 *
 *   FILE TRANSFER (1) — fetches a baget.ai-rendered artifact and ships
 *   it through nanoclaw's per-channel send pipeline. Lives here rather
 *   than next to core's `send_file` because the orchestration is
 *   baget-specific (calls /render-pdf with the channel bearer to get a
 *   blob URL, fetches the bytes, then defers to the same outbox-write
 *   pattern `send_file` uses):
 *     - baget_send_document_file
 *
 *   GENERATE (1) — produces fresh artifacts (images today; future:
 *   videos, audio) and ships them via the same outbox + attachments
 *   contract as send_document_file. Calls Gemini Image API directly
 *   with the channel-runner's existing GOOGLE_GENERATIVE_AI_API_KEY —
 *   intentionally bypasses baget.ai's auth/audit/credit rail because
 *   image generation is conversational scratchwork (mockup, "what
 *   could this look like" exploration), not a saved-asset write. If
 *   the founder wants the image as a saved brand asset, point them at
 *   the dashboard's image flow which goes through the worker:
 *     - baget_generate_image
 *
 *   WRITE — direct (free, immediate; calls /approval/execute):
 *     - baget_set_direction
 *     - baget_update_metric
 *     - baget_archive_metric
 *     - baget_add_metric_history
 *     - baget_set_metric_target
 *     - baget_add_task
 *     - baget_park_task
 *     - baget_cancel_running_tasks
 *     - baget_approve_pending
 *     - baget_reject_pending
 *     - baget_pause_ad
 *     - baget_resume_ad
 *
 *   WRITE — approval-gated (founder must tap ✅ on the channel UI;
 *   action runs only after approval):
 *     - baget_launch_batch
 *     - baget_edit_document
 *     - baget_reveal_prospect
 *     - baget_send_campaign
 *
 * For approval-gated tools, the wrapper:
 *   1. Calls /approval/preview to compute cost + render context
 *   2. Returns a "approval-pending — show the cost + summary, ask the
 *      founder to confirm by replying yes" structured response
 *   3. The agent's NEXT turn (after founder confirms) calls
 *      /approval/execute to actually run the action.
 *
 * NanoClaw doesn't have a native inline-keyboard primitive across all
 * channels (Telegram has it, Slack has blocks, Discord has buttons,
 * WhatsApp has neither). Using a "natural confirmation" turn keeps the
 * approval flow channel-agnostic. Phase 4 may add per-channel rich UI
 * via channel adapter capabilities.
 */
import fs from 'fs';
import path from 'path';

import { writeMessageOut } from '../db/messages-out.js';
import { workspaceOutboxDir } from '../workspace-paths.js';
import { generateImageBytes, type AspectRatio, type GenerateImageDeps } from './image-gen.js';
import { generateId, resolveRouting } from './core.js';
import { htmlToMarkdown, looksLikeHtml } from './html-to-markdown.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools/baget] ${msg}`);
}

// ── Configuration ─────────────────────────────────────────────────────────────

function getBagetApiBase(): string {
  return process.env.BAGET_API_BASE_URL ?? 'https://stg-app.baget.ai';
}

function getChannelToken(): string | null {
  return process.env.BAGET_CHANNEL_TOKEN ?? null;
}

/**
 * Host-callback token for `/approval/confirm` — separate from the
 * per-(user, company) channel token because confirm is a privileged
 * "the founder DID tap approve" assertion that the apps/web side
 * gates with a shared secret. PR #462 (apps/web) added the
 * `BAGET_CHANNEL_APPROVAL_CALLBACK_TOKEN` requirement; the fork
 * picks it up here so dispatchApproval(confirmed:true) can mint
 * the approvalToken JWT it then passes to /approval/execute.
 *
 * Sam 2026-05-06 staging smoke: dispatchApproval was using the
 * per-company channel token for confirm and the route threw
 * `BAGET_CHANNEL_APPROVAL_CALLBACK_TOKEN is not set` (caught by
 * the empty catch → 500 → "There was an issue running that task").
 */
function getApprovalCallbackToken(): string | null {
  return process.env.BAGET_APPROVAL_CALLBACK_TOKEN ?? null;
}

function getCompanyId(): string | null {
  return process.env.BAGET_COMPANY_ID ?? null;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

interface BagetFetchArgs {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /**
   * Per-call abort timeout (ms). Defaults to 15s — fine for the read +
   * approval/execute paths which return promptly. Override for routes
   * that do real work server-side (render-pdf does pdfkit cold-import +
   * markdown rendering + a Vercel Blob upload, easily 25-30s on a cold
   * lambda). Caller sets `timeoutMs` to give themselves enough budget.
   */
  timeoutMs?: number;
  /**
   * Override the bearer token. Defaults to the channel token (per-
   * (user, company) bearer minted at pair-time). Set to
   * `'approval-callback'` for `/approval/confirm` which requires the
   * shared `BAGET_APPROVAL_CALLBACK_TOKEN` host secret instead.
   */
  authToken?: 'channel' | 'approval-callback';
}

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

interface BagetFetchOk<T> {
  ok: true;
  status: number;
  data: T;
}

interface BagetFetchErr {
  ok: false;
  status: number;
  error: string;
}

async function bagetFetch<T = unknown>(args: BagetFetchArgs): Promise<BagetFetchOk<T> | BagetFetchErr> {
  const tokenKind = args.authToken ?? 'channel';
  const token =
    tokenKind === 'approval-callback'
      ? getApprovalCallbackToken()
      : getChannelToken();
  if (!token) {
    return {
      ok: false,
      status: 0,
      error:
        tokenKind === 'approval-callback'
          ? 'BAGET_APPROVAL_CALLBACK_TOKEN missing. The fork can\'t authenticate /approval/confirm without it. Set it on Railway baget-channel staging/prod env to the same value as Vercel\'s BAGET_CHANNEL_APPROVAL_CALLBACK_TOKEN.'
          : 'BAGET_CHANNEL_TOKEN missing. Container is not authenticated to baget.ai. Re-pair the channel from the Baget dashboard.',
    };
  }

  const base = getBagetApiBase();
  const url = `${base.replace(/\/$/, '')}${args.path}`;
  const res = await fetch(url, {
    method: args.method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: args.body ? JSON.stringify(args.body) : undefined,
    signal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
  });

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const errMsg =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
    return { ok: false, status: res.status, error: errMsg };
  }

  return { ok: true, status: res.status, data: data as T };
}

// ── Result helpers ────────────────────────────────────────────────────────────

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function fail(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function requireCompanyId(): { ok: true; companyId: string } | { ok: false; error: string } {
  const companyId = getCompanyId();
  if (!companyId) {
    return {
      ok: false,
      error: 'BAGET_COMPANY_ID not set. This container is not bound to a company. Check the agent group config.',
    };
  }
  return { ok: true, companyId };
}

/**
 * Build a `?key=value&key2=value2` query string from `args`, including
 * only the keys that are defined and casting values to strings via
 * `String(...)`.
 *
 * Why this helper exists: the Tier 2 read tools each had the same
 * 5-line pattern — `new URLSearchParams()`, `if (args.x !== undefined)
 * sp.set('x', String(args.x))` ×N, then `sp.toString()` — repeated
 * across listContacts / exportContacts / listProspectSearches /
 * getProspectSearchLeads / readAdMetrics. Gemini medium on PR #51
 * flagged the dup. Centralizing here also gives us one place to add
 * future query-string concerns (e.g., URL-length capping, key
 * canonicalization) if they come up.
 *
 * Returns `'?key=value&...'` when at least one key is set, else `''`.
 * The empty-string branch is important so callers can do
 * `path: \`/api/.../foo${q}\`` without a trailing `?`.
 *
 * `defaults` are always-set pairs (e.g., `format: 'json'` for
 * exportContacts). They go in first so `args` overrides them.
 */
function buildQueryString(
  args: Record<string, unknown>,
  keys: readonly string[],
  defaults?: Record<string, string>,
): string {
  const sp = new URLSearchParams(defaults ?? {});
  for (const key of keys) {
    if (args[key] !== undefined) sp.set(key, String(args[key]));
  }
  const q = sp.toString();
  return q ? `?${q}` : '';
}

// ── Action dispatch helpers ──────────────────────────────────────────────────

/**
 * Direct dispatch — fire /approval/execute immediately, return the
 * server-rendered `messageForFounder` so the agent can echo it.
 *
 * Use for free, idempotent, non-destructive write actions where there's
 * no card flow.
 */
async function dispatchDirect(args: { action: string; payload: Record<string, unknown>; fallbackMessage: string }) {
  const ctx = requireCompanyId();
  if (!ctx.ok) return fail(ctx.error);

  const result = await bagetFetch<{ ok: boolean; messageForFounder?: string; kind?: string }>({
    method: 'POST',
    path: `/api/companies/${ctx.companyId}/approval/execute`,
    body: { action: args.action, payload: args.payload },
  });
  if (!result.ok) return fail(`${args.action} failed: ${result.error}`);

  const msg = result.data.messageForFounder ?? args.fallbackMessage;
  return ok(msg);
}

/**
 * Approval dispatch — fire /approval/preview to compute cost, return a
 * structured "approval-pending" message the agent can show. The
 * AGENT'S NEXT TURN calls this same tool with confirmed=true, which
 * fires /approval/execute.
 *
 * Why a 2-turn flow vs an inline keyboard:
 *   - NanoClaw is channel-agnostic — no shared inline-button primitive
 *     across Telegram/Slack/Discord/WhatsApp.
 *   - The agent's natural-language ask ("This will cost ~5 credits.
 *     Want me to proceed? Reply 'yes' or 'no'.") works on every
 *     channel and is auditable in the chat history.
 *   - The model handles the confirm flow with system-prompt rules in
 *     setup/baget-template/CLAUDE.md (look for "approval card").
 *   - Phase 4: per-channel rich UI via adapter capabilities.
 */
// Sam 2026-05-06 S-10 retest: tapping ✅ Approve produced
// "Error: run-task execute failed: approval-required". Root cause:
// PR #462 (apps/web) added a 3-step approval flow:
//   1. POST /approval/preview  → returns { cost, approval: { requestId, expiresAt } }
//   2. POST /approval/confirm  → returns { approvalToken } (mints a JWT proof)
//   3. POST /approval/execute  → REQUIRES `approvalToken` in body, else 403 approval-required
// The fork's dispatchApproval was only doing 1 and 3, dropping the
// requestId from the preview response and skipping confirm. Every
// approval-gated action (run-task, launch-batch, edit-document,
// reveal-prospect, send-campaign) was therefore unrunnable end-to-end.
//
// Cache keyed by `companyId|action|<canonical payload>`. The LLM
// is instructed to pass the IDENTICAL payload on confirmed:true,
// so the cache hits. TTL is 5 min (matches the approval-request
// expiry).
//
// Hardening (Gemini medium on PR #44):
//   1. **Memory leak fix**: every read/write sweeps expired entries
//      so a series of preview-only / no-tap calls (e.g. founder
//      dismisses the card, network drop) can't grow the Map
//      unbounded over a long-running process. Sweep is O(N) but N
//      is bounded by founder activity (5-min TTL × concurrent
//      agents = ~tens at most), and only fires on cache touch, not
//      on a timer — keeps the agent-runner deterministic.
//   2. **Canonical key fix**: `JSON.stringify` order depends on
//      object construction order. The LLM nominally sends the
//      identical payload, but defense-in-depth: serialize via a
//      sorted-key replacer so `{a:1, b:2}` and `{b:2, a:1}` map to
//      the same cache slot.
//
// Process-local Map is safe — agent-runner is single-process per
// company, container restart loses pending approvals (founder
// re-issues the request; 5-min TTL was already a soft contract).
interface PendingApproval {
  requestId: string;
  expiresAtMs: number;
}
const pendingApprovals = new Map<string, PendingApproval>();

function canonicalizePayload(payload: Record<string, unknown>): string {
  // Sorted-key serialization. Recurse into nested objects so
  // `{outer: {b:2, a:1}}` and `{outer: {a:1, b:2}}` produce the
  // same string. Arrays preserve order (semantically meaningful).
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === 'object') {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = sortKeys((value as Record<string, unknown>)[k]);
      }
      return sorted;
    }
    return value;
  };
  return JSON.stringify(sortKeys(payload));
}

function approvalCacheKey(companyId: string, action: string, payload: Record<string, unknown>): string {
  return `${companyId}|${action}|${canonicalizePayload(payload)}`;
}

function sweepExpiredApprovals(): void {
  const now = Date.now();
  for (const [key, entry] of pendingApprovals) {
    if (entry.expiresAtMs < now) pendingApprovals.delete(key);
  }
}

async function dispatchApproval(args: {
  action: string;
  payload: Record<string, unknown>;
  confirmed: boolean;
  summary: string;
}) {
  const ctx = requireCompanyId();
  if (!ctx.ok) return fail(ctx.error);

  const cacheKey = approvalCacheKey(ctx.companyId, args.action, args.payload);
  // Lazy sweep — every dispatch touch clears expired entries. Cheap
  // (O(N) over a short list) and avoids needing a separate timer
  // that would have its own lifecycle in the runtime.
  sweepExpiredApprovals();

  if (!args.confirmed) {
    // Cost preview — show the founder what they'd be approving.
    // Capture the `approval.requestId` from the response so we can
    // confirm + execute on the next call (confirmed:true).
    const preview = await bagetFetch<{
      ok: boolean;
      cost: { amount: number; remaining: number; tasksRemaining: number; disabledReason?: string };
      approval?: { required: boolean; requestId: string; expiresAt: string };
    }>({
      method: 'POST',
      path: `/api/companies/${ctx.companyId}/approval/preview`,
      body: { action: args.action, payload: args.payload },
    });
    if (!preview.ok) return fail(`${args.action} preview failed: ${preview.error}`);

    // Cache the requestId (when present) for the confirmed:true
    // re-entry. Pre-#462 deployments don't return `approval` and
    // we'll fall through to the legacy path on confirm without it.
    if (preview.data.approval?.requestId) {
      pendingApprovals.set(cacheKey, {
        requestId: preview.data.approval.requestId,
        expiresAtMs: new Date(preview.data.approval.expiresAt).getTime(),
      });
    }

    const cost = preview.data.cost;
    if (cost.disabledReason) {
      return ok(
        JSON.stringify({
          status: 'cannot-proceed',
          reason: cost.disabledReason,
          summary: args.summary,
        }),
      );
    }

    // Phase 4 v0.1: send the approval card DIRECTLY as a Telegram
    // message with inline-keyboard buttons, bypassing the LLM's
    // outbound rendering. Architecture rationale:
    //
    //   - Buttons are a UX shortcut for typing yes/no. The host's
    //     callback_query handler (in src/channels/baget-telegram.ts)
    //     synthesizes the tap as a normal "yes" / "cancel" inbound
    //     so the existing dispatchApproval(confirmed:true) re-entry
    //     path runs unchanged.
    //   - Since the LLM doesn't know about reply_markup formatting,
    //     and our prompt-shaping has been brittle, we just write the
    //     outbound row directly here.
    //   - Falls back to the legacy text-only flow when we can't
    //     resolve a Telegram destination (no session_routing yet,
    //     `to` resolution misses, etc.).
    //
    // callback_data schema: `appr:yes` / `appr:no`. No card_id —
    // the LLM keeps the payload in its conversation context, and
    // the callback_query just synthesizes a text "yes"/"cancel" the
    // model already knows how to interpret.
    const routing = resolveRouting(undefined);
    // Codex P1 on PR #40: the Baget Telegram adapter registers as
    // `baget-telegram` (`BAGET_TELEGRAM_CHANNEL_TYPE` in
    // src/channels/baget-telegram-bind.ts), so the host's
    // session_routing carries `channel_type: 'baget-telegram'`. A
    // bare `=== 'telegram'` guard never matches, so the direct-write
    // branch never ran, so approval-card buttons never reached the
    // founder. Accept both: 'telegram' (generic / non-Baget nanoclaw
    // deployments) AND 'baget-telegram' (every Baget founder pairing).
    const isTelegramChannel =
      'channel_type' in routing &&
      (routing.channel_type === 'telegram' || routing.channel_type === 'baget-telegram');
    if (isTelegramChannel && routing.platform_id) {
      const costLine =
        cost.amount > 0
          ? `Cost: ${cost.amount} credits. You have ${cost.remaining} remaining.`
          : 'Included in your plan — no extra credit charge.';
      const cardText = `${args.summary.trim()}\n\n${costLine}`;
      const replyMarkup = {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: 'appr:yes' },
            { text: '❌ Cancel', callback_data: 'appr:no' },
          ],
        ],
      };
      try {
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platform_id,
          channel_type: routing.channel_type,
          thread_id: routing.thread_id,
          content: JSON.stringify({ text: cardText, replyMarkup }),
        });
        // Tell the LLM the card has been delivered — DO NOT render
        // a second text message. Wrap the instruction in a clear
        // status the persona-handler can recognise.
        return ok(
          JSON.stringify({
            status: 'approval-card-delivered',
            summary: args.summary,
            cost: {
              amount: cost.amount,
              remaining: cost.remaining,
              tasksRemaining: cost.tasksRemaining,
            },
            note: 'The approval card has been sent to the founder via Telegram with [✅ Approve] / [❌ Cancel] inline buttons. The card IS the message — return immediately without writing additional text and await the founder\'s tap. When the founder taps a button, the host synthesizes a "yes" or "cancel" message into your inbound queue; on "yes" you call this tool again with `confirmed: true` and the IDENTICAL payload. On "cancel" / "no", acknowledge briefly ("Got it — cancelled.") and move on.',
          }),
        );
      } catch (err) {
        // If the direct outbound write failed, fall through to the
        // legacy text-only flow below so the founder still sees a
        // confirmation prompt.
        // eslint-disable-next-line no-console
        console.error('[baget] dispatchApproval direct-write failed; falling back to text', err);
      }
    }

    // Legacy fallback — text-only flow when we can't deliver
    // buttons (no telegram routing yet, etc.).
    return ok(
      JSON.stringify({
        status: 'approval-pending',
        summary: args.summary,
        cost: {
          amount: cost.amount,
          remaining: cost.remaining,
          tasksRemaining: cost.tasksRemaining,
        },
        note: [
          'Reply in plain text with the summary + cost, and ask the founder to confirm by typing a word ("yes" / "go" / "approve" or "no" / "cancel"). Do NOT say "tap", "press", or "✅" — there is no button here.',
          'Set `confirmed: true` ONLY on a standalone confirmation word in the NEXT message. A repeat of the original request is NOT a confirmation — ask "To confirm, reply \'yes\' or \'go\'." Then re-call this tool with the IDENTICAL payload.',
          '`amount` is the credit deduction for this action; `remaining` is the founder\'s balance; `tasksRemaining` is budget headroom (how many MORE tasks of this size fit) — do not phrase it as "queues N tasks". When `amount === 0` say "included in your plan", not "0 credits".',
        ].join(' '),
      }),
    );
  }

  // Founder confirmed — actually execute. Per PR #462's hardening,
  // /approval/execute requires an `approvalToken` minted by
  // /approval/confirm against the requestId we captured during the
  // preview call. If the cache miss / expired, ask the agent to
  // re-request approval (the LLM will paraphrase to the founder).
  const cached = pendingApprovals.get(cacheKey);
  if (!cached) {
    return fail(
      `${args.action} execute failed: approval-not-cached — call this tool with confirmed:false first to mint a fresh approval request, then re-confirm`,
    );
  }
  if (cached.expiresAtMs < Date.now()) {
    pendingApprovals.delete(cacheKey);
    return fail(
      `${args.action} execute failed: approval-expired — call this tool with confirmed:false to mint a fresh request`,
    );
  }

  // Step 2: confirm the request, get an approvalToken JWT.
  // /approval/confirm uses a SHARED host-callback secret (not the
  // per-(user, company) channel token) — see getApprovalCallbackToken
  // for the rationale.
  const confirmResp = await bagetFetch<{
    ok: boolean;
    approvalToken?: string;
    expiresAt?: string;
    status?: 'rejected';
  }>({
    method: 'POST',
    path: `/api/companies/${ctx.companyId}/approval/confirm`,
    body: { requestId: cached.requestId, decision: 'approve' },
    authToken: 'approval-callback',
  });
  if (!confirmResp.ok) {
    pendingApprovals.delete(cacheKey);
    return fail(`${args.action} confirm failed: ${confirmResp.error}`);
  }
  const approvalToken = confirmResp.data.approvalToken;
  if (!approvalToken) {
    pendingApprovals.delete(cacheKey);
    return fail(`${args.action} confirm failed: no approvalToken in response`);
  }

  // Step 3: execute with the proof token.
  const result = await bagetFetch<{ ok: boolean; messageForFounder?: string }>({
    method: 'POST',
    path: `/api/companies/${ctx.companyId}/approval/execute`,
    body: { action: args.action, payload: args.payload, approvalToken },
  });
  // Always invalidate the cache after attempt — token is single-use.
  pendingApprovals.delete(cacheKey);
  if (!result.ok) return fail(`${args.action} execute failed: ${result.error}`);
  return ok(result.data.messageForFounder ?? `${args.action} done.`);
}

// ── READ tools ────────────────────────────────────────────────────────────────

const getCompanyOverview: McpToolDefinition = {
  tool: {
    name: 'baget_get_company_overview',
    description:
      "Fetch the founder's company overview — name, status, current batch number, top metrics. Use at the start of every conversation to ground your reply in the latest state.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/overview`,
    });
    if (!result.ok) return fail(`get_company_overview failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

const queryMetrics: McpToolDefinition = {
  tool: {
    name: 'baget_query_metrics',
    description:
      "Get current values + recent history for the founder's active business metrics (waitlist, MRR, signups, etc.). ALWAYS call this before answering ANY question about a number, KPI, or trend — never invent metrics.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/metrics`,
    });
    if (!result.ok) return fail(`query_metrics failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

const getCredits: McpToolDefinition = {
  tool: {
    name: 'baget_get_credits',
    description:
      "Read the founder's current credit balance — total + breakdown across daily, treasury, and purchased pools. Use this BEFORE answering ANY question about credits, balance, budget, spending capacity, or affordability — \"how much do I have?\", \"can I afford to launch the batch?\", \"am I running low?\", \"what's my balance?\". Also call it BEFORE proposing an action that costs credits, so you can warn the founder if they'd run dry. NEVER hallucinate the number; this tool is the only source of truth that matches what the dashboard shows.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/credits`,
    });
    if (!result.ok) return fail(`get_credits failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

const listRecentActivity: McpToolDefinition = {
  tool: {
    name: 'baget_list_recent_activity',
    description:
      "Read the founder's recent activity feed — the same rows the dashboard's activity timeline shows. Use this BEFORE answering questions about what the team has been doing — \"what did the team ship today?\", \"what happened yesterday?\", \"what has Louis been working on?\", \"any progress?\", \"what's new?\". Returns the most recent 25 founder-visible items (debug rows already filtered out, messages already sanitized for founder eyes). NEVER make up activity. If the feed is empty, say so honestly — empty is information.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const result = await bagetFetch<{ activity?: unknown }>({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/recent-activity`,
    });
    if (!result.ok) return fail(`list_recent_activity failed: ${result.error}`);
    // Unwrap the `{ activity: [...] }` envelope so the model gets just
    // the array. Mirrors `baget_read_document`'s `{ document }` unwrap
    // pattern. Saves tokens in the agent's context window — the
    // envelope key is metadata the agent doesn't need. Falls back to
    // the raw payload if the upstream shape ever changes (better to
    // surface unfamiliar JSON than to hide it under a defensive null).
    const inner =
      result.data && typeof result.data === 'object' && 'activity' in result.data
        ? (result.data as { activity: unknown }).activity
        : result.data;
    return ok(JSON.stringify(inner, null, 2));
  },
};

const listDocuments: McpToolDefinition = {
  tool: {
    name: 'baget_list_documents',
    description:
      'List the founder\'s documents — business plan, brand guide, pitch deck, research, etc. Returns id, title, category, and createdAt for each. Call this first before referring to a specific document by name; never guess document ids. After listing, route to the right follow-up tool based on the founder\'s intent and the document category:\n' +
      '\n' +
      '**For DECKS (`category === "deck"`, or "pitch deck" / "presentation" / "slides" in the title):**\n' +
      '- Bare delivery requests ("send me the deck", "share the pitch", "give me the deck", "show me the slides") → call `baget_send_deck_visuals`. The founder gets actual rendered slide IMAGES inline — visual layout preserved, scrollable in chat.\n' +
      '- Content discussion ("what\'s in the deck?", "summarize the pitch", "read me the problem statement") → call `baget_read_document` to fetch the markdown body and quote it inline.\n' +
      '\n' +
      '**For NON-DECK documents** (BPs, brand guides, research, etc.):\n' +
      '- Bare delivery + content discussion → call `baget_read_document` (markdown inline; chat-native default).\n' +
      '- Explicit file/forward intent ("as a PDF", "the file", "to forward", "to save", "attach the file") → call `baget_send_document_file`.\n' +
      '\n' +
      'When in doubt, default to the inline path (`baget_read_document` for non-decks, `baget_send_deck_visuals` for decks); offer the file as a follow-up.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/documents`,
    });
    if (!result.ok) return fail(`list_documents failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

const readDocument: McpToolDefinition = {
  tool: {
    name: 'baget_read_document',
    description:
      'Fetch the markdown body of a single document and QUOTE it INLINE in your reply. This is the CHAT-NATIVE DEFAULT for content-discussion intent on NON-DECK documents (BPs, brand guides, research) AND for content-discussion intent on DECKS ("what\'s in the deck?", "summarize the pitch", "read me the problem statement"). Markdown renders cleanly inline and the founder reads it in one tap, without leaving the chat. Use for: discuss / summarize / read-aloud ("what\'s in the BP?", "summarize the brand guide", "what\'s the positioning?") AND bare delivery on NON-DECK docs ("send me the BP", "share the brand guide"). For long documents, quote the most relevant section and offer to expand or scroll through other sections inline. **For DECK delivery (bare "send me the deck", "share the pitch", "show me the slides") use `baget_send_deck_visuals` INSTEAD** — that tool ships actual rendered slide images so the visual layout is preserved; this tool is for deck CONTENT-DISCUSSION only. Pairs with `baget_send_document_file` for explicit non-deck file intent ("as a PDF", "the file", "to forward", "to save"). Call `baget_list_documents` FIRST to resolve a name (e.g. \'pitch deck\') to a documentId; never guess document ids.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          format: 'uuid',
          description: 'UUID of the document to read; resolve via baget_list_documents.',
        },
      },
      required: ['documentId'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const documentId = String(args.documentId ?? '').trim();
    if (!documentId) return fail('documentId is required');
    // encodeURIComponent on the model-supplied id — a hallucinated `..`
    // or `/` would otherwise change the request path semantics before
    // the server's UUID guard could reject it cleanly.
    const result = await bagetFetch<{ document?: unknown }>({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/documents/${encodeURIComponent(documentId)}`,
    });
    if (!result.ok) return fail(`read_document failed: ${result.error}`);
    // Unwrap the `{ document: ... }` envelope so the model gets just the
    // document object, not the wrapper. Saves tokens in the agent's
    // context window (Gemini medium on PR #12). Falls back to the raw
    // payload if the upstream shape ever changes — better to surface
    // unfamiliar JSON than to hide it under a defensive null.
    const inner =
      result.data && typeof result.data === 'object' && 'document' in result.data
        ? (result.data as { document: unknown }).document
        : result.data;

    // Sam 2026-05-07 Telegram smoke (after PR #64): the deck doc body
    // had been regenerated as the new HTML deck format (HTML/CSS for
    // visual rendering on the dashboard). The agent dutifully quoted
    // the returned `content` inline and the founder saw 1000+ lines
    // of `<section>` / `<style>` / CSS tokens — equally unreadable
    // as the PDF render path PR #64 just shut off. Fix: detect HTML
    // content here and convert to clean markdown via `turndown`
    // (already pre-installed in the Dockerfile for the markdown→PDF
    // path). The conversion is gated on `looksLikeHtml` so plain-
    // markdown bodies (BPs, brand guides, research) round-trip
    // unchanged. On any conversion error, return the original body
    // — degrades to today's behavior, never blocks the read.
    //
    // This is the fork-side bridge until apps/web ships a
    // `?format=text` variant on GET /api/companies/:id/documents/
    // :docId that returns stripped-to-text content for chat
    // consumers (queued as the principled fix).
    if (inner && typeof inner === 'object' && 'content' in inner) {
      const doc = inner as { content?: unknown };
      const rawContent = doc.content;
      if (typeof rawContent === 'string' && looksLikeHtml(rawContent)) {
        try {
          doc.content = htmlToMarkdown(rawContent);
        } catch {
          // Swallow turndown failures — the original content is
          // still better than nothing, and the model + persona
          // renderer downstream will handle a wall-of-html more
          // gracefully than a tool error would (which surfaces as
          // a founder-visible "send me the deck failed" message).
        }
      }
    }

    return ok(JSON.stringify(inner, null, 2));
  },
};

// ── Tier 2 READ tools ───────────────────────────────────────────────────────
//
// Six new bearer-GET tools added by Tier 2 (apps/web PRs #471, #473,
// #474). Each fronts a baget.ai bearer route that returns a chat-
// budgeted projection — paginated/filterable for explore use, capped
// for token-budget safety.

const listContacts: McpToolDefinition = {
  tool: {
    name: 'baget_list_contacts',
    description:
      "Read the founder's contact list (people emailable for campaigns). Returns id, email, name, title, company, source, and createdAt for the most-recent contacts plus a totalCount. Default page 25, max 50 per call. Use BEFORE answering questions about contacts — \"how many people are on my list?\", \"who's on the contact list?\", \"is Jane Doe on it?\". Filter by `source` (\"manual\" / \"import\" / \"website_lead\" / \"prospect\") to narrow, e.g. \"only the manually-added contacts\". Pass `cursor` (the previous page's `nextCursor`) for older pages. NEVER hallucinate counts — call this first.",
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'ISO 8601 createdAt of the previous page\'s OLDEST item; pass back the `pagination.nextCursor` from a prior response.' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        source: { type: 'string', enum: ['manual', 'import', 'website_lead', 'prospect'] },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const q = buildQueryString(args, ['cursor', 'limit', 'source']);
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/contacts/list${q}`,
    });
    if (!result.ok) return fail(`list_contacts failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

const exportContacts: McpToolDefinition = {
  tool: {
    name: 'baget_export_contacts',
    description:
      "Export the founder's full contact list (up to 5,000 rows) for downstream use — campaign target list, CRM import, manual review. Use when the founder says \"export my contacts\", \"give me the full list\", \"send me a CSV\". Returns JSON by default with a `cap` flag if the 5,000 limit was hit (warning: the response can be large). For chat exploration prefer `baget_list_contacts` (paginated, smaller). RUNS IMMEDIATELY (free). The dashboard's \"Export\" button uses the same endpoint.",
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['manual', 'import', 'website_lead', 'prospect'], description: 'Filter to a single source (optional).' },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const q = buildQueryString(args, ['source'], { format: 'json' });
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/contacts/export${q}`,
    });
    if (!result.ok) return fail(`export_contacts failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

const listProspectSearches: McpToolDefinition = {
  tool: {
    name: 'baget_list_prospect_searches',
    description:
      "Read the founder's prospect-search history — searches the marketing agent ran (or the founder kicked off via baget_create_prospect_search). Returns id, name, query, status, discoveredCount, importedCount, creditsUsed, and timestamps. Use BEFORE proposing a NEW search if the founder might already have a recent one for the same intent (\"didn't we already look at Series A founders in NYC last week?\"). Default 20 most recent; cap 50. Filter by `status` (\"pending\" / \"running\" / \"completed\" / \"failed\") to narrow.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed'] },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const q = buildQueryString(args, ['limit', 'status']);
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/prospect-searches${q}`,
    });
    if (!result.ok) return fail(`list_prospect_searches failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

const getProspectSearchLeads: McpToolDefinition = {
  tool: {
    name: 'baget_get_prospect_search_leads',
    description:
      'Read the leads from a SPECIFIC prospect search — names, titles, companies, locations, LinkedIn URLs, and (where revealed) emails. Use AFTER `baget_list_prospect_searches` when the founder asks "show me a few from that search" / "who did we find?" / "what kind of people are on the list?". Page 25, cap 50. UNREVEALED leads have `email: null` — use `baget_reveal_prospect` (approval-gated, 1 credit each) to fetch emails. Filter by `status` ("discovered" / "revealing" / "revealed" / "failed") to narrow.',
    inputSchema: {
      type: 'object',
      properties: {
        searchId: { type: 'string', format: 'uuid', description: 'UUID from baget_list_prospect_searches.' },
        cursor: { type: 'string', description: 'ISO 8601 createdAt of the previous page\'s OLDEST lead.' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        status: { type: 'string', enum: ['discovered', 'revealing', 'revealed', 'failed'] },
      },
      required: ['searchId'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const searchId = String(args.searchId ?? '').trim();
    if (!searchId) return fail('searchId is required');
    const q = buildQueryString(args, ['cursor', 'limit', 'status']);
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/prospect-searches/${encodeURIComponent(searchId)}/leads${q}`,
    });
    if (!result.ok) return fail(`get_prospect_search_leads failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

const readRoadmap: McpToolDefinition = {
  tool: {
    name: 'baget_read_roadmap',
    description:
      "Read the founder's strategic roadmap — short_term / mid_term / long_term goals with titles, target metrics, and current progress. Use BEFORE answering strategic questions — \"what's our plan?\", \"what are we focused on?\", \"how are we tracking against the goals?\", \"what's the long-term vision?\". Returns the active (non-archived) items only. If the company has no roadmap yet, `roadmap` will be `null` and all horizon arrays will be empty — say so honestly and offer to help generate one (the worker handles roadmap generation today, so direct the founder to the dashboard's roadmap modal).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/roadmap-summary`,
    });
    if (!result.ok) return fail(`read_roadmap failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

const readAdMetrics: McpToolDefinition = {
  tool: {
    name: 'baget_read_ad_metrics',
    description:
      "Read Meta-ad campaign performance — total spend, impressions, clicks, conversions, CTR, CPC across the founder's launched campaigns. Use BEFORE answering ad questions — \"how are my ads doing?\", \"how much have I spent?\", \"is the launch ad converting?\", \"what's the CTR?\". Returns a cross-campaign `summary` plus per-campaign `totals` + per-day `daily` breakdown. Default lookback: last 30 days, cap 90 days (Apollo API quota). Pass `campaignId` to drill into one campaign. If `campaigns` is empty, the founder hasn't launched ads yet — say so honestly. NEVER hallucinate spend numbers.",
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO 8601 lookback start; defaults to 30 days ago, capped at 90 days back.' },
        campaignId: { type: 'string', format: 'uuid', description: 'Optional UUID to scope to a single campaign.' },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const q = buildQueryString(args, ['since', 'campaignId']);
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/ad-metrics${q}`,
    });
    if (!result.ok) return fail(`read_ad_metrics failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

// ── FILE TRANSFER tool ──────────────────────────────────────────────────────

/**
 * Telegram (and Slack/Discord) impose a hard upper bound on attachment
 * size — Telegram bots cap at 50 MB. Library docs render to single-digit
 * MB PDFs in practice, but a stray very-long document plus images could
 * push past that. We surface a clean error rather than letting the host
 * channel adapter fail silently after the file is on disk.
 */
const MAX_ATTACHMENT_BYTES = 45 * 1024 * 1024;

/**
 * Render-pdf timing budget. The server's Next.js route is `maxDuration =
 * 30s` (set in render-pdf/route.ts), and a cold-start path (pdfkit
 * dynamic import + a long markdown body + Vercel Blob upload) can
 * realistically use most of that. Give the channel-side fetch a bit more
 * headroom so we time out AFTER the server gives up rather than racing
 * it — racing produces a misleading "client aborted" instead of a clean
 * upstream error message.
 */
const RENDER_PDF_TIMEOUT_MS = 45_000;

/**
 * Blob fetch is a separate hop from /render-pdf. Vercel Blob is fast
 * (cached at the edge) but a freshly-uploaded blob can take a beat to
 * propagate. 30s is generous; in practice these complete in <500ms.
 */
const BLOB_FETCH_TIMEOUT_MS = 30_000;

/**
 * Vercel Blob storage hostname — the only public host the agent should
 * follow when fetching a render-pdf response. Locking the destination
 * closes the SSRF hole that would otherwise let a compromised baget.ai
 * redirect the agent to internal services (e.g. AWS metadata IP) by
 * crafting an arbitrary `blobUrl` in the response.
 *
 * Pattern: hostname must end in `.public.blob.vercel-storage.com` (the
 * subdomain is the storage account suffix). Production blobs always
 * land under that domain — see the route's `put({ access: "public" })`
 * call. If we ever switch storage backends this allowlist needs to
 * change in lockstep.
 */
const ALLOWED_BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com';

const sendDocumentFile: McpToolDefinition = {
  tool: {
    name: 'baget_send_document_file',
    description:
      'Send a NON-DECK document to the founder as a real downloadable FILE attachment — PDF for markdown docs (server-side render via pdfkit), original media for image/video docs. The TRIGGER is an EXPLICIT signal that the founder wants a file (not chat-readable text): either an explicit format mention (the words "PDF", "file", or "attachment") OR an explicit downstream-of-chat verb (forward, save, print, share with someone outside the conversation). Positive examples — every one explicitly mentions a format or downstream verb: "give me the PDF version of the BP", "I need the file to forward to a lawyer", "attach the brand guide so I can print it", "I want a PDF I can save", "shoot me the file for the investor email". The chat-native default for ANY content delivery without one of those explicit signals is `baget_read_document` — markdown body inline reads in one tap on Telegram, no download required. When in doubt for non-deck docs, default to read; offer the file as a follow-up. **For DECK-CATEGORY documents — `category === "deck"` or "pitch deck" / "presentation" / "slides" in the title — use `baget_send_deck_visuals` instead.** That tool ships actual rendered slide IMAGES (one PNG per slide, 1920×1080, scrollable inline on Telegram) — visual layout preserved, which the pdfkit text-render path cannot do. If the founder explicitly asks for a deck PDF, route to `baget_send_deck_visuals` first and offer the PDF as a follow-up; the visual delivery is strictly better for chat consumption than a styled-text PDF. SUPPORTED OUTPUT FORMATS for THIS tool are PDF + original-media only. HTML, DOCX, and slide-deck (.key/.pptx) cannot be shipped as files from here — call `baget_read_document` for HTML/markdown intent on non-deck docs, or tell the founder the Documents tab on their dashboard has the rich rendering and offer to send a PDF as a substitute. NEVER quote a literal URL — never paste any URL or path with placeholders or the substring "dashboard/" in your reply; the founder is already signed into their dashboard and knows where it is. NEVER attempt to convert documents using shell utilities (npx marked / pandoc / wkhtmltopdf / similar via the Bash tool) — the container does not have npm-registry access or these binaries; the attempt will fail and the founder will see a confusing "still encountering an issue" loop. Call `baget_list_documents` FIRST to resolve a name (e.g. \'pitch deck\') to a documentId. Lands in the same chat thread as the conversation — no "to" parameter needed.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          format: 'uuid',
          description: 'UUID of the document to send; resolve via baget_list_documents.',
        },
        text: {
          type: 'string',
          maxLength: 1000,
          description:
            'Optional one-line caption to send with the file ("Here\'s the deck — let me know which sections you want expanded.").',
        },
      },
      required: ['documentId'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);

    const documentId = String(args.documentId ?? '').trim();
    if (!documentId) return fail('documentId is required');

    // 1. Ask baget.ai to render the document to a downloadable artifact.
    //    Markdown docs become PDFs; image/video docs return their existing
    //    media URL directly. Either way the response shape is the same:
    //    { blobUrl, blobKey, filename, mimeType }. The route is bearer-aware
    //    via the same hybrid-auth pattern as the LIST + per-doc routes.
    //    encodeURIComponent neutralizes a hallucinated path traversal in
    //    the model-supplied id. Render needs a longer timeout than the
    //    default — see RENDER_PDF_TIMEOUT_MS comment.
    const render = await bagetFetch<{ blobUrl: string; filename: string; mimeType: string }>({
      method: 'POST',
      path: `/api/companies/${ctx.companyId}/documents/${encodeURIComponent(documentId)}/render-pdf`,
      timeoutMs: RENDER_PDF_TIMEOUT_MS,
    });
    if (!render.ok) return fail(`send_document_file failed: ${render.error}`);
    // Null-check before destructuring — `bagetFetch` returns
    // `data: null` on an empty / non-JSON response body even when
    // `ok: true` (Gemini medium on PR #13). Without this guard the
    // destructure throws an uncaught TypeError and crashes the runner.
    if (!render.data || typeof render.data !== 'object') {
      return fail('send_document_file got an empty or non-JSON response from /render-pdf');
    }
    const { blobUrl, filename } = render.data;
    if (!blobUrl || !filename) {
      return fail('send_document_file got an unexpected response from /render-pdf (missing blobUrl or filename)');
    }

    // 2. SSRF defense — only follow URLs hosted on Vercel Blob's public
    //    storage domain. Without this guard, a compromised baget.ai
    //    could craft a `blobUrl` pointing at internal infrastructure
    //    (e.g. AWS instance metadata, Railway service mesh) and the
    //    agent would dutifully fetch and ship the response. URL parsing
    //    must happen BEFORE the fetch so we never even open the
    //    connection to a disallowed host.
    let parsedBlobUrl: URL;
    try {
      parsedBlobUrl = new URL(blobUrl);
    } catch {
      return fail(`send_document_file got an invalid blobUrl from /render-pdf: ${blobUrl}`);
    }
    if (parsedBlobUrl.protocol !== 'https:' || !parsedBlobUrl.hostname.endsWith(ALLOWED_BLOB_HOST_SUFFIX)) {
      return fail(
        `send_document_file refused to fetch a blobUrl outside the allowed Vercel Blob domain (host=${parsedBlobUrl.hostname}).`,
      );
    }

    // 3. Resolve the destination — always reply in-place (the founder's
    //    current chat thread). No `to` parameter exposed to the agent;
    //    this is a 1:1 channel surface, not a fan-out tool.
    const routing = resolveRouting(undefined);
    if ('error' in routing) return fail(routing.error);

    // 4. Pull the bytes from the validated blob URL. Vercel Blob URLs
    //    are public-read by design (the dashboard's LibraryPicker uses
    //    the same URLs unauthenticated); the URL itself is the capability.
    //
    //    OOM defense (Codex P1 + Gemini security-medium on PR #13):
    //    enforce the size cap BEFORE buffering. A two-step check —
    //    (a) Content-Length pre-check rejects a known-too-large response
    //        without buffering at all (fast path, the usual case);
    //    (b) streaming check during arrayBuffer aborts mid-read on a
    //        stream that omits or lies about Content-Length.
    //    `arrayBuffer()` alone would happily allocate the entire body
    //    into memory before our `buffer.length > MAX` check ran, which
    //    on a malicious 5GB response would OOM the runner and kill the
    //    container before any clean error message could surface.
    let buffer: Buffer;
    try {
      const blobRes = await fetch(parsedBlobUrl, { signal: AbortSignal.timeout(BLOB_FETCH_TIMEOUT_MS) });
      if (!blobRes.ok) {
        return fail(`send_document_file failed to fetch the rendered file (HTTP ${blobRes.status})`);
      }

      // (a) Pre-check Content-Length when present.
      const contentLengthHeader = blobRes.headers.get('content-length');
      if (contentLengthHeader !== null) {
        const declaredBytes = Number(contentLengthHeader);
        if (Number.isFinite(declaredBytes) && declaredBytes > MAX_ATTACHMENT_BYTES) {
          return fail(
            `send_document_file: rendered file is ${(declaredBytes / 1024 / 1024).toFixed(1)} MB, ` +
              `over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB chat-attachment limit. ` +
              `Tell the founder to download from the dashboard.`,
          );
        }
      }

      // (b) Stream the body into a buffer with a running size cap. The
      //     reader is aborted as soon as accumulated bytes exceed the
      //     cap, so a stream that omits Content-Length OR lies about
      //     it (advertised < cap, actual >> cap) still can't OOM us.
      const reader = blobRes.body?.getReader();
      if (!reader) {
        // No body stream — fall back to arrayBuffer which is bounded
        // by the cap-check we'd do post-buffer (small responses only).
        const arr = await blobRes.arrayBuffer();
        if (arr.byteLength > MAX_ATTACHMENT_BYTES) {
          return fail(
            `send_document_file: rendered file is ${(arr.byteLength / 1024 / 1024).toFixed(1)} MB, ` +
              `over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB chat-attachment limit. ` +
              `Tell the founder to download from the dashboard.`,
          );
        }
        buffer = Buffer.from(arr);
      } else {
        const chunks: Buffer[] = [];
        let total = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > MAX_ATTACHMENT_BYTES) {
            await reader.cancel();
            return fail(
              `send_document_file: rendered file is over the ` +
                `${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB chat-attachment limit. ` +
                `Tell the founder to download from the dashboard.`,
            );
          }
          chunks.push(Buffer.from(value));
        }
        buffer = Buffer.concat(chunks);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(`send_document_file failed to fetch the rendered file: ${msg}`);
    }

    // 5. Stage the file in the per-message outbox dir (same shape the
    //    core `send_file` tool uses — the host channel adapter scans
    //    this layout and ships the file via Telegram sendDocument /
    //    Slack files.upload / etc.). `path.basename` strips any path
    //    separators in case a broken server-side slugifier ever leaks
    //    `..` or `/`; the empty-string / dot-only check below catches
    //    `"./"` and `""` which basename returns as-is.
    const id = generateId();
    const outboxDir = path.join(workspaceOutboxDir(), id);
    const safeFilename = path.basename(filename);
    if (!safeFilename || safeFilename === '.' || safeFilename === '..') {
      return fail(`send_document_file got an unusable filename from /render-pdf: ${JSON.stringify(filename)}`);
    }
    const stagedPath = path.join(outboxDir, safeFilename);
    try {
      fs.mkdirSync(outboxDir, { recursive: true });
      fs.writeFileSync(stagedPath, buffer);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(`send_document_file failed to stage the attachment locally: ${msg}`);
    }

    // 5. Enqueue the outbound message using the path-based attachments
    //    contract (PR #18 / `OutboundAttachment`) — the only contract the
    //    Telegram adapter's deliver() loop reads. The legacy `content.files`
    //    contract is buffer-based and never wired to Telegram, so a
    //    messages_out row that only sets `files` ships nothing and the
    //    founder sees an empty reply (this was the original bug). Caption
    //    rides WITH the file (Telegram's sendDocument supports up to 1024
    //    chars of caption); `text` left empty so we don't also fire a
    //    separate sendMessage for the same content. The model still emits
    //    its own conversational follow-up via `send_message` if it wants.
    const captionText = typeof args.text === 'string' ? args.text.trim() : '';
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({
        text: '',
        attachments: [
          {
            kind: 'document',
            path: stagedPath,
            filename: safeFilename,
            ...(captionText ? { caption: captionText } : {}),
          },
        ],
      }),
    });

    log(`send_document_file: ${id} → ${routing.resolvedName} (${safeFilename}, ${buffer.length} bytes)`);
    return ok(`Sent ${safeFilename} (${(buffer.length / 1024).toFixed(0)} KB).`);
  },
};

// ── DECK VISUALS ────────────────────────────────────────────────────────────

/**
 * Per-slide download timeout. Each slide is ~150-500 KB on Vercel Blob
 * (CDN-cached, sub-100ms in practice); 10s is conservative for the
 * tail. Mirrors the BLOB_FETCH_TIMEOUT_MS used by send_document_file.
 */
const SLIDE_BLOB_FETCH_TIMEOUT_MS = 10_000;

/**
 * Per-slide size cap. A 1920×1080 PNG with rich content rarely exceeds
 * 1.5 MB; 5 MB gives generous headroom while protecting against an
 * attacker-controlled blobUrl smuggling a 4K-bombing payload before
 * SSRF host check rejects it. Aggregate cap (cap × MAX_SLIDES_PER_RENDER)
 * stays well under MAX_ATTACHMENT_BYTES (45 MB).
 */
const MAX_SLIDE_BYTES = 5 * 1024 * 1024;

/**
 * Telegram caption cap on a single photo is 1024 chars; we keep it
 * tighter to leave room for emoji + persona prefix on the host side.
 */
const MAX_DECK_CAPTION_CHARS = 500;

interface RenderSlidesResponse {
  slides?: Array<{
    index: number;
    blobUrl: string;
    mimeType: string;
    width: number;
    height: number;
    slideType: string | null;
  }>;
}

const sendDeckVisuals: McpToolDefinition = {
  tool: {
    name: 'baget_send_deck_visuals',
    description:
      "Send a pitch deck to the founder as VISUAL slides — actual rendered PNG images of every slide, in order. This is the chat-native default for ANY delivery of a deck-category document on Telegram: bare 'send me the deck', 'share the pitch', 'give me the deck', 'show me the slides'. The founder gets a sequence of slide images they can scroll through inline — visual layout preserved, not text. Use `baget_read_document` instead ONLY when the founder asks for CONTENT discussion ('what's in the deck?', 'summarize the pitch', 'read me the problem statement') — that path returns markdown for inline quoting. Use `baget_send_document_file` instead for NON-deck documents (BPs, brand guides, research) when the founder explicitly asks for a file. Call `baget_list_documents` FIRST to resolve a name (e.g. 'pitch deck') to a documentId; never guess document ids. Caption rides on the first slide only — keep it short (≤500 chars). The renderer caps at 20 slides; a deck longer than that returns a friendly 'see the dashboard' message.",
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          format: 'uuid',
          description: 'UUID of the deck to render; resolve via baget_list_documents.',
        },
        text: {
          type: 'string',
          maxLength: MAX_DECK_CAPTION_CHARS,
          description:
            "Optional one-line caption for the FIRST slide (e.g. 'Here's the deck — let me know which slide to expand.'). Telegram convention: caption attaches to the lead image only.",
        },
      },
      required: ['documentId'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);

    const documentId = String(args.documentId ?? '').trim();
    if (!documentId) return fail('documentId is required');

    // 1. Ask baget.ai to render the deck to per-slide PNGs. The route
    //    is bearer-aware via the same channel-token path as the LIST +
    //    per-doc routes. encodeURIComponent neutralizes a hallucinated
    //    path traversal in the model-supplied id.
    const render = await bagetFetch<RenderSlidesResponse>({
      method: 'POST',
      path: `/api/companies/${ctx.companyId}/documents/${encodeURIComponent(documentId)}/render-slides`,
      timeoutMs: RENDER_PDF_TIMEOUT_MS, // chromium cold-start + render budget — same shape as render-pdf
    });

    // Failure mapping — typed status codes from the apps/web route
    // (PR #493). bagetFetch only surfaces { status, error: string } on
    // non-2xx, so we discriminate on the status code and emit the
    // matching founder-facing copy. Generic 5xx falls through to the
    // raw error string.
    if (!render.ok) {
      if (render.status === 413) {
        return fail(
          'That deck is longer than I can ship in chat. ' +
            'Take a look at the Documents tab on your dashboard for the full version.',
        );
      }
      if (render.status === 422) {
        return fail(
          "That document isn't a deck — call baget_read_document with the same id " +
            'to fetch its content inline instead.',
        );
      }
      if (render.status === 404) {
        return fail(`I couldn't find that document — call baget_list_documents to refresh the catalogue.`);
      }
      return fail(`send_deck_visuals failed: ${render.error}`);
    }

    if (!render.data || typeof render.data !== 'object' || !Array.isArray(render.data.slides)) {
      return fail('send_deck_visuals got an unexpected response shape from /render-slides');
    }
    const slides = render.data.slides;
    if (slides.length === 0) {
      return fail('send_deck_visuals: /render-slides returned no slides — deck may be empty.');
    }

    // 2. Validate every slide URL up-front (fail-fast SSRF check).
    //    A single bad URL aborts the whole send rather than half-
    //    delivering and confusing the founder.
    for (const slide of slides) {
      let parsed: URL;
      try {
        parsed = new URL(slide.blobUrl);
      } catch {
        return fail(`send_deck_visuals got an invalid blobUrl from /render-slides: ${slide.blobUrl}`);
      }
      if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith(ALLOWED_BLOB_HOST_SUFFIX)) {
        return fail(
          `send_deck_visuals refused to fetch a blobUrl outside the allowed Vercel Blob domain (host=${parsed.hostname}).`,
        );
      }
    }

    // 3. Resolve the destination — always reply in-place.
    const routing = resolveRouting(undefined);
    if ('error' in routing) return fail(routing.error);

    // 4. Stage every slide PNG in one outbox dir.
    //    Sequential downloads — the channel adapter ships them one by
    //    one anyway, and parallel fetches against the same Blob CDN
    //    don't actually help latency for 6-20 small files. Each fetch
    //    has its own size cap (matches send_document_file pattern).
    const outboxId = generateId();
    const outboxDir = path.join(workspaceOutboxDir(), outboxId);
    try {
      fs.mkdirSync(outboxDir, { recursive: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(`send_deck_visuals failed to stage the outbox dir: ${msg}`);
    }

    const captionText = typeof args.text === 'string' ? args.text.trim() : '';
    const attachments: Array<{ kind: 'photo'; path: string; filename: string; caption?: string }> = [];

    for (const slide of slides) {
      let buffer: Buffer;
      try {
        const res = await fetch(slide.blobUrl, { signal: AbortSignal.timeout(SLIDE_BLOB_FETCH_TIMEOUT_MS) });
        if (!res.ok) {
          return fail(`send_deck_visuals failed to fetch slide ${slide.index + 1} (HTTP ${res.status})`);
        }
        const lenHeader = res.headers.get('content-length');
        if (lenHeader && Number.parseInt(lenHeader, 10) > MAX_SLIDE_BYTES) {
          return fail(`send_deck_visuals: slide ${slide.index + 1} is over the ${MAX_SLIDE_BYTES / 1024 / 1024} MB cap.`);
        }
        const arr = await res.arrayBuffer();
        if (arr.byteLength > MAX_SLIDE_BYTES) {
          return fail(`send_deck_visuals: slide ${slide.index + 1} is over the ${MAX_SLIDE_BYTES / 1024 / 1024} MB cap.`);
        }
        buffer = Buffer.from(arr);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return fail(`send_deck_visuals failed to fetch slide ${slide.index + 1}: ${msg}`);
      }

      // Filename: `slide-1-cover.png`, `slide-2-problem.png`, etc.
      // The slideType comes from the composer's `data-slide-type`
      // attribute (cover / problem / solution / market / traction /
      // ask). Index is 1-based for founder-readable filenames; null
      // slideType degrades to just `slide-N.png`.
      const safeType = slide.slideType
        ? slide.slideType.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 32)
        : '';
      const filename = safeType
        ? `slide-${slide.index + 1}-${safeType}.png`
        : `slide-${slide.index + 1}.png`;
      const stagedPath = path.join(outboxDir, filename);
      try {
        fs.writeFileSync(stagedPath, buffer);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return fail(`send_deck_visuals failed to stage slide ${slide.index + 1} locally: ${msg}`);
      }

      attachments.push({
        kind: 'photo',
        path: stagedPath,
        filename,
        // Telegram convention: caption rides on the lead photo only.
        // Subsequent photos in the same outbox row ship without
        // caption; the persona-prefixed text reply (if any) follows
        // separately per the adapter's existing flow.
        ...(slide.index === 0 && captionText ? { caption: captionText } : {}),
      });
    }

    // 5. Emit ONE outbox row with all attachments. The adapter loops
    //    and ships each as a separate Telegram photo message in
    //    sequence. (sendMediaGroup album would fold them into a
    //    swipeable carousel; that's a future adapter optimization.)
    writeMessageOut({
      id: outboxId,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text: '', attachments }),
    });

    log(`send_deck_visuals: ${outboxId} → ${routing.resolvedName} (${slides.length} slides)`);
    return ok(`Sent the deck — ${slides.length} slide${slides.length === 1 ? '' : 's'}.`);
  },
};

// ── GENERATE tools ──────────────────────────────────────────────────────────

/**
 * Test seam — production passes a freshly-built Google GenAI client at
 * tool-call time; tests inject a stub via `_setImageGenDeps` so the real
 * Gemini API never gets pinged from CI.
 */
let imageGenDeps: GenerateImageDeps = {};

/** Test-only — reset between tests via `_setImageGenDeps({})`. */
export function _setImageGenDeps(deps: GenerateImageDeps): void {
  imageGenDeps = deps;
}

/** A simple per-image-extension → mime-type map used to derive a safe
 *  filename. Keep in sync with what Imagen actually returns (PNG by
 *  default in our config). */
function extensionFromMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    default:
      return 'png';
  }
}

/** Slug a free-form prompt into a filesystem-safe basename so the
 *  founder sees `pitch-mockup-vela-{ts}.png` instead of `image-{id}.png`.
 *  Length-bounded so the host's outbox path never exceeds the FS limit. */
function slugFromPrompt(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'image';
}

const generateImage: McpToolDefinition = {
  tool: {
    name: 'baget_generate_image',
    description:
      "Generate an image from a text prompt and ship it to the founder as a real photo attachment. Use when the founder asks for a logo / mockup / illustration / 'show me what X could look like' / 'make me an image of Y'. Conversational scratchwork — does NOT save to the founder's brand library (point them at the dashboard if they want a saved asset). Caption rides with the image. Picks Imagen 3 by default; override via env. The model may refuse some prompts (people / brands / NSFW) — surface the error, suggest a reword.",
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          description:
            'Text prompt for the image. Be specific about style, composition, color, and subject — Imagen rewards detail.',
        },
        aspectRatio: {
          type: 'string',
          enum: ['1:1', '3:4', '4:3', '9:16', '16:9'],
          description:
            'Optional aspect ratio. Default 1:1 (square — safest across channels). Use 9:16 for story / portrait, 16:9 for landscape / cover, 4:3 or 3:4 for in-between.',
        },
        text: {
          type: 'string',
          maxLength: 1000,
          description:
            'Optional caption rendered with the image (Telegram + WhatsApp support up to ~1024 chars). Often empty — the image speaks for itself.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) return fail('prompt is required');

    const aspectRatio = (args.aspectRatio as AspectRatio | undefined) ?? '1:1';

    // Generate FIRST — if Gemini fails or refuses the prompt, we want
    // to surface that BEFORE doing any filesystem or DB work. Avoids
    // the "outbox dir created, then nothing landed" debugging confusion.
    const result = await generateImageBytes({ prompt, aspectRatio }, imageGenDeps);
    if (!result.ok) return fail(`generate_image failed: ${result.error}`);

    // Resolve destination — always reply in-place, no `to` arg exposed.
    const routing = resolveRouting(undefined);
    if ('error' in routing) return fail(routing.error);

    const id = generateId();
    const outboxDir = path.join(workspaceOutboxDir(), id);
    const ext = extensionFromMime(result.mimeType);
    const filename = `${slugFromPrompt(prompt)}.${ext}`;
    const stagedPath = path.join(outboxDir, filename);
    try {
      fs.mkdirSync(outboxDir, { recursive: true });
      fs.writeFileSync(stagedPath, result.bytes);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(`generate_image failed to stage the image locally: ${msg}`);
    }

    // Path-based attachments contract — same as send_document_file.
    // `kind: 'photo'` so the Telegram adapter routes through
    // sendBagetBotPhoto (renders inline) instead of sendBagetBotDocument
    // (renders as file card). Founders want the visual immediately.
    const captionText = typeof args.text === 'string' ? args.text.trim() : '';
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({
        text: '',
        attachments: [
          {
            kind: 'photo',
            path: stagedPath,
            filename,
            ...(captionText ? { caption: captionText } : {}),
          },
        ],
      }),
    });

    log(`generate_image: ${id} → ${routing.resolvedName} (${filename}, ${result.bytes.length} bytes)`);
    return ok(`Generated and sent ${filename} (${(result.bytes.length / 1024).toFixed(0)} KB).`);
  },
};

// ── WRITE tools (direct — no approval card needed) ────────────────────────────

const setDirection: McpToolDefinition = {
  tool: {
    name: 'baget_set_direction',
    description:
      'Save the founder\'s direction for the next batch. Use when the founder says "set direction to focus on X", "I want us to prioritize Y", "pivot toward Z". Direction-save does NOT plan a new batch by itself; the founder will say "launch the batch" separately. APPROVAL-GATED — the channel surface confirms direction-set with the founder before persisting (no credit cost, but the direction shapes every subsequent batch and the founder should see what they\'re committing to). On first call set `confirmed: false` to surface the preview; on the founder\'s explicit confirmation word, call again with `confirmed: true` and the IDENTICAL payload. Distill founder intent into 1-2 clear sentences; don\'t echo verbatim.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', minLength: 1, maxLength: 2000 },
        confirmed: {
          type: 'boolean',
          description:
            'Default false (preview). Set true ONLY after the founder explicitly confirms with a word like "yes" / "go" / "approve". Repeating the original "set direction to X" message is NOT a confirmation.',
        },
      },
      required: ['direction'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const direction = String(args.direction ?? '').trim();
    if (!direction || direction.length > 2000) return fail('direction must be 1–2000 chars');
    return dispatchApproval({
      action: 'set-direction',
      payload: { direction },
      confirmed: args.confirmed === true,
      summary: `Set the founder direction to: "${direction.slice(0, 80)}${direction.length > 80 ? '…' : ''}"`,
    });
  },
};

const updateMetric: McpToolDefinition = {
  tool: {
    name: 'baget_update_metric',
    description:
      'Update an existing business metric\'s current value OR start tracking a brand-new metric. Use when the founder says "waitlist is at 142 now", "we\'re at 30 signups", "start tracking MRR, currently $1.2k". Updates if the label matches an active metric (case-insensitive); otherwise adds a new metric (max 3 active). RUNS IMMEDIATELY (free).',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', minLength: 1, maxLength: 80 },
        current: { type: 'number' },
        unit: { type: 'string', maxLength: 24 },
        target: { type: 'number' },
      },
      required: ['label', 'current'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'update-metric',
      payload: {
        label: String(args.label),
        current: Number(args.current),
        ...(args.unit !== undefined ? { unit: String(args.unit) } : {}),
        ...(args.target !== undefined ? { target: Number(args.target) } : {}),
      },
      fallbackMessage: `Updated ${args.label}.`,
    });
  },
};

const archiveMetric: McpToolDefinition = {
  tool: {
    name: 'baget_archive_metric',
    description:
      'Archive an active metric — frees a slot under the 3-active-metric cap. Use when the founder says "stop tracking X", "retire the waitlist metric", "archive Y". Match by label (case-insensitive). RUNS IMMEDIATELY (free).',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', minLength: 1, maxLength: 80 },
        reason: { type: 'string', maxLength: 200 },
      },
      required: ['label'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'archive-metric',
      payload: {
        label: String(args.label),
        ...(args.reason !== undefined ? { reason: String(args.reason) } : {}),
      },
      fallbackMessage: `Archived ${args.label}.`,
    });
  },
};

const addMetricHistory: McpToolDefinition = {
  tool: {
    name: 'baget_add_metric_history',
    description:
      'Backfill a historical data point on an existing active metric. Use when the founder volunteers a PAST value: "we hit 50 signups last Monday", "MRR was $800 in October". Different from update_metric — this only touches the chart history, not current. Distill date phrases into ISO 8601 (use founder timezone from get_company_overview). RUNS IMMEDIATELY (free).',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', minLength: 1, maxLength: 80 },
        value: { type: 'number' },
        checkedAt: { type: 'string', description: 'ISO 8601 datetime of the observation' },
      },
      required: ['label', 'value'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'add-metric-history',
      payload: {
        label: String(args.label),
        value: Number(args.value),
        ...(args.checkedAt !== undefined ? { checkedAt: String(args.checkedAt) } : {}),
      },
      fallbackMessage: `History added for ${args.label}.`,
    });
  },
};

const setMetricTarget: McpToolDefinition = {
  tool: {
    name: 'baget_set_metric_target',
    description:
      'Update only the TARGET on an existing active metric — leaves current and history untouched. Use when the founder raises or lowers a goal: "waitlist goal is 500 now", "bump MRR target to $5k". Match by label (case-insensitive). RUNS IMMEDIATELY (free).',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', minLength: 1, maxLength: 80 },
        target: { type: 'number', exclusiveMinimum: 0 },
      },
      required: ['label', 'target'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'set-metric-target',
      payload: { label: String(args.label), target: Number(args.target) },
      fallbackMessage: `Target updated for ${args.label}.`,
    });
  },
};

const addTask: McpToolDefinition = {
  tool: {
    name: 'baget_add_task',
    description:
      'Add a task to the current open batch. Use when the founder says "add a task to ship the pricing page", "we need to do X", "make sure to Y". Pick the right agent role from the topic (developer for code/site, marketing for campaigns, analyst for research/data, design for visuals, ops for infra/legal/business, chief-of-staff for strategy/planning). RUNS IMMEDIATELY — credits only deduct when the batch actually launches. RESPONSE includes `[taskId=<uuid>]` — REMEMBER this UUID; if the founder immediately says "run it" / "kick it off" / "start it" you pass that exact taskId to baget_run_task. STRIP `[taskId=…]` from your reply to the founder (it\'s an internal handle, not user-facing).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', maxLength: 4000 },
        agentRole: {
          type: 'string',
          enum: ['chief-of-staff', 'developer', 'marketing', 'analyst', 'design', 'ops', 'intern'],
        },
      },
      required: ['title', 'agentRole'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'add-task',
      payload: {
        title: String(args.title),
        agentRole: String(args.agentRole),
        ...(args.description !== undefined ? { description: String(args.description) } : {}),
      },
      fallbackMessage: `Task added.`,
    });
  },
};

const parkTask: McpToolDefinition = {
  tool: {
    name: 'baget_park_task',
    description:
      'Park a task — moves a backlog task out of the active batch so the worker won\'t pick it up. Use when the founder says "X is no longer a priority", "drop the Y task", "park Z". Resolve the taskId from `baget_get_company_overview` (returns `tasks[]` for the open batch). RUNS IMMEDIATELY (free).',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', format: 'uuid' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'park-task',
      payload: { taskId: String(args.taskId) },
      fallbackMessage: `Task parked.`,
    });
  },
};

const cancelRunningTasks: McpToolDefinition = {
  tool: {
    name: 'baget_cancel_running_tasks',
    description:
      'Out-of-hours killswitch — stops ALL running work for the company. Use when the founder says "stop the work", "halt everything", "cancel the running tasks", "pause the run". Errors any in-flight tasks (no credit waste — credits only deduct on completion) and reverts queued tasks to backlog. Company status flips to "paused" — founder says "launch the batch" to resume. RUNS IMMEDIATELY (free). DIFFERENT from park_task (single backlog task) — this is the stop-everything-now hammer.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    return dispatchDirect({
      action: 'cancel-running-task',
      payload: {},
      fallbackMessage: `All running work stopped.`,
    });
  },
};

const approvePending: McpToolDefinition = {
  tool: {
    name: 'baget_approve_pending',
    description:
      'Approve the current pending cycle proposal — the CoS-suggested next batch direction. Use when the founder says "approve the plan", "go with the proposal", "sounds good, approve it". RUNS IMMEDIATELY — merges proposal direction into stored direction, no credit cost. Founder still says "launch the batch" separately to actually plan tasks.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    return dispatchDirect({
      action: 'approve-pending',
      payload: {},
      fallbackMessage: `Plan approved.`,
    });
  },
};

const rejectPending: McpToolDefinition = {
  tool: {
    name: 'baget_reject_pending',
    description:
      'Reject the current pending cycle proposal — silent decline. Use when the founder says "reject the plan", "no thanks", "we\'re not going that direction", "decline". RUNS IMMEDIATELY — clears the pending proposal without merging direction. No credit cost.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    return dispatchDirect({
      action: 'reject-pending',
      payload: {},
      fallbackMessage: `Plan rejected.`,
    });
  },
};

const pauseAd: McpToolDefinition = {
  tool: {
    name: 'baget_pause_ad',
    description:
      'Pause a running Meta ad campaign. Use when the founder says "pause the ad", "stop the campaign", "halt the launch ad". Optional campaignNameOrId (case-insensitive substring match on name); omit if there\'s only one running campaign. RUNS IMMEDIATELY (free — Meta does the cost accounting).',
    inputSchema: {
      type: 'object',
      properties: {
        campaignNameOrId: { type: 'string', minLength: 1, maxLength: 200 },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'pause-ad',
      payload: args.campaignNameOrId !== undefined ? { campaignNameOrId: String(args.campaignNameOrId) } : {},
      fallbackMessage: `Ad campaign paused.`,
    });
  },
};

const resumeAd: McpToolDefinition = {
  tool: {
    name: 'baget_resume_ad',
    description:
      'Resume a paused Meta ad campaign. Use when the founder says "resume the ad", "start the campaign back up", "unpause the launch ad". Same name-resolution rules as pause_ad (optional name; ambiguity asks for clarification). RUNS IMMEDIATELY (free).',
    inputSchema: {
      type: 'object',
      properties: {
        campaignNameOrId: { type: 'string', minLength: 1, maxLength: 200 },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'resume-ad',
      payload: args.campaignNameOrId !== undefined ? { campaignNameOrId: String(args.campaignNameOrId) } : {},
      fallbackMessage: `Ad campaign resumed.`,
    });
  },
};

// ── Tier 2 WRITE tools (direct) ─────────────────────────────────────────────
//
// Seven new direct (no approval card) write tools added by Tier 2
// (apps/web PRs #470, #472, #473, #475). Each fans through
// /approval/execute on the same channel-action substrate as the
// existing direct writes (set-direction, update-metric, etc.).
//
// All seven are intentionally NOT approval-gated:
//   - add_contact: free, reversible, high-frequency.
//   - create/preview/pause/resume_campaign: drafts/state toggles —
//     the actual money-spending gate is on send_campaign (Tier 1,
//     approval-gated).
//   - update_roadmap_item: low-risk edits, founder undoes from
//     dashboard if wrong.
//   - create_prospect_search: Apollo SEARCHES are free (only reveals
//     deduct credits, via baget_reveal_prospect). The plan's
//     "approval-gated" annotation was based on a misread of Apollo's
//     pricing model — see apps/web/src/lib/founder-chat/search-prospects.ts
//     for the full rationale.

const addContact: McpToolDefinition = {
  tool: {
    name: 'baget_add_contact',
    description:
      'Add a single contact (email + optional name/title/company) to the founder\'s contact list. Use when the founder says "add jane@acme.com", "save Bob from Acme — bob@acme.com, CEO", "I met Sarah, her email is sarah@x.com — add her to the list". RUNS IMMEDIATELY (free). The (companyId, email) UNIQUE INDEX is the natural dedup contract — a second call with the same email REFRESHES name/title/companyName but does NOT duplicate the row. Email is normalized (lowercased + trimmed) before insert. Source is recorded as "manual".',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', minLength: 3, maxLength: 320, description: 'Email address; gets lowercased + trimmed.' },
        name: { type: 'string', maxLength: 200, description: 'Display name (e.g., "Sam Founder").' },
        title: { type: 'string', maxLength: 200, description: 'Job title (e.g., "CEO", "VP Eng").' },
        companyName: { type: 'string', maxLength: 200, description: 'Employer (e.g., "Acme Inc.").' },
      },
      required: ['email'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'add-contact',
      payload: {
        email: String(args.email),
        ...(args.name !== undefined ? { name: String(args.name) } : {}),
        ...(args.title !== undefined ? { title: String(args.title) } : {}),
        ...(args.companyName !== undefined ? { companyName: String(args.companyName) } : {}),
      },
      fallbackMessage: `Contact added.`,
    });
  },
};

const createCampaign: McpToolDefinition = {
  tool: {
    name: 'baget_create_campaign',
    description:
      'Create a DRAFT email campaign — name + subject template + body template. Use when the founder says "draft a welcome email to all contacts", "make a campaign for the Series A announcement", "write a re-engagement email to the manual leads". Templates use Mustache-lite `{{ name }}`, `{{ email }}`, `{{ title }}`, `{{ company }}` interpolation against each recipient. RUNS IMMEDIATELY (free) — creates the draft only. Founder iterates with `baget_preview_campaign` then sends with `baget_send_campaign` (approval-gated, the actual money-spending gate).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200, description: 'Founder-facing label (e.g., "Welcome to Baget", "Series A announcement").' },
        subjectTemplate: { type: 'string', minLength: 1, maxLength: 500, description: 'Subject line with optional {{ var }} interpolation.' },
        bodyTemplate: { type: 'string', minLength: 1, maxLength: 50000, description: 'Body text with optional {{ var }} interpolation.' },
        segment: {
          type: 'string',
          enum: ['all', 'opted_in', 'source:manual', 'source:import', 'source:website_lead', 'source:prospect'],
          description: 'Recipient segment. Default "all". Use "source:manual" / "source:import" / etc. to target a specific origin.',
        },
      },
      required: ['name', 'subjectTemplate', 'bodyTemplate'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'create-campaign',
      payload: {
        name: String(args.name),
        subjectTemplate: String(args.subjectTemplate),
        bodyTemplate: String(args.bodyTemplate),
        ...(args.segment !== undefined ? { segment: String(args.segment) } : {}),
      },
      fallbackMessage: `Draft campaign created.`,
    });
  },
};

const previewCampaign: McpToolDefinition = {
  tool: {
    name: 'baget_preview_campaign',
    description:
      'Render the FIRST recipient\'s subject + body for a draft email campaign — sanity check before sending. Use when the founder says "show me what the email looks like", "preview the campaign", "render the welcome email for the first contact". Returns the rendered text WITH variable interpolation against the first recipient (alphabetical by email). If the segment has zero recipients, uses placeholder vars ([Sample Person] etc.). FLAGS missing merge fields (template references {{ unknownField }} but recipients don\'t provide it) so the founder can spot template bugs before send. RUNS IMMEDIATELY (free, read-only — no DB writes).',
    inputSchema: {
      type: 'object',
      properties: {
        campaignId: {
          type: 'string',
          format: 'uuid',
          description: 'UUID of the campaign to preview. Resolve from `baget_create_campaign`\'s response (the campaign id is in the activity log) or by listing campaigns from the dashboard.',
        },
      },
      required: ['campaignId'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'preview-campaign',
      payload: { campaignId: String(args.campaignId) },
      fallbackMessage: `Campaign preview rendered.`,
    });
  },
};

const pauseCampaign: McpToolDefinition = {
  tool: {
    name: 'baget_pause_campaign',
    description:
      'Pause a scheduled or actively-sending email campaign — stops further deliveries until resumed. Use when the founder says "pause the campaign", "stop the welcome series mid-flight", "halt the announcement". RUNS IMMEDIATELY (free). Status transitions: scheduled → paused, sending → paused. If the campaign is in any other state (draft / sent / cancelled / paused), returns a precise message ("can\'t pause a draft" / "already paused" / "already finished sending") so you know the action didn\'t take effect.',
    inputSchema: {
      type: 'object',
      properties: {
        campaignId: { type: 'string', format: 'uuid', description: 'UUID of the campaign to pause.' },
      },
      required: ['campaignId'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'pause-campaign',
      payload: { campaignId: String(args.campaignId) },
      fallbackMessage: `Campaign paused.`,
    });
  },
};

const resumeCampaign: McpToolDefinition = {
  tool: {
    name: 'baget_resume_campaign',
    description:
      'Resume a paused email campaign — flips status back to scheduled so deliveries continue. Use when the founder says "resume the campaign", "unpause it", "send the rest". RUNS IMMEDIATELY (free). Status transition: paused → scheduled. If the campaign is in any other state, returns a precise message ("already scheduled" / "already sending" / "already finished sending" / etc.) so you know the action didn\'t take effect.',
    inputSchema: {
      type: 'object',
      properties: {
        campaignId: { type: 'string', format: 'uuid', description: 'UUID of the campaign to resume.' },
      },
      required: ['campaignId'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'resume-campaign',
      payload: { campaignId: String(args.campaignId) },
      fallbackMessage: `Campaign resumed.`,
    });
  },
};

const updateRoadmapItem: McpToolDefinition = {
  tool: {
    name: 'baget_update_roadmap_item',
    description:
      'Edit a roadmap item — change title, description, horizon, or target metric. Use when the founder says "change the title of that goal", "move it to mid_term", "the target should be 1000 not 500", "rename it". Pass at least one of title/description/horizon/targetMetric. RUNS IMMEDIATELY (free). If the item was archived (e.g., by a Regenerate), returns a "was archived" message so you re-read the roadmap. Resolve `itemId` from `baget_read_roadmap` first; never guess UUIDs.',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', format: 'uuid', description: 'UUID of the roadmap item; resolve via baget_read_roadmap.' },
        title: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', maxLength: 4000, description: 'Empty string clears the description.' },
        horizon: { type: 'string', enum: ['short_term', 'mid_term', 'long_term'] },
        targetMetric: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            target: { type: 'number' },
            unit: { type: 'string', minLength: 1, maxLength: 24 },
          },
          required: ['name', 'target', 'unit'],
          additionalProperties: false,
          description: 'Structured measurable goal (e.g., { name: "MRR", target: 10000, unit: "$" }).',
        },
      },
      required: ['itemId'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'update-roadmap-item',
      payload: {
        itemId: String(args.itemId),
        ...(args.title !== undefined ? { title: String(args.title) } : {}),
        ...(args.description !== undefined ? { description: String(args.description) } : {}),
        ...(args.horizon !== undefined ? { horizon: String(args.horizon) } : {}),
        ...(args.targetMetric !== undefined ? { targetMetric: args.targetMetric } : {}),
      },
      fallbackMessage: `Roadmap item updated.`,
    });
  },
};

const createProspectSearch: McpToolDefinition = {
  tool: {
    name: 'baget_create_prospect_search',
    description:
      'Run a NEW Apollo prospect search — discover people matching the founder\'s ICP filters (titles, seniorities, locations, company size, etc.). Use when the founder says "find me Series A founders in NYC", "look up CEOs at companies with 50-200 employees in healthcare", "search for VPs of Engineering at SaaS companies". RUNS IMMEDIATELY (free — Apollo SEARCHES are 0 credits; reveals are 1 credit each via `baget_reveal_prospect`). Cap 500 leads per search. Provide AT LEAST ONE filter or the search is rejected (an empty query would return Apollo\'s entire database — useless and slow). Optional `name` for the dashboard label; defaults to a derived label from the filters.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'object',
          properties: {
            person_titles: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 100 }, maxItems: 20, description: 'Job titles to match. e.g., ["CEO", "Founder", "Co-Founder"].' },
            person_seniorities: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 40 }, maxItems: 10, description: 'Seniorities. e.g., ["c_suite", "founder", "vp"].' },
            person_locations: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 120 }, maxItems: 20, description: 'Person locations. e.g., ["United States", "California, US"].' },
            organization_num_employees_ranges: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 40 }, maxItems: 10, description: 'Org size buckets. e.g., ["11,50", "51,200"].' },
            organization_locations: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 120 }, maxItems: 20 },
            q_organization_domains_list: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 253 }, maxItems: 50, description: 'Specific company domains. e.g., ["stripe.com"].' },
            q_organization_keyword_tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 80 }, maxItems: 20, description: 'Industry keywords. e.g., ["fintech", "saas"].' },
            contact_email_status: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 40 }, maxItems: 10 },
            page: { type: 'integer', minimum: 1, maximum: 50 },
            per_page: { type: 'integer', minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
          description: 'Apollo filter object. At least ONE filter required.',
        },
        name: { type: 'string', minLength: 1, maxLength: 120, description: 'Optional dashboard label for the search.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'create-prospect-search',
      payload: {
        query: args.query as Record<string, unknown>,
        ...(args.name !== undefined ? { name: String(args.name) } : {}),
      },
      fallbackMessage: `Prospect search complete.`,
    });
  },
};

// ── WRITE tools (approval-gated) ─────────────────────────────────────────────

const runTask: McpToolDefinition = {
  tool: {
    name: 'baget_run_task',
    description:
      'Run ONE specific task right now — same as the founder tapping the per-task "Run" button on the dashboard. PREFER THIS over baget_launch_batch when the founder refers to a single task ("can you run THIS task", "run the competitor research one", "kick off task X"). Use baget_launch_batch only when the founder explicitly asks for "the batch", "all tasks", "everything queued". WHERE TO GET taskId: (a) the `[taskId=<uuid>]` suffix from the most recent baget_add_task response (use this when the founder JUST asked to add the task and now wants to run it — no extra calls needed), or (b) baget_get_company_overview which returns `tasks: [{ id, title, agentRole, status }]`. DO NOT use baget_list_recent_activity — that returns activity_log row IDs which are NOT task IDs. APPROVAL-GATED: first call returns the per-task cost preview ("X credits, you have Y remaining"); second call with confirmed: true actually enqueues.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          format: 'uuid',
          description: 'The UUID of the task to run. Sources, in order of preference: (a) the `[taskId=<uuid>]` suffix in the most recent baget_add_task response (when the founder JUST asked to add and now wants to run it — no extra calls needed), or (b) baget_get_company_overview which returns `tasks: [{ id, title, agentRole, status }]`. DO NOT use baget_list_recent_activity — it returns activity_log row IDs, NOT task IDs.',
        },
        confirmed: {
          type: 'boolean',
          description:
            'Set true ONLY after the founder has explicitly confirmed (e.g., "yes", "go ahead", "approve"). On the first call, omit or pass false to get the cost preview.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchApproval({
      action: 'run-task',
      payload: { taskId: String(args.taskId) },
      confirmed: args.confirmed === true,
      summary: 'Run this task — enqueues it now and the assigned specialist starts working.',
    });
  },
};

const launchBatch: McpToolDefinition = {
  tool: {
    name: 'baget_launch_batch',
    description:
      'Launch the ENTIRE backlog batch — same as the founder tapping "Run All" on the dashboard. Queues EVERY backlog task for the current batch. ONLY use when the founder explicitly asks for "the batch", "all tasks", "run everything", "kick off the batch". For a single task, use baget_run_task INSTEAD. APPROVAL-GATED: first call returns cost preview ("X credits, ~Y tasks"); second call (with confirmed: true) actually launches. Show the cost to the founder verbatim, ask them to confirm, then re-call.',
    inputSchema: {
      type: 'object',
      properties: {
        confirmed: {
          type: 'boolean',
          description:
            'Set true ONLY after the founder has explicitly confirmed (e.g., "yes", "go ahead", "approve"). On the first call, omit or pass false to get the cost preview.',
        },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchApproval({
      action: 'launch-batch',
      payload: {},
      confirmed: args.confirmed === true,
      summary: 'Launch the current batch — queues every backlog task and the team starts working.',
    });
  },
};

const editDocument: McpToolDefinition = {
  tool: {
    name: 'baget_edit_document',
    description:
      'Rewrite a specific document with founder-provided instructions. Kicks off a single rewrite task that runs IMMEDIATELY (skips the "wait for batch launch" detour). Use when the founder says "rewrite the BP for enterprise", "update the brand guide with the new colors", "shorten the pitch deck". Call list_documents FIRST. APPROVAL-GATED — costs credits because the worker runs the rewrite as a real task.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', format: 'uuid' },
        instructions: { type: 'string', minLength: 1, maxLength: 2000 },
        confirmed: { type: 'boolean' },
      },
      required: ['documentId', 'instructions'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchApproval({
      action: 'edit-document',
      payload: {
        documentId: String(args.documentId),
        instructions: String(args.instructions),
      },
      confirmed: args.confirmed === true,
      summary: `Rewrite the document with: ${String(args.instructions).slice(0, 80)}…`,
    });
  },
};

const revealProspect: McpToolDefinition = {
  tool: {
    name: 'baget_reveal_prospect',
    description:
      'Reveal email addresses for N prospects from the most-recent discovery search. Use when the founder says "reveal 10 leads", "unlock 20 prospects", "get me emails for the next 5". Costs 1 credit per SUCCESSFUL email match — fewer than `count` may be returned if some prospects have no matchable contact. APPROVAL-GATED — the cost preview shows the worst-case credit charge (= count) before the founder confirms. Cap is 100 from chat (vs 500 from dashboard) to limit runaway spends. WHEN RELAYING THE RESULT to the founder, ALWAYS state the actual reveal count vs the requested count — e.g. "Revealed 2 of the 3 you asked for (1 prospect had no matchable contact). Charged 2 credits." Never report the requested count as if it were the result; mismatch reads as a bug.\n\nOperates on the LATEST discovery search by default. If you don\'t know whether the founder has any discovered leads yet, call `baget_list_prospect_searches` first — if `searches[]` is empty or all rows are status="failed", reveal will fail with no source to draw from, and you should run `baget_create_prospect_search` instead. The chat agent often wants to reveal "more leads" without realising no search has actually run; this guard prevents the silent fail.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 100 },
        confirmed: { type: 'boolean' },
      },
      required: ['count'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const count = Number(args.count);
    return dispatchApproval({
      action: 'reveal-prospect',
      payload: { count },
      confirmed: args.confirmed === true,
      summary: `Reveal up to ${count} prospect email${count === 1 ? '' : 's'} (1 credit each on success).`,
    });
  },
};

const sendCampaign: McpToolDefinition = {
  tool: {
    name: 'baget_send_campaign',
    description:
      'Send a draft email campaign — atomically claims the draft and queues it for delivery via Resend. Use when the founder says "send the welcome series", "fire the August newsletter", "send the campaign". If only one draft exists, the name is optional; otherwise pass the substring match. APPROVAL-GATED — sending is irreversible. Recipient count comes back on the cost preview so the founder isn\'t surprised. NO baget credit cost (Resend bills per email separately).',
    inputSchema: {
      type: 'object',
      properties: {
        campaignNameOrId: { type: 'string', minLength: 1, maxLength: 200 },
        confirmed: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchApproval({
      action: 'send-campaign',
      payload: args.campaignNameOrId !== undefined ? { campaignNameOrId: String(args.campaignNameOrId) } : {},
      confirmed: args.confirmed === true,
      summary: args.campaignNameOrId
        ? `Send "${String(args.campaignNameOrId)}" to all eligible recipients.`
        : `Send the draft email campaign to all eligible recipients.`,
    });
  },
};

// ── Tier 3 cluster 1: Credits & billing ─────────────────────────────────────

const topupCredits: McpToolDefinition = {
  tool: {
    name: 'baget_topup_credits',
    description:
      "Generate a Stripe Checkout link the founder can tap to add credits. APPROVAL-GATED — surfaces a confirmation card with the dollar amount before the link is minted (the bot does NOT charge; it just generates a URL the founder taps in their browser). Use when the founder says \"I'm running low\" / \"add $20 in credits\" / \"top me up\". On confirm, baget.ai returns a `url` the LLM echoes verbatim; founder taps, completes Stripe Checkout, webhook fires, balance updates. Confirm with `baget_get_credits` after the founder reports completion. Apprenti tier rejected (zero credits-per-dollar). Range: $1–$1,000.\n\nFlow:\n1. First call: `confirmed: false` with `amountCents`.\n2. baget.ai surfaces approval card showing 'Generate a $X Stripe Checkout link?'\n3. Founder taps Approve → call again with `confirmed: true` and the IDENTICAL payload.\n4. baget.ai returns the URL — relay it verbatim.",
    inputSchema: {
      type: 'object',
      properties: {
        amountCents: {
          type: 'integer',
          minimum: 100,
          maximum: 100000,
          description: 'Amount in cents. e.g., 2000 = $20. Range [100, 100000].',
        },
        confirmed: {
          type: 'boolean',
          description:
            'Set to false on the first call (surfaces preview card). Set to true with the IDENTICAL payload after the founder confirms.',
        },
      },
      required: ['amountCents'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const amountCents = Number(args.amountCents);
    if (!Number.isInteger(amountCents) || amountCents < 100 || amountCents > 100000) {
      return fail('amountCents must be an integer in [100, 100000]');
    }
    const dollars = (amountCents / 100).toFixed(2);
    return dispatchApproval({
      action: 'topup-credits',
      payload: { amountCents },
      confirmed: args.confirmed === true,
      summary: `Generate a $${dollars} Stripe Checkout link to add credits to your wallet.`,
    });
  },
};

const getBillingHistory: McpToolDefinition = {
  tool: {
    name: 'baget_get_billing_history',
    description:
      "Read the founder's recent transaction history — top-ups, daily refills, task spending, refunds. Use when the founder asks \"did my last top-up go through?\" / \"what have I spent this week?\" / \"show me my recent charges\". Default 25 most recent; cap 50. Filter by `type` (\"credit\" / \"debit\" / \"withdrawal\" / \"hold\") to narrow. Pagination via opaque `cursor` (pass back `pagination.nextCursor` from a prior response).",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        type: {
          type: 'string',
          enum: ['credit', 'debit', 'withdrawal', 'hold'],
          description:
            'Optional filter. credit = top-up / treasury grant. debit = task spend. withdrawal = refund / chargeback. hold = pending ad-charge reservation.',
        },
        cursor: {
          type: 'string',
          description:
            'Opaque pagination cursor from a prior response. Pass `pagination.nextCursor` verbatim.',
        },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const q = buildQueryString(args, ['limit', 'type', 'cursor']);
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/billing${q}`,
    });
    if (!result.ok) return fail(`get_billing_history failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

// ── Tier 3 cluster 2: Customer site ─────────────────────────────────────────

const getSiteStatus: McpToolDefinition = {
  tool: {
    name: 'baget_get_site_status',
    description:
      "Read the founder's customer-facing site status — auto-deployed Vercel URL plus any custom domains they've configured (with DNS verification status). Use when the founder asks \"what's my URL\" / \"is my site live\" / \"did the domain finish verifying\". Returns `deploymentUrl` (the auto Vercel URL — always set on running companies), `hasCustomDomains` shortcut, and `customDomains` array. If the founder hasn't configured a custom domain, the auto URL is the answer.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/site`,
    });
    if (!result.ok) return fail(`get_site_status failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

// ── Tier 3 cluster 3: Email domains ─────────────────────────────────────────

const listEmailDomains: McpToolDefinition = {
  tool: {
    name: 'baget_list_email_domains',
    description:
      "Read the founder's configured email-sending domains — the custom domains they verified with Resend so emails come from their brand instead of baget.ai. Use when the founder asks \"what email domains do I have\" / \"is my custom sending domain verified\" / \"can I send from yourstartup.com yet\". Returns id, domainName, status (\"pending\" / \"verified\" / \"failed\" / etc), isPrimary, region, createdAt, verifiedAt. Empty array means the founder is still using baget.ai's managed sending address.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/email-domains`,
    });
    if (!result.ok) return fail(`list_email_domains failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

// ── Tier 3 cluster 4: Inbox ─────────────────────────────────────────────────

const listInbox: McpToolDefinition = {
  tool: {
    name: 'baget_list_inbox',
    description:
      "Read the founder's recent email threads — incoming replies + outbound conversations stitched into threads. Use when the founder asks \"what new emails came in\" / \"did Jane reply\" / \"search for 'pricing'\". Compact projection (no message bodies — use `baget_read_email_thread` for those). Default 25, cap 50. Optional `q` ILIKE search across subject + contactEmail + contactName (case-insensitive, max 100 chars). Filter by `status` (\"open\" / \"closed\"). Pagination via opaque `cursor`.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        cursor: {
          type: 'string',
          description:
            'Opaque pagination cursor from a prior response. Pass `pagination.nextCursor` verbatim.',
        },
        q: {
          type: 'string',
          maxLength: 100,
          description:
            'Optional search term. Matches anywhere in subject / contactEmail / contactName (case-insensitive).',
        },
        status: { type: 'string', enum: ['open', 'closed'] },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const q = buildQueryString(args, ['limit', 'cursor', 'q', 'status']);
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/inbox${q}`,
    });
    if (!result.ok) return fail(`list_inbox failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

const readEmailThread: McpToolDefinition = {
  tool: {
    name: 'baget_read_email_thread',
    description:
      "Read one email thread's full message history. Use AFTER `baget_list_inbox` when the founder asks \"show me the conversation with Jane\" / \"what did Bob write back\". Returns thread metadata + messages array (chronological) with bodyText (HTML→text converted) and `bodyTruncated` flag if a single message exceeded 8000 chars. Resolve `threadId` via `baget_list_inbox` first; never guess UUIDs.",
    inputSchema: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          format: 'uuid',
          description: 'UUID from baget_list_inbox.',
        },
      },
      required: ['threadId'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const threadId = String(args.threadId ?? '').trim();
    if (!threadId) return fail('threadId is required');
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/inbox/${encodeURIComponent(threadId)}`,
    });
    if (!result.ok) return fail(`read_email_thread failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

// ── Tier 3 cluster 5: Briefing controls ─────────────────────────────────────

const setBriefingPreferences: McpToolDefinition = {
  tool: {
    name: 'baget_set_briefing_preferences',
    description:
      "Change the founder's morning-briefing notification settings — snooze briefings for N days OR change cadence (daily / weekly / blockers-only). Either or both fields can be set in one call; at least one is required. Use when the founder asks \"snooze briefings for 3 days\" / \"switch me to weekly briefings\" / \"only ping me on blocker days\". `snoozeDays: 0` clears an active snooze (founder wants briefings back NOW). Range 0–30 days. RUNS IMMEDIATELY (free).",
    inputSchema: {
      type: 'object',
      properties: {
        snoozeDays: {
          type: 'integer',
          minimum: 0,
          maximum: 30,
          description:
            'Snooze briefing emails for this many days. 0 = clear snooze (resume now). 1–30 = future date.',
        },
        frequency: {
          type: 'string',
          enum: ['daily', 'weekly', 'blockers-only'],
          description:
            'daily = every day at morningHour. weekly = Monday only. blockers-only = only days with at least one blocker.',
        },
      },
      // Codex P2 on PR #53: at least one of snoozeDays / frequency
      // must be present. Without `anyOf`, the in-process Gemini
      // provider's `call.args ?? {}` happily passes `{}` to the
      // handler, which then POSTs an empty-body update upstream
      // (baget.ai's route returns 400 no-fields-provided, but we'd
      // rather fail locally and let the agent re-prompt).
      anyOf: [
        { required: ['snoozeDays'] },
        { required: ['frequency'] },
      ],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    // Defense-in-depth: even with the anyOf schema, some providers
    // skip JSON-Schema validation. Guard locally so we never POST a
    // no-op mutation upstream.
    if (args.snoozeDays === undefined && args.frequency === undefined) {
      return fail(
        'set_briefing_preferences: at least one of `snoozeDays` or `frequency` is required',
      );
    }
    const result = await bagetFetch({
      method: 'POST',
      path: `/api/companies/${ctx.companyId}/briefing/preferences`,
      body: {
        ...(args.snoozeDays !== undefined ? { snoozeDays: Number(args.snoozeDays) } : {}),
        ...(args.frequency !== undefined ? { frequency: String(args.frequency) } : {}),
      },
    });
    if (!result.ok) return fail(`set_briefing_preferences failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

// ── Tier 3.5: Vercel-backed domain & deploy tools ───────────────────────────

const checkDomainAvailability: McpToolDefinition = {
  tool: {
    name: 'baget_check_domain_availability',
    description:
      "Check whether a domain is available for purchase, and get the renewal price. Use when the founder asks \"is yourstartup.com available\" / \"how much for alpha.io\" / \"can I register foo-bar.app\". Returns `{ available, priceCents, period }` — `available: true` with `priceCents: null` means available but Vercel can't quote (rare TLD). NO purchase happens here — this is read-only. The buy-domain action is deferred to Tier 4 (needs careful Stripe-backed money flow). Range checked at the route layer (≤253 chars, RFC domain shape).",
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 3,
          maxLength: 253,
          description: "Domain to look up. Lowercased + trimmed before lookup. e.g. 'yourstartup.com'.",
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const name = String(args.name ?? '').trim().toLowerCase();
    if (!name) return fail('name is required');
    const q = buildQueryString({ name }, ['name']);
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/domain-availability${q}`,
    });
    if (!result.ok) return fail(`check_domain_availability failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

const redeploySite: McpToolDefinition = {
  tool: {
    name: 'baget_redeploy_site',
    description:
      "Trigger a fresh Vercel build of the founder's customer site so they can recover from a broken build without leaving Telegram. Use when the founder says \"redeploy my site\" / \"rebuild it\" / \"the site is broken, restart it\". APPROVAL-GATED — surfaces a confirm card first because a bad redeploy could clobber a working site. NO Baget credit cost; Vercel build minutes only (baget-paid). Same git ref re-pulled — NOT a regenerate-via-agent (that's `run-task` on a deploy task). On first call set `confirmed: false` to surface the preview; on the founder's explicit confirmation word, call again with `confirmed: true` and the IDENTICAL payload.",
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          minLength: 1,
          maxLength: 255,
          description:
            "Git ref to deploy. Default 'main'. Only set this if the founder asks to roll back to a specific branch or tag.",
        },
        confirmed: {
          type: 'boolean',
          description:
            'Set to false on the first call (surfaces preview card). Set to true with the IDENTICAL payload after the founder confirms.',
        },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchApproval({
      action: 'redeploy-site',
      payload: args.ref !== undefined ? { ref: String(args.ref) } : {},
      confirmed: args.confirmed === true,
      summary: args.ref
        ? `Redeploy the customer site from ref \`${String(args.ref)}\`.`
        : `Redeploy the customer site (latest main).`,
    });
  },
};

// ── Tier 4: domain purchase ──────────────────────────────────────────────────

const buyDomain: McpToolDefinition = {
  tool: {
    name: 'baget_buy_domain',
    description:
      "Register (purchase) a NEW domain on behalf of the founder. APPROVAL-GATED — surfaces a confirmation card with the domain name + price before charging. CHARGES THE FOUNDER'S SAVED CARD via Stripe. The bot CANNOT charge directly; baget.ai handles the Stripe → Vercel /v5/domains/buy → refund-on-failure flow synchronously.\n\nYou MUST call `baget_check_domain_availability` IMMEDIATELY before this — the price quoted there flows into `expectedPriceCents` so baget.ai can detect a price-jump race and refuse to charge above what the founder approved. baget.ai re-quotes anyway and refuses if the price moved beyond a $0.10 tolerance.\n\nFlow:\n1. First call: `confirmed: false` with `name` + `expectedPriceCents` from the prior availability check.\n2. baget.ai surfaces approval card showing 'Charge $X.XX to your VISA •••• 4242 to register yourstartup.com.'\n3. Founder taps Approve → call again with `confirmed: true` and the IDENTICAL payload.\n4. baget.ai charges → buys → attaches → returns `{ domain, expiresAt, addedToProject }`.\n\nFailure modes you need to be ready to relay verbatim: card declined, 3DS required (\"buy via dashboard\"), Vercel rejected (founder is auto-refunded), price changed at registry (auto-refunded, re-quote and try again). The `messageForFounder` in baget.ai's response always tells the truth — echo it.",
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 3,
          maxLength: 253,
          description: "Domain to register, e.g. 'yourstartup.com'. Lowercased + trimmed by baget.ai.",
        },
        expectedPriceCents: {
          type: 'integer',
          minimum: 1,
          maximum: 100000000,
          description: "Quoted price in CENTS from the prior baget_check_domain_availability call. baget.ai re-quotes and rejects if the price moved beyond $0.10.",
        },
        confirmed: {
          type: 'boolean',
          description: "Set to false on the first call (surfaces preview card). Set to true with the IDENTICAL payload after the founder confirms.",
        },
      },
      required: ['name', 'expectedPriceCents'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const name = String(args.name ?? '').trim().toLowerCase();
    if (!name) return fail('name is required');
    const expectedPriceCents = Number(args.expectedPriceCents);
    if (!Number.isInteger(expectedPriceCents) || expectedPriceCents <= 0) {
      return fail('expectedPriceCents must be a positive integer');
    }
    const dollars = (expectedPriceCents / 100).toFixed(2);

    // DS-audit follow-up (2026-05-07). The approval-card summary used to
    // say "your saved card" — founders with multiple PMs had no idea
    // which card was about to be charged. Pre-fetch the default PM so we
    // can interpolate `${BRAND} ••••${LAST4}` into the summary text the
    // founder is approving. Best-effort: if the lookup fails (no card,
    // provider outage, fork talking to an old baget.ai before the route
    // existed, the new endpoint is slow / unreachable, etc.) we fall
    // back to "your saved card" — the server side still re-validates
    // payment in `buyDomain.execute`, so the worst case is a slightly
    // less informative card, never a wrong charge.
    //
    // Code review (PR #58, 2026-05-07):
    // - Skip the lookup on the second turn. `cardLabel` only feeds the
    //   approval summary which is shown ONLY on the first turn (when
    //   `confirmed` is false). Pre-#58 we hit the route on every call.
    //   [Gemini HIGH]
    // - Wrap `bagetFetch` in a try/catch — `fetch(..., AbortSignal.
    //   timeout(...))` REJECTS on timeout instead of returning
    //   `{ok: false}`, so a slow PM endpoint would fail the buy
    //   instead of silently degrading to "your saved card". [Codex P2]
    // - Null-check `pmRes.data` — bagetFetch can return ok:true with a
    //   null body if the response isn't valid JSON. [Gemini HIGH]
    let cardLabel = 'your saved card';
    if (args.confirmed !== true) {
      const ctx = requireCompanyId();
      if (!ctx.ok) return fail(ctx.error);
      try {
        const pmRes = await bagetFetch<{
          hasCard: boolean;
          brand?: string;
          last4?: string;
        }>({
          method: 'GET',
          path: `/api/companies/${ctx.companyId}/payment-method`,
        });
        if (
          pmRes.ok &&
          pmRes.data?.hasCard &&
          pmRes.data?.brand &&
          pmRes.data?.last4
        ) {
          const brand = String(pmRes.data.brand).toUpperCase();
          cardLabel = `${brand} ••••${pmRes.data.last4}`;
        }
      } catch {
        // Network / timeout / abort — keep the generic fallback.
      }
    }

    return dispatchApproval({
      action: 'buy-domain',
      payload: { name, expectedPriceCents },
      confirmed: args.confirmed === true,
      summary: `Register **${name}** for $${dollars}/year. Charges ${cardLabel}.`,
    });
  },
};

// ── Register ─────────────────────────────────────────────────────────────────

registerTools([
  // Read (existing)
  getCompanyOverview,
  queryMetrics,
  getCredits,
  listRecentActivity,
  listDocuments,
  readDocument,
  // Read — Tier 2
  listContacts,
  exportContacts,
  listProspectSearches,
  getProspectSearchLeads,
  readRoadmap,
  readAdMetrics,
  // Read — Tier 3
  getBillingHistory,
  getSiteStatus,
  listEmailDomains,
  listInbox,
  readEmailThread,
  // Read — Tier 3.5
  checkDomainAvailability,
  // File transfer
  sendDocumentFile,
  sendDeckVisuals,
  // Generate
  generateImage,
  // Write — direct (existing)
  setDirection,
  updateMetric,
  archiveMetric,
  addMetricHistory,
  setMetricTarget,
  addTask,
  parkTask,
  cancelRunningTasks,
  approvePending,
  rejectPending,
  pauseAd,
  resumeAd,
  // Write — direct (Tier 2)
  addContact,
  createCampaign,
  previewCampaign,
  pauseCampaign,
  resumeCampaign,
  updateRoadmapItem,
  createProspectSearch,
  // Write — direct (Tier 3)
  setBriefingPreferences,
  // Write — approval-gated
  launchBatch,
  runTask,
  editDocument,
  revealProspect,
  sendCampaign,
  // Write — approval-gated (Tier 3)
  topupCredits,
  // Write — approval-gated (Tier 3.5)
  redeploySite,
  // Write — approval-gated (Tier 4)
  buyDomain,
]);

log(
  'baget MCP tools registered: 18 read + 1 file-transfer + 1 generate + 21 direct write + 7 approval-gated = 50 total (Tier 4: +1 approval-gated)',
);
