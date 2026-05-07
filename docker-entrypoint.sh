#!/bin/sh
# Railway-volume-aware entrypoint.
#
# The Dockerfile creates /app/data + /app/groups owned by node:node at
# build time, but a Railway persistent volume mounted on /app/data
# (added 2026-05-07 — see BAGET-DEPLOY.md "Persistence requirements")
# overlays the directory at runtime, owned by root:root with no node
# write access. The container then crash-loops on the first
# `circuit-breaker.json` write.
#
# Fix: container starts as root, this entrypoint chowns the mount
# point back to node:node (idempotent — fast no-op when ownership is
# already correct), then drops to the unprivileged node user via
# `runuser` before exec'ing the CMD. PID 1 is preserved by `exec`
# so signal handling (SIGTERM on Railway redeploy) reaches Node.
#
# `runuser` is part of util-linux, present in node:20-bookworm-slim
# by default — no extra apt install needed. We deliberately do NOT
# use `gosu` (would require apt install + signed-key dance) or `su`
# (drops PID 1 / breaks signal forwarding).
#
# The chown silently swallows errors via `|| true` because:
#   - Local Docker runs without a volume mount: directories already
#     exist at build-time perms, chown -R is a no-op.
#   - Restricted environments where the chown lacks the capability
#     (CAP_CHOWN dropped) should surface via the subsequent app-level
#     EACCES if the perms are still wrong, not by failing the
#     entrypoint silently.
set -e

chown -R node:node /app/data /app/groups 2>/dev/null || true

exec runuser -u node -- "$@"
