# Baget channel smoke test — first end-to-end run

Run this BEFORE flipping `USE_BAGET_CHANNEL_HOST=true` on baget.ai
staging. Goal: prove the full loop works on local nanoclaw + bridge
before any real founder traffic.

## What you'll have at the end

A founder Telegram chat where:
- "What's the waitlist at?" → `analyst:` reply with the actual number
- "Set direction to focus on X" → `cos:` reply confirming
- "Anything pending my approval?" → `cos:` reply listing or "nothing"
- The bot is your founder's actual team names (not generic "Louis/Tristan")

If any of these fails, the bridge isn't ready for staging.

## Prerequisites (15 min)

You'll need:
- `BagetAI/baget-channel` cloned locally with branches
  `baget/single-process-mode` (B1) + `baget/expand-mcp-tools` (the
  6 new MCP tools) + `baget/use-gemini-via-opencode` (Gemini config)
  merged together. Fastest:
  ```bash
  cd /path/to/baget-channel
  git fetch origin
  git checkout -b smoke/full-stack origin/baget/single-process-mode
  git merge --no-edit origin/baget/expand-mcp-tools
  git merge --no-edit origin/baget/use-gemini-via-opencode
  ```
- A Telegram test bot (`@baget_team_staging_test_bot` or similar via
  `@BotFather`). Save the token.
- Docker running locally (host's `RUNTIME=single-process` skips
  per-session Docker, but the container image still needs to build).
- A test company on `stg-app.baget.ai` you own (or use an existing
  one).
- The 16+ char `BAGET_ADMIN_TOKEN` you'll share between baget.ai
  staging and your local nanoclaw.

## Setup (10 min)

```bash
# 1. Run the install + provider skills
./nanoclaw.sh                  # walks through Anthropic auth, OneCLI,
                               # first agent, etc.
# When prompted for the first agent, name it `baget-smoke`.

.claude/skills/add-telegram/SKILL.md    # follow the steps
.claude/skills/add-opencode/SKILL.md    # follow the steps

# 2. Set env vars in `.env`
cat >> .env <<EOF
RUNTIME=single-process
TELEGRAM_BOT_TOKEN=<your-test-bot-token>
TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 24)
BAGET_TELEGRAM_BOT_USERNAME=<your-test-bot-username>
BAGET_ADMIN_TOKEN=$(openssl rand -hex 24)
BAGET_API_BASE_URL=https://stg-app.baget.ai
OPENCODE_PROVIDER=google
OPENCODE_MODEL=google/gemini-2.5-flash
OPENCODE_SMALL_MODEL=google/gemini-2.5-flash-lite
ANTHROPIC_BASE_URL=https://generativelanguage.googleapis.com/v1beta
EOF

# 3. Register the Google API key with OneCLI
onecli secrets create --name google-genai-api-key \
  --host-pattern generativelanguage.googleapis.com \
  --value "$YOUR_GOOGLE_API_KEY"

# 4. Find the agent_id for `baget-smoke` and grant it the secret
onecli agents list                              # note the id
onecli agents set-secrets --id <id> --secret-ids google-genai-api-key

# 5. Build + run
pnpm install
pnpm run build
./container/build.sh
pnpm run dev                  # leaves nanoclaw running on
                              # 8443 (admin) + 3001 (telegram webhook)
```

## Expose ngrok / cloudflare-tunnel for Telegram webhooks

Telegram needs a public URL to deliver updates. Easiest:

```bash
# In another terminal:
ngrok http 3001
# Note the https://<random>.ngrok-free.app URL.

# Tell Telegram where to deliver:
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{
    \"url\": \"https://<random>.ngrok-free.app/api/channels/telegram/webhook\",
    \"secret_token\": \"${TELEGRAM_WEBHOOK_SECRET}\",
    \"allowed_updates\": [\"message\"]
  }"

# Verify:
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
# Expect: { "ok": true, "result": { "url": "...ngrok...", "pending_update_count": 0 } }
```

## The smoke (5 min)

### S-1 — Health check

```bash
curl -fsS http://localhost:8443/healthz
# Expect: {"ok":true}
```

### S-2 — Provision via admin API

Use a real (userId, companyId) from your stg-app.baget.ai test
company. Get them from the dashboard URL:
`stg-app.baget.ai/dashboard/<company-id>`. The userId is in your
Clerk session — grab it from the dashboard's network tab on any
authenticated XHR (`x-user-id` header or session JWT claim).

