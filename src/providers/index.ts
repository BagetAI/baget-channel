// Host-side provider container-config barrel.
// Providers that need host-side container setup (extra mounts, env passthrough,
// per-session directories) self-register on import.
//
// Keep this list explicit so it's obvious which providers are allowed to pass
// host env through to single-process child runners.
import './claude.js';
import './gemini.js';
