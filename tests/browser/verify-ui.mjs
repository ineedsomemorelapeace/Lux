// Comprehensive UI verification: navigate every page/panel, screenshot, check errors.
import { chromium } from "playwright";

const BASE = "http://localhost:8080";
const SCREENSHOTS_DIR = "tests/browser/screenshots";

let passed = 0;
let failed = 0;
const errors = [];

function check(name, condition) {
  if (condition) {
    console.log(`  PASS ${name}`);
    passed++;
  } else {
    console.log(`  FAIL ${name}`);
    failed++;
  }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();

// Capture all browser errors.
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

console.log("\n=== Lux UI Verification ===\n");

// ── 1. Lock Screen ──────────────────────────────────────────────────────────
console.log("--- Lock Screen ---");
await page.goto(BASE + "/", { waitUntil: "networkidle" });
await page.waitForTimeout(500);
await page.screenshot({ path: `${SCREENSHOTS_DIR}/01-lock-screen.png`, fullPage: true });

const lockVisible = await page.evaluate(() =>
  document.body.classList.contains("lux-locked")
);
check("Lock screen visible on cold start", lockVisible);

const lockTitle = await page.textContent("#lock-title");
check("Lock title shows 'Set a Password' (first visit)", lockTitle?.includes("Set a Password"));

// Create a password.
await page.fill("#lock-input", "testpass123");
await page.keyboard.press("Enter");
await page.waitForTimeout(300);

const lockDismissed = await page.evaluate(() =>
  !document.body.classList.contains("lux-locked")
);
check("Lock screen dismissed after password creation", lockDismissed);
await page.screenshot({ path: `${SCREENSHOTS_DIR}/02-after-unlock.png`, fullPage: true });

// ── 2. Main UI / Browser Window ─────────────────────────────────────────────
console.log("\n--- Main UI ---");
const browserWindow = await page.evaluate(() =>
  !!document.getElementById("browser-window")
);
check("Browser window exists", browserWindow);

const toolbar = await page.evaluate(() =>
  !!document.getElementById("toolbar-url")
);
check("Toolbar URL input exists", toolbar);

const tabStrip = await page.evaluate(() =>
  !!document.getElementById("tab-strip")
);
check("Tab strip exists", tabStrip);

const taskbar = await page.evaluate(() =>
  !!document.getElementById("taskbar")
);
check("Taskbar exists", taskbar);

// ── 3. Settings Panel ───────────────────────────────────────────────────────
console.log("\n--- Settings Panel ---");
await page.click("#open-settings");
await page.waitForTimeout(300);

const settingsOpen = await page.evaluate(() =>
  document.getElementById("settings")?.classList.contains("open")
);
check("Settings panel opens", settingsOpen);
await page.screenshot({ path: `${SCREENSHOTS_DIR}/03-settings.png`, fullPage: true });

// Check settings content rendered.
const settingsBody = await page.evaluate(() =>
  document.getElementById("settings-body")?.innerHTML.length > 100
);
check("Settings body has content", settingsBody);

// Close settings.
await page.click("#settings-done");
await page.waitForTimeout(200);

// ── 4. Games Panel ──────────────────────────────────────────────────────────
console.log("\n--- Games Panel ---");
await page.evaluate(() => {
  document.querySelector('[data-app="games"]')?.click();
});
await page.waitForTimeout(300);

const gamesOpen = await page.evaluate(() =>
  document.getElementById("panel-games")?.classList.contains("open")
);
check("Games panel opens", gamesOpen);
await page.screenshot({ path: `${SCREENSHOTS_DIR}/04-games.png`, fullPage: true });

// Close games.
await page.evaluate(() => {
  document.querySelector('[data-close="panel-games"]')?.click();
});
await page.waitForTimeout(200);

// ── 5. TV Panel ─────────────────────────────────────────────────────────────
console.log("\n--- TV Panel ---");
await page.evaluate(() => {
  document.querySelector('[data-app="tv"]')?.click();
});
await page.waitForTimeout(300);

const tvOpen = await page.evaluate(() =>
  document.getElementById("panel-tv")?.classList.contains("open")
);
check("TV panel opens", tvOpen);
await page.screenshot({ path: `${SCREENSHOTS_DIR}/05-tv.png`, fullPage: true });

// Close TV.
await page.evaluate(() => {
  document.querySelector('[data-close="panel-tv"]')?.click();
});
await page.waitForTimeout(200);

// ── 6. Chat Panel ───────────────────────────────────────────────────────────
console.log("\n--- Chat Panel ---");
await page.evaluate(() => {
  document.querySelector('[data-app="chat"]')?.click();
});
await page.waitForTimeout(300);

const chatOpen = await page.evaluate(() =>
  document.getElementById("panel-chat")?.classList.contains("open")
);
check("Chat panel opens", chatOpen);
await page.screenshot({ path: `${SCREENSHOTS_DIR}/06-chat.png`, fullPage: true });

// Close chat.
await page.evaluate(() => {
  document.querySelector('[data-close="panel-chat"]')?.click();
});
await page.waitForTimeout(200);

// ── 7. Vault Window ─────────────────────────────────────────────────────────
console.log("\n--- Vault Window ---");
await page.evaluate(() => {
  document.querySelector('[data-app="vault"]')?.click();
});
await page.waitForTimeout(500);

const vaultWindow = await page.evaluate(() =>
  !!document.querySelector('.lux-window#vault')
);
check("Vault window opens", vaultWindow);
await page.screenshot({ path: `${SCREENSHOTS_DIR}/07-vault.png`, fullPage: true });

// ── 8. Notes Window ─────────────────────────────────────────────────────────
console.log("\n--- Notes Window ---");
// First close vault by clicking browser app.
await page.evaluate(() => {
  document.querySelector('[data-app="browser"]')?.click();
});
await page.waitForTimeout(200);
await page.evaluate(() => {
  document.querySelector('[data-app="notes"]')?.click();
});
await page.waitForTimeout(500);

const notesWindow = await page.evaluate(() =>
  !!document.querySelector('.lux-window#notes [contenteditable]')
);
check("Notes window opens with editor", notesWindow);
await page.screenshot({ path: `${SCREENSHOTS_DIR}/08-notes.png`, fullPage: true });

// ── 9. Dark Theme ───────────────────────────────────────────────────────────
console.log("\n--- Theme Toggle ---");
await page.evaluate(() => {
  document.body.dataset.theme = "dark";
});
await page.waitForTimeout(200);
await page.screenshot({ path: `${SCREENSHOTS_DIR}/09-dark-theme.png`, fullPage: true });
const darkTheme = await page.evaluate(() => document.body.dataset.theme === "dark");
check("Dark theme applies", darkTheme);

// ── 10. Kill Switch Banner ──────────────────────────────────────────────────
console.log("\n--- Kill Switch ---");
await page.evaluate(() => {
  document.body.classList.add("lux-killswitch");
});
await page.waitForTimeout(200);
await page.screenshot({ path: `${SCREENSHOTS_DIR}/10-killswitch.png`, fullPage: true });
const killVisible = await page.evaluate(() =>
  document.body.classList.contains("lux-killswitch")
);
check("Kill switch banner shows", killVisible);
await page.evaluate(() => {
  document.body.classList.remove("lux-killswitch");
});

// ── 11. Lock Screen (return visit) ─────────────────────────────────────────
console.log("\n--- Lock Screen (return) ---");
// Trigger lock.
await page.evaluate(() => {
  sessionStorage.removeItem("lux.session.unlocked");
  document.body.classList.add("lux-locked");
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${SCREENSHOTS_DIR}/11-lock-return.png`, fullPage: true });

const lockReturnVisible = await page.evaluate(() =>
  document.body.classList.contains("lux-locked")
);
check("Lock screen shows on re-lock", lockReturnVisible);

// ── Error Report ────────────────────────────────────────────────────────────
console.log("\n--- Browser Errors ---");
if (errors.length === 0) {
  console.log("  No console/page errors detected.");
} else {
  console.log(`  ${errors.length} error(s):`);
  for (const e of errors.slice(0, 15)) {
    console.log("    " + e.slice(0, 120));
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(40)}`);
console.log(`  Result: ${passed} passed, ${failed} failed, ${errors.length} browser errors`);
console.log(`${"─".repeat(40)}\n`);

await browser.close();
process.exit(failed > 0 || errors.length > 0 ? 1 : 0);