```bash
USER_ID="<your-user-uuid>"
COMPANY_ID="<your-company-uuid>"

# Resolve team names from baget.ai (call your existing endpoint
# OR hardcode if you know them):
curl -fsS "https://stg-app.baget.ai/api/companies/${COMPANY_ID}/overview" \
  -H "Authorization: Bearer <a-channel-token-you-mint-locally>"
# Note the team names from the dashboard. For testing you can hardcode:
COS=Louis
STRATEGIST=Théo
DEVELOPER=Tristan
MARKETING=Valentin
ANALYST=Chloé
DESIGN=Marie

# Provision
curl -X POST http://localhost:8443/baget/agent-groups \
  -H "Authorization: Bearer ${BAGET_ADMIN_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "{
    \"userId\": \"${USER_ID}\",
    \"companyId\": \"${COMPANY_ID}\",
    \"companyName\": \"Acme Smoke Test\",
    \"teamMembers\": {
      \"cos\": \"${COS}\", \"strategist\": \"${STRATEGIST}\",
      \"developer\": \"${DEVELOPER}\", \"marketing\": \"${MARKETING}\",
      \"analyst\": \"${ANALYST}\", \"design\": \"${DESIGN}\"
    },
    \"channelTokenCredentialName\": \"baget-channel-token-smoke\",
    \"bagetApiBaseUrl\": \"https://stg-app.baget.ai\"
  }"
# Expect: { "ok": true, "agentGroupId": "...", "folder": "baget-...",
#           "telegramDeepLink": "https://t.me/<bot>?start=...",
#           "pairingTokenExpiresAt": "..." }
# COPY the deep link.
```

### S-3 — Pair on Telegram

Open the deep link on your phone (or `t.me/<bot>?start=<token>` in
desktop Telegram). Type `/start <token>` if it doesn't auto-fire.

Expected reply:
> 🧭 Louis: Hey {first_name} — I'm here with Théo, Tristan, Valentin,
> Chloé, Marie. What's on your mind for Acme Smoke Test today?

Names should match what you set above. If they're wrong → CLAUDE.md
template wasn't rendered with the per-founder names; check
`groups/baget-<u>-<c>/CLAUDE.local.md`.

### S-4 — Read tool round-trip

In the Telegram chat:

> What's the waitlist at?

Expected reply (assuming your test company has a `Waitlist` metric):
> 📊 Chloé: Waitlist: <real number>. <real history if relevant>.

Verify on the nanoclaw logs:
```bash
# In the nanoclaw terminal, you should see:
# [opencode-provider] tool baget_query_metrics …
# (NOT [claude-provider] — confirms #1 worked)
```

### S-5 — Write tool round-trip (free, direct)

> Set direction to focus on enterprise sales.

Expected:
> 🧭 Louis: Direction saved: "Focus on enterprise sales."

Verify on baget.ai dashboard at `stg-app.baget.ai/dashboard/<id>`:
- Direction box shows the new text
- Activity log has `metadata.source: "channel:telegram"`

### S-6 — Approval-gated tool (cost preview)

> Reveal 5 prospects.

Expected first reply:
> 📊 Chloé: This will reveal up to 5 prospect emails — costs up to
> 5 credits. Reply yes to proceed.

Reply: `yes`

Expected:
> 📊 Chloé: Revealed N prospect emails — N credit(s) charged.

Verify on dashboard: balance dropped by N, prospects are now
contacts.

### S-7 — Read tools that need the new endpoints (commit 46f7931)

Try:
> What shipped this week?
> Anything pending my approval?
> What reminders do I have?

Each should return real data from baget.ai (or "nothing" if empty).
If you get errors, check that baget.ai staging is on commit 46f7931
or later (the 4 new GET endpoints).

### S-8 — Disconnect

In the dashboard, click the disconnect button on the channel widget.
Telegram bot stops responding. Re-pair via S-2 if needed.

## Pass/fail

| Step | Tests | Pass criteria |
|------|------|---------------|
| S-1 | nanoclaw is up | 200 + `{"ok":true}` |
| S-2 | admin API works | 200 + deep link returned |
| S-3 | persona render + Telegram bind | bot greets with the right team names |
| S-4 | read tool fans through public API | reply has real metric data + `[opencode-provider]` in logs |
| S-5 | write tool via /approval/execute | direction saved on dashboard |
| S-6 | approval-card flow | cost preview → confirm → executed |
| S-7 | new read endpoints | reply pulls from /batches/recent etc. |
| S-8 | disconnect tears down | bot stops + dashboard reflects |

**ALL 8 must pass to flip the staging flag.** Any failure is a real
bug — open an issue or fix in place before flipping.

## After smoke passes

```bash
# 1. Set env vars on Vercel staging:
USE_BAGET_CHANNEL_HOST=true
BAGET_CHANNEL_HOST_URL=https://nanoclaw.baget.ai   # production URL,
                                                    # NOT your ngrok
BAGET_CHANNEL_ADMIN_TOKEN=<same value as on Railway>

# 2. Trigger redeploy on staging:
git commit --allow-empty -m "chore(staging): flip USE_BAGET_CHANNEL_HOST"
git push origin staging

# 3. Watch staging Sentry for one sprint. Look for:
# - 5xx on /api/channels/telegram/{pair,disconnect,pair/status}
# - baget-channel-client breadcrumbs at level=warning
# - Any new error class involving 'opencode' or 'gemini'

# 4. After one clean sprint, flip the flag on prod the same way.
```

## Rollback

```bash
# On Vercel:
USE_BAGET_CHANNEL_HOST=false
# Triggers redeploy, reverts pair/disconnect/status to in-app handlers.
# Existing baget-channel agent groups stay in place but won't be hit
# by new dashboard pair clicks. Founders who paired during the
# bridge window keep talking to baget-channel until they disconnect.
```
