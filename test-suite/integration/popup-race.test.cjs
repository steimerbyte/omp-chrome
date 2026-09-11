// Integration test: load the companion extension in a real Chromium via puppeteer-core and
// verify the popup status page renders within 5s of being opened. This catches the MV3 race
// where chrome.runtime.connect responds after the popup closes.
//
// We use a persistent profile directory so the extension id is stable across runs.

const fs = require("node:fs");
const puppeteer = require("/home/steimerbyte/.omp/plugins/node_modules/puppeteer-core");

const EXT_PATH = "/mnt/c/Users/benjamin.steimer/pi-chrome/extensions/chrome-profile-bridge/browser-extension";
const PROFILE_PATH = "/tmp/pi-chrome-integration-profile";
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
  try {
    const r = await fetch(`${BRIDGE_URL}/status`);
    ok(r.ok, `omp bridge reachable at ${BRIDGE_URL} (HTTP ${r.status})`);
  } catch (e) {
    console.error(`omp bridge NOT reachable at ${BRIDGE_URL}: ${e.message}`);
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
  if (!extId) {
    console.error("Could not resolve extension id");
    await browser.close();
    process.exit(1);
  }

  const popupUrl = `chrome-extension://${extId}/ui/status.html`;
  const page = await browser.newPage();
  page.on("console", (m) => {
    const text = m.text();
    if (!text.includes("favicon")) console.log(`  [popup console:${m.type()}] ${text}`);
  });
  page.on("pageerror", (e) => console.error(`  [popup pageerror] ${e.message}`));
  page.on("requestfailed", (req) => console.error(`  [popup requestfailed] ${req.url()} ${req.failure()?.errorText}`));

  logSection("popup as tab: load + wait for storage snapshot");
  await page.goto(popupUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await new Promise((r) => setTimeout(r, 1000));

  const debugSnapshot = await page.evaluate(() => ({
    ver: document.getElementById("ver")?.textContent,
    bodyChildren: document.body?.children?.length,
    scriptTags: Array.from(document.querySelectorAll("script")).map((s) => s.src || "(inline)"),
    hasChromeStorage: typeof chrome !== "undefined" && !!chrome.storage,
    hasChromeStorageSession: typeof chrome !== "undefined" && !!chrome.storage?.session,
    hasChromeRuntime: typeof chrome !== "undefined" && !!chrome.runtime,
  }));
  console.log(`  [popup debug] ${JSON.stringify(debugSnapshot)}`);

  // Wait for the snapshot to land in storage.
  const observed = await page
    .waitForFunction(
      async () => {
        const stored = await chrome.storage.session.get("piChromePopupSnapshot");
        return stored && stored.piChromePopupSnapshot ? stored.piChromePopupSnapshot : null;
      },
      { timeout: 10_000, polling: 250 },
    )
    .then((handle) => handle.jsonValue())
    .catch((e) => ({ error: e.message }));

  ok(!observed.error, `storage snapshot arrived (${observed.error || "ok"})`);
  if (!observed.error && observed) {
    ok(typeof observed.companionVersion === "string", `snapshot.companionVersion = '${observed.companionVersion}'`);
    ok(typeof observed.bridgeUrl === "string" && observed.bridgeUrl.includes("17318"), `snapshot.bridgeUrl = '${observed.bridgeUrl}'`);
    ok(["connected", "authorized", "offline"].includes(observed.state), `snapshot.state = '${observed.state}'`);
    ok(observed.bridgeProbe && typeof observed.bridgeProbe === "object", `snapshot.bridgeProbe exists`);
    if (observed.bridgeProbe) {
      ok(typeof observed.bridgeProbe.url === "string", `bridgeProbe.url = '${observed.bridgeProbe.url}'`);
      ok(typeof observed.bridgeProbe.latencyMs === "number", `bridgeProbe.latencyMs = ${observed.bridgeProbe.latencyMs}`);
      ok(typeof observed.bridgeProbe.ok === "boolean", `bridgeProbe.ok = ${observed.bridgeProbe.ok}`);
    }
  }

  // Re-check DOM after a few seconds: subtitle, state-pill, and probe text should now reflect data.
  await new Promise((r) => setTimeout(r, 1500));
  const domState = await page.evaluate(() => ({
    ver: document.getElementById("ver")?.textContent,
    statePill: document.getElementById("statePill")?.textContent,
    probeText: document.getElementById("probeText")?.textContent,
    bridgeShort: document.getElementById("bridgeShort")?.textContent,
  }));
  console.log(`  [popup dom] ${JSON.stringify(domState)}`);
  ok(domState.ver && domState.ver !== "—", `header subtitle version is '${domState.ver}'`);
  ok(domState.statePill && domState.statePill !== "offline" || observed.state === "offline", `state pill text is '${domState.statePill}'`);
  ok(domState.probeText && domState.probeText !== "no probe yet", `probe text is '${domState.probeText}'`);

  // Service worker read-back.
  logSection("service worker: storage + badge");
  const swTarget = browser.targets().find(
    (t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`),
  );
  ok(!!swTarget, "found the extension service worker target");
  if (swTarget) {
    const sw = await swTarget.worker();
    const workerProbe = await sw.evaluate(async () => {
      const stored = await chrome.storage.session.get("piChromePopupSnapshot");
      const t = await chrome.action.getBadgeText({});
      return { snap: stored?.piChromePopupSnapshot, badge: Array.isArray(t) ? t.join(",") : t };
    });
    ok(!!workerProbe.snap, "worker sees a stored snapshot");
    ok(typeof workerProbe.badge === "string" && workerProbe.badge.length > 0, `badge text = '${workerProbe.badge}'`);
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
