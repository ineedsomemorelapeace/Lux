// Lux server.
//
// Architecture:
//   1. Express serves the static front-end from public/.
//   2. The Ultraviolet (UV) client bundle is served from /uv/ (built by
//      `npm run build:uv`), bare-mux from /baremux/, epoxy transport from
//      /epoxy/.
//   3. The same Node http.Server handles WebSocket upgrades on /wisp/ via
//      wisp-js. The browser's UV service worker tunnels all proxied traffic
//      through this WSS endpoint using the Epoxy transport.
//   4. /stats/json and /stats/stream expose the active-user counter.
//
// Env:
//   PORT      listen port (default 8080)
//   HOST      listen host (default 0.0.0.0)

import express from "express";
import compression from "compression";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { server as wisp, logging as wispLogging } from "@mercuryworkshop/wisp-js/server";
import { statsJson, statsSse, userConnected, userDisconnected } from "./stats.js";
import { config } from "./config.js";
import { createSession, sessionExists, configureSessionTtl } from "./sessions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const publicDir = join(root, "public");

// Use the merged config (env vars + config.local.js), not just raw env vars.
const PORT = Number(config.port) || 8080;
const HOST = config.host || "0.0.0.0";

configureSessionTtl(config.sessionTtlHours);

// Minimal login page for shared mode. No external dependencies.
const LOGIN_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lux</title>
<style>body{margin:0;height:100dvh;display:flex;align-items:center;justify-content:center;background:#fbfbfa;font-family:Georgia,serif}form{display:flex;flex-direction:column;gap:14px;align-items:center}input{width:240px;height:44px;border:1px solid #e8e8e6;border-radius:999px;text-align:center;font-size:16px;outline:none;background:transparent;color:#1a1a1a}input:focus{border-color:#6b6b6b}button{height:44px;padding:0 24px;border:0;border-radius:999px;background:#1a1a1a;color:#fbfbfa;font-size:14px;cursor:pointer}</style>
</head><body><form id="f"><input id="p" type="password" placeholder=" " maxlength="64" autofocus><button type="submit">Enter</button></form>
<script>document.getElementById("f").onsubmit=async(e)=>{e.preventDefault();const p=document.getElementById("p").value;const r=await fetch("/api/session",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:p})});if(r.ok){location.href="/";}else{document.getElementById("p").value="";document.getElementById("p").placeholder="try again";}};</script>
</body></html>`;

// Quieter wisp logs in production; keep INFO for debugging locally.
if (process.env.NODE_ENV === "production") {
  wispLogging.set_level(wispLogging.WARN);
}

const app = express();
app.disable("x-powered-by");
if (config.trustProxy) app.set("trust proxy", 1);

// In shared mode, gate every request behind a session cookie. The login page
// and the session-create endpoint are exempt. In single mode, no auth.
// /stats/json and /stats/stream are left open so operators can monitor load;
// set STATS_TOKEN in config.local.js to require it.
const MODE = config.mode || "single";
const STATS_TOKEN = process.env.STATS_TOKEN || config.statsToken || "";

function statsAuthorized(req) {
  if (!STATS_TOKEN) return true;
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.query.token || "";
  return token === STATS_TOKEN;
}
if (MODE === "shared" && !config.masterPassword) {
  console.error("\n  FATAL: shared mode requires a master password.");
  console.error("  Set LUX_MASTER_PASSWORD env var or add masterPassword to config.local.js.\n");
  process.exit(1);
}
if (MODE === "shared") {
  app.use((req, res, next) => {
    // Exempt the login page and the API endpoints.
    if (req.path === "/login" || req.path === "/api/session" || req.path === "/health") {
      return next();
    }
    // Check the session cookie.
    if (hasValidSession(req)) return next();
    // No valid session: redirect to login.
    if (req.path.startsWith("/api/") || req.headers.accept?.includes("application/json")) {
      return res.status(401).json({ error: "no session" });
    }
    return res.redirect("/login");
  });
  console.log("  Mode: shared (session auth required)");
}

function parseCookie(header, name) {
  for (const part of header.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === name) return v;
  }
  return null;
}

function hasValidSession(req) {
  const sid = parseCookie(req.headers.cookie || "", "lux_sid");
  return !!sid && sessionExists(sid);
}

// Count each unique connection toward the active-user stat, keyed by Host so
// multi-domain deployments can see per-hostname load.
// gzip all responses — uv.bundle alone drops from 379KB to 110KB on the wire.
app.use(compression());
// Count active users per session, not per request. A session is identified by
// the lux_sid cookie (shared mode) or a temporary one set on first visit
// (single mode). This prevents the counter from inflating by ~50 on every
// page load (one increment per asset request).
const countedSessions = new Set();
app.use((req, res, next) => {
  const host = req.headers.host || "unknown";
  // Only count page navigations (HTML), not assets.
  const accept = req.headers.accept || "";
  const isPageNav = accept.includes("text/html") && req.method === "GET";
  if (isPageNav) {
    let sid = parseCookie(req.headers.cookie || "", "lux_sid") ||
              parseCookie(req.headers.cookie || "", "lux_guest");
    if (!sid) {
      sid = "g_" + Math.random().toString(36).slice(2, 10);
      res.cookie("lux_guest", sid, { maxAge: 86400000, httpOnly: true, sameSite: "lax" });
    }
    const key = sid + "@" + host;
    if (!countedSessions.has(key)) {
      countedSessions.add(key);
      userConnected(host);
    }
    res.on("close", () => {
      // Delay disconnect so rapid navigations within a session don't flap.
      // 30s is long enough to cover multi-asset page loads and short enough
      // to reflect genuine departures within a minute.
      setTimeout(() => {
        if (countedSessions.has(key)) {
          countedSessions.delete(key);
          userDisconnected(host);
        }
      }, 30000);
    });
  }
  next();
});

// Static mounts. Order matters: the SW scope root must be able to fetch these.
// The bare-mux worker is fetched with strict same-origin expectations, so each
// engine + transport gets its own mount.
// transportStaticOptions sets correct MIME types for .mjs/.js/.wasm. Browsers
// refuse to execute modules served as text/plain, and WASM needs the wasm MIME
// to compile. Interstellar does the same; without it some strict browsers
// silently fail to load the transport.
const transportStaticOptions = {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".mjs") || filePath.endsWith(".js")) {
      res.type("text/javascript");
    } else if (filePath.endsWith(".wasm")) {
      res.type("application/wasm");
    }
    // Built bundles change only on rebuild/redeploy; allow 1h revalidation.
    res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=600");
  },
  fallthrough: false,
};
app.use("/uv", express.static(join(publicDir, "uv"), transportStaticOptions));
app.use("/baremux", express.static(join(publicDir, "baremux"), transportStaticOptions));
app.use("/epoxy", express.static(join(publicDir, "epoxy"), transportStaticOptions));
app.use("/scramjet", express.static(join(publicDir, "scramjet"), transportStaticOptions));
// Tinf0il-style Scramjet paths: /scram/ (scramjet runtime), /controller/
// (controller API + SW), /clients/ (libcurl transport with embedded wasm).
app.use("/scram", express.static(join(publicDir, "scramjet"), transportStaticOptions));
app.use("/controller", express.static(join(publicDir, "controller"), transportStaticOptions));
app.use("/clients", express.static(join(publicDir, "libcurl"), transportStaticOptions));
app.use("/libcurl", express.static(join(publicDir, "libcurl"), transportStaticOptions));
app.use("/cloak", express.static(join(publicDir, "cloak"), transportStaticOptions));
// webretro emulator (static, ~95MB — cloned by the operator or build script).
// Served with correct MIME for .wasm/.js cores.
app.use("/webretro", express.static(join(publicDir, "webretro"), transportStaticOptions));
app.use("/css", express.static(join(publicDir, "css"), transportStaticOptions));
app.use("/js", express.static(join(publicDir, "js"), transportStaticOptions));
app.use("/data", express.static(join(publicDir, "data"), transportStaticOptions));
app.use("/assets", express.static(join(publicDir, "assets"), { fallthrough: false }));

// The proxy service workers must control the proxy path (/service/ for UV,
// /scramjet/ routes for Scramjet). A service worker can only intercept URLs
// within its scope, and by default its scope is the directory of its script.
// We serve the SW scripts at root and set Service-Worker-Allowed: / so the
// registration can claim scope "/" and intercept /service/*. Without this the
// proxy loads the page but never rewrites anything.
app.get("/uv.sw.js", (req, res) => {
  res.set("Service-Worker-Allowed", "/");
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(join(publicDir, "uv/uv.sw.js"));
});
app.get("/sj.sw.js", (req, res) => {
  res.set("Service-Worker-Allowed", "/");
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.type("text/javascript");
  // The raw controller.sw.js defines $scramjetController.{shouldRoute, route}
  // but does NOT wire a fetch event listener. Tinf0il generates a wrapper SW
  // that importScripts the controller SW and adds the fetch handler. We do
  // the same here.
  res.send(`// Generated SJ SW wrapper (Tinf0il pattern) + devtools reporting.
