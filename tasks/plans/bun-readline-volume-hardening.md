# Bun child_process readline crash + volume hardening

## Why

Two intertwined production issues on the staging single-process deploy.

### 1. Agents crash mid-stream on every Telegram message

Founder messages route correctly to the spawned agent-runner, MCP tools register, the channel-completion poll loop starts — then ~22ms later:

```
TypeError: this.input.pause is not a function. (In 'this.input.pause()', 'this.input.pause' is undefined)
  at pause (node:readline:654:28)
  at close (node:readline:647:19)
  at emitError (node:events:43:23)
  at <anonymous> (node:child_process:686:20)
Bun v1.2.20 (Linux x64)
[parent] Single-process runner exited code=1
```

Trigger: the Claude Agent SDK creates a `readline.Interface` over the MCP stdio child's stdout for line-delimited JSON-RPC framing. When that child errors during startup, Bun 1.2.20's `child_process` polyfill propagates an internal error that flows through `readline.close()` → `readline.pause()`. The readline's `input` is undefined at that point in Bun's cleanup path, so `this.input.pause()` throws an uncaught `TypeError` that kills the runner.

User-visible symptom: agents send partial responses (the streaming tool call lands, then exit code 1 cuts off mid-sentence — observed live in staging Telegram).

### 2. Operators can't tell if the persistence volume is actually attached

Single-process mode stores plaintext bearer tokens, the bot pool, and active pairings under `DATA_DIR=/app/data`. Without a Railway volume mounted there, the container's ephemeral filesystem wipes everything on every redeploy. The deploy already documented this requirement in BAGET-DEPLOY.md, but there was no boot-time signal that the volume was actually present — a misconfigured staging env would silently lose data and then complain when bots stopped responding.

Related: M1 from the 2026-05-04 comprehensive review — `/app/data/v2.db` is created with default umask (0644) so the plaintext bearer column was readable by any process with volume access.

## What changes

### Crash fix (primary)

1. **Bump `BUN_VERSION` 1.2.20 → 1.2.23 in `Dockerfile`.** 1.2.22 fixed several `spawnSync` `RangeError` paths and made `stdin/stdout/stderr/stdio` enumerable on `ChildProcess`. 1.2.23 added more `node:tty` and `node:net` compat. Stay on 1.2.x to avoid `bun:sqlite` drift on majors — 1.3 needs its own validation pass.
2. **Add `uncaughtException` and `unhandledRejection` handlers** in `container/agent-runner/src/index.ts`. Defense-in-depth: if Bun's cleanup path throws another way we haven't picked up, the runner logs loudly but stays alive instead of exiting code 1 mid-stream. Real errors in our own code still surface via `main().catch` → `process.exit(1)` — this only swallows escapes from outside our control flow.

### Persistence hardening (bundled because all in the same boot path)

3. **Boot-time ephemeral-fs detection** in `src/index.ts` (`detectEphemeralDataDir`). Reads `/proc/mounts` (Linux only; macOS dev returns nothing), finds the longest mount-point prefix of `DATA_DIR`, classifies the fstype. tmpfs/overlay/overlayfs/rootfs → loud WARN; ext4/xfs/btrfs/zfs → confirmation INFO. Best-effort: any read failure returns "not ephemeral" so a misconfigured procfs doesn't trigger spurious alarms.
4. **`chmod 0o600` on `v2.db` and WAL/SHM sidecars** in `src/db/connection.ts` after `new Database(...)`. Closes M1. Best-effort: silently ignores `ENOENT` for sidecars not yet created on a fresh boot, logs WARN on other failures so you find out before deploy day.
5. **Document in `BAGET-DEPLOY.md`** — extend the existing "Persistence requirements" section to call out:
   - The channel-tokens table specifically (founder bot stops responding when `getChannelToken` returns null)
   - The new startup self-check log line so operators know what "good" looks like
   - The chmod 0o600 pattern
   - The recovery flow gap: env-var bot-pool seeder rebuilds the pool but NOT founder pairings (baget.ai keeps only the sha256 hash; plaintext lives only in the lost SQLite — every founder has to re-pair).

## What's NOT changing

- The OneCLI vault integration (no-op in single-process mode).
- The pairing write order (still SQLite-first; not relevant here because we picked volume-backed SQLite as the durable store rather than inverting to OneCLI-authoritative — see chat thread for why OneCLI's `secrets list` is metadata-only and rules out value rehydration).
- Anything on the baget.ai web side. This PR is fork-side only.

## Verification

- `pnpm typecheck` clean.
- `pnpm test` — 586/586 green pre-change, expected same post-change (no test files modified).
- Smoke on staging after merge: send a Telegram message, watch logs for:
  - `INFO DATA_DIR persistence confirmed { fstype: "ext4", ... }` (volume detected)
  - No `TypeError: this.input.pause` line
  - Agent response completes without "Single-process runner exited code=1"

## Rollback

Each change is independent and reversible:
- Dockerfile: revert the `BUN_VERSION` line.
- Agent-runner handlers: remove the two `process.on(...)` blocks.
- DB chmod: remove the `for (const suffix of ...)` block in `initDb`.
- Volume self-check: remove the `detectEphemeralDataDir` call and the helper function.
- Doc: revert the BAGET-DEPLOY.md hunk.
