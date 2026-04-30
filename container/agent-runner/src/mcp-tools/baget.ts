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
 * Initial scope (proves the wire-up):
 *   - 3 read tools: company overview, query metrics, list documents
 *   - 1 write tool: set founder direction
 *
 * Remaining 16+ tools land in subsequent commits, mirroring the
 * existing implementations in
 * BagetAI/baget.ai/apps/web/src/lib/channels/agent/tools/{read,write}.ts.
 */
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools/baget] ${msg}`);
}

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Baget API base URL. Read from env at request time so a container
 * spawned for staging hits stg-app.baget.ai and a prod container hits
 * app.baget.ai. The fallback is staging — fail-safe to a non-billing
 * environment if config is missing.
 */
function getBagetApiBase(): string {
  return process.env.BAGET_API_BASE_URL ?? 'https://stg-app.baget.ai';
}

/**
 * Channel bearer token for the (user, company) tuple this container is
 * scoped to. Injected by OneCLI from the agent's vault — never read from
 * a plain env var. The token is minted by Baget's auth bridge and
 * scoped to a single (user_id, company_id, conversation_id); revoking it
 * from the dashboard immediately invalidates this container's writes.
 *
 * If the token is missing the tools fail closed — better to surface a
 * configuration error than to make unauthenticated calls.
 */
function getChannelToken(): string | null {
  // OneCLI populates BAGET_CHANNEL_TOKEN at request time when
  // `secret_mode: selective` includes this credential for the agent.
  return process.env.BAGET_CHANNEL_TOKEN ?? null;
}

/**
 * Company id this container is acting on behalf of. Set at container
 * spawn time from the agent group's container_config — one container =
 * one company. Cross-tenant pivot is impossible at this layer because
 * the tools never accept a companyId argument from the model.
 */
function getCompanyId(): string | null {
  return process.env.BAGET_COMPANY_ID ?? null;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

interface BagetFetchArgs {
  method: 'GET' | 'POST';
  path: string; // e.g. "/api/companies/<id>/approval/execute"
  body?: unknown;
}

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

async function bagetFetch<T = unknown>(
  args: BagetFetchArgs,
): Promise<BagetFetchOk<T> | BagetFetchErr> {
  const token = getChannelToken();
  if (!token) {
    return {
      ok: false,
      status: 0,
      error:
        'BAGET_CHANNEL_TOKEN missing. Container is not authenticated to baget.ai. Re-pair the channel from the Baget dashboard.',
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
    signal: AbortSignal.timeout(15_000),
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
      error:
        'BAGET_COMPANY_ID not set. This container is not bound to a company. Check the agent group config.',
    };
  }
  return { ok: true, companyId };
}

// ── Tools ─────────────────────────────────────────────────────────────────────

/**
 * Read-only — fetch the founder's company overview (name, current batch,
 * status, top-line metrics). Cheap; safe to call early in every turn so
 * the agent has fresh context.
 */
const getCompanyOverview: McpToolDefinition = {
  tool: {
    name: 'baget_get_company_overview',
    description:
      'Fetch the founder\'s company overview — name, status, current batch number, top metrics. Use at the start of every conversation to ground your reply in the latest state.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  async handler() {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);

    const result = await bagetFetch<{ company: unknown }>({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/overview`,
    });
    if (!result.ok) return fail(`get_company_overview failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

/**
 * Read-only — current values + last-7-points history for every active
 * metric the founder is tracking. Capped at 3 active metrics by Baget's
 * MAX_ACTIVE_METRICS rule.
 */
const queryMetrics: McpToolDefinition = {
  tool: {
    name: 'baget_query_metrics',
    description:
      'Get current values + recent history for the founder\'s active business metrics (waitlist, MRR, signups, etc.). Always call this before answering ANY question about a number, KPI, or trend — never invent metrics.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  async handler() {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);

    const result = await bagetFetch<{ metrics: unknown[] }>({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/metrics`,
    });
    if (!result.ok) return fail(`query_metrics failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

/**
 * Read-only — list of documents the team has produced (BP, brand
 * guide, pitch deck, research). Returns id + title + category so the
 * agent can pick one for `read_document` or `edit_document`.
 */
const listDocuments: McpToolDefinition = {
  tool: {
    name: 'baget_list_documents',
    description:
      'List the founder\'s documents — business plan, brand guide, pitch deck, research, etc. Returns id, title, category, and createdAt for each. Call this first before referring to a specific document by name; never guess document ids.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  async handler() {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);

    const result = await bagetFetch<{ documents: unknown[] }>({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/documents`,
    });
    if (!result.ok) return fail(`list_documents failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

/**
 * Write — save the founder's direction for the next batch. Routes
 * through the same `/approval/execute` endpoint the dashboard's
 * direction-save modal uses, so auth + rate limit + tenant guard +
 * activity log are identical between web and chat.
 *
 * NOT approval-gated — direction-save is free (no credits deduct).
 * The approval card is reserved for credit-burning, irreversible
 * actions (launch_batch, edit_document, reveal_prospect, send_campaign).
 */
const setDirection: McpToolDefinition = {
  tool: {
    name: 'baget_set_direction',
    description:
      'Save the founder\'s direction for the next batch — same as editing the direction box on the dashboard and clicking Save. Use when the founder says "set direction to focus on X", "I want us to prioritize Y", "pivot toward Z". Direction-save does NOT plan a new batch by itself; the founder will say "launch the batch" separately. RUNS IMMEDIATELY (free). Confirm naturally in your reply.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          description:
            'The founder\'s new direction text. Distill the founder\'s intent into a clear 1-2 sentence direction; do NOT just echo their words verbatim if they were vague.',
          minLength: 1,
          maxLength: 2000,
        },
      },
      required: ['direction'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);

    const direction = typeof args.direction === 'string' ? args.direction : '';
    if (!direction || direction.length > 2000) {
      return fail('direction must be 1–2000 chars');
    }

    const result = await bagetFetch<{ ok: boolean; messageForFounder?: string }>({
      method: 'POST',
      path: `/api/companies/${ctx.companyId}/approval/execute`,
      body: {
        action: 'set-direction',
        payload: { direction },
      },
    });
    if (!result.ok) return fail(`set_direction failed: ${result.error}`);

    // The /execute route returns a `messageForFounder` string the agent
    // can echo verbatim — keeps the chat reply consistent with what the
    // dashboard would show.
    const msg = result.data.messageForFounder ?? `Direction saved: ${direction.slice(0, 80)}.`;
    return ok(msg);
  },
};

// ── Register ─────────────────────────────────────────────────────────────────

registerTools([getCompanyOverview, queryMetrics, listDocuments, setDirection]);

log('baget MCP tools registered: 3 read + 1 write');
