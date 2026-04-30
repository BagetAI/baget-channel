import { describe, expect, it } from 'vitest';

import { applyPersonaPrefix, parseRoleTag } from './baget-persona.js';
import type { BagetTeamMembers } from './baget-pairing.js';

const TEAM: BagetTeamMembers = {
  cos: 'Louis',
  developer: 'Valentin',
  marketing: 'Chloé',
  analyst: 'Théo',
  design: 'Nicolas',
  ops: 'Tristan',
};

describe('parseRoleTag', () => {
  it('parses each known role tag', () => {
    for (const tag of ['cos', 'dev', 'marketing', 'analyst', 'design', 'ops'] as const) {
      const r = parseRoleTag(`${tag}: hello`);
      expect(r.tag).toBe(tag);
      expect(r.body).toBe('hello');
    }
  });

  it('handles tag with no space (cos:body)', () => {
    const r = parseRoleTag('cos:hi');
    expect(r.tag).toBe('cos');
    expect(r.body).toBe('hi');
  });

  it('handles tag with newline before body', () => {
    const r = parseRoleTag('cos:\nhi there');
    expect(r.tag).toBe('cos');
    expect(r.body).toBe('hi there');
  });

  it('preserves multi-line body', () => {
    const r = parseRoleTag('analyst: line one\nline two\nline three');
    expect(r.tag).toBe('analyst');
    expect(r.body).toBe('line one\nline two\nline three');
  });

  it('tolerates leading whitespace before tag', () => {
    const r = parseRoleTag('  \n cos: hi');
    expect(r.tag).toBe('cos');
    expect(r.body).toBe('hi');
  });

  it('returns null tag when no tag found', () => {
    const r = parseRoleTag('Hey, just a regular message.');
    expect(r.tag).toBeNull();
    expect(r.rawTag).toBeNull();
    expect(r.body).toBe('Hey, just a regular message.');
  });

  it('returns null tag with rawTag set on unknown tag', () => {
    const r = parseRoleTag('captain: ahoy');
    expect(r.tag).toBeNull();
    expect(r.rawTag).toBe('captain');
    // Unknown tag => preserve original message intact
    expect(r.body).toBe('captain: ahoy');
  });

  it('handles empty string', () => {
    const r = parseRoleTag('');
    expect(r.tag).toBeNull();
    expect(r.body).toBe('');
  });

  it('does not detect capitalized text as a tag candidate', () => {
    // The regex matches lowercase only — capitalized "Hey:" passes
    // through as a non-candidate so we don't accidentally swallow
    // legitimate sentences that happen to have a colon.
    const r = parseRoleTag('Hey: this is a message with a colon.');
    expect(r.tag).toBeNull();
    expect(r.rawTag).toBeNull();
    expect(r.body).toBe('Hey: this is a message with a colon.');
  });
});

describe('applyPersonaPrefix', () => {
  it('prefixes known tags with emoji + member name', () => {
    expect(applyPersonaPrefix('cos: hi', TEAM)).toBe('🧭 Louis: hi');
    expect(applyPersonaPrefix('analyst: 142', TEAM)).toBe('📊 Théo: 142');
    expect(applyPersonaPrefix('dev: live', TEAM)).toBe('💻 Valentin: live');
  });

  it('uses ops member name for ops tag (own member, no longer aliased to design)', () => {
    expect(applyPersonaPrefix('ops: book the supplier', TEAM)).toBe('⚙️ Tristan: book the supplier');
  });

  it('falls through to cos when no tag is present', () => {
    expect(applyPersonaPrefix('hi there', TEAM)).toBe('🧭 Louis: hi there');
  });

  it('passes through unknown tag untouched (no silent re-prefix)', () => {
    expect(applyPersonaPrefix('captain: ahoy', TEAM)).toBe('captain: ahoy');
  });

  it('falls through plainly when team.cos is empty (defensive)', () => {
    const broken = { ...TEAM, cos: '' } as BagetTeamMembers;
    expect(applyPersonaPrefix('hi', broken)).toBe('hi');
  });

  it('returns body without prefix when targeted role name is empty', () => {
    const broken = { ...TEAM, analyst: '   ' } as BagetTeamMembers;
    expect(applyPersonaPrefix('analyst: 142', broken)).toBe('142');
  });

  it('handles multi-line body intact', () => {
    expect(applyPersonaPrefix('cos: line1\nline2', TEAM)).toBe('🧭 Louis: line1\nline2');
  });
});
