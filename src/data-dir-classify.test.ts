/**
 * Unit tests for `classifyDataDir` — the parser half of the boot-time
 * volume self-check (see src/index.ts). The IO wrapper
 * (`detectEphemeralDataDir`) is platform-gated to Linux and reads
 * `/proc/mounts`; we test the pure logic with synthetic mount tables
 * because a regression here means silent production data loss (operator
 * pushes a deploy thinking the volume is attached, founder pairings
 * vanish on next redeploy, no warning fires).
 */
import { describe, it, expect } from 'vitest';

import { classifyDataDir } from './data-dir-classify.js';

const mounts = {
  // Typical Railway container with the volume attached.
  withVolume: [
    'overlay / overlay rw,relatime,lowerdir=/var/lib/containers,upperdir=/var/lib/containers/storage 0 0',
    'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
    'sysfs /sys sysfs ro,nosuid,nodev,noexec,relatime 0 0',
    '/dev/sda1 /app/data ext4 rw,relatime 0 0',
    'tmpfs /run tmpfs rw,nosuid,nodev,size=65536k 0 0',
  ].join('\n'),

  // Container without a volume — `/app/data` is part of the overlay rootfs.
  withoutVolume: [
    'overlay / overlay rw,relatime,lowerdir=/var/lib/containers,upperdir=/var/lib/containers/storage 0 0',
    'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
    'sysfs /sys sysfs ro,nosuid,nodev,noexec,relatime 0 0',
    'tmpfs /run tmpfs rw,nosuid,nodev,size=65536k 0 0',
  ].join('\n'),

  // Pathological: the data dir is on tmpfs explicitly (some k8s-style configs).
  onTmpfs: ['overlay / overlay rw,relatime 0 0', 'tmpfs /app/data tmpfs rw,relatime,size=128M 0 0'].join('\n'),

  // Empty / unreadable procfs — should not classify as ephemeral.
  empty: '',

  // Garbage line robustness.
  malformed: ['not a valid mount line', '', 'overlay / overlay rw 0 0'].join('\n'),
};

describe('classifyDataDir', () => {
  it('returns ephemeral=false when the volume is mounted at the data dir', () => {
    const result = classifyDataDir(mounts.withVolume, '/app/data');
    expect(result).toEqual({ ephemeral: false, fstype: 'ext4', mountPoint: '/app/data' });
  });

  it('returns ephemeral=true (overlay rootfs) when no volume is attached', () => {
    const result = classifyDataDir(mounts.withoutVolume, '/app/data');
    expect(result).toEqual({ ephemeral: true, fstype: 'overlay', mountPoint: '/' });
  });

  it('returns ephemeral=true when the data dir is explicitly on tmpfs', () => {
    const result = classifyDataDir(mounts.onTmpfs, '/app/data');
    expect(result).toEqual({ ephemeral: true, fstype: 'tmpfs', mountPoint: '/app/data' });
  });

  it('prefers the longest matching mount point', () => {
    // /app is overlay (ephemeral), /app/data is ext4 (volume) — must pick /app/data.
    const longest = ['overlay / overlay rw 0 0', 'overlay /app overlay rw 0 0', '/dev/sda1 /app/data ext4 rw 0 0'].join(
      '\n',
    );
    const result = classifyDataDir(longest, '/app/data');
    expect(result.mountPoint).toBe('/app/data');
    expect(result.fstype).toBe('ext4');
    expect(result.ephemeral).toBe(false);
  });

  it('treats / as a valid prefix (would otherwise miss root via startsWith check)', () => {
    const onlyRoot = 'overlay / overlay rw 0 0';
    const result = classifyDataDir(onlyRoot, '/app/data');
    expect(result.mountPoint).toBe('/');
  });

  it('does not match a sibling mount point that shares a prefix string', () => {
    // `/app/data2` is NOT a child of `/app/data` even though the strings share a prefix.
    const sibling = ['overlay / overlay rw 0 0', '/dev/sda1 /app/data2 ext4 rw 0 0'].join('\n');
    const result = classifyDataDir(sibling, '/app/data');
    expect(result.mountPoint).toBe('/');
    expect(result.fstype).toBe('overlay');
  });

  it('returns no-match shape on empty input', () => {
    const result = classifyDataDir(mounts.empty, '/app/data');
    expect(result).toEqual({ ephemeral: false, fstype: null, mountPoint: null });
  });

  it('skips malformed lines and still finds a valid match', () => {
    const result = classifyDataDir(mounts.malformed, '/app/data');
    expect(result.fstype).toBe('overlay');
    expect(result.mountPoint).toBe('/');
  });
});