importScripts("/controller/controller.sw.js");
self.addEventListener("fetch", (event) => {
  try {
    if ($scramjetController.shouldRoute(event)) {
      event.respondWith(sjReport($scramjetController.route(event), event.request));
    }
  } catch (e) {
    console.error("[sj.sw] fetch handler error:", e);
  }
});
// Report proxied request info to the DevTools panel (same pattern as UV SW).
async function sjReport(promise, req) {
  try {
    const resp = await promise;
    const size = resp.headers.get("content-length") || "?";
    const clients = await self.clients.matchAll({ type: "window" });
    for (const client of clients) {
      client.postMessage({
        luxDevtools: true,
        method: req.method,
        url: req.url,
        status: resp.status,
        size: size,
      });
    }
    return resp;
  } catch (e) {
    return new Response("SJ fetch error: " + e.message, { status: 502 });
  }
}
`);
});

app.use(express.static(publicDir));

// Clean 404 page for invalid URLs.
const PAGE_NOT_FOUND = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>404 — Lux</title>
<style>
body{margin:0;height:100dvh;display:flex;align-items:center;justify-content:center;
  font-family:system-ui,-apple-system,sans-serif;background:#faf9f6;color:#1a1a1a}
.wrap{text-align:center;max-width:420px;padding:24px}
h1{font-size:64px;margin:0 0 8px;font-weight:300;letter-spacing:-2px}
p{font-size:15px;line-height:1.6;color:#666;margin:0 0 16px}
.detail{font-size:12px;color:#999;word-break:break-all;padding:8px;
  background:#f0efec;border-radius:6px;margin:12px 0}
a{color:#1a1a1a;text-decoration:underline}
a:hover{color:#666}</style></head><body><div class="wrap">
<h1>404</h1>
<p>The page you requested could not be loaded.<br>
If you believe this is an error, please contact the site owner.</p>
<a href="/">Return to Lux</a>
</div></body></html>`;

