// Companion status popup runtime. MV3 extension-page CSP forbids inline <script>
// (script-src 'self'), so the markup in status.html loads this file via
// <script src="status.js"></script>.
//
// Storage-first bootstrap: read the latest snapshot synchronously from
// chrome.storage.session before opening any port. The service worker pushes
// a fresh snapshot there every 2s; storage is the source of truth that wins
// any race against the action popup closing mid-handshake.

"use strict";

// Single source of truth for DOM IDs. Rename here, not in markup.
const IDS = {
  ver: "ver", bridge: "bridge", bridgeShort: "bridgeShort",
  bridgeProbe: "bridgeProbe", probeDot: "probeDot", probeText: "probeText",
  targets: "targets", ledDot: "ledDot", ledRing: "ledRing", statePill: "statePill",
  authState: "authState", bgState: "bgState", debugBody: "debugBody",
  doctorWrap: "doctorWrap", doctorBody: "doctorBody", toast: "toast",
  auth15: "auth15", authIndef: "authIndef", revoke: "revoke",
  bgToggle: "bgToggle", runDoctor: "runDoctor",
  refresh: "refresh", copy: "copy", doctor: "doctor",
};
const $ = (id) => document.getElementById(id);

// State visual + small formatters.
const STATE = {
  connected: { label: "connected", pill: "green", dotClass: "green", ringClass: "green" },
  authorized: { label: "authorized", pill: "amber", dotClass: "amber", ringClass: "amber" },
  offline: { label: "offline", pill: "red", dotClass: "red", ringClass: "red" },
};
function shortBridge(url) {
  if (!url) return "—";
  try { return new URL(url).host; } catch { return url; }
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function setStateVisual(state) {
  const meta = STATE[state] || STATE.offline;
  document.body.className = "state-" + state;
  const ledDot = $(IDS.ledDot);
  if (ledDot) ledDot.className = "led-dot " + meta.dotClass;
  const ledRing = $(IDS.ledRing);
  if (ledRing) ledRing.className = "led-ring " + meta.ringClass;
  const pill = $(IDS.statePill);
  if (pill) { pill.className = "state-pill " + meta.pill; pill.textContent = meta.label; }
}

// Render helpers — each owns one row from the snapshot. Defensive:
// every $(...) result is null-checked so stale markup never throws.
function renderHeader(snapshot) {
  setStateVisual(snapshot.state || "offline");
  const ver = $(IDS.ver);
  if (ver) ver.textContent = snapshot.companionVersion || "?";
  const bridge = $(IDS.bridge);
  if (bridge) bridge.textContent = snapshot.bridgeUrl || "—";
  const bridgeShort = $(IDS.bridgeShort);
  if (bridgeShort) bridgeShort.textContent = shortBridge(snapshot.bridgeUrl);
}
function renderProbe(probe) {
  const el = $(IDS.bridgeProbe);
  const text = $(IDS.probeText);
  if (!el || !text) return;
  el.classList.remove("ok", "warn", "error");
  if (!probe) { text.textContent = "no probe yet"; return; }
  if (probe.ok) {
    el.classList.add("ok");
    text.textContent = `reachable · ${probe.status} ${probe.mode} · ${probe.latencyMs}ms`;
  } else if (probe.error) {
    el.classList.add("error");
    text.textContent = `unreachable · ${probe.error}`;
  } else {
    el.classList.add("warn");
    text.textContent = `HTTP ${probe.status || "?"}`;
  }
}
function renderConnection(snapshot) {
  const targets = $(IDS.targets);
  if (targets) targets.textContent = String(snapshot.automationTargetCount ?? 0);
  renderProbe(snapshot.bridgeProbe);
}
function renderControl(control) {
  const authEl = $(IDS.authState);
  if (authEl) {
    authEl.classList.remove("locked", "authorized");
    if (!control) {
      authEl.textContent = "checking…";
      authEl.classList.add("locked");
    } else if (control.authorized) {
      authEl.classList.add("authorized");
      const until = control.authorizedUntil;
      if (until === "indefinite") authEl.textContent = "authorized indefinitely";
      else if (typeof until === "number" && until > 0) {
        const minutesLeft = Math.max(0, Math.floor((until - Date.now()) / 60_000));
        authEl.textContent = `authorized · ${minutesLeft}m left`;
      } else authEl.textContent = "authorized";
    } else {
      authEl.classList.add("locked");
      authEl.textContent = "locked";
    }
  }
  const bgEl = $(IDS.bgState);
  if (bgEl) {
    bgEl.classList.remove("on", "off");
    if (!control) bgEl.textContent = "—";
    else if (control.background === "on") { bgEl.textContent = "on (hard)"; bgEl.classList.add("on"); }
    else if (control.background === "off") { bgEl.textContent = "off (foreground)"; bgEl.classList.add("off"); }
    else bgEl.textContent = control.background;
  }
}
function renderDebug(snapshot) {
  const dbg = $(IDS.debugBody);
  if (!dbg) return;
  const rows = [
    ["companionVersion", snapshot.companionVersion],
    ["bridgeUrl",        snapshot.bridgeUrl],
    ["state",            snapshot.state],
    ["automationTargets",snapshot.automationTargetCount],
    ["lastSuccessAt",    snapshot.lastSuccessAt ? new Date(snapshot.lastSuccessAt).toISOString() : "never"],
    ["lastAuthAt",       snapshot.lastAuthAt ? new Date(snapshot.lastAuthAt).toISOString() : "never"],
    ["lastError",        snapshot.lastError || "(none)"],
    ["bridgeProbe.ok",   snapshot.bridgeProbe ? String(snapshot.bridgeProbe.ok) : "?"],
    ["bridgeProbe.latencyMs", snapshot.bridgeProbe ? snapshot.bridgeProbe.latencyMs : "?"],
    ["control.authorized", snapshot.control ? String(snapshot.control.authorized) : "?"],
    ["control.background", snapshot.control ? snapshot.control.background : "?"],
  ];
  dbg.innerHTML = rows
    .map(([k, v]) => `<div><span class="k">${k}</span> <span class="v">${escapeHtml(String(v))}</span></div>`)
    .join("");
}

let lastSnapshot = null;
function render(snapshot) {
  lastSnapshot = snapshot;
  renderHeader(snapshot);
  renderConnection(snapshot);
  renderControl(snapshot.control);
  renderDebug(snapshot);
}

// Toast + doctor output toggle.
function toast(msg) {
  const el = $(IDS.toast);
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 1500);
}
// Opens the doctor <details> and writes either the real text or a structured
// error. Toggles display so the block only takes vertical space once the user
// has actually run the doctor.
function showDoctor(textOrError) {
  const wrap = $(IDS.doctorWrap);
  const out  = $(IDS.doctorBody);
  if (!wrap || !out) return;
  out.textContent = textOrError || "Doctor request failed.";
  wrap.style.display = "block";
  wrap.open = true;
}

