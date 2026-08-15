# Lux Fixes Log — 2026-08-15

## Applied fixes

### 1. SSRF protections hardened (server/index.js)
- `proxyFetch` now resolves hostnames via DNS and blocks any resolved private/loopback/link-local address, preventing DNS rebinding.
- Blocked IPv4 alternate forms (`2130706433`, `0177.0.0.1`, `0x7f000001`), IPv6 literals, CGNAT 100.64/10, and cloud metadata hostnames.
- Redirects are followed manually (max 5) with each hop re-validated.
- Invalid/non-http(s) URLs return 400; blocked addresses return 403.

### 2. Proxied responses no longer overwrite Lux cookies (server/index.js)
- `/sj-proxy` and `/api/tv-proxy` now strip `set-cookie`, `clear-site-data`, `x-frame-options`, and CSP headers from upstream responses.

### 3. Shared-mode login rate limiting (server/index.js)
- `POST /api/session` now rate-limits by IP: 10 attempts per 10 minutes, blocked for 10 minutes after.
- Session cookie gets `Secure` when TLS/X-Forwarded-Proto is https.

### 4. /ip spoofing and XSS fixed
- Express `trust proxy` is now opt-in (`LUX_TRUST_PROXY=1` or `config.local.js` `trustProxy`).
- `/ip` uses `req.ip` instead of raw X-Forwarded-For.
- IP badge now uses `textContent` (no innerHTML injection).

### 5. Chat WebSocket hardened
- Validates `Sec-WebSocket-Version: 13`.
- Shared mode now requires a valid `lux_sid` session for `/chat/`.
- `socket.on("error")` cleanup added.

### 6. config.local.js actually works now
- `config.port`, `config.host`, `config.sessionTtlHours` are now respected (previously env-only).
- Added `trustProxy` and `statsToken` to config.

### 7. Stats endpoints can be protected
- `STATS_TOKEN` (env or config.local.js) requires `Authorization: Bearer <token>` or `?token=` for `/stats/json` and `/stats/stream`.

### 8. UV service worker now claims clients immediately (scripts/build-uv.mjs)
- Build appends `skipWaiting()` + `clients.claim()`.
- **This fixed a real first-visit bug**: the SW previously never claimed the page, so the first navigation silently did nothing (about:blank iframes).
- Build idempotency changed to sentinel comment `/* lux-sw-wired */` instead of checking the first line.

### 9. Engine init cached (public/js/engine.js)
- UV/SJ `init()` promises are cached per engine; rapid tab navigations no longer re-register service workers each time.
- Failed init promises are removed from cache so they can retry.

### 10. URL-scheme settings fixed/removed (public/js/url-scheme.js, main.js)
- `plain` and `none` were broken (plain produced XOR-decodable garbage; none bypassed the proxy entirely).
- Settings UI now only offers `Obfuscated (recommended)`. `buildProxyPath` always defers to the engine codec, so stale settings can't break navigation.

### 11. navigate() guard fixed (public/js/main.js)
- Already-proxied URL guard now only matches Lux proxy paths on the current origin. URLs like `https://example.com/s/page` now work.

### 12. Scramjet/sj-proxy URL decoding (public/js/tabs.js)
- `decodeProxiedUrl` now decodes `/sj-proxy?url=` and `/~/sj/` in addition to UV `/s/`, so tab title/URL sync works for SJ frames.

### 13. Session import cache invalidation (public/js/settings.js, session.js)
- Imported settings now invalidate the in-memory settings cache.

### 14. Notes save button fixed (public/js/editor.js, main.js)
- Save button now uses the actual active editor document instead of calling a nonexistent active editor method.

### 15. Cleanup
- `import crypto` moved to top of server/index.js.
- `httpServer.on("error")` now cleanly reports `EADDRINUSE`.
- `X-Powered-By` disabled.
- Built static bundles get `Cache-Control: public, max-age=3600, stale-while-revalidate=600`.
- UV SW serves `no-cache`.
- Removed dead `popup-perm` usage, `disconnectChat`, and `waitForSjControl`.
- `.dockerignore` and `.gitignore` updated; tracked junk files untracked.
- HTML base injection now matches `<head>` case-insensitively and escapes errors fully.

## Test results

| Test | Result |
|---|---|
| npm run test:block-sim | 10 passed |
| npm run test:vault | 8 passed |
| npm run test:e2e | 4 passed |
| npm run test:features | 45 passed |
| node --check all changed JS | all OK |
| SSRF live endpoint test | 8 passed |
| Shared-mode auth live test | passed |
| Chat handshake + shared gating | passed |
| Trust-proxy /ip test | passed |
| config.local.js test | passed |
| Playwright browser smoke | Example Domain renders via UV, 0 page errors |
| Playwright settings smoke | urlScheme only offers encoded; example.com/s/page navigates |

## Notes
- The old browser tests in tests/browser/*.test.mjs still target the pre-tab UI (`#search-input`, `#cloak-btn`, `#stage`). They are not part of `npm test`; rewrite them for the current UI as a follow-up.
- The /tmp/lux-tests/*.mjs checks were scratch validation; keep in tests/ if they should become permanent.

## Second pass (2026-08-15, speed + UX)

### 16. SW ad-block/privacy/devtools settings now actually applied at runtime
- `public/uv/uv.sw.js` (via build) now receives `adBlock`, `privacyGuard`, `devtools` flags through `lux:settings` postMessage.
- DevTools SW reporting only runs when the DevTools panel is enabled.
- Cosmetic CSS/privacy injection only runs when their toggles are enabled.

### 17. Faster navigation setup
- `tabs.js` runs `setTransportFor`, `engine.init`, and SW `ready` in parallel instead of serially.
- Scramjet early init at boot is now fire-and-forget (does not block first paint).

### 18. Already-proxied URL UX fixed
- Pasting/entering a Lux `/s/`, `/~/sj/`, or `/sj-proxy` URL now opens it as a tab instead of silently doing nothing.
- `loadProxiedUrl` waits for engine/SW ready before setting iframe.src (previously the raw proxied path could hit the server as a plain 404).

### 19. Small UX/perf improvements
- DevTools click uses a toast instead of focus-stealing `alert()`.
- Kill switch detaches/re-attaches iframes when blanking so pending paints can't linger.
- Cloak iframe now sets `referrerpolicy="no-referrer"`.
- Info panel volume poll only touches iframes that actually have media.
- Stats SSE timer unref'd and `req.on("error")` cleanup added.
- `/health` is `no-store`.
- `index.html` adds `<meta name="referrer" content="no-referrer">`.
- Omnibox focuses on boot once unlocked.

## Test results (second pass)

| Test | Result |
|---|---|
| npm run test:features | 45 passed |
| npm run test:block-sim | 10 passed |
| npm run test:vault | 8 passed |
| npm run test:e2e | 4 passed |
| Playwright UV smoke (Example Domain) | passed, 0 page errors |
| Playwright Scramjet smoke (Example Domain) | passed, 0 page errors |
| Playwright proxied-URL paste UX | passed, 0 page errors |
| SSRF live endpoint test | 8 passed |