// ---- Server-side proxy helper ----
// Shared logic for /sj-proxy and /api/tv-proxy. Fetches a URL server-side,
// strips dangerous headers, injects a <base> tag for relative URL resolution.
// Security: blocks private/internal IPs (SSRF) and HTML-escapes the base href.

function isPrivateHost(hostname) {
  // Quick textual checks first (no DNS needed for these).
  if (!hostname) return true;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "localhost.localdomain" || h === "localhost6") return true;
  if (h === "0.0.0.0" || h === "0" || h === "[::]" || h === "::") return true;
  // Link-local / cloud metadata.
  if (h === "169.254.169.254" || h.startsWith("169.254.")) return true;
  if (h === "metadata.google.internal" || h.endsWith(".metadata.google.internal")) return true;
  // IPv4 literal checks (incl. alternate forms).
  if (/^\d+$/.test(h)) return isPrivateIp(h);
  if (isIP(h)) return isPrivateIp(h);
  // IPv6 private/link-local without brackets.
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true;
  return false;
}

function isPrivateIp(address) {
  // Normalize IPv4-mapped IPv6 (::ffff:1.2.3.4) and bracket wrappers.
  let a = String(address || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (a.startsWith("::ffff:")) a = a.slice("::ffff:".length);
  const v = isIP(a);
  if (!v) return true; // unresolved or invalid -> treat as private (deny)
  if (v === 6) {
    if (a === "::" || a === "::1") return true;
    // Unique-local fc00::/7 and link-local fe80::/10.
    if (a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb")) return true;
    // IPv4-mapped IPv6 loopback.
    return false;
  }
  const parts = a.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a1, b, c] = parts;
  if (a1 === 0 || a1 === 10 || a1 === 127) return true;
  if (a1 === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a1 === 169 && b === 254) return true;
  if (a1 === 172 && b >= 16 && b <= 31) return true;
  if (a1 === 192 && b === 168) return true;
  if (a1 >= 224) return true; // multicast/experimental
  return false;
}

async function assertPublicUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Unsupported protocol");
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateHost(hostname)) throw new Error("Blocked address");
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("Blocked address");
    return;
  }
  // Resolve DNS and verify every address is public (prevents DNS rebinding).
  let records;
  try {
    records = await dnsLookup(hostname, { all: true });
  } catch {
    throw new Error("Could not resolve hostname");
  }
  if (!records?.length) throw new Error("Could not resolve hostname");
  for (const r of records) {
    if (isPrivateIp(r.address)) throw new Error("Blocked address");
  }
}

