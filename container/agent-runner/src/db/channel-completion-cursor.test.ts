import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from './connection.js';
import {
  getChannelCompletionCursor,
  setChannelCompletionCursor,
} from './channel-completion-cursor.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('channel-completion-cursor', () => {
  it('returns undefined before first set', () => {
    expect(getChannelCompletionCursor()).toBeUndefined();
  });

  it('round-trips a value', () => {
    const iso = '2026-05-05T12:34:56.789Z';
    setChannelCompletionCursor(iso);
    expect(getChannelCompletionCursor()).toBe(iso);
  });

  it('overwrites the previous value (single row only)', () => {
    setChannelCompletionCursor('2026-05-05T01:00:00.000Z');
    setChannelCompletionCursor('2026-05-05T02:00:00.000Z');
    expect(getChannelCompletionCursor()).toBe('2026-05-05T02:00:00.000Z');

    const rows = getOutboundDb()
      .prepare("SELECT COUNT(*) AS n FROM session_state WHERE key = 'channel_completion_cursor'")
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('writes updated_at on set', () => {
    setChannelCompletionCursor('2026-05-05T03:00:00.000Z');
    const row = getOutboundDb()
      .prepare("SELECT updated_at FROM session_state WHERE key = 'channel_completion_cursor'")
      .get() as { updated_at: string };
    // ISO 8601 format
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
