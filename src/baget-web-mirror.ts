/**
 * Cross-channel conversation mirror.
 *
 * The founder's conversation with the team is currently fragmented per
 * channel: a Telegram thread and the dashboard chat panel are separate
 * even though they reach the same agent_group. This module is the
 * SOLE writer to `baget_web_messages` — it intercepts every founder→team
 * (inbound) and team→founder (outbound) message regardless of which
 * channel adapter handled it, persists it under one shared
 * conversation, and broadcasts to dashboard WebSocket subscribers.
 *
 * Wired in src/index.ts:
 *
 *   - Inbound: the `setupFn` that builds each channel's `ChannelSetup`
 *     wraps `onInbound` so every adapter's inbound message hits
 *     `mirrorInbound` before the router sees it.
 *
 *   - Outbound: the `deliveryAdapter` shim wraps `deliver` to call
 *     `mirrorOutbound` AFTER the underlying channel adapter
 *     successfully delivers (so a phantom "team replied" never appears
 *     for failed deliveries).
 *
 * Both paths skip silently when:
 *   - The `baget_web_messages` table doesn't exist (a fresh checkout
 *     pre-migration, or a host running without migrations).
 *   - The (channelType, platformId) tuple doesn't resolve to a wired
 *     agent_group (unpaired chats, /start handshakes, ghost sessions).
 *
 * No double-write: the baget-web adapter itself does NOT write to the
 * log directly. Its inbound hits this module via setup.onInbound, its
 * outbound hits this module via the deliveryAdapter wrap.
 */
import { hasTable, getDb } from './db/connection.js';
import {
  appendMessage,
  findMessageBySource,
  getOrCreateConversation,
  type BagetWebMessageAttachment,
} from './db/baget-web-conversations.js';
import { getBagetAgentGroupById } from './db/baget-agent-groups.js';
import { getMessagingGroupByPlatform, getMessagingGroupAgents } from './db/messaging-groups.js';
import { broadcastToAgentGroup, type BroadcastMessageEvent } from './baget-web-broadcast.js';
import { log } from './log.js';
import type { InboundAttachment, InboundMessage, OutboundAttachment, OutboundFile } from './channels/adapter.js';

const TABLE = 'baget_web_messages';
const BAGET_WEB_PLATFORM_PREFIX = 'baget-web:';

/**
 * Resolve the agent_group bound to (channelType, platformId), or null
 * when the chat is unpaired / has no wired agent / the agent_group is
 * archived. Bypasses entirely when the migration hasn't run —
 * defensive for fresh installs.
 *
 * Two resolution paths:
 *
 *   - `baget-web` is special-cased: the platform_id encodes the
 *     agent_group_id directly (`baget-web:<agent_group_id>`), so the
 *     dashboard can post against an agent_group without first
 *     creating a `messaging_groups` row. We additionally verify the
 *     row exists and isn't archived — without that guard, a stray
 *     platform_id would let `getOrCreateConversation` hammer the
 *     `agent_groups` FK and emit a swallowed-warn on every call.
 *
 *   - Every other channel goes through the standard
 *     messaging_groups → wired-agents lookup. We require exactly one
 *     wired agent so a multi-bind misconfiguration silently skips
 *     mirroring rather than writing to the wrong conversation, and
 *     check `archived_at` so a delivery to an archived founder
 *     doesn't add a phantom "team replied" row to a defunct
 *     conversation.
 */
function resolveAgentGroupId(channelType: string, platformId: string): string | null {
  if (!hasTable(getDb(), TABLE)) return null;
  let agentGroupId: string | null = null;
  if (channelType === 'baget-web') {
    agentGroupId = platformId.startsWith(BAGET_WEB_PLATFORM_PREFIX)
      ? platformId.slice(BAGET_WEB_PLATFORM_PREFIX.length) || null
      : null;
  } else {
    const mg = getMessagingGroupByPlatform(channelType, platformId);
    if (!mg) return null;
    const wired = getMessagingGroupAgents(mg.id);
    if (wired.length !== 1) return null;
    agentGroupId = wired[0]!.agent_group_id;
  }
  if (!agentGroupId) return null;
  const ag = getBagetAgentGroupById(agentGroupId);
  if (!ag || ag.archived_at) return null;
  return agentGroupId;
}

function mapInboundAttachments(attachments: InboundAttachment[] | undefined): BagetWebMessageAttachment[] {
  if (!attachments || attachments.length === 0) return [];
  return attachments.map((a) => ({
    kind: a.kind,
    path: a.path,
    filename: a.originalName,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
  }));
}

function extractInboundText(message: InboundMessage): string | null {
  const c = message.content;
  if (typeof c === 'string') return c.length > 0 ? c : null;
  if (c && typeof c === 'object') {
    const obj = c as Record<string, unknown>;
    const text = obj.text;
    if (typeof text === 'string' && text.length > 0) return text;
  }
  return null;
}

/**
 * Inbound mirror — append a 'founder' message to the cross-channel log
 * and broadcast to web subscribers. Silent no-op when the chat is
 * unpaired / multi-bound or when the table isn't present.
 */
