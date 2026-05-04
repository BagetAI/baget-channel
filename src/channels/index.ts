// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// Main ships with one default channel — `cli`, the always-on local-terminal
// channel. Other channel skills (/add-slack, /add-discord, /add-whatsapp,
// ...) copy their module from the `channels` branch and append a
// self-registration import below.

import './cli.js';
// Baget telegram channel — self-registers when TELEGRAM_BOT_TOKEN is set.
import './baget-telegram.js';
// Baget web-chat channel — self-registers when BAGET_ADMIN_TOKEN is set.
// Provides the dashboard's WebSocket + history endpoints sharing the
// admin server's listener.
import './baget-web.js';
