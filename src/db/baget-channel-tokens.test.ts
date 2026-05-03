import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteChannelToken,
  getChannelToken,
  getChannelTokenMeta,
  upsertChannelToken,
} from './baget-channel-tokens.js';
import { closeDb, getDb, initTestDb } from './connection.js';
import { runMigrations } from './migrations/index.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  // Seed two agent_groups so cross-row isolation tests have something to
  // contrast against.
  db.prepare(
    `INSERT INTO agent_groups (id, name, folder, created_at, user_id, company_id)
     VALUES
       ('ag-1', 'Acme', 'baget-aaaaaaaa-bbbbbbbb', '2026-01-01T00:00:00Z', 'u-1', 'c-1'),
       ('ag-2', 'Beta', 'baget-cccccccc-dddddddd', '2026-01-01T00:00:00Z', 'u-2', 'c-2')`,
  ).run();
});

afterEach(() => {
  closeDb();
});

describe('upsertChannelToken (insert path)', () => {
  it('persists a fresh token row keyed by agent_group_id', () => {
    upsertChannelToken({
      agentGroupId: 'ag-1',
      tokenValue: 'token-aaaa',
      now: '2026-04-30T10:00:00Z',
    });
    expect(getChannelToken('ag-1')).toBe('token-aaaa');
    const meta = getChannelTokenMeta('ag-1');
    expect(meta).toEqual({ persisted_at: '2026-04-30T10:00:00Z', rotated_from_at: null });
  });

  it('returns null when the token does not exist', () => {
    expect(getChannelToken('ag-1')).toBeNull();
    expect(getChannelTokenMeta('ag-1')).toBeNull();
  });

  it('keeps tokens isolated across agent_groups', () => {
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 'token-A', now: '2026-04-30T10:00:00Z' });
    upsertChannelToken({ agentGroupId: 'ag-2', tokenValue: 'token-B', now: '2026-04-30T10:00:01Z' });
    expect(getChannelToken('ag-1')).toBe('token-A');
    expect(getChannelToken('ag-2')).toBe('token-B');
  });
});

describe('upsertChannelToken (rotate path)', () => {
  it('overwrites the value and stamps rotated_from_at to the prior persisted_at', () => {
    upsertChannelToken({
      agentGroupId: 'ag-1',
      tokenValue: 'token-old',
      now: '2026-04-30T10:00:00Z',
    });
    upsertChannelToken({
      agentGroupId: 'ag-1',
      tokenValue: 'token-new',
      now: '2026-04-30T11:00:00Z',
    });

    expect(getChannelToken('ag-1')).toBe('token-new');
    const meta = getChannelTokenMeta('ag-1');
    expect(meta).toEqual({
      persisted_at: '2026-04-30T11:00:00Z',
      rotated_from_at: '2026-04-30T10:00:00Z',
    });
  });

  it('preserves the most recent rotation pointer through multiple rotations', () => {
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 't1', now: '2026-04-30T10:00:00Z' });
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 't2', now: '2026-04-30T11:00:00Z' });
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 't3', now: '2026-04-30T12:00:00Z' });

    expect(getChannelToken('ag-1')).toBe('t3');
    expect(getChannelTokenMeta('ag-1')).toEqual({
      persisted_at: '2026-04-30T12:00:00Z',
      rotated_from_at: '2026-04-30T11:00:00Z',
    });
  });

  it('does not bleed rotation timestamps across agent_groups', () => {
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 't1', now: '2026-04-30T10:00:00Z' });
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 't2', now: '2026-04-30T11:00:00Z' });
    upsertChannelToken({ agentGroupId: 'ag-2', tokenValue: 'first-for-ag2', now: '2026-04-30T12:00:00Z' });

    expect(getChannelTokenMeta('ag-2')).toEqual({
      persisted_at: '2026-04-30T12:00:00Z',
      rotated_from_at: null,
    });
  });
});

describe('deleteChannelToken', () => {
  it('returns 1 when a row was deleted', () => {
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 't', now: '2026-04-30T10:00:00Z' });
    expect(deleteChannelToken('ag-1')).toBe(1);
    expect(getChannelToken('ag-1')).toBeNull();
  });

  it('returns 0 when no row exists (idempotent)', () => {
    expect(deleteChannelToken('ag-1')).toBe(0);
    expect(deleteChannelToken('ag-1')).toBe(0);
  });

  it('does not affect tokens for other agent_groups', () => {
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 'A', now: '2026-04-30T10:00:00Z' });
    upsertChannelToken({ agentGroupId: 'ag-2', tokenValue: 'B', now: '2026-04-30T10:00:00Z' });
    expect(deleteChannelToken('ag-1')).toBe(1);
    expect(getChannelToken('ag-2')).toBe('B');
  });
});

describe('FK CASCADE on agent_groups hard delete', () => {
  it('drops the channel token when its agent_group is hard-deleted', () => {
    upsertChannelToken({ agentGroupId: 'ag-1', tokenValue: 'token', now: '2026-04-30T10:00:00Z' });
    expect(getChannelToken('ag-1')).toBe('token');

    // Better-sqlite3 doesn't enable foreign keys by default — initTestDb
    // does (mirrors connection.ts production behavior). Hard-delete to
    // verify the CASCADE actually fires.
    getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run('ag-1');
    expect(getChannelToken('ag-1')).toBeNull();
  });
});
