/**
 * Baget web-chat channel adapter.
 *
 * Mirrors the founder's conversation onto the baget.ai dashboard. The
 * dashboard opens a WebSocket per agent_group and posts founder
 * messages over it; team replies (whether routed through here or
 * through Telegram) flow back via the cross-channel mirror module.
 *
 * Three transport surfaces, all sharing the admin server's HTTP
 * listener (Railway exposes one public port per service):
 *
 *   1. POST /api/channels/web/messages/:agentGroupId — founder posts a
 *      new message. Bearer-token gated. Returns the persisted record
 *      so the dashboard can insert it optimistically and reconcile.
 *
 *   2. GET  /api/channels/web/messages/:agentGroupId[?since=<iso>]
 *      — load history (full or incremental). Bearer-token gated.
 *
 *   3. WSS /api/channels/web/ws/:agentGroupId — live feed. Bearer
 *      passed via `Authorization: Bearer …` header (preferred) or the
 *      `?token=…` query parameter (fallback for browser clients that
 *      can't set custom headers on WebSocket connect).
 *
 * Auth model: `BAGET_ADMIN_TOKEN` for now — same constant-time check
 * as the rest of the admin surface. The cross-repo follow-up in
 * baget.ai will replace this with a per-(user, company) Clerk-issued
 * token; the admin token gate is the seam where that swap happens.
 *
 * Outbound `deliver()` does NOT write to the cross-channel log nor
 * broadcast — both are the mirror's job and live one layer up so a
 * Telegram-originated team reply also reaches dashboard subscribers
 * without the web adapter being on the call path. `deliver()`'s only
 * responsibility is to be a no-op endpoint for messages targeted at a
 * `baget-web` platform_id; the broadcast already happened in the
 * mirror (post-delivery hook), and there is no platform-side render
 * to perform.
 */
import { randomUUID } from 'crypto';
import http from 'http';

import { WebSocketServer, type WebSocket } from 'ws';

import {
  compareTokensConstantTime,
  registerExtraRoute,
  registerExtraUpgradeRoute,
  verifyAdminBearer,
} from '../baget-admin-server.js';
import {
  findConversationByAgentGroup,
  listMessages,
  type BagetWebMessageAttachment,
} from '../db/baget-web-conversations.js';
import { addSubscriber, removeSubscriber } from '../baget-web-broadcast.js';
import { getBagetAgentGroupById } from '../db/baget-agent-groups.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

export const BAGET_WEB_CHANNEL_TYPE = 'baget-web';
const PLATFORM_PREFIX = 'baget-web:';

const HTTP_ROUTE_PREFIX = '/api/channels/web/messages/';
const WS_ROUTE_PREFIX = '/api/channels/web/ws/';

/** Inbound payload the dashboard sends over WS or POSTs to the messages endpoint. */
interface InboundFounderPayload {
  text?: string;
  attachments?: BagetWebMessageAttachment[];
  /** Optional client-provided dedup id; falls back to a fresh uuid. */
  clientId?: string;
}

export interface BagetWebConfig {
  /** Bearer token clients must present. Same constant-time check as the rest of the admin surface. */
  adminToken: string;
}


/**
 * Pull a bearer token from a `?token=…` query parameter. Required for
 * WebSocket clients in the browser — `new WebSocket(url)` cannot set
 * an `Authorization` header, so the query-param fallback is the only
 * way to authenticate before the upgrade completes.
 */
function bearerFromQuery(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const idx = url.indexOf('?');
  if (idx === -1) return undefined;
  const params = new URLSearchParams(url.slice(idx + 1));
  const t = params.get('token');
  return t ?? undefined;
}

/**
 * Authenticate a request that may carry the bearer in either the
 * Authorization header (preferred) OR the `?token=…` query parameter
 * (browser WS fallback). Header path delegates to `verifyAdminBearer`
 * so the constant-time compare lives in exactly one place.
 */
function authenticateRequest(req: http.IncomingMessage, expected: string): boolean {
  if (verifyAdminBearer(req.headers.authorization, expected)) return true;
  return compareTokensConstantTime(bearerFromQuery(req.url), expected);
}

// Validates the shape of an `agent_group_id` URL segment. The
// canonical id format created by the admin server is `ag-<uuid>`
// (see `generateAgentGroupId` callsites). The narrower regex below
// is intentionally permissive (matches the legacy hand-set ids in
// fixtures while rejecting path-traversal / control-char garbage)
// and shrinks the per-id 404 oracle attackers can scrape.
const AGENT_GROUP_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function parseAgentGroupFromUrl(url: string, prefix: string): string | null {
  if (!url.startsWith(prefix)) return null;
  const tail = url.slice(prefix.length);
  // Strip query string + trailing slash. Reject empty segments.
  const id = tail.split('?')[0]!.replace(/\/+$/, '');
  if (!AGENT_GROUP_ID_PATTERN.test(id)) return null;
  return id;
}