// Popup ⇄ service worker plumbing.
// Send a control message to the service worker and wait for the JSON response.
// Returns the response object (may be null on timeout). Always re-renders the
// latest snapshot from storage so auth/background state reflects the action.
async function popupAction(type, params = {}) {
  const snap = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      chrome.runtime.sendMessage({ type, ...params }, (response) => {
        finish(chrome.runtime.lastError ? null : response);
      });
    } catch { finish(null); }
    setTimeout(() => finish(null), 3000);
  });
  if (snap && snap.ok) toast(`OK · ${type.replace("popup.", "")}`);
  else if (snap && snap.error) toast(`Error · ${snap.error}`);
  else toast(`Timeout · ${type.replace("popup.", "")}`);
  try {
    if (chrome.storage?.session?.get) {
      const stored = await chrome.storage.session.get("piChromePopupSnapshot");
      if (stored?.piChromePopupSnapshot) render(stored.piChromePopupSnapshot);
    }
  } catch {}
  return snap;
}

// Mapping from button id -> IPC action. Adding a new button is a single
// entry here plus the matching element in status.html.
const CONTROL_BUTTONS = {
  auth15:    { type: "popup.authorize",   params: { duration: "15m" } },
  authIndef: { type: "popup.authorize",   params: { duration: "indefinite" } },
  revoke:    { type: "popup.revoke",      params: {} },
  bgToggle:  { type: "popup.background",  params: {} },
  runDoctor: { type: "popup.doctor",      params: {} },
};

