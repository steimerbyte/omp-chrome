// Companion status popup runtime. MV3 extension-page CSP forbids inline <script>
// (script-src 'self'), so the markup in status.html loads this file via
// <script src="status.js"></script>.
//
// Storage-first bootstrap: read the latest snapshot synchronously from
// chrome.storage.session before opening any port. The service worker pushes
// a fresh snapshot there every 2s; storage is the source of truth that wins
// any race against the action popup closing mid-handshake.

const $ = (id) => document.getElementById(id);

const STATE = {
  online:  { label: "online",  pill: "green", dotClass: "green", ringClass: "green"  },
  auth:    { label: "auth",    pill: "amber", dotClass: "amber", ringClass: "amber"  },
  offline: { label: "offline", pill: "red",   dotClass: "red",   ringClass: "red"    },
};

function fmtTime(ms) {
  if (!ms) return "never";
  const ago = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const t = new Date(ms);
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  const ss = String(t.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss} · ${ago}s ago`;
}

function shortBridge(url) {
  if (!url) return "—";
  try {
    const u = new URL(url);
    return u.host;
  } catch { return url; }
}

function setStateVisual(state) {
  const meta = STATE[state] || STATE.offline;
  document.body.className = "state-" + state;
  const ledDot = $("ledDot");
  if (ledDot) ledDot.className = "led-dot " + meta.dotClass;
  const ledRing = $("ledRing");
  if (ledRing) ledRing.className = "led-ring " + meta.ringClass;
  const pill = $("statePill");
  if (pill) { pill.className = "state-pill " + meta.pill; pill.textContent = meta.label; }
}

function renderProbe(probe) {
  const el = $("bridgeProbe");
  const text = $("probeText");
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

let lastSnapshot = null;
function render(snapshot) {
  lastSnapshot = snapshot;
  const state = snapshot.state || "offline";
  setStateVisual(state);
  const ver = $("ver"); if (ver) ver.textContent = snapshot.companionVersion || "?";
  const bridge = $("bridge"); if (bridge) bridge.textContent = snapshot.bridgeUrl || "—";
  const bridgeShort = $("bridgeShort"); if (bridgeShort) bridgeShort.textContent = shortBridge(snapshot.bridgeUrl);
  const targets = $("targets"); if (targets) targets.textContent = String(snapshot.automationTargetCount ?? 0);
  renderProbe(snapshot.bridgeProbe);
  renderControl(snapshot.control);

  const dbg = $("debugBody");
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

function renderControl(control) {
  const authEl = $("authState");
  const bgEl = $("bgState");
  if (authEl) {
    authEl.classList.remove("locked", "authorized");
    if (!control) { authEl.textContent = "checking…"; authEl.classList.add("locked"); }
    else if (control.authorized) {
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
  if (bgEl) {
    bgEl.classList.remove("on", "off");
    if (!control) { bgEl.textContent = "—"; }
    else if (control.background === "on") { bgEl.textContent = "on (hard)"; bgEl.classList.add("on"); }
    else if (control.background === "off") { bgEl.textContent = "off (foreground)"; bgEl.classList.add("off"); }
    else { bgEl.textContent = control.background; }
  }
}


function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toast(msg) {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 1500);
}

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
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 500);
    });
  } catch {
    setTimeout(connect, 500);
  }
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

// Diagnostic: surface the popup's loaded version so the user can confirm the latest
// status.html is in their popup cache. Falls back to '?' if chrome.runtime is missing.
try {
  const ver = $("ver");
  if (ver) ver.textContent = chrome.runtime.getManifest().version;
} catch {}

// Send a control message to the service worker and wait for the JSON response. Returns
// { ok, result?, error? }. Always re-renders the latest snapshot from storage after a control
// action so the UI reflects the new auth/background state.
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
  if (snap && snap.ok) {
    toast(`OK · ${type.replace("popup.", "")}`);
  } else if (snap && snap.error) {
    toast(`Error · ${snap.error}`);
  } else {
    toast(`Timeout · ${type.replace("popup.", "")}`);
  }
  // Read the latest snapshot from storage so auth/background state reflects the action.
  try {
    if (chrome.storage?.session?.get) {
      const stored = await chrome.storage.session.get("piChromePopupSnapshot");
      if (stored?.piChromePopupSnapshot) render(stored.piChromePopupSnapshot);
    }
  } catch {}
  return snap;
}

$("auth15").addEventListener("click", async () => { await popupAction("popup.authorize", { duration: "15m" }); });
$("authIndef").addEventListener("click", async () => { await popupAction("popup.authorize", { duration: "indefinite" }); });
$("revoke").addEventListener("click", async () => { await popupAction("popup.revoke"); });
$("bgToggle").addEventListener("click", async () => { await popupAction("popup.background", {}); });
$("runDoctor").addEventListener("click", async () => {
  const body = await popupAction("popup.doctor");
  const wrap = $("doctorWrap");
  const out = $("doctorBody");
  if (wrap && out) {
    if (body && body.ok && body.result && typeof body.result.text === "string") {
      out.textContent = body.result.text;
      wrap.style.display = "block";
      wrap.open = true;
    } else {
      out.textContent = (body && body.error) || "Doctor request failed.";
      wrap.style.display = "block";
      wrap.open = true;
    }
  }
});
// cached 1.5s bridge probe and the 2s storage push interval). The worker
// responds with the new snapshot via sendResponse AND writes it to storage,
// so any open popup sees the update through both the port channel and the
// storage read.
$("refresh").addEventListener("click", async () => {
  const btn = $("refresh");
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
    if (snap) {
      render(snap);
      toast("Refreshed");
    } else {
      toast("Refresh timed out");
    }
  } finally {
    setTimeout(() => { if (btn) btn.disabled = false; }, 300);
  }
});

$("copy").addEventListener("click", async () => {
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
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied diagnostic");
  } catch {
    toast("Copy failed");
  }
});

$("doctor").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText("/chrome doctor");
    toast("Copied — paste in Pi");
  } catch {
    toast("Copy failed");
  }
});

// Refresh relative timestamps every second without a fresh message.
setInterval(() => { if (lastSnapshot) render(lastSnapshot); }, 1000);
