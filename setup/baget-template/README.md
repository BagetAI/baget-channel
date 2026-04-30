# Baget agent group template

Files in this folder seed a new "baget" agent group on a fresh
NanoClaw install. To activate:

```bash
# After running bash nanoclaw.sh and pairing Telegram:
mkdir -p groups/baget
cp setup/baget-template/CLAUDE.md groups/baget/CLAUDE.md
cp setup/baget-template/container_config.json groups/baget/container_config.json

# Edit groups/baget/container_config.json:
#   - set BAGET_API_BASE_URL to https://app.baget.ai for prod (default: stg-app)
#   - configure OneCLI credential `baget-channel-token` for this agent
#   - set BAGET_COMPANY_ID to the founder's company UUID
```

`groups/` is per-install state (gitignored upstream). This template
ships the baked-in defaults; once copied, edit freely without polluting
the fork.

When NanoClaw eventually grows a `/add-baget` skill (analogous to
`/add-telegram`, `/add-slack`), it will copy this template
automatically. Until then, the manual copy above is the install path.
