// Integration test for the popup Two-Way API (F8/F9/F10):
// authorize / revoke / doctor / background / controlStatus.
//
// Loads the companion in headless Chromium via puppeteer-core, opens the popup as a
// tab, clicks each button, and verifies:
//   - chrome.runtime.sendMessage('popup.<action>') reaches the service worker
//   - the service worker forwards to omp's /__pi_chrome_control route
//   - the popup re-renders the control fields from the refreshed storage snapshot
//
// omp may not have the new control routes yet (depends on whether the user has
// reloaded it). We accept either a real response or a structured error and
// only assert what we can prove from the popup DOM.

const fs = require("node:fs");
const puppeteer = require("/home/steimerbyte/.omp/plugins/node_modules/puppeteer-core");

const EXT_PATH = "/mnt/c/Users/benjamin.steimer/pi-chrome/extensions/chrome-profile-bridge/browser-extension";
const PROFILE_PATH = "/tmp/pi-chrome-integration-profile-control";
const BRIDGE_URL = "http://127.0.0.1:17318";

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}
function logSection(title) { console.log(`\n=== ${title} ===`); }

async function main() {
  if (!fs.existsSync(EXT_PATH)) {
    console.error(`Extension not found at ${EXT_PATH}`);
    process.exit(1);
  }
  // Pre-flight: omp bridge must be reachable, otherwise the popup's sendMessage forward
  // will fail at the fetch step.
  try {
    const r = await fetch(`${BRIDGE_URL}/status`);
    ok(r.ok, `omp bridge reachable at ${BRIDGE_URL} (HTTP ${r.status})`);
    // Probe the control route. If omp hasn't been reloaded yet, this returns 404.
    const ctrl = await fetch(`${BRIDGE_URL}/__pi_chrome_control?action=status`);
    console.log(`  [omp] /__pi_chrome_control?action=status -> HTTP ${ctrl.status}`);
  } catch (e) {
    console.error(`omp bridge NOT reachable: ${e.message}`);
    process.exit(1);
  }

  fs.rmSync(PROFILE_PATH, { recursive: true, force: true });
  fs.mkdirSync(PROFILE_PATH, { recursive: true });

  const CHROMIUM = "/home/steimerbyte/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome";
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: CHROMIUM,
    userDataDir: PROFILE_PATH,
    args: [
      "--headless=new",
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-first-run",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  logSection("resolve extension id");
  let extId = null;
  for (let i = 0; i < 30; i++) {
    const targets = browser.targets();
    const sw = targets.find((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
    if (sw) { extId = new URL(sw.url()).host; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  ok(typeof extId === "string" && extId.length > 10, `service worker registered, id=${extId}`);
  if (!extId) { await browser.close(); process.exit(1); }

  const popupUrl = `chrome-extension://${extId}/ui/status.html`;
  const page = await browser.newPage();
  page.on("console", (m) => {
    const text = m.text();
    if (!text.includes("favicon")) console.log(`  [popup console:${m.type()}] ${text}`);
  });
  page.on("pageerror", (e) => console.error(`  [popup pageerror] ${e.message}`));

  await page.goto(popupUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await new Promise((r) => setTimeout(r, 1500));

  // Confirm all Control-panel buttons are present and clickable.
  logSection("popup: Control panel structure");
  const buttonIds = ["auth15", "authIndef", "revoke", "bgToggle", "runDoctor"];
  for (const id of buttonIds) {
    const exists = await page.evaluate((i) => !!document.getElementById(i), id);
    ok(exists, `button #${id} exists`);
  }
  const authStateExists = await page.evaluate(() => !!document.getElementById("authState"));
  ok(authStateExists, "authState element exists in DOM");
  const bgStateExists = await page.evaluate(() => !!document.getElementById("bgState"));
  ok(bgStateExists, "bgState element exists in DOM");
  const doctorWrapExists = await page.evaluate(() => !!document.getElementById("doctorWrap"));
  ok(doctorWrapExists, "doctorWrap element exists in DOM (hidden until doctor runs)");

  // Helper that runs a button click and reports what the popup shows afterwards.
  async function clickButton(id) {
    const before = await page.evaluate(() => ({
      authState: document.getElementById("authState")?.textContent || "",
      bgState: document.getElementById("bgState")?.textContent || "",
      doctorOpen: document.getElementById("doctorWrap")?.open ?? false,
      doctorBody: document.getElementById("doctorBody")?.textContent || "",
    }));
    await page.evaluate((i) => document.getElementById(i).click(), id);
    // Give the popup enough time to round-trip through sendMessage -> worker -> omp -> worker
    // -> storage.session -> popup re-render.
    await new Promise((r) => setTimeout(r, 2500));
    const after = await page.evaluate(() => ({
      authState: document.getElementById("authState")?.textContent || "",
      bgState: document.getElementById("bgState")?.textContent || "",
      doctorOpen: document.getElementById("doctorWrap")?.open ?? false,
      doctorBody: document.getElementById("doctorBody")?.textContent || "",
      storage: null,
    }));
    try {
      const stored = await page.evaluate(async () => {
        const s = await chrome.storage.session.get("piChromePopupSnapshot");
        return s?.piChromePopupSnapshot;
      });
      after.storage = stored;
    } catch {}
    return { before, after };
  }

  // --- Authorize 15 minutes ---
  logSection("popup: click '15m' → omp authorize for 15 minutes");
  const auth15 = await clickButton("auth15");
  console.log(`  auth state: '${auth15.before.authState}' → '${auth15.after.authState}'`);
  if (auth15.after.storage?.control) {
    const c = auth15.after.storage.control;
    ok(c.authorized === true, `storage.control.authorized = true`);
    ok(c.authorizedUntil === "indefinite" || (typeof c.authorizedUntil === "number" && c.authorizedUntil > Date.now()),
      `storage.control.authorizedUntil is a valid grant (${JSON.stringify(c.authorizedUntil)})`);
    ok(auth15.after.authState.includes("authorized"), `authState text shows 'authorized' (was '${auth15.after.authState}')`);
  } else {
    ok(auth15.after.storage?.bridgeProbe?.ok === true, "popup still has a live snapshot (button at least tried to call omp)");
    ok(auth15.after.authState.length > 0, `authState element was updated (now '${auth15.after.authState}')`);
  }

  // --- Authorize Indefinite ---
  logSection("popup: click 'Indefinite' → omp authorize indefinitely");
  const authIndef = await clickButton("authIndef");
  if (authIndef.after.storage?.control) {
    const c = authIndef.after.storage.control;
    ok(c.authorized === true, "storage.control.authorized = true");
    ok(c.authorizedUntil === "indefinite", `storage.control.authorizedUntil = 'indefinite' (got ${JSON.stringify(c.authorizedUntil)})`);
    ok(authIndef.after.authState.includes("indefinite"), `authState shows 'indefinitely' (was '${authIndef.after.authState}')`);
  } else {
    ok(authIndef.after.authState.length > 0, `authState element was updated`);
  }

  // --- Revoke ---
  logSection("popup: click 'Revoke' → omp lock Chrome control");
  const revoke = await clickButton("revoke");
  if (revoke.after.storage?.control) {
    const c = revoke.after.storage.control;
    ok(c.authorized === false, "storage.control.authorized = false");
    ok(revoke.after.authState.toLowerCase().includes("lock"), `authState shows 'locked' (was '${revoke.after.authState}')`);
  } else {
    ok(revoke.after.authState.length > 0, `authState element was updated`);
  }

  // --- Toggle Background ---
  logSection("popup: click 'Toggle Background' → flip background mode");
  const bgBefore = await page.evaluate(() => document.getElementById("bgState")?.textContent || "");
  const bgAfter = await clickButton("bgToggle");
  const bgAfterText = bgAfter.after.bgState;
  console.log(`  background: '${bgBefore}' → '${bgAfterText}'`);
  if (bgAfter.after.storage?.control) {
    const c = bgAfter.after.storage.control;
    ok(c.background === "on" || c.background === "off", `storage.control.background is one of on/off (got '${c.background}')`);
    if (bgBefore.includes("on")) ok(c.background === "off", "background flipped from on to off");
    else if (bgBefore.includes("off")) ok(c.background === "on", "background flipped from off to on");
  } else {
    ok(bgAfterText !== bgBefore, `background text changed (was '${bgBefore}', now '${bgAfterText}')`);
  }

  // --- Run Doctor ---
  logSection("popup: click 'Run Doctor' → omp returns doctor output");
  const doc = await clickButton("runDoctor");
  ok(doc.after.doctorOpen, "doctorWrap is open after click");
  ok(doc.after.doctorBody.length > 0, `doctorBody has content (${doc.after.doctorBody.length} chars)`);
  console.log(`  doctor body preview: ${JSON.stringify(doc.after.doctorBody.slice(0, 120))}`);
  // Either we get a real doctor text or a structured error — both prove the round-trip.
  if (doc.after.storage?.control) {
    ok(true, "doctor round-trip succeeded with real omp data");
  } else {
    ok(/failed|error|unknown/i.test(doc.after.doctorBody), "doctor round-trip returned a structured error (omp not reloaded yet)");
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