function platformIdFor(agentGroupId: string): string {
  return `${PLATFORM_PREFIX}${agentGroupId}`;
}

function agentGroupIdFromPlatformId(platformId: string): string | null {
  if (!platformId.startsWith(PLATFORM_PREFIX)) return null;
  return platformId.slice(PLATFORM_PREFIX.length);
}

/**
 * Read the entire request body up to a hard cap. Mirrors the
 * admin-server pattern (no body-parser dep) so this module stays
 * dependency-light.
 */
async function readJsonBody<T>(req: http.IncomingMessage, max: number): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > max) {
        aborted = true;
        req.destroy();
        resolve({ ok: false, error: 'body_too_large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.length === 0) {
        resolve({ ok: true, value: {} as T });
        return;
      }
      try {
        resolve({ ok: true, value: JSON.parse(text) as T });
      } catch {
        resolve({ ok: false, error: 'invalid_json' });
      }
    });
    req.on('error', () => {
      if (!aborted) resolve({ ok: false, error: 'read_error' });
    });
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Mirrors the `InboundAttachment.kind` union in src/channels/adapter.ts
// — keep these in sync. An attachment with an unknown kind is dropped
// rather than passed through, matching the Telegram adapter's
// strictness on inbound media types.
const ALLOWED_ATTACHMENT_KINDS: ReadonlySet<string> = new Set([
  'photo',
  'document',
  'voice',
  'video',
  'video_note',
  'audio',
]);

function sanitizeAttachments(raw: unknown): BagetWebMessageAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: BagetWebMessageAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (typeof a.kind !== 'string' || !ALLOWED_ATTACHMENT_KINDS.has(a.kind)) continue;
    out.push({
      kind: a.kind,
      path: typeof a.path === 'string' ? a.path : undefined,
      caption: typeof a.caption === 'string' ? a.caption : undefined,
      filename: typeof a.filename === 'string' ? a.filename : undefined,
      mimeType: typeof a.mimeType === 'string' ? a.mimeType : undefined,
      sizeBytes: typeof a.sizeBytes === 'number' ? a.sizeBytes : undefined,
    });
  }
  return out;
}

/** True when the agent_group exists and isn't soft-deleted. */
function isLiveAgentGroup(agentGroupId: string): boolean {
  const ag = getBagetAgentGroupById(agentGroupId);
  return !!ag && !ag.archived_at;
}

interface BuildAdapterDeps {
  /**
   * Override the WebSocketServer constructor for tests. Not used at
   * runtime — the real adapter constructs its own WSS without
   * binding a port (it consumes the upgrade event from the admin
   * server's listener).
   */
  _testWebSocketServerFactory?: () => WebSocketServer;
}

