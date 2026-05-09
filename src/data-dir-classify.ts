/**
 * Boot-time volume self-check. Reads `/proc/mounts` and classifies
 * whether DATA_DIR is on an ephemeral filesystem layer (tmpfs / overlay)
 * — i.e. nobody attached a persistent volume. On Railway this means
 * SQLite, the bot pool, and the channel-tokens table get wiped on every
 * redeploy, so a loud startup warning beats a silent surprise the next
 * time the operator pushes a hotfix.
 *
 * Pure-parser/IO split so the parser can be unit-tested with synthetic
 * mount tables (a regression here means silent production data loss).
 */
import fs from 'fs';
import path from 'path';

export interface DataDirFsInfo {
  ephemeral: boolean;
  fstype: string | null;
  mountPoint: string | null;
}

const EPHEMERAL_FSTYPES = new Set(['tmpfs', 'overlay', 'overlayfs', 'rootfs']);

/**
 * Pure parser. Given /proc/mounts content, find the longest mountpoint
 * that owns `dataDir` and classify whether that mount is ephemeral.
 *
 * /proc/mounts escapes whitespace as octal (`\040` for space); we don't
 * use such paths on Railway, but if you ever do, decode them here before
 * splitting.
 */
export function classifyDataDir(mounts: string, dataDir: string): DataDirFsInfo {
  const dataDirAbs = path.resolve(dataDir);
  let best: { mountPoint: string; fstype: string } | null = null;
  for (const line of mounts.split('\n')) {
    const [, mp, fstype] = line.split(' ');
    if (!mp || !fstype) continue;
    // `/` needs its own clause: `dataDirAbs.startsWith('/' + '/')` is false
    // for any normal path, so the prefix check below never matches root.
    // Every absolute path is logically under `/`, so we match it here and
    // let the longest-prefix tiebreaker prefer a more specific mount.
    if (mp === '/' || dataDirAbs === mp || dataDirAbs.startsWith(mp + '/')) {
      if (!best || mp.length > best.mountPoint.length) best = { mountPoint: mp, fstype };
    }
  }
  if (!best) return { ephemeral: false, fstype: null, mountPoint: null };
  return { ephemeral: EPHEMERAL_FSTYPES.has(best.fstype), fstype: best.fstype, mountPoint: best.mountPoint };
}

/**
 * IO wrapper around {@link classifyDataDir}. Linux-only (procfs);
 * macOS dev returns `{ ephemeral: false }` so the warning is only
 * meaningful in containers. Best-effort: any read failure returns
 * `ephemeral: false` so a misconfigured procfs doesn't trigger spurious
 * alarms.
 */
export function detectEphemeralDataDir(dataDir: string): DataDirFsInfo {
  if (process.platform !== 'linux') return { ephemeral: false, fstype: null, mountPoint: null };
  let mounts: string;
  try {
    mounts = fs.readFileSync('/proc/mounts', 'utf-8');
  } catch {
    return { ephemeral: false, fstype: null, mountPoint: null };
  }
  return classifyDataDir(mounts, dataDir);
}