export function mirrorInbound(channelType: string, platformId: string, message: InboundMessage, nowIso: string): void {
  const agentGroupId = resolveAgentGroupId(channelType, platformId);
  if (!agentGroupId) return;

  try {
    const text = extractInboundText(message);
    const attachments = mapInboundAttachments(message.attachments);
    // Skip empty messages BEFORE creating the conversation so an
    // unbound chat that only sends service / no-op messages doesn't
    // accumulate empty `baget_web_conversations` rows.
    if (text === null && attachments.length === 0) return;
    // Retry-dedup: if the same (channel, message_id) was already
    // persisted, this is a replay (e.g. a dashboard reconnect re-
    // POSTing with the same `clientId`, or a Telegram update_id that
    // somehow reached us twice past the seen-updates dedup). Skip
    // the second write rather than producing duplicate conversation
    // entries and duplicate broadcasts.
    if (findMessageBySource(channelType, message.id)) return;
    const conv = getOrCreateConversation(agentGroupId, nowIso);
    const persisted = appendMessage(
      {
        conversationId: conv.conversation_id,
        direction: 'founder',
        text,
        attachments,
        sourceChannel: channelType,
        sourceMessageId: message.id,
        timestamp: message.timestamp,
      },
      nowIso,
    );
    const event: BroadcastMessageEvent = {
      type: 'message',
      id: persisted.id,
      direction: 'founder',
      text: persisted.text,
      attachments: persisted.attachments as unknown as Array<Record<string, unknown>>,
      sourceChannel: persisted.source_channel,
      sourceMessageId: persisted.source_message_id,
      timestamp: persisted.timestamp,
    };
    broadcastToAgentGroup(agentGroupId, event);
  } catch (err) {
    // The mirror must NEVER block the upstream pipeline — a write
    // failure here drops the cross-channel record but leaves the
    // founder's message routing intact.
    log.warn('baget-web mirror: inbound append failed', { err, channelType, platformId });
  }
}

/**
 * Parse the JSON content payload from `messages_out`. Returns `null`
 * for empty input, the parsed object for valid JSON, and the raw
 * string for anything else (legacy adapters that wrote plain text).
 * Lifted out of `mirrorOutbound` to flatten the surrounding control
 * flow — keeping the parse fallback in its own pure function lets
 * the outer try/catch read as one error boundary.
 */
function parseOutboundContent(content: string): unknown {
  if (!content || content.length === 0) return null;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function extractOutboundText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.length > 0 ? content : null;
  }
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === 'string' && obj.text.length > 0) return obj.text;
    if (typeof obj.markdown === 'string' && obj.markdown.length > 0) return obj.markdown;
    if (typeof obj.summary === 'string' && obj.summary.length > 0) return obj.summary;
  }
  return null;
}

function mapOutboundAttachments(content: unknown): BagetWebMessageAttachment[] {
  if (!content || typeof content !== 'object') return [];
  const raw = (content as Record<string, unknown>).attachments;
  if (!Array.isArray(raw)) return [];
  const out: BagetWebMessageAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Partial<OutboundAttachment> & Record<string, unknown>;
    if (typeof a.kind !== 'string') continue;
    out.push({
      kind: a.kind,
      path: typeof a.path === 'string' ? a.path : undefined,
      caption: typeof a.caption === 'string' ? a.caption : undefined,
      filename: typeof a.filename === 'string' ? a.filename : undefined,
    });
  }
  return out;
}

function describeOutboundFiles(files: OutboundFile[] | undefined): BagetWebMessageAttachment[] {
  if (!files || files.length === 0) return [];
  // OutboundFile carries a Buffer — store size + filename only so we
  // don't blow up the central DB with repeated buffers. The dashboard
  // can fall back to "[attachment: X bytes]" placeholders; future PRs
  // may replace this with a content-addressed pointer.
  return files.map((f) => ({
    kind: 'document',
    filename: f.filename,
    sizeBytes: f.data.length,
  }));
}

export interface MirrorOutboundInput {
  channelType: string;
  platformId: string;
  kind: string;
  /** JSON string as it appears on `messages_out.content`. */
  content: string;
  files?: OutboundFile[];
  /** Platform message id returned by the underlying adapter, when known. */
  platformMessageId?: string;
}

/**
 * Outbound mirror — append a 'team' message to the cross-channel log
 * after a successful delivery, and broadcast to web subscribers. Same
 * silent-skip semantics as `mirrorInbound`.
 *
 * Internal traffic that isn't team↔founder is intentionally NOT
 * mirrored: `kind === 'system'` (schedule_task, cancel_task, …) and
 * `channelType === 'agent'` (agent-to-agent routing) are agent-runner
 * orchestration, not founder-visible conversation. Mirrors the skip
 * branches in `delivery.ts → deliverMessage`.
 */
export function mirrorOutbound(input: MirrorOutboundInput, nowIso: string): void {
  if (input.kind === 'system' || input.channelType === 'agent') return;

  const agentGroupId = resolveAgentGroupId(input.channelType, input.platformId);
  if (!agentGroupId) return;

  try {
    const parsed = parseOutboundContent(input.content);
    // Skip ask-question rendering; the persisted founder-visible record
    // is the eventual answer flow, not the prompt card.
    if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).type === 'ask_question') {
      return;
    }

    const text = extractOutboundText(parsed);
    const attachments = [...mapOutboundAttachments(parsed), ...describeOutboundFiles(input.files)];
    if (text === null && attachments.length === 0) return;
    const conv = getOrCreateConversation(agentGroupId, nowIso);

    const persisted = appendMessage(
      {
        conversationId: conv.conversation_id,
        direction: 'team',
        text,
        attachments,
        sourceChannel: input.channelType,
        sourceMessageId: input.platformMessageId ?? null,
        timestamp: nowIso,
      },
      nowIso,
    );
    const event: BroadcastMessageEvent = {
      type: 'message',
      id: persisted.id,
      direction: 'team',
      text: persisted.text,
      attachments: persisted.attachments as unknown as Array<Record<string, unknown>>,
      sourceChannel: persisted.source_channel,
      sourceMessageId: persisted.source_message_id,
      timestamp: persisted.timestamp,
    };
    broadcastToAgentGroup(agentGroupId, event);
  } catch (err) {
    log.warn('baget-web mirror: outbound append failed', {
      err,
      channelType: input.channelType,
      platformId: input.platformId,
    });
  }
}
