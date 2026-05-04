/**
 * Cross-channel WebSocket subscriber registry.
 *
 * The dashboard subscribes via WebSocket to a per-`agent_group_id`
 * conversation feed. This module owns the in-memory map of agent_group
 * → connected sockets and the broadcast primitive.
 *
 * The baget-web channel adapter manages the connection lifecycle
 * (handshake, ping/pong, disconnect) and registers each socket here on
 * connect / removes on close. The cross-channel mirror module
 * (baget-web-mirror.ts) calls `broadcastToAgentGroup` from any source
 * channel's inbound or outbound path so the dashboard sees Telegram
 * traffic in real time.
 *
 * Why a separate module: the mirror is wired into core (the inbound /
 * outbound pipeline in src/index.ts), but the adapter is conditionally
 * registered (only when the env gate is set). Splitting the registry
 * out of the adapter keeps the mirror's import graph independent of
 * whether the channel is enabled — when the adapter never registers,
 * `broadcastToAgentGroup` is a cheap no-op against an empty Set.
 */
import type { WebSocket } from 'ws';

import { log } from './log.js';

const subscribers = new Map<string, Set<WebSocket>>();

/**
 * Per-agent_group socket cap. A misbehaving (or malicious-with-token)
 * client could otherwise pin host memory by opening unbounded
 * connections — capping at the largest plausible "founder team" size
 * trades hard-stops at the server for predictable bounds. Today the
 * bearer is shared, so this is the principal defense; once the
 * cross-repo PR scopes auth per-(user, company) the cap shifts to
 * "per-user" semantically and the value can be tightened further.
 */
const MAX_SUBSCRIBERS_PER_AGENT_GROUP = 32;

/**
 * Add a WebSocket subscription for an agent_group. Idempotent on
 * existing sockets; rejects (returns false) when the per-agent_group
 * cap is hit. Caller is responsible for closing the rejected socket.
 */
export function addSubscriber(agentGroupId: string, ws: WebSocket): boolean {
  let set = subscribers.get(agentGroupId);
  if (!set) {
    set = new Set();
    subscribers.set(agentGroupId, set);
  }
  if (set.has(ws)) return true;
  if (set.size >= MAX_SUBSCRIBERS_PER_AGENT_GROUP) {
    log.warn('baget-web ws: subscriber cap reached, rejecting new socket', {
      agentGroupId,
      cap: MAX_SUBSCRIBERS_PER_AGENT_GROUP,
    });
    return false;
  }
  set.add(ws);
  return true;
}

/**
 * Remove a WebSocket subscription. Drops the agent_group key entirely
 * when the last subscriber leaves so the map doesn't grow unbounded
 * with empty Sets after long-running deployments.
 */
export function removeSubscriber(agentGroupId: string, ws: WebSocket): void {
  const set = subscribers.get(agentGroupId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) subscribers.delete(agentGroupId);
}

/** How many sockets are subscribed for an agent_group. Used by tests. */
export function subscriberCount(agentGroupId: string): number {
  return subscribers.get(agentGroupId)?.size ?? 0;
}

/** Drop ALL subscribers (test teardown only). */
export function _resetSubscribersForTest(): void {
  subscribers.clear();
}

/**
 * The broadcast event shape sent over the wire to dashboard clients.
 * Mirrors the persisted `BagetWebMessage` shape minus the bookkeeping
 * columns (`conversation_id`, `created_at`) — the client opens a feed
 * already scoped to one conversation, and `created_at` is internal.
 */
export interface BroadcastMessageEvent {
  type: 'message';
  id: string;
  direction: 'founder' | 'team';
  text: string | null;
  attachments: Array<Record<string, unknown>>;
  sourceChannel: string;
  sourceMessageId: string | null;
  timestamp: string;
}

/**
 * Send a serialized event to every subscriber of an agent_group.
 * Closed / closing sockets are tolerated (`readyState !== OPEN` skips
 * — the disconnect handler will remove them shortly). Returns the
 * number of sockets the payload was actually written to so callers
 * can log delivery fan-out.
 */
export function broadcastToAgentGroup(agentGroupId: string, event: BroadcastMessageEvent): number {
  const set = subscribers.get(agentGroupId);
  if (!set || set.size === 0) return 0;
  const payload = JSON.stringify(event);
  let delivered = 0;
  for (const ws of set) {
    // ws.OPEN is 1 — comparing readyState directly avoids a hard
    // import dependency in the hot path.
    if (ws.readyState === 1) {
      try {
        ws.send(payload);
        delivered++;
      } catch {
        // The socket may have raced into a closing state between the
        // readyState check and send(); ignore and let the close
        // handler clean up.
      }
    }
  }
  return delivered;
}