function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function fetchWithRedirectChecks(url, headers) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(current);
    const resp = await fetch(current, { headers, redirect: "manual" });
    const status = resp.status;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = resp.headers.get("location");
      if (!location) return resp;
      current = new URL(location, current).href;
      continue;
    }
    return resp;
  }
  throw new Error("Too many redirects");
}

async function proxyFetch(req, res, { allowHeaders = false } = {}) {
  const target = req.query.url;
  if (!target || typeof target !== "string") {
    return res.status(400).type("html").send(PAGE_NOT_FOUND);
  }
  if (!target.startsWith("http://") && !target.startsWith("https://")) {
    return res.status(400).type("html").send(PAGE_NOT_FOUND);
  }
  try {
    await assertPublicUrl(target);
  } catch (e) {
    return res.status(403).type("html").send(PAGE_NOT_FOUND);
  }
  try {
    const fetchHeaders = { "User-Agent": req.headers["user-agent"] || "" };
    if (allowHeaders) {
      if (req.headers["x-cookie"]) fetchHeaders.cookie = req.headers["x-cookie"];
      if (req.headers["x-referer"]) fetchHeaders.referer = req.headers["x-referer"];
    }
    const resp = await fetchWithRedirectChecks(target, fetchHeaders);
    res.status(resp.status);
    for (const [k, v] of resp.headers) {
      const lk = k.toLowerCase();
      // Set-Cookie/clear-site-data are stripped so a proxied site cannot
      // overwrite Lux's own cookies. X-Frame-Options and CSP are stripped so
      // the proxied page can render in Lux's iframe.
      if (["transfer-encoding", "connection", "keep-alive", "content-security-policy",
           "content-security-policy-report-only", "content-encoding", "content-length",
           "set-cookie", "clear-site-data", "x-frame-options"].includes(lk)) continue;
      res.setHeader(k, v);
    }
    const ct = resp.headers.get("content-type") || "";
    const buf = Buffer.from(await resp.arrayBuffer());
    if (ct.includes("text/html")) {
      let html = buf.toString("utf8");
      // Insert <base> into the first <head>/<HEAD> so relative URLs resolve.
      html = html.replace(/<head[^>]*>/i, (m) => m + `<base href="${escapeAttr(target)}">`);
      res.setHeader("content-length", Buffer.byteLength(html));
      return res.send(html);
    }
    res.send(buf);
  } catch (e) {
    const msg = e.message || String(e);
    const withError = PAGE_NOT_FOUND.replace(
      "</p>",
      `</p><div class="detail">${escapeHtml(msg)}</div>`
    );
    res.status(502).type("html").send(withError);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Scramjet proxy endpoint: fetches a URL on the server side and returns
// the response with a <base> tag for relative URL resolution.
app.get("/sj-proxy", (req, res) => proxyFetch(req, res));

// TV proxy endpoint: same as /sj-proxy but also maps x-cookie/x-referer headers.
app.get("/api/tv-proxy", (req, res) => proxyFetch(req, res, { allowHeaders: true }));

// Stats endpoints (Phase 3 status page consumes these; harmless now).
app.get("/stats/json", (req, res) => {
  if (!statsAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  return statsJson(req, res);
});
app.get("/stats/stream", (req, res) => {
  if (!statsAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  return statsSse(req, res);
});

// Health check for deploy platforms. A page-only response is not enough:
// UV can show the Lux interface while its generated transport bundles are absent.
const REQUIRED_PROXY_FILES = [
  "uv/uv.bundle.js",
  "uv/uv.config.js",
  "uv/uv.sw.js",
  "baremux/index.mjs",
  "baremux/worker.js",
  "epoxy/index.mjs",
  "epoxy/epoxy-bundled.js",
  "epoxy/epoxy.wasm",
];
app.get("/health", (req, res) => {
  res.set("Cache-Control", "no-store");
  const missing = REQUIRED_PROXY_FILES.filter((file) => !existsSync(join(publicDir, file)));
  const ok = missing.length === 0;
  res.status(ok ? 200 : 503).json({
    ok,
    proxyReady: ok,
    ...(ok ? {} : { missing }),
  });
});

// Session creation (shared mode). POST { password } -> { sessionId, expires }.
// The submitted password is verified against the configured master password.
// Only on a match is a session created and the cookie set.
app.use("/api/session", (req, res, next) => {
  if (req.method === "POST") {
    if (loginRateLimited(req)) {
      return res.status(429).json({ error: "too many attempts" });
    }
    express.json({ limit: "64kb" })(req, res, (err) => {
      if (err) return res.status(400).json({ error: "invalid body" });
      const password = typeof req.body.password === "string" ? req.body.password.slice(0, 64) : "";
      // Verify against the master password using timing-safe comparison.
      if (!verifyMasterPassword(password)) {
        return res.status(401).json({ error: "wrong password" });
      }
      const { id, expires } = createSession(password);
      res.cookie("lux_sid", id, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.secure || req.headers["x-forwarded-proto"] === "https",
        maxAge: expires - Date.now(),
      });
      res.json({ sessionId: id, expires });
    });
  } else if (req.method === "GET") {
    res.json({ mode: MODE });
  } else {
    next();
  }
});

// Timing-safe comparison of the submitted password against the master password.
function verifyMasterPassword(candidate) {
  const master = config.masterPassword;
  if (!master) return false; // No master password configured = deny all.
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(master, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Brute-force throttle for the shared-mode login endpoint.
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_BLOCK_MS = 10 * 60 * 1000;

function loginRateLimited(req) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || now > entry.blockUntil + LOGIN_WINDOW_MS) {
    entry = { count: 0, blockUntil: 0 };
    loginAttempts.set(ip, entry);
  }
  if (entry.blockUntil > now) return true;
  entry.count++;
  if (entry.count > LOGIN_MAX_ATTEMPTS) {
    entry.blockUntil = now + LOGIN_BLOCK_MS;
    entry.count = 0;
    return true;
  }
  return false;
}

// Login page (shared mode). A minimal form that POSTs to /api/session.
app.get("/login", (req, res) => {
  res.type("html").send(LOGIN_HTML);
});

// Egress IP echo. Used by the kill switch and the IP badge. Returns the
// client's apparent IP (as the server sees it). Express only honors
// X-Forwarded-For when `trust proxy` is enabled (LUX_TRUST_PROXY=1 or
// config.local.js trustProxy), so spoofed XFF headers are ignored by default.
app.get("/ip", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "";
  res.set("Cache-Control", "no-store").json({ ip });
});

// ---- Chat WebSocket ----
// Simple in-memory chat. Minimal WebSocket implementation using Node's
// built-in crypto for the handshake, and raw TCP frames for messaging.

const CHAT_HISTORY = [];
const CHAT_MAX = 100;
const chatClients = new Set();

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const send of chatClients) {
    try { send(payload); } catch { chatClients.delete(send); }
  }
}

