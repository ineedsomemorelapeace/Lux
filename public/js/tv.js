// TV / Live Tab panel. App-dashboard style (inspired by tinf0il.site/tv).
// Shows app cards (YouTube, Discord, etc.) in a grid that load proxied via
// /api/tv-proxy. URL input for any custom site.

const TV_CUSTOM_KEY = "lux.tv.customPicks";
const $ = (id) => document.getElementById(id);

// Default app catalog — proxied-friendly popular sites
const DEFAULT_APPS = [
  { label: "YouTube", url: "https://youtube.com", icon: "YT" },
  { label: "Twitch", url: "https://twitch.tv", icon: "TW" },
  { label: "Discord", url: "https://discord.com/app", icon: "DC" },
  { label: "Reddit", url: "https://reddit.com", icon: "RD" },
  { label: "TikTok", url: "https://tiktok.com", icon: "TT" },
  { label: "Spotify", url: "https://open.spotify.com", icon: "SP" },
  { label: "GeForce NOW", url: "https://play.geforcenow.com", icon: "GN" },
  { label: "Chess.com", url: "https://chess.com", icon: "CH" },
  { label: "VS Code", url: "https://vscode.dev", icon: "VS" },
  { label: "Google", url: "https://google.com", icon: "GO" },
  { label: "DuckDuckGo", url: "https://duckduckgo.com", icon: "DD" },
  { label: "Wikipedia", url: "https://en.wikipedia.org", icon: "WI" },
];

let currentFrame = null;

export async function initTV() {
  const home = $("tv-home");
  const player = $("tv-player");
  const frame = $("tv-frame");
  const urlInput = $("tv-url");
  const loadBtn = $("tv-load");
  const backBtn = $("tv-back");
  const appGrid = $("tv-app-grid");

  if (!home || !player || !appGrid) return;

  // Render app grid: default apps + any custom ones from localStorage
  renderAppGrid(appGrid);

  // Load URL from input
  const doLoad = (val) => {
    const input = val || urlInput.value.trim();
    if (input) loadUrl(input);
  };
  loadBtn.onclick = () => doLoad();
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLoad();
  });

  // Back button — returns to grid
  backBtn.onclick = () => {
    player.style.display = "none";
    home.style.display = "flex";
    if (currentFrame) { currentFrame.src = "about:blank"; currentFrame = null; }
  };

  // Focus input when panel opens
  const panel = $("panel-tv");
  if (panel) {
    const obs = new MutationObserver(() => {
      if (panel.classList.contains("open")) setTimeout(() => urlInput.focus(), 100);
    });
    obs.observe(panel, { attributes: true, attributeFilter: ["class"] });
  }
}

function renderAppGrid(container) {
  const apps = getApps();
  container.innerHTML = "";
  for (const a of apps) {
    const card = document.createElement("button");
    card.className = "tv-app-card";
    card.innerHTML = `<span class="tv-app-icon">${escapeHtml(a.icon)}</span><span class="tv-app-label">${escapeHtml(a.label)}</span>`;
    card.onclick = () => loadUrl(a.url);
    container.appendChild(card);
  }
}

function getApps() {
  let custom = [];
  try {
    const raw = localStorage.getItem(TV_CUSTOM_KEY);
    if (raw) custom = JSON.parse(raw);
  } catch {}
  return [...DEFAULT_APPS, ...custom];
}

async function loadUrl(input) {
  const home = $("tv-home");
  const player = $("tv-player");
  const frame = $("tv-frame");
  if (!input || !home || !player || !frame) return;

  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Only HTTP and HTTPS sites can be opened.");
    url = parsed.href;
  } catch (error) {
    showTvError(error.message || "Enter a valid website address.");
    return;
  }

  home.style.display = "none";
  player.style.display = "flex";
  const priorError = $("tv-load-error");
  if (priorError) priorError.style.display = "none";
  currentFrame = frame;

  // Use Lux's real proxy engine rather than /api/tv-proxy. The latter is a
  // single HTTP fetch and cannot carry a site's WebSockets, streaming media,
  // client-side routing, or normal login/session flows (Twitch is a notable
  // example). UV/Scramjet use the same Wisp transport as normal browser tabs.
  frame.setAttribute("allow", "autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-read; clipboard-write");
  frame.setAttribute("allowfullscreen", "");
  frame.setAttribute("webkit-playsinline", "");
  frame.setAttribute("playsinline", "");
  frame.setAttribute("referrerpolicy", "no-referrer");

  try {
    const { getEngine, setTransportFor } = await import("./tab-nav.js");
    const engine = getEngine();
    await Promise.all([
      setTransportFor(engine.name),
      engine.init(),
      navigator.serviceWorker?.ready.catch(() => {}),
    ]);
    // Safari can have an active registration without a controller on the
    // first visit. Refuse to load a raw proxy path until control is available.
    if ("serviceWorker" in navigator && !navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          navigator.serviceWorker.removeEventListener("controllerchange", onChange);
          resolve();
        };
        const onChange = () => {
          if (navigator.serviceWorker.controller) finish();
        };
        navigator.serviceWorker.addEventListener("controllerchange", onChange);
        setTimeout(finish, 2500);
      });
    }
    if ("serviceWorker" in navigator && !navigator.serviceWorker.controller) {
      throw new Error("The proxy worker is not controlling this page yet. Reload Lux once, then try again.");
    }
    frame.src = engine.encode(url);
  } catch (error) {
    console.error("[lux] Live panel navigation failed:", error);
    showTvError(error.message || "This site could not be started by the proxy engine.");
  }
}

function showTvError(message) {
  let status = $("tv-load-error");
  if (!status) {
    status = document.createElement("div");
    status.id = "tv-load-error";
    status.setAttribute("role", "status");
    status.style.cssText = "padding:10px 12px;margin:8px 0;border:1px solid var(--line);border-radius:8px;color:var(--ink-soft);font-size:13px";
    const player = $("tv-player");
    if (player) player.prepend(status);
  }
  status.textContent = message;
  status.style.display = "block";
}

// Add a custom app card
export function addCustomApp(label, url, icon) {
  const apps = getApps();
  apps.push({ label, url: url.startsWith("http") ? url : "https://" + url, icon: icon || label.slice(0, 2).toUpperCase() });
  try { localStorage.setItem(TV_CUSTOM_KEY, JSON.stringify(apps.filter(a => !DEFAULT_APPS.find(d => d.url === a.url)))); } catch {}
  const grid = $("tv-app-grid");
  if (grid) renderAppGrid(grid);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
}
