// Kill switch. Halts all proxied traffic the moment the network changes
// (online/offline/connectivity event, or a visible IP change) until the user
// explicitly confirms the new network is trusted. Prevents a proxy session
// from silently continuing on a hostile Wi-Fi after a network switch.

import { loadSettings } from "./settings.js";
import { getAllTabs, navigateTab, getActiveTab } from "./tabs.js";

let armed = false;
let tripped = false;
let lastIp = null;

const listeners = [];

export function onTrip(cb) {
  listeners.push(cb);
}

function trip(reason) {
  if (tripped) return;
  tripped = true;
  // Actually halt traffic: stop all tab iframes and blank them.
  pauseAllTabs();
  document.body.classList.add("lux-killswitch");
  window.dispatchEvent(new CustomEvent("lux:killswitch", { detail: { reason } }));
  for (const cb of listeners) {
    try {
      cb(reason);
    } catch {}
  }
}

// Stop all in-flight requests and blank the iframes so no content is visible.
function pauseAllTabs() {
  for (const tab of getAllTabs()) {
    try { tab.iframe.contentWindow.stop(); } catch {}
    tab.iframe.src = "about:blank";
  }
}

// Restore the active tab by re-navigating to its stored URL.
function resumeTabs() {
  const active = getActiveTab();
  if (active && active.url) {
    navigateTab(active.id, active.url, false);
  }
}

export function isTripped() {
  return tripped;
}

export function arm() {
  const s = loadSettings();
  if (!s.killSwitch || armed) return;
  armed = true;

  // Record the time we armed. The browser fires an initial "online" event at
  // page load which we must ignore — only trip on events that come after a
  // short grace period (the page was already online when it loaded).
  const armedAt = Date.now();
  const GRACE_MS = 3000;

  window.addEventListener("online", () => {
    if (Date.now() - armedAt > GRACE_MS) trip("network:online");
  });
  window.addEventListener("offline", () => trip("network:offline"));
  // connection.addEventListener('change') fires on Wi-Fi/cellular handoff.
  if (navigator.connection) {
    navigator.connection.addEventListener("change", () => {
      if (Date.now() - armedAt > GRACE_MS) trip("network:changed");
    });
  }
}

export async function disarm() {
  tripped = false;
  document.body.classList.remove("lux-killswitch");
  // Resume the active tab's navigation.
  resumeTabs();
}

// Record the apparent egress IP (via the server's own echo endpoint) and
// trip the kill switch if it changes mid-session. The server exposes /ip
// returning the client's observed IP.
export async function checkIpOnce() {
  try {
    const r = await fetch("/ip", { cache: "no-store" });
    const j = await r.json();
    if (lastIp && j.ip && j.ip !== lastIp) {
      trip("ip-changed: " + lastIp + " -> " + j.ip);
    }
    lastIp = j.ip;
    return j.ip;
  } catch {
    return null;
  }
}

export function getLastIp() {
  return lastIp;
}