export function buildAdapter(cfg: BagetWebConfig, deps: BuildAdapterDeps = {}): ChannelAdapter {
  let setup: ChannelSetup | null = null;
  let unregisterRoute: (() => void) | null = null;
  let unregisterUpgrade: (() => void) | null = null;
  // `noServer: true` skips port binding; we hand each upgrade through
  // wss.handleUpgrade() inside the admin server's upgrade dispatcher.
  // `maxPayload` mirrors the HTTP body cap (256 KiB) so a malicious or
  // buggy client can't send arbitrarily large frames over WS that the
  // HTTP path would have rejected.
  const wss: WebSocketServer = deps._testWebSocketServerFactory
    ? deps._testWebSocketServerFactory()
    : new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  // ── HTTP routes ──

  async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '';
    const method = (req.method ?? 'GET').toUpperCase();
    const agentGroupId = parseAgentGroupFromUrl(url, HTTP_ROUTE_PREFIX);
    if (!agentGroupId) {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }

    if (!authenticateRequest(req, cfg.adminToken)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }

    if (!isLiveAgentGroup(agentGroupId)) {
      sendJson(res, 404, { ok: false, error: 'agent_group_not_found' });
      return;
    }

    if (method === 'GET') {
      const since = new URL(url, 'http://localhost').searchParams.get('since') ?? undefined;
      const conv = findConversationByAgentGroup(agentGroupId);
      if (!conv) {
        sendJson(res, 200, { ok: true, conversationId: null, messages: [] });
        return;
      }
      const messages = listMessages(conv.conversation_id, since);
      sendJson(res, 200, { ok: true, conversationId: conv.conversation_id, messages });
      return;
    }

    if (method === 'POST') {
      const body = await readJsonBody<InboundFounderPayload>(req, 256 * 1024);
      if (!body.ok) {
        sendJson(res, 400, { ok: false, error: body.error });
        return;
      }
      const ok = await ingestFounderMessage(agentGroupId, body.value);
      if (!ok) {
        sendJson(res, 400, { ok: false, error: 'empty_message' });
        return;
      }
      sendJson(res, 202, { ok: true });
      return;
    }

    sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  // ── WebSocket route ──

  async function handleUpgrade(req: http.IncomingMessage, socket: import('stream').Duplex, head: Buffer): Promise<void> {
    const url = req.url ?? '';
    const agentGroupId = parseAgentGroupFromUrl(url, WS_ROUTE_PREFIX);
    if (!agentGroupId) {
      rejectUpgrade(socket, 404);
      return;
    }
    if (!authenticateRequest(req, cfg.adminToken)) {
      rejectUpgrade(socket, 401);
      return;
    }
    if (!isLiveAgentGroup(agentGroupId)) {
      rejectUpgrade(socket, 404);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      attachWebSocket(ws, agentGroupId);
    });
  }

  function attachWebSocket(ws: WebSocket, agentGroupId: string): void {
    if (!addSubscriber(agentGroupId, ws)) {
      // Per-agent_group cap reached; close with policy-violation
      // (close code 1008) so the client can see why and back off.
      ws.close(1008, 'subscriber_limit');
      return;
    }
    log.info('baget-web ws: subscribed', { agentGroupId });

    ws.on('message', (raw) => {
      void handleSocketMessage(ws, agentGroupId, raw);
    });
    ws.on('close', () => {
      removeSubscriber(agentGroupId, ws);
      log.info('baget-web ws: unsubscribed', { agentGroupId });
    });
    ws.on('error', (err) => {
      log.warn('baget-web ws: socket error', { err, agentGroupId });
      // ws emits 'close' after 'error', so the registry cleanup
      // happens in the close handler — no double-remove needed here.
    });
  }

  async function handleSocketMessage(ws: WebSocket, agentGroupId: string, raw: WebSocket.RawData): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'invalid_json' }));
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      ws.send(JSON.stringify({ type: 'error', error: 'invalid_payload' }));
      return;
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (obj.type !== 'message') {
      ws.send(JSON.stringify({ type: 'error', error: 'unknown_type' }));
      return;
    }
    const payload: InboundFounderPayload = {
      text: typeof obj.text === 'string' ? obj.text : undefined,
      attachments: sanitizeAttachments(obj.attachments),
      clientId: typeof obj.clientId === 'string' ? obj.clientId : undefined,
    };
    const ok = await ingestFounderMessage(agentGroupId, payload);
    if (!ok) {
      ws.send(JSON.stringify({ type: 'error', error: 'empty_message' }));
      return;
    }
    // No per-socket ack: the broadcast that fires from `mirrorInbound`
    // (via setup.onInbound below) is the source of truth that all
    // tabs (including the originator) reconcile against.
  }

  // ── Founder ingest ──

  /**
   * Forward a dashboard-originated message into the channel pipeline
   * via `setup.onInbound`. The cross-channel mirror module — wrapped
   * around `setup.onInbound` in src/index.ts — is the SOLE writer to
   * `baget_web_messages` and the SOLE caller of broadcastToAgentGroup.
   * Returns true when the payload had content to forward, false when
   * the dashboard sent an empty message.
   *
   * We deliberately do NOT touch the conversation log here: handing
   * the write to the mirror keeps a single timeline ordering whether
   * the inbound came from baget-web, baget-telegram, or any future
   * channel — and avoids the double-write that would happen if both
   * the adapter AND the central hook persisted.
   */
  async function ingestFounderMessage(agentGroupId: string, payload: InboundFounderPayload): Promise<boolean> {
    const text = typeof payload.text === 'string' && payload.text.length > 0 ? payload.text : null;
    const attachments = payload.attachments ?? [];
    if (text === null && attachments.length === 0) return false;

    if (!setup) {
      log.warn('baget-web: founder message before adapter setup() resolved', { agentGroupId });
      return false;
    }

    const nowIso = new Date().toISOString();
    // Use the dashboard's `clientId` as the message id when supplied
    // so retries (POST or WS replay after a reconnect) deduplicate
    // against the same row instead of producing duplicate
    // conversation entries and duplicate runner wakeups. We namespace
    // it to keep message-id format predictable downstream and to
    // prevent collision with server-minted ids.
    const messageId = payload.clientId
      ? `bwm-client-${payload.clientId}`
      : `bwm-${randomUUID()}`;
    const inbound: InboundMessage = {
      id: messageId,
      kind: 'chat',
      timestamp: nowIso,
      content: { text: text ?? '', sender: 'baget-web', senderId: `baget-web:${agentGroupId}` },
      isMention: true,
      isGroup: false,
      ...(attachments.length > 0
        ? {
            attachments: attachments
              .filter((a) => typeof a.path === 'string')
              .map((a) => ({
                // Inbound contract requires a non-empty path/mimeType/sizeBytes/platformFileId.
                // Web-uploaded files are out of scope this PR — surface a
                // placeholder so the runner sees attachments are present
                // without breaking the type contract.
                kind: (a.kind as 'photo' | 'document' | 'voice' | 'video' | 'video_note' | 'audio') ?? 'document',
                path: a.path!,
                mimeType: a.mimeType ?? 'application/octet-stream',
                sizeBytes: a.sizeBytes ?? 0,
                platformFileId: a.filename ?? messageId,
                originalName: a.filename,
              })),
          }
        : {}),
    };
    try {
      await setup.onInbound(platformIdFor(agentGroupId), null, inbound);
    } catch (err) {
      log.error('baget-web: onInbound threw', { err, agentGroupId });
    }
    return true;
  }

  // ── Outbound (no-op render; broadcast already handled by mirror) ──

  async function deliver(
    platformId: string,
    _threadId: string | null,
    _message: OutboundMessage,
  ): Promise<string | undefined> {
    const agentGroupId = agentGroupIdFromPlatformId(platformId);
    if (!agentGroupId) {
      log.warn('baget-web deliver: platform_id not in baget-web namespace', { platformId });
      return undefined;
    }
    // The cross-channel mirror writes the row + broadcasts AFTER this
    // deliver returns. Returning a synthetic platform message id so
    // the upstream `markDelivered` path has something stable to
    // record. UUID rather than hash so the id is unique per delivery
    // attempt — `markDelivered` keys on `messages_out.id` already, so
    // this is purely informational on the host side.
    return `bwm-deliver-${randomUUID()}`;
  }

  return {
    name: 'baget-web',
    channelType: BAGET_WEB_CHANNEL_TYPE,
    supportsThreads: false,
    mediaSupport: {
      // Phase 1: text-only delivery. Inbound carries client-provided
      // attachment metadata for the runner; outbound rendering of
      // attachments to the dashboard is a follow-up (the dashboard
      // already shows attachments via the cross-channel mirror feed,
      // so deliver() doesn't need to push them itself).
      photo: false,
      document: false,
      maxBytesPerAttachment: 0,
    },

    async setup(s: ChannelSetup): Promise<void> {
      setup = s;
      unregisterRoute = registerExtraRoute(
        (method, url) =>
          (method === 'GET' || method === 'POST') && url.startsWith(HTTP_ROUTE_PREFIX),
        (req, res) => handleHttp(req, res),
      );
      unregisterUpgrade = registerExtraUpgradeRoute(
        (url) => url.startsWith(WS_ROUTE_PREFIX),
        (req, socket, head) => handleUpgrade(req, socket, head),
      );
      log.info('baget-web channel registered on shared admin listener');
    },

    async teardown(): Promise<void> {
      if (unregisterRoute) {
        unregisterRoute();
        unregisterRoute = null;
      }
      if (unregisterUpgrade) {
        unregisterUpgrade();
        unregisterUpgrade = null;
      }
      // Close every live socket. wss.close() walks the client set and
      // sends a close frame on each.
      for (const ws of wss.clients) {
        try {
          ws.close(1001, 'server_shutdown');
        } catch {
          // socket already gone
        }
      }
      wss.close();
      setup = null;
    },

    isConnected(): boolean {
      return unregisterRoute !== null;
    },

    deliver,
  };
}

// ── Helpers ──

function rejectUpgrade(socket: import('stream').Duplex, status: number): void {
  const reason =
    status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : status === 405 ? 'Method Not Allowed' : 'Bad Request';
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  } catch {
    // socket already gone
  }
}

// ── Registration ──
//
// Gated on BAGET_ADMIN_TOKEN: the bearer-auth check uses it directly,
// and a host without the admin server doesn't expose the listener
// this adapter would attach to.
if (process.env.BAGET_ADMIN_TOKEN && process.env.BAGET_ADMIN_TOKEN.length >= 16) {
  registerChannelAdapter(BAGET_WEB_CHANNEL_TYPE, {
    factory: () =>
      buildAdapter({
        adminToken: process.env.BAGET_ADMIN_TOKEN!,
      }),
  });
}

// Test exports — unit tests construct a fresh adapter without touching
// env or the channel-registry singleton.
export const _testBuildBagetWebAdapter = buildAdapter;
export const _testHttpRoutePrefix = HTTP_ROUTE_PREFIX;
export const _testWsRoutePrefix = WS_ROUTE_PREFIX;
