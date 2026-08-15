// Lux server configuration. Copy this to config.local.js and edit, or set
// environment variables. config.local.js (if present) overrides these defaults.
//
// Modes:
//   "single"  — local use only. No session login. Anyone on the same machine
//               (or LAN, since the server binds 0.0.0.0) can use it, but there
//               is no per-session isolation.
//   "shared"  — for hosting on a VPS or sharing on a network. Requires a
//               session ID + password to access. Sessions persist for
//               SESSION_TTL_HOURS (default 168 = 1 week). Anyone with the UUID
//               and password can load the session.

export const config = {
  // "single" or "shared".
  mode: process.env.LUX_MODE || "single",

  // Port and host.
  port: Number(process.env.PORT) || 8080,
  host: process.env.HOST || "0.0.0.0",

  // Set LUX_TRUST_PROXY=1 (or trustProxy: true in config.local.js) when Lux
  // runs behind nginx/Caddy. This makes Express trust X-Forwarded-For for
  // req.ip and the /ip echo. Leave off otherwise.
  trustProxy: process.env.LUX_TRUST_PROXY === "1" || process.env.LUX_TRUST_PROXY === "true" || false,

  // Optional bearer token required for /stats/json and /stats/stream.
  // Set via STATS_TOKEN env var or statsToken in config.local.js.
  statsToken: process.env.STATS_TOKEN || "",

  // Shared-mode session settings.
  sessionTtlHours: Number(process.env.LUX_SESSION_TTL_HOURS) || 168, // 1 week

  // Master password for shared mode. Users must submit this to get a session.
  // Set via LUX_MASTER_PASSWORD env var or config.local.js. If empty in shared
  // mode, the server refuses to start (prevents accidental open access).
  masterPassword: process.env.LUX_MASTER_PASSWORD || "",

  // In single mode the server binds 0.0.0.0 by default, which exposes it to
  // the LAN. Set LUX_HOST=127.0.0.1 to restrict to localhost only.
};

// Merge config.local.js if it exists.
try {
  const local = await import("../config.local.js");
  if (local.config) Object.assign(config, local.config);
} catch {
  // No local override; use defaults.
}