function wireControlButtons() {
  for (const [id, { type, params }] of Object.entries(CONTROL_BUTTONS)) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.addEventListener("click", async () => {
      // runDoctor also surfaces its body into the <details> panel; every
      // other button only cares about the toast + re-render.
      if (id === IDS.runDoctor) {
        const body = await popupAction(type, params);
        if (body && body.ok && body.result && typeof body.result.text === "string") {
          showDoctor(body.result.text);
        } else {
          showDoctor((body && body.error) || "Doctor request failed.");
        }
        return;
      }
      await popupAction(type, params);
    });
  }
}

// Commands: refresh, copy, doctor-copy.
async function refreshNow() {
  const btn = $(IDS.refresh);
  if (btn) btn.disabled = true;
  try {
    const snap = await new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        chrome.runtime.sendMessage({ type: "popup.refresh" }, (response) => {
          finish(chrome.runtime.lastError ? null : response);
        });
      } catch { finish(null); }
      setTimeout(() => finish(null), 3000);
    });
    if (snap) { render(snap); toast("Refreshed"); }
    else toast("Refresh timed out");
  } finally {
    setTimeout(() => { if (btn) btn.disabled = false; }, 300);
  }
}
async function copyDiagnostic() {
  const s = lastSnapshot || {};
  const text = [
    "pi-chrome status snapshot",
    "  state:              " + (s.state || "offline"),
    "  companionVersion:   " + (s.companionVersion || "?"),
    "  bridgeUrl:          " + (s.bridgeUrl || "?"),
    "  automationTargets:  " + (s.automationTargetCount ?? 0),
    "  lastSuccessAt:      " + (s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : "never"),
    "  lastAuthAt:         " + (s.lastAuthAt ? new Date(s.lastAuthAt).toISOString() : "never"),
    "  lastError:          " + (s.lastError || "(none)"),
  ].join("\n");
  try { await navigator.clipboard.writeText(text); toast("Copied diagnostic"); }
  catch { toast("Copy failed"); }
}
async function copyDoctorCommand() {
  try { await navigator.clipboard.writeText("/chrome doctor"); toast("Copied — paste in Pi"); }
  catch { toast("Copy failed"); }
}

// Storage-first bootstrap. Storage wins any race against the action popup
// closing mid-handshake (worker writes the snapshot there every 2s).
let port = null;
function fetchOnce() {
  try {
    chrome.runtime.sendMessage({ type: "popup.getStatus" }, (response) => {
      if (response && typeof response === "object") render(response);
    });
  } catch {}
}
function connect() {
  try {
    port = chrome.runtime.connect({ name: "popup" });
    port.onMessage.addListener(render);
    port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 500); });
  } catch { setTimeout(connect, 500); }
}
async function bootstrap() {
  try {
    if (chrome.storage && chrome.storage.session) {
      const stored = await chrome.storage.session.get("piChromePopupSnapshot");
      if (stored && stored.piChromePopupSnapshot) render(stored.piChromePopupSnapshot);
    }
  } catch {}
  fetchOnce();
  connect();
}
bootstrap();

// Wire DOM listeners + surface popup version. Version is read AFTER the
// control buttons are wired so the helper survives even if chrome.runtime
// is briefly unavailable.
wireControlButtons();
const refreshBtn = $(IDS.refresh);
if (refreshBtn) refreshBtn.addEventListener("click", refreshNow);
const copyBtn = $(IDS.copy);
if (copyBtn) copyBtn.addEventListener("click", copyDiagnostic);
const doctorBtn = $(IDS.doctor);
if (doctorBtn) doctorBtn.addEventListener("click", copyDoctorCommand);

// Diagnostic: surface the popup's loaded version so the user can confirm the
// latest status.html is in their popup cache. Falls back to '?' if chrome.runtime
// is missing (e.g. when this file is loaded outside the extension context).
try {
  const ver = $(IDS.ver);
  if (ver) ver.textContent = chrome.runtime.getManifest().version;
} catch {}

// Refresh relative timestamps every second without a fresh message.
setInterval(() => { if (lastSnapshot) render(lastSnapshot); }, 1000);