function handleChat(req, socket) {
  if (req.headers["upgrade"]?.toLowerCase() !== "websocket") {
    return socket.end();
  }
  // The Express session middleware does not run for WebSocket upgrades.
  if (MODE === "shared" && !hasValidSession(req)) {
    return socket.end();
  }

  const key = req.headers["sec-websocket-key"];
  if (!key || req.headers["sec-websocket-version"] !== "13") {
    return socket.end();
  }
  const accept = crypto.createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );

  let buffer = Buffer.alloc(0);
  const MAX_MESSAGE = 65536; // 64KB cap per message
  const MAX_BUFFER = 262144; // 256KB total buffer cap (prevents memory DoS)

  function sendWS(data) {
    const payload = Buffer.from(data, "utf8");
    const len = payload.length;
    let frame;
    if (len < 126) {
      frame = Buffer.alloc(2 + len);
      frame[0] = 0x81;
      frame[1] = len;
      payload.copy(frame, 2);
    } else if (len < 65536) {
      frame = Buffer.alloc(4 + len);
      frame[0] = 0x81;
      frame[1] = 126;
      frame.writeUInt16BE(len, 2);
      payload.copy(frame, 4);
    } else {
      frame = Buffer.alloc(10 + len);
      frame[0] = 0x81;
      frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(len), 2);
      payload.copy(frame, 10);
    }
    socket.write(frame);
  }

  function sendPong(payload) {
    const frame = Buffer.alloc(2 + payload.length);
    frame[0] = 0x8a; // FIN + pong opcode
    frame[1] = payload.length;
    payload.copy(frame, 2);
    socket.write(frame);
  }

  function sendClose() {
    socket.write(Buffer.from([0x88, 0x00])); // FIN + close, no payload
  }

  chatClients.add(sendWS);
  if (CHAT_HISTORY.length) {
    sendWS(JSON.stringify({ type: "history", messages: CHAT_HISTORY }));
  }
  broadcast({ type: "system", text: "A user joined the chat." });

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    // Guard against unbounded buffer growth (memory DoS).
    if (buffer.length > MAX_BUFFER) {
      chatClients.delete(sendWS);
      sendClose();
      socket.end();
      return;
    }
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      const masked = buffer[1] & 0x80;
      let payloadLen = buffer[1] & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      let maskKey = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.slice(offset, offset + 4);
        offset += 4;
      }

      if (buffer.length < offset + payloadLen) return;

      // Enforce per-message size cap.
      if (payloadLen > MAX_MESSAGE) {
        chatClients.delete(sendWS);
        sendClose();
        socket.end();
        return;
      }

      let payload = Buffer.from(buffer.slice(offset, offset + payloadLen));
      if (maskKey) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      }
      buffer = buffer.slice(offset + payloadLen);

      // Ping: respond with pong (echo payload).
      if (opcode === 0x09) {
        sendPong(payload);
        continue;
      }
      // Close: echo and disconnect.
      if (opcode === 0x08) {
        chatClients.delete(sendWS);
        sendClose();
        socket.end();
        broadcast({ type: "system", text: "A user left the chat." });
        return;
      }
      if (opcode === 0x01) {
        const raw = payload.toString("utf8");
        let name = "Anonymous", text = raw;
        try {
          const parsed = JSON.parse(raw);
          if (parsed.text) text = parsed.text;
          if (parsed.name) name = parsed.name;
        } catch {}
        const msg = { type: "message", name, text, time: Date.now() };
        CHAT_HISTORY.push(msg);
        if (CHAT_HISTORY.length > CHAT_MAX) CHAT_HISTORY.shift();
        broadcast(msg);
      }
    }
  });

  socket.on("close", () => {
    chatClients.delete(sendWS);
    broadcast({ type: "system", text: "A user left the chat." });
  });

  socket.on("error", () => {
    chatClients.delete(sendWS);
    try { socket.end(); } catch {}
  });
}

// Create the HTTP server and attach wisp to the upgrade event. UV's service
// worker connects to /wisp/ over WebSocket; wisp.routeRequest multiplexes
// each connection into per-stream TCP/UDP tunnels to the real destinations.
const httpServer = createServer(app);
httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  FATAL: port ${err.port} is already in use.`);
    console.error("  Stop the other process or set PORT to a different value.\n");
  } else {
    console.error("\n  FATAL server error:", err.message, "\n");
  }
  process.exit(1);
});
httpServer.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/wisp/")) {
    wisp.routeRequest(req, socket, head);
  } else if (req.url === "/chat/") {
    handleChat(req, socket);
  } else {
    socket.end();
  }
});

httpServer.listen(PORT, HOST, () => {
  const addr = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
  console.log(`\n  Lux running   -> ${addr}`);
  console.log(`  Wisp endpoint -> ws://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/wisp/`);
  console.log(`  Stats         -> ${addr}/stats/json\n`);
});
