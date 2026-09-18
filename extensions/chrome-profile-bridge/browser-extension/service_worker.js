// ===============================================================
// Connection status (toolbar badge LED + popup live view)
// ===============================================================
// The toolbar action badge mirrors the live bridge connection so the user can see at a glance
// whether Pi can drive Chrome right now. The popup (manifest action.default_popup) shows the
// same data with more detail. Both are driven from one source of truth: the most recent result
// of pollLoop() and a watchdog that flips to "offline" if the bridge stops responding.
// Connection states:
//   "offline"    — bridge not reachable; never spoke to us, or watchdog expired
//   "connected"  — bridge reachable; last /next returned successfully within the watchdog window
//   "authorized" — bridge reachable, but the active Pi session is not authorized (HTTP 401/403)
const BADGE_COLORS = {
  offline: "#dc2626", // red-600
  connected: "#16a34a", // green-600
  authorized: "#ca8a04", // yellow-600
};
const BADGE_LABELS = {
  offline: "off",
  connected: "conn",
  authorized: "auth",
};
let lastBridgeSuccessAt = 0;
let lastBridgeAuthAt = 0;
let lastBridgeError = "";
let connectionState = "offline"; // sentinel: BADGE_COLORS["offline"] is the initial paint
function setConnectionState(next) {
  if (connectionState === next) return;
  connectionState = next;
  updateBadge();
  broadcastStatus();
}
function updateBadge() {
  try {
    chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS[connectionState] });
    chrome.action.setBadgeText({ text: BADGE_LABELS[connectionState] });
  } catch {
    /* chrome.action can be missing in the unit-test sandbox; ignore */
  }
}
// Active bridge probe: GET ${BRIDGE_URL}/health first with a tight 750ms budget, falling back
// to /status on an Unknown route so older pi-chrome versions (which do not yet serve /health)
// still work. /health returns the same shape as /status with cache-control:no-store so the
// popup and watchdog see a live bridge even when the long-poll path is idle.
let lastBridgeProbeAt = 0;
let lastBridgeProbe = null; // { ok, status, latencyMs, mode, error, url }
async function probeBridge() {
  const now = Date.now();
  if (lastBridgeProbe && now - lastBridgeProbeAt < 1500) return lastBridgeProbe;
  lastBridgeProbeAt = now;
  const url = `${BRIDGE_URL}/health`;
  const t0 = Date.now();
  const ctrl = (typeof AbortController === "function") ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctrl?.abort(); } catch {} }, 1500);
  let probe = { ok: false, status: 0, latencyMs: 0, mode: "?", error: "", url };
  try {
    let res = await fetch(url, { cache: "no-store", signal: ctrl?.signal });
    if (res.status === 404) {
      // Older pi-chrome (<=0.17.x without /health). Retry /status with a short fresh budget so
      // the probe still completes inside the 1500ms outer cap.
      const retryCtrl = (typeof AbortController === "function") ? new AbortController() : null;
      const retryTimer = setTimeout(() => { try { retryCtrl?.abort(); } catch {} }, 750);
      try {
        res = await fetch(`${BRIDGE_URL}/status`, { cache: "no-store", signal: retryCtrl?.signal });
      } finally {
        clearTimeout(retryTimer);
      }
    }
    const latencyMs = Date.now() - t0;
    let body = null;
    try { body = await res.json(); } catch {}
    probe = {
      ok: res.ok,
      status: res.status,
      latencyMs,
      mode: body && typeof body === "object" && body.mode ? String(body.mode) : "?",
      error: res.ok ? "" : `HTTP ${res.status}`,
      url,
    };
    // Successful probe also proves the bridge is reachable — feed the success timestamp
    // so the watchdog sees an active bridge even when the /next long-poll is idle.
    if (res.ok) lastBridgeSuccessAt = Date.now();
  } catch (e) {
    probe = {
      ok: false, status: 0, latencyMs: Date.now() - t0,
      mode: "?", error: e?.message || String(e), url,
    };
  } finally {
    clearTimeout(timer);
  }
  lastBridgeProbe = probe;
  return probe;
}

// Open popup channels get a fresh status snapshot on connect. Future state changes are pushed.
const popupPorts = new Set();
async function buildStatusSnapshot() {
  const probe = await probeBridge();
  // Only fetch the control-plane status when the bridge is reachable. A failed probe
  // would otherwise overwrite a previously-known good control value with `null`, and
  // the popup would show "?" instead of the last reliable state.
  let control = null;
  if (probe && probe.ok) {
    try {
      const res = await fetch(`${BRIDGE_URL}/__pi_chrome_control?action=status`, { cache: "no-store" });
      if (res.ok) {
        const body = await res.json();
        if (body && body.ok) control = body.result || null;
      }
    } catch {}
  }
  return {
    type: "status",
    state: connectionState,
    companionVersion: chrome.runtime.getManifest().version,
    bridgeUrl: BRIDGE_URL,
    bridgeProbe: probe,
    control,
    lastSuccessAt: lastBridgeSuccessAt,
    lastAuthAt: lastBridgeAuthAt,
    lastError: lastBridgeError,
    automationTargetCount: typeof automationTargets !== "undefined" ? automationTargets.size : 0,
  };
}
async function broadcastStatus() {
  const snapshot = await buildStatusSnapshot();
  for (const port of popupPorts) {
    try { port.postMessage(snapshot); } catch { popupPorts.delete(port); }
  }
}
if (chrome.runtime && chrome.runtime.onConnect) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "popup") return;
    popupPorts.add(port);
    buildStatusSnapshot().then((snapshot) => {
      try { port.postMessage(snapshot); } catch { popupPorts.delete(port); }
    });
    port.onDisconnect.addListener(() => { popupPorts.delete(port); });
  });
}
// One-shot fallback for popup.getStatus requests. Useful when chrome.runtime.connect somehow
// fails to wake the worker (mv3 keeps the worker suspended and onConnect sometimes returns
// before the listener is registered after reload).
// popups can close before an async response arrives, so a port-based snapshot can race.
// The popup reads chrome.storage.session on open and renders synchronously. The worker
// keeps pushing so the value is always fresh within PUSH_INTERVAL_MS.
const POPUP_SNAPSHOT_KEY = "piChromePopupSnapshot";
const PUSH_INTERVAL_MS = 2000;
async function pushStatusToStorage() {
  try {
    const snapshot = await buildStatusSnapshot();
    if (chrome.storage && chrome.storage.session && typeof chrome.storage.session.set === "function") {
      await chrome.storage.session.set({ [POPUP_SNAPSHOT_KEY]: snapshot });
    }
  } catch {
    /* storage may be unavailable in some sandboxed contexts; never throw out of the timer. */
  }
}
pushStatusToStorage(); // initial paint
setInterval(pushStatusToStorage, PUSH_INTERVAL_MS);

updateBadge(); // initial paint

const BRIDGE_URL = "http://127.0.0.1:17318";

// Forward a popup control request to omp's /__pi_chrome_control route. Returns the parsed
// JSON body so the popup can show the result inline.
async function popupControlRequest(action, extraParams = {}) {
  const params = new URLSearchParams({ action, ...extraParams });
  const url = `${BRIDGE_URL}/__pi_chrome_control?${params.toString()}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (chrome.storage?.session?.set) {
      try { await chrome.storage.session.set({ [POPUP_SNAPSHOT_KEY]: await buildStatusSnapshot() }); } catch {}
    }
    return body;
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// One-shot IPC for popup.* messages. Popup uses sendMessage as a fallback when
// chrome.runtime.connect races against the popup closing.
if (chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type === "popup.getStatus" || msg.type === "popup.refresh") {
      // Bypass the 1.5s probe cache on explicit refresh so the user sees a fresh read.
      if (msg.type === "popup.refresh") {
        lastBridgeProbe = null;
        lastBridgeProbeAt = 0;
      }
      buildStatusSnapshot().then(async (snapshot) => {
        if (msg.type === "popup.refresh" && chrome.storage?.session?.set) {
          try { await chrome.storage.session.set({ [POPUP_SNAPSHOT_KEY]: snapshot }); } catch {}
        }
        sendResponse(snapshot);
      });
      return true;
    }
    if (msg.type === "popup.authorize" || msg.type === "popup.revoke" ||
        msg.type === "popup.doctor" || msg.type === "popup.background" ||
        msg.type === "popup.controlStatus") {
      const extraParams = {};
      if (msg.type === "popup.authorize" && msg.duration) extraParams.duration = msg.duration;
      if (msg.type === "popup.background" && typeof msg.on === "boolean") extraParams.on = String(msg.on);
      const action = ({
        "popup.authorize": "authorize",
        "popup.revoke": "revoke",
        "popup.doctor": "doctor",
        "popup.background": "background",
        "popup.controlStatus": "status",
      })[msg.type];
      popupControlRequest(action, extraParams).then((body) => sendResponse(body));
      return true;
    }
    return false;
  });
}
const CLIENT_NAME = `Pi Chrome Connector ${chrome.runtime.id}`;
const POLL_ERROR_BACKOFF_MS = 2000;
const DEFAULT_GROUP_COLOR = "blue";

// Auto-reconnect backoff for chrome.debugger sessions that detach unexpectedly
// (Chrome nav, devtools opened/closed, target closed mid-command, etc.). Per-tab
// schedule that grows with each consecutive failure and caps so we never race the
// bridge ping. Stale target cleanup always runs BEFORE the timer is scheduled,
// and the worker uses chrome.alarms as a wakeup so MV3 suspension does not eat
// the timer.
const RECONNECT_ALARM_NAME = "piChromeReconnect";
const RECONNECT_SCHEDULE_MS = [250, 500, 1000, 2000, 5000, 10000, 30000];
const RECONNECT_JITTER = 0.25; // ±25%
const RECONNECT_BACKOFF_CAP_MS = POLL_ERROR_BACKOFF_MS * 5; // 10s — never race bridge ping
// Map<tabId, { count: int, nextDelayMs: int, scheduledAt: number }>
// scheduledAt is the wall-clock time at which the next reconnect attempt may run.
// count is the number of consecutive failures (resets on success).
const reconnectAttempts = new Map();
let reconnectAlarmScheduled = false;

// Pick the next backoff delay for `count` (0-indexed: count=0 → first attempt).
// Always within ±25% jitter and capped at RECONNECT_BACKOFF_CAP_MS so a hot
// auto-reconnect loop never starves the bridge ping path.
function computeReconnectDelay(count) {
  const idx = Math.min(Math.max(count, 0), RECONNECT_SCHEDULE_MS.length - 1);
  const base = RECONNECT_SCHEDULE_MS[idx];
  const cap = Math.min(base, RECONNECT_BACKOFF_CAP_MS);
  const jitter = cap * RECONNECT_JITTER;
  const min = Math.max(1, cap - jitter);
  const max = cap + jitter;
  return Math.round(min + Math.random() * (max - min));
}

// Schedule (or refresh) a chrome.alarm that wakes the worker even while
// suspended. Two layers:
//   - A setTimeout in the worker fires the fast path when the worker is alive
//     and the next delay is <30s (chrome.alarms clamps delayInMinutes to
//     0.5min minimum, which is too coarse for our 250ms-2s early steps).
//   - A periodic chrome.alarm with periodInMinutes:1 is the MV3-safe wakeup:
//     even if the worker suspends mid-backoff, Chrome will wake it within
//     ~1 minute and processReconnectBackoffs() will resume from the next
//     scheduledAt that has elapsed.
// We always (re)create the periodic alarm whenever there is anything to do,
// and clear it when the map empties.
function armReconnectAlarm() {
  if (typeof chrome === "undefined" || !chrome.alarms) return;
  let earliest = Number.POSITIVE_INFINITY;
  for (const entry of reconnectAttempts.values()) {
    if (entry.scheduledAt < earliest) earliest = entry.scheduledAt;
  }
  if (!Number.isFinite(earliest)) {
    chrome.alarms.clear(RECONNECT_ALARM_NAME).catch(() => undefined);
    reconnectAlarmScheduled = false;
    return;
  }
  const delayMs = Math.max(1, earliest - Date.now());
  // Fast path: in-worker setTimeout for sub-30s delays. Cheap, runs while the
  // worker is awake; the periodic alarm below covers us after suspension.
  if (delayMs < 30_000) {
    if (!reconnectAlarmScheduled) {
      setTimeout(() => void processReconnectBackoffs(), delayMs);
      reconnectAlarmScheduled = true;
    }
  } else {
    reconnectAlarmScheduled = true;
  }
  // Periodic MV3-safe wakeup: Chrome fires this every minute at most, even
  // across worker suspension. processReconnectBackoffs() is a no-op when no
  // scheduledAt has elapsed, so the cadence is harmless.
  chrome.alarms.create(RECONNECT_ALARM_NAME, { periodInMinutes: 1 });
}

// Clear any reconnect bookkeeping for a tab. Called on successful attach and
// on cancel-by-user so we do not keep retrying a session the user just killed.
function clearReconnect(tabId) {
  if (reconnectAttempts.delete(tabId)) {
    if (reconnectAttempts.size === 0) {
      reconnectAlarmScheduled = false;
      if (typeof chrome !== "undefined" && chrome.alarms) {
        chrome.alarms.clear(RECONNECT_ALARM_NAME).catch(() => undefined);
      }
    }
  }
}

// Drain the reconnectAttempts map: for each entry whose scheduledAt has
// elapsed, try attachDebugger. On success, clear the entry; on failure,
// bump count and schedule the next delay. Always re-arms the alarm so
// survivors keep trying.
async function processReconnectBackoffs() {
  reconnectAlarmScheduled = false;
  if (typeof chrome !== "undefined" && chrome.alarms) {
    chrome.alarms.clear(RECONNECT_ALARM_NAME).catch(() => undefined);
  }
  const now = Date.now();
  // Snapshot keys so we can mutate the map while iterating.
  const tabIds = Array.from(reconnectAttempts.keys());
  for (const tabId of tabIds) {
    const entry = reconnectAttempts.get(tabId);
    if (!entry) continue;
    if (entry.scheduledAt > now) continue;
    // If the tab no longer exists or is mid-navigation, defer rather than
    // burning an attempt. chrome.tabs.get throws for closed tabs.
    let tabSnapshot = null;
    try {
      tabSnapshot = await chrome.tabs.get(tabId);
    } catch {
      clearReconnect(tabId);
      continue;
    }
    if (!tabSnapshot || tabSnapshot.status !== "complete") {
      // Reschedule for the same delay — try again on the next tick.
      entry.scheduledAt = now + entry.nextDelayMs;
      continue;
    }
    try {
      await attachDebugger(tabId);
      clearReconnect(tabId);
    } catch (err) {
      recordAttachEvent({ kind: "auto-reconnect-failed", tabId, message: String(err?.message || err), count: entry.count + 1 });
      entry.count += 1;
      entry.nextDelayMs = computeReconnectDelay(entry.count);
      entry.scheduledAt = now + entry.nextDelayMs;
    }
  }
  if (reconnectAttempts.size > 0) armReconnectAlarm();
}

// Schedule a fresh reconnect backoff for `tabId`. Caller is responsible for
// having already cleaned up any stale CDP target on the tab (the existing
// attachDebugger prologue does that). `reason` is recorded in the attach log.
function scheduleReconnect(tabId, reason) {
  const existing = reconnectAttempts.get(tabId);
  const count = existing ? existing.count : 0;
  const nextDelayMs = computeReconnectDelay(count);
  reconnectAttempts.set(tabId, { count, nextDelayMs, scheduledAt: Date.now() + nextDelayMs });
  recordAttachEvent({ kind: "auto-reconnect-scheduled", tabId, count, delayMs: nextDelayMs, reason: String(reason || "") });
  armReconnectAlarm();
}

// Snapshot of the reconnectAttempts map suitable for inputStatus() / the
// /chrome doctor view. Returns a plain object keyed by tabId with the same
// shape used internally, never the live Map (so callers cannot mutate).
function reconnectStatusSnapshot() {
  const out = {};
  for (const [tabId, entry] of reconnectAttempts) {
    out[tabId] = {
      count: entry.count,
      nextDelayMs: entry.nextDelayMs,
      scheduledAt: entry.scheduledAt,
      nextDelayIn: Math.max(0, entry.scheduledAt - Date.now()),
    };
  }
  return out;
}

const PI_GROUP_RE = /^Pi(\b|\s*-)/i;
const VALID_GROUP_COLORS = new Set(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
const COMMAND_TIMEOUT_MS = 25_000;
const CDP_COMMAND_TIMEOUT_MS = 5_000;
const SCRIPTING_TIMEOUT_MS = 8_000;
const ATTACH_TIMEOUT_MS = 3_000;
let polling = false;

// =================== pi-chrome automation target ownership ===================
// pi-chrome must never hijack the user's active tab. When a page/navigation action runs without
// an explicit target (targetId/urlIncludes/titleIncludes), we route it to a dedicated automation
// target that pi-chrome created and owns. We prefer a separate Chrome window so the user's
// windows are left untouched; if the windows API is unavailable we fall back to a dedicated tab.
//
// Ownership is SESSION-SCOPED, keyed by the calling Pi session's `sessionKey` (forwarded on the
// wire). One Chrome extension / service worker brokers commands for *all* Pi sessions (see the
// client/server bridge in index.ts), so a single global target would make concurrent sessions
// fight over one window. A per-session map gives each session its own isolated window and lets
// cleanup close exactly that session's target — never another session's, never a user's.
//
// State is mirrored to chrome.storage.session so a service-worker restart (MV3 can suspend the
// worker at any time) re-hydrates ownership instead of orphaning the window it already created.
// storage.session is cleared on browser restart; any window restored by Chrome's session-restore
// is then untracked and simply left alone (we only ever close ids we still recognize as ours).
const automationTargets = new Map(); // sessionKey -> { windowId?: number, tabId: number }
const DEFAULT_SESSION_KEY = "__default__";
const AUTOMATION_STORAGE_KEY = "piChromeAutomationTargets";
let automationHydrated;
const sessionTabs = new Map(); // sessionKey -> Map<tabId, { created: boolean, groupId?: number }>
const SESSION_TABS_STORAGE_KEY = "piChromeSessionTabs";
let sessionTabsReady;
let sessionTabsWrite = Promise.resolve();

function sessionKeyOf(params) {
  return params && typeof params.sessionKey === "string" && params.sessionKey
    ? params.sessionKey
    : DEFAULT_SESSION_KEY;
}

// Re-hydrate the in-memory ownership map from storage.session once per worker lifetime. Best
// effort: storage may be unavailable on old Chrome, and a failure just means we may create a
// fresh window (a harmless orphan) rather than reusing one.
async function hydrateAutomationTargets() {
  if (automationHydrated) return automationHydrated;
  automationHydrated = (async () => {
    try {
      const stored = await chrome.storage?.session?.get?.(AUTOMATION_STORAGE_KEY);
      const saved = stored && stored[AUTOMATION_STORAGE_KEY];
      if (saved && typeof saved === "object") {
        for (const [key, value] of Object.entries(saved)) {
          if (value && typeof value.tabId === "number") {
            automationTargets.set(key, {
              windowId: typeof value.windowId === "number" ? value.windowId : undefined,
              tabId: value.tabId,
            });
          }
        }
      }
    } catch {
      // Ignore: treat as "no persisted state".
    }
  })();
  return automationHydrated;
}

async function hydrateSessionTabs() {
  if (!sessionTabsReady) sessionTabsReady = (async () => {
    try {
      const stored = await chrome.storage?.session?.get?.(SESSION_TABS_STORAGE_KEY);
      for (const [key, entries] of Object.entries(stored?.[SESSION_TABS_STORAGE_KEY] || {})) {
        if (!Array.isArray(entries)) continue;
        const tabs = new Map();
        for (const entry of entries) {
          if (!entry || !Number.isInteger(entry.tabId) || entry.tabId < 0) continue;
          if (entry.created === true) tabs.set(entry.tabId, { created: true });
          else if (entry.created === false && Number.isInteger(entry.groupId) && entry.groupId >= 0) {
            tabs.set(entry.tabId, { created: false, groupId: entry.groupId });
          }
        }
        if (tabs.size) sessionTabs.set(key, tabs);
      }
    } catch {
      // Missing ownership must leave tabs alone, not guess ownership from group names.
    }
  })();
  return sessionTabsReady;
}

function persistSessionTabs() {
  // Serialize writes and construct each snapshot when its turn starts.
  sessionTabsWrite = sessionTabsWrite.then(async () => {
    const saved = Object.fromEntries([...sessionTabs].map(([key, tabs]) => [
      key, [...tabs].map(([tabId, record]) => ({ tabId, ...record })),
    ]));
    await chrome.storage?.session?.set?.({ [SESSION_TABS_STORAGE_KEY]: saved });
  }).catch(() => {});
  return sessionTabsWrite;
}

async function trackSessionTab(sessionKey, tabId, created, groupId) {
  await Promise.all([hydrateSessionTabs(), hydrateAutomationTargets()]);
  if (!Number.isInteger(tabId)) return;
  if (!created) {
    if (!Number.isInteger(groupId) || groupId < 0 || isPiChromeOwnedTarget(tabId)) return;
    if ([...sessionTabs.values()].some((tabs) => tabs.get(tabId)?.created)) return;
  }
  let tabs = sessionTabs.get(sessionKey);
  if (!tabs) sessionTabs.set(sessionKey, tabs = new Map());
  tabs.set(tabId, created ? { created: true } : { created: false, groupId });
  await persistSessionTabs();
}

async function cleanupSessionTabs(sessionKey) {
  await hydrateSessionTabs();
  const automation = await cleanupAutomationTarget(sessionKey);
  const tabs = sessionTabs.get(sessionKey);
  let closedCreatedTabs = 0;
  let ungroupedAdoptedTabs = 0;
  for (const [tabId, record] of [...(tabs || [])]) {
    try {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab && record.created) {
        await chrome.tabs.remove(tabId);
        closedCreatedTabs++;
      } else if (tab && tab.groupId === record.groupId) {
        await chrome.tabs.ungroup(tabId);
        ungroupedAdoptedTabs++;
      }
      tabs.delete(tabId);
    } catch {
      // Retain failed operations for a later cleanup; never report them as completed.
    }
  }
  if (tabs && !tabs.size) sessionTabs.delete(sessionKey);
  await persistSessionTabs();
  return { ...automation, closedCreatedTabs, ungroupedAdoptedTabs };
}

async function persistAutomationTargets() {
  try {
    const obj = {};
    for (const [key, value] of automationTargets) {
      obj[key] = { windowId: typeof value.windowId === "number" ? value.windowId : null, tabId: value.tabId };
    }
    await chrome.storage?.session?.set?.({ [AUTOMATION_STORAGE_KEY]: obj });
  } catch {
    // Ignore: persistence is an optimization, not a correctness requirement.
  }
}

// True if `tabId` is a pi-chrome-owned automation tab. Pass `sessionKey` to check a specific
// session; omit it to check ownership across *any* session (used as a safety predicate so we
// never operate on a user-created tab). Never infers ownership from "active".
function isPiChromeOwnedTarget(tabId, sessionKey) {
  if (typeof tabId !== "number") return false;
  if (sessionKey !== undefined) {
    const t = automationTargets.get(sessionKey);
    return !!t && t.tabId === tabId;
  }
  for (const t of automationTargets.values()) if (t.tabId === tabId) return true;
  return false;
}
// Initial URL for automation targets. Must be a real http(s) URL on an origin covered by
// manifest host_permissions. We use the bridge origin itself (`http://127.0.0.1:17318`) which
// the companion already trusts and which the bridge serves as a tiny `text/html` page with a
// `<title>Pi Chrome</title>` shell. About:blank is unusable (host_permissions cannot cover
// about: — Chrome treats it as opaque). Data: URLs are unusable too (chrome.scripting rejects
// them even with `<all_urls>` because data: has no extension access for injection).
// Chrome-extension: URLs (our own origin) are also rejected by chrome.scripting unless the
// user has just interacted with the tab (activeTab flow). Chrome: / devtools: / edge: are
// likewise blocked. The bridge route is the only universal option that does not require a
// user click or a specific external page.
const AUTOMATION_TARGET_URL = `${BRIDGE_URL}/__pi_chrome_shell`;

async function createAutomationTarget(sessionKey, groupTitle) {
	const existingGroup = groupTitle ? await findGroupRecordByTitle(groupTitle) : null;
	if (existingGroup && typeof existingGroup.windowId === "number") {
		const tab = await chrome.tabs.create({ url: AUTOMATION_TARGET_URL, active: false, windowId: existingGroup.windowId });
		automationTargets.set(sessionKey, { windowId: undefined, tabId: typeof tab.id === "number" ? tab.id : undefined });
		await persistAutomationTargets();
		return tab;
	}
	// Prefer reusing the user's currently-active window: open a background tab there instead of
	// spawning a new Chrome window. We never replace the active tab — `active: false` keeps the
	// user's selection intact, and background mode keeps the new tab out of focus. If the
	// chrome.windows API is unavailable we fall through to the tab-only fallback below.
	let activeWindowId;
	if (chrome.windows && typeof chrome.windows.getCurrent === "function") {
		try {
			const win = await chrome.windows.getCurrent();
			if (win && typeof win.id === "number") activeWindowId = win.id;
		} catch {
			// No current window (headless / detached) — leave activeWindowId undefined.
		}
	}
	const createParams = { url: AUTOMATION_TARGET_URL, active: false };
	if (typeof activeWindowId === "number") createParams.windowId = activeWindowId;
	// Tab fallback: the tab lives in a pre-existing (user/shared) window we did NOT create, so we
	// must leave windowId unset on the automation record — cleanup then closes only our tab,
	// never the user's window. If we passed a windowId above, chrome.tabs.create will fail with
	// "Tabs cannot be edited right now (user may be dragging a tab)" on rare races — retry once
	// without windowId to land the tab somewhere.
	let tab;
	try {
		tab = await chrome.tabs.create(createParams);
	} catch {
		tab = await chrome.tabs.create({ url: AUTOMATION_TARGET_URL, active: false });
	}
	automationTargets.set(sessionKey, { windowId: undefined, tabId: typeof tab.id === "number" ? tab.id : undefined });
	await persistAutomationTargets();
	return tab;
}

// Return the session's owned automation target if it still exists, else null. Robust to the user
// (or Chrome) having closed it: a stale entry is forgotten so callers can recreate cleanly.
async function resolveOwnedAutomationTarget(sessionKey) {
  await hydrateAutomationTargets();
  const t = automationTargets.get(sessionKey);
  if (!t || typeof t.tabId !== "number") return null;
  const existing = await chrome.tabs.get(t.tabId).catch(() => null);
  if (existing && typeof existing.id === "number") return existing;
  automationTargets.delete(sessionKey);
  await persistAutomationTargets();
  return null;
}

// Return the session's dedicated automation target, creating it on first use (or after the user
// closed it). Used by page/navigation actions that need a live surface to drive.
async function getOrCreateAutomationTarget(sessionKey, groupTitle) {
  return (await resolveOwnedAutomationTarget(sessionKey)) || createAutomationTarget(sessionKey, groupTitle);
}

// Close only the session's pi-chrome-owned window/tab, and only if it still exists. Never touches
// user tabs/windows or other sessions' targets. Safe to call repeatedly and when nothing exists.
async function cleanupAutomationTarget(sessionKey) {
  await hydrateAutomationTargets();
  const t = automationTargets.get(sessionKey);
  const result = { closedWindowId: null, closedTabId: null };
  if (!t) return result;
  const tab = await chrome.tabs.get(t.tabId).catch(() => null);
  if (tab) {
    try {
      // Never remove a whole window: users/other sessions can add tabs even between a
      // contents check and removal. Chrome closes empty windows when their last tab closes.
      await chrome.tabs.remove(t.tabId);
      result.closedTabId = t.tabId;
    } catch {
      return result; // Keep ownership so cleanup can retry.
    }
    if (tab.windowId === t.windowId && typeof chrome.windows?.get === "function") {
      const remaining = await chrome.windows.get(t.windowId).catch(() => null);
      if (!remaining) result.closedWindowId = t.windowId;
    }
  }
  automationTargets.delete(sessionKey);
  await persistAutomationTargets();
  return result;
}

function withTimeout(promise, ms, label, onTimeout) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(async () => {
        try { await onTimeout?.(); } catch {}
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
    }),
  ]);
}

// =================== Chrome input (CDP) layer ===================
// Tracks which tabs we have attached chrome.debugger to.
const attachedTabs = new Map(); // tabId -> { detachAt: number, pointer: {x,y} }
const INPUT_IDLE_DETACH_MS = 15_000;
const CDP_VERSION = "1.3";
// Matches the stale-tab errors that survive the cdp() wrapper's one-shot self-heal.
// Used by chromeInputClick to decide whether to fall through to the next link in the
// auto-fallback chain (uid-CDP -> selector-CDP -> uid-DOM -> selector-DOM -> native).
const STALE_CDP_PATTERN = /Debugger is not attached|Detached while|Target closed|No tab with id/i;
function isStaleCdpError(err) { return STALE_CDP_PATTERN.test(String(err?.message || err || "")); }
const STALE_CDP_PATTERN_FOR_CHAIN = /Debugger is not attached|Detached while|Target closed|No tab with id/i;

async function chromeClickViaChain(tabId, params, baseResolved) {
  // Chain order: uid-CDP -> selector-CDP -> uid-DOM -> selector-DOM -> native.
  // Each link is attempted in order; on a stale-CDP error, fall through.
  const log = [];
  async function cdpClickOnce(resolveParams) {
    const r = await resolveTargetInTab(tabId, resolveParams);
    const point = r.rect ? pickInsideRect(r.rect) : { x: r.x, y: r.y };
    await cdpMoveTo(tabId, point.x, point.y);
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", force: 0.5 });
    await sleep(rng(45, 140));
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
    return { point, tag: r.tag };
  }
  const links = [];
  if (params.uid) links.push({ kind: "cdp-uid", run: () => cdpClickOnce({ uid: params.uid, targetId: params.targetId }) });
  if (params.selector) links.push({ kind: "cdp-sel", run: () => cdpClickOnce({ selector: params.selector, targetId: params.targetId }) });
  if (params.uid) links.push({ kind: "dom-uid", run: () => domClickFallback(tabId, { uid: params.uid, targetId: params.targetId }, new Error("chain-fallback")) });
  if (params.selector) links.push({ kind: "dom-sel", run: () => domClickFallback(tabId, { selector: params.selector, targetId: params.targetId }, new Error("chain-fallback")) });
  // x,y-only calls: a single CDP attempt is the right path; no DOM fallback because there is
  // no resolved element to .click(). When uid/selector are absent we still emit one direct
  // CDP click so the chain returns success on the happy path without ever throwing
  // "click chain exhausted" for well-formed {x,y} clicks.
  if (links.length === 0 && Number.isFinite(Number(params.x)) && Number.isFinite(Number(params.y))) {
    links.push({ kind: "cdp-xy", run: async () => {
      const x = Number(params.x), y = Number(params.y);
      await cdpMoveTo(tabId, x, y);
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", force: 0.5 });
      await sleep(rng(45, 140));
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
      return { point: { x, y }, tag: undefined };
    } });
  }
  let lastErr = null;
  for (const link of links) {
    try {
      const out = await link.run();
      return { ...out, syntheticFallback: link.kind === "cdp-uid" || link.kind === "cdp-sel" || link.kind === "cdp-xy" ? "cdp-only" : "dom-click" };
    } catch (err) {
      lastErr = err;
      const msg = String(err && err.message || err);
      if (!STALE_CDP_PATTERN_FOR_CHAIN.test(msg)) throw err;
      log.push(link.kind);
    }
  }
  throw lastErr || new Error("click chain exhausted");
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function rng(min, max) { return min + Math.random() * (max - min); }

function inputStatus() {
  return {
    attachedTabs: Array.from(attachedTabs.keys()),
    permissionGranted: typeof chrome !== "undefined" && !!chrome.debugger,
    reconnectAttempts: reconnectStatusSnapshot(),
  };
}

// Last few attach failures, kept for diagnostics.
const attachDebugLog = [];
function recordAttachEvent(entry) {
  attachDebugLog.push({ ...entry, t: Date.now() });
  if (attachDebugLog.length > 20) attachDebugLog.shift();
}

function normalPageTarget(target, tabId) {
  const url = String(target?.url || "");
  return target?.tabId === tabId && target?.type === "page" && !url.startsWith("chrome://") && !url.startsWith("chrome-extension://") && !url.startsWith("devtools://");
}

async function pageDebuggeeForTab(tabId) {
  const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || []))).catch(() => []);
  const target = targets.find((t) => normalPageTarget(t, tabId));
  return target?.id ? { targetId: target.id } : { tabId };
}

async function debuggerAttachRaw(tabId, preferredDebuggee) {
  const debuggee = preferredDebuggee || { tabId };
  await withTimeout(
    chrome.debugger.attach(debuggee, CDP_VERSION),
    ATTACH_TIMEOUT_MS,
    `Chrome debugger attach to tab ${tabId}`,
    async () => {
      attachedTabs.delete(tabId);
      try { await chrome.debugger.detach(debuggee); } catch {}
    },
  );
  return debuggee;
}

async function attachDebugger(tabId) {
  if (!chrome.debugger) throw new Error("chrome.debugger API unavailable; reload the extension to grant the new permission");
  if (attachedTabs.has(tabId)) {
    const entry = attachedTabs.get(tabId);
    entry.detachAt = Date.now() + INPUT_IDLE_DETACH_MS;
    return entry;
  }
  // Honor the auto-reconnect backoff: if a timer is in flight for this tab and
  // has not yet elapsed, skip the attach and reschedule so the next user-driven
  // call does not race the worker-initiated retry. The check is intentionally
  // a soft gate — callers like processReconnectBackoffs() still pass through
  // (they bypass via the direct schedule, and we let them proceed when the
  // timer has elapsed by simply clearing the entry below).
  const pending = reconnectAttempts.get(tabId);
  if (pending && pending.scheduledAt > Date.now()) {
    // Re-arm in case no other entry brought the alarm back; harmless if already set.
    armReconnectAlarm();
    throw new Error(`Chrome debugger attach deferred for tab ${tabId}; auto-reconnecting in ${pending.scheduledAt - Date.now()}ms`);
  }
  // If a tab is mid-navigation, defer until status==='complete'. chrome.debugger
  // attach races the navigation lifecycle otherwise — Chrome will reject with
  // "Target closed" and we'd just have to retry.
  try {
    const tabSnapshot = await chrome.tabs.get(tabId).catch(() => null);
    if (tabSnapshot && tabSnapshot.status && tabSnapshot.status !== "complete") {
      scheduleReconnect(tabId, `tab-status-${tabSnapshot.status}`);
      throw new Error(`Chrome debugger attach deferred for tab ${tabId}; tab still ${tabSnapshot.status}`);
    }
  } catch (deferErr) {
    // Only swallow if it was our own deferral; re-throw chrome.tabs errors.
    if (deferErr && /deferred for tab/.test(String(deferErr.message || deferErr))) throw deferErr;
  }
  // Before each attach, force-detach any stale CDP target this extension owns on the tab.
  // Chrome sometimes keeps a half-dead session around (extension reload mid-attach, etc.) and
  // surfaces it as "Cannot access a chrome-extension://" on the next attach attempt.
  try {
    const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || [])));
    for (const tgt of targets) {
      if (tgt.tabId === tabId && tgt.attached) {
        recordAttachEvent({ kind: "stale-target-found", tabId, target: { id: tgt.id, type: tgt.type, url: tgt.url, extensionId: tgt.extensionId } });
        try { await chrome.debugger.detach({ tabId }); } catch {}
        await sleep(80);
        break;
      }
    }
  } catch {}
  let attachedDebuggee = null;
  const attemptAttach = async (debuggee) => {
    try {
      attachedDebuggee = await debuggerAttachRaw(tabId, debuggee);
      return null;
    } catch (error) {
      return error;
    }
  };
  const retryPageTargetIfExtensionBlocked = async (err, kind) => {
    if (!/Cannot access a chrome-extension:\/\/ URL of different extension/i.test(String(err?.message || err))) return err;
    const pageDebuggee = await pageDebuggeeForTab(tabId);
    recordAttachEvent({ kind, tabId, debuggee: pageDebuggee });
    return attemptAttach(pageDebuggee);
  };
  let err = await attemptAttach();
  if (err) err = await retryPageTargetIfExtensionBlocked(err, "attach-page-target-retry");
  if (err) {
    const msg = String(err?.message || err);
    const transient = /Cannot access a chrome-extension|Cannot access contents of|No tab with id|Debugger is not attached|Another debugger|Target closed/i.test(msg);
    const tabSnapshot = await chrome.tabs.get(tabId).catch(() => null);
    recordAttachEvent({ kind: "attach-failed", tabId, message: msg, tabUrl: tabSnapshot?.url, transient });
    if (!transient) throw err;
    if (!tabSnapshot || (tabSnapshot.url || "").startsWith("chrome://") || (tabSnapshot.url || "").startsWith("chrome-extension://")) {
      throw new Error(`Chrome can't attach the debugger to this tab (${tabSnapshot?.url ?? "unknown"}). Open a normal http(s) tab and try again.`);
    }
    await sleep(180);
    err = await attemptAttach();
    if (err) err = await retryPageTargetIfExtensionBlocked(err, "attach-page-target-retry2");
    if (err) {
      recordAttachEvent({ kind: "attach-retry-failed", tabId, message: String(err.message || err), tabUrl: tabSnapshot?.url });
      // One more try after a longer settle. Some Chrome builds need ~500ms after a navigation
      // for content-script registration on the tab to drain before chrome.debugger.attach
      // will accept the target.
      await sleep(500);
      err = await attemptAttach();
      if (err) err = await retryPageTargetIfExtensionBlocked(err, "attach-page-target-retry3");
      if (err) {
        recordAttachEvent({ kind: "attach-retry2-failed", tabId, message: String(err.message || err), tabUrl: tabSnapshot?.url });
        const meta = await describeInputTarget(tabId);
        throw new Error(`Chrome debugger attach failed for tab ${tabId}: ${String(err.message || err)}${targetMetaSuffix(meta)}`);
      }
    }
  }
  recordAttachEvent({ kind: "attached", tabId, debuggee: attachedDebuggee });
  // Seed pointer in a plausible "just left the address bar" location.
  const entry = { detachAt: Date.now() + INPUT_IDLE_DETACH_MS, pointer: { x: 120 + Math.random() * 200, y: 80 + Math.random() * 120 }, debuggee: attachedDebuggee || { tabId } };
  attachedTabs.set(tabId, entry);
  // Successful attach — reset the auto-reconnect backoff for this tab so the
  // next detach starts from count=0 instead of inheriting the previous storm.
  clearReconnect(tabId);
  return entry;
}

async function describeInputTarget(tabId) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  const active = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []))[0] || null;
  let targets = [];
  try { targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || []))); } catch {}
  return {
    resolvedTab: tab ? { id: tab.id, windowId: tab.windowId, url: tab.url, status: tab.status, title: tab.title, active: tab.active } : null,
    activeTab: active ? { id: active.id, windowId: active.windowId, url: active.url, status: active.status, title: active.title, active: active.active } : null,
    attachedTabs: Array.from(attachedTabs.keys()),
    cdpTargets: targets.map((t) => ({ id: t.id, tabId: t.tabId, type: t.type, url: t.url, attached: t.attached, extensionId: t.extensionId })),
  };
}

function targetMetaSuffix(meta) {
  return `\nTarget metadata: ${JSON.stringify(meta).slice(0, 4000)}`;
}

async function inputDebug(params) {
  const requested = params?.targetId ? await describeInputTarget(Number(params.targetId)) : await describeInputTarget(-1);
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    extensionId: chrome.runtime.id,
    ...requested,
    recentAttachEvents: attachDebugLog.slice(),
  };
}

async function detachDebugger(tabId) {
  const entry = attachedTabs.get(tabId);
  if (!entry) return;
  attachedTabs.delete(tabId);
  try { await chrome.debugger.detach(entry.debuggee || { tabId }); } catch {}
}

async function detachAll() {
  const ids = Array.from(attachedTabs.keys());
  await Promise.all(ids.map(detachDebugger));
}

if (chrome.debugger && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
    if (tabId !== undefined) attachedTabs.delete(tabId);
    if (reason === "canceled_by_user") {
      console.warn(`[pi-chrome] debugger canceled by user on tab ${tabId}; Chrome input will reattach on next call`);
      // User actively canceled — do NOT auto-reconnect. Just clear any pending
      // backoff so we don't re-attach the moment they switch tabs.
      clearReconnect(tabId);
      return;
    }
    // Stale target cleanup runs BEFORE the backoff timer is scheduled so the
    // next attach attempt does not collide with a half-dead CDP target.
    void (async () => {
      try {
        const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || [])));
        for (const tgt of targets) {
          if (tgt.tabId === tabId && tgt.attached) {
            recordAttachEvent({ kind: "auto-reconnect-stale-target", tabId, target: { id: tgt.id, type: tgt.type, url: tgt.url, extensionId: tgt.extensionId } });
            try { await chrome.debugger.detach({ tabId }); } catch {}
            await sleep(80);
            break;
          }
        }
      } catch {}
      scheduleReconnect(tabId, reason);
    })();
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [tabId, entry] of attachedTabs) {
    if (entry.detachAt && entry.detachAt < now) {
      void detachDebugger(tabId);
    }
  }
}, 5000);

function cdpRaw(tabId, method, params) {
  const debuggee = attachedTabs.get(tabId)?.debuggee || { tabId };
  return withTimeout(new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(debuggee, method, params || {}, (result) => {
      if (chrome.runtime.lastError) reject(new Error(`${method}: ${chrome.runtime.lastError.message}`));
      else resolve(result);
    });
  }), CDP_COMMAND_TIMEOUT_MS, `CDP ${method}`, async () => {
    attachedTabs.delete(tabId);
    try { await chrome.debugger.detach(debuggee); } catch {}
  });
}

function executeScriptTimed(options, label) {
  return withTimeout(chrome.scripting.executeScript(options), SCRIPTING_TIMEOUT_MS, label || "chrome.scripting.executeScript");
}

// Wraps cdpRaw with one auto-recover on detached/closed sessions:
// chrome.debugger.attach can stay cached in attachedTabs even after Chrome killed
// the session (tab nav, devtools opened/closed, etc). Recover by detaching the
// stale entry and re-attaching, then retry the command once.
// Find foreign chrome-extension targets currently anchored to the tab. Password managers,
// autofill helpers, and other input-attached extensions create type:"other" CDP targets
// whose URL is chrome-extension://<otherId>/...  When that target is in focus, CDP refuses
// our Input.dispatchMouseEvent calls with "Cannot access a chrome-extension:// URL of
// different extension" — surfacing a cryptic error to the user.
async function findForeignExtensionTargets() {
  try {
    const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || [])));
    return targets.filter((t) => {
      const url = String(t.url || "");
      if (!url.startsWith("chrome-extension://")) return false;
      if (t.extensionId === chrome.runtime.id) return false;
      return true;
    });
  } catch {
    return [];
  }
}

function extractForeignExtId(targets) {
  for (const t of targets) {
    if (t.extensionId && t.extensionId !== chrome.runtime.id) return t.extensionId;
    const m = String(t.url || "").match(/chrome-extension:\/\/([a-p]+)\//);
    if (m && m[1] !== chrome.runtime.id) return m[1];
  }
  return null;
}

async function dismissOverlayViaEscape(tabId) {
  // Esc routes through key dispatcher (target-by-focus), not by mouse coordinates, so it
  // works even when a foreign chrome-extension popup is intercepting pointer events.
  try {
    await cdpRaw(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdpRaw(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(120);
  } catch {}
}

async function cdp(tabId, method, params) {
  try {
    return await cdpRaw(tabId, method, params);
  } catch (error) {
    const msg = String(error?.message || error);
    const isStale = /Debugger is not attached|Detached while|Target closed|No tab with id/i.test(msg);
    const isForeignExtBlock = /Cannot access a chrome-extension:\/\/ URL of different extension/i.test(msg);
    if (isForeignExtBlock && /Input\./.test(method)) {
      // Foreign chrome-extension popup (autofill, password manager) is hijacking input.
      // Try once: dismiss via Esc, then retry.
      const before = await findForeignExtensionTargets();
      recordAttachEvent({ kind: "foreign-ext-detected", tabId, method, foreignExtId: extractForeignExtId(before), targetCount: before.length });
      await dismissOverlayViaEscape(tabId);
      try {
        return await cdpRaw(tabId, method, params);
      } catch (retryErr) {
        const retryMsg = String(retryErr?.message || retryErr);
        if (/Cannot access a chrome-extension:\/\/ URL of different extension/i.test(retryMsg)) {
          const after = await findForeignExtensionTargets();
          const id = extractForeignExtId(after) || extractForeignExtId(before) || "unknown";
          throw new Error(
            `Another Chrome extension (${id}) has an input overlay on this page (e.g. a password manager / autofill popup). \n` +
            `pi-chrome tried to dismiss it with Escape but it reappeared. Disable that extension on this page, close its popup, or focus the field via Tab instead of clicking.`,
          );
        }
        throw retryErr;
      }
    }
    if (!isStale) throw error;
    attachedTabs.delete(tabId);
    await attachDebugger(tabId).catch(() => undefined);
    return cdpRaw(tabId, method, params);
  }
}

// cdpEval: evaluate a JavaScript expression string in the page's MAIN world via CDP
// Runtime.evaluate. Runtime.evaluate is a DevTools protocol command and is NOT subject to
// the page's Content-Security-Policy, so it works on pages that ship `script-src 'self'`
// without `'unsafe-eval'` (which blocks `eval`/`new Function`). Ensures the debugger is
// attached first. Returns the raw CDP result ({ result, exceptionDetails }).
async function cdpEval(tabId, expression, opts) {
  await attachDebugger(tabId);
  return cdp(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
    ...(opts || {}),
  });
}

function cdpExceptionText(details) {
  if (!details) return "";
  return String(
    details.exception?.description ||
      details.exception?.value ||
      details.text ||
      "",
  );
}

function cdpIsSyntaxError(details) {
  if (!details) return false;
  const className = String(details.exception?.className || "");
  return className === "SyntaxError" || /SyntaxError/.test(cdpExceptionText(details));
}

// Resolve target -> {x, y, rect} in viewport coords by running tiny script in tab.
async function resolveTargetInTab(tabId, params) {
  const results = await executeScriptTimed({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: (selector, uid, x, y) => {
      const state = window.__PI_CHROME_STATE__;
      let el = null;
      if (uid) {
        el = state && state.elements ? state.elements[uid] : null;
        if (!el || !el.isConnected) return { found: false, staleUid: true, reason: `snapshot uid ${uid} is stale; refresh chrome_snapshot`, url: location.href };
      } else if (selector) {
        el = document.querySelector(selector);
      }
      if (el) {
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const r = el.getBoundingClientRect();
        // Sample computed style for the visibility-gate fast path in chromeInputType.
        // The slow path falls back to snapshot_injected.js's countMatchesStable predicate.
        const cs = getComputedStyle(el);
        return {
          x: r.left + r.width / 2, y: r.top + r.height / 2,
          rect: { left: r.left, top: r.top, width: r.width, height: r.height },
          tag: el.tagName,
          found: true,
          opacity: parseFloat(cs.opacity || "1"),
          display: cs.display,
          visibility: cs.visibility,
        };
      }
      if (typeof x === "number" && typeof y === "number") return { x, y, rect: null, tag: null, found: true };
      return { found: false };
    },
    args: [params.selector ?? null, params.uid ?? null, params.x ?? null, params.y ?? null],
  }, `resolve input target in tab ${tabId}`);
  const v = results?.[0]?.result;
  if (v?.staleUid) throw new Error(v.reason || "snapshot uid is stale; refresh chrome_snapshot");
  if (!v || !v.found) throw new Error("Could not resolve target element for Chrome input");
  return v;
}

function pickInsideRect(rect) {
  if (!rect) return null;
  const insetX = Math.min(rect.width * 0.35, Math.max(2, rect.width / 2 - 1));
  const insetY = Math.min(rect.height * 0.35, Math.max(2, rect.height / 2 - 1));
  return {
    x: rect.left + rect.width / 2 + rng(-insetX, insetX),
    y: rect.top + rect.height / 2 + rng(-insetY, insetY),
  };
}

async function cdpMoveTo(tabId, x, y) {
  const entry = attachedTabs.get(tabId);
  const startX = entry?.pointer?.x ?? Math.max(20, Math.min(400, x - 200));
  const startY = entry?.pointer?.y ?? Math.max(20, Math.min(400, y - 200));
  const n = Math.max(18, Math.min(42, Math.round(Math.hypot(x - startX, y - startY) / 18)));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 8;
    const px = startX + (x - startX) * ease + rng(-wobble, wobble);
    const py = startY + (y - startY) * ease + rng(-wobble, wobble);
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: px, y: py, button: "none", buttons: 0, pointerType: "mouse",
    });
    await sleep(rng(5, 16));
  }
  if (entry) entry.pointer = { x, y };
}

function cdpModifiersFor(mods) {
  let m = 0;
  if (mods?.altKey) m |= 1;
  if (mods?.ctrlKey) m |= 2;
  if (mods?.metaKey) m |= 4;
  if (mods?.shiftKey) m |= 8;
  return m;
}

// Resolve a single printable character to { code, keyCode, needShift } on a US layout.
// Self-contained (maps defined inline) so it can be serialized into the page via
// HELPER_FUNCS for the DOM-event fallback as well as used by the CDP path.
// Using charCodeAt() for punctuation is wrong: e.g. "." is charCode 46 which collides
// with VK_DELETE, "-" is 45 (VK_INSERT), so app keydown handlers misfire and drop input.
function usKeyLayoutForChar(ch) {
  const PUNCT = {
    "`": { code: "Backquote", keyCode: 192 }, "~": { code: "Backquote", keyCode: 192, shift: true },
    "-": { code: "Minus", keyCode: 189 }, "_": { code: "Minus", keyCode: 189, shift: true },
    "=": { code: "Equal", keyCode: 187 }, "+": { code: "Equal", keyCode: 187, shift: true },
    "[": { code: "BracketLeft", keyCode: 219 }, "{": { code: "BracketLeft", keyCode: 219, shift: true },
    "]": { code: "BracketRight", keyCode: 221 }, "}": { code: "BracketRight", keyCode: 221, shift: true },
    "\\": { code: "Backslash", keyCode: 220 }, "|": { code: "Backslash", keyCode: 220, shift: true },
    ";": { code: "Semicolon", keyCode: 186 }, ":": { code: "Semicolon", keyCode: 186, shift: true },
    "'": { code: "Quote", keyCode: 222 }, "\"": { code: "Quote", keyCode: 222, shift: true },
    ",": { code: "Comma", keyCode: 188 }, "<": { code: "Comma", keyCode: 188, shift: true },
    ".": { code: "Period", keyCode: 190 }, ">": { code: "Period", keyCode: 190, shift: true },
    "/": { code: "Slash", keyCode: 191 }, "?": { code: "Slash", keyCode: 191, shift: true },
    " ": { code: "Space", keyCode: 32 },
  };
  // Shifted digit symbols share the digit's physical code + keyCode.
  const SHIFT_DIGIT = { ")": "0", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9" };
  if (/^[a-z]$/.test(ch)) return { code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), needShift: false };
  if (/^[A-Z]$/.test(ch)) return { code: `Key${ch}`, keyCode: ch.charCodeAt(0), needShift: true };
  if (/^[0-9]$/.test(ch)) return { code: `Digit${ch}`, keyCode: ch.charCodeAt(0), needShift: false };
  if (SHIFT_DIGIT[ch]) { const d = SHIFT_DIGIT[ch]; return { code: `Digit${d}`, keyCode: d.charCodeAt(0), needShift: true }; }
  const p = PUNCT[ch];
  if (p) return { code: p.code, keyCode: p.keyCode, needShift: !!p.shift };
  // Unknown char (e.g. unicode): keep text-driven insertion, avoid bogus keyCode collisions.
  return { code: ch, keyCode: 0, needShift: false };
}

function cdpKeyInfo(key, shifted) {
  // Map common keys to CDP key event init fields. Returns { code, key, windowsVirtualKeyCode, text }.
  const SPECIAL = {
    Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Tab: { code: "Tab", windowsVirtualKeyCode: 9, text: "\t" },
    Backspace: { code: "Backspace", windowsVirtualKeyCode: 8, text: "" },
    Delete: { code: "Delete", windowsVirtualKeyCode: 46, text: "" },
    Escape: { code: "Escape", windowsVirtualKeyCode: 27, text: "" },
    ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37, text: "" },
    ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38, text: "" },
    ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39, text: "" },
    ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40, text: "" },
    Shift: { code: "ShiftLeft", windowsVirtualKeyCode: 16, text: "" },
    Control: { code: "ControlLeft", windowsVirtualKeyCode: 17, text: "" },
    Alt: { code: "AltLeft", windowsVirtualKeyCode: 18, text: "" },
    Meta: { code: "MetaLeft", windowsVirtualKeyCode: 91, text: "" },
    " ": { code: "Space", windowsVirtualKeyCode: 32, text: " " },
  };
  if (SPECIAL[key]) return { key, ...SPECIAL[key] };
  if (key.length === 1) {
    // Explicit Shift chords need shifted text as well as a modifier bit. CDP does
    // not derive printable text from code/windowsVirtualKeyCode for us.
    const SHIFTED = {
      "`": "~", "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
      "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?",
    };
    const ch = shifted ? (/^[a-z]$/.test(key) ? key.toUpperCase() : SHIFTED[key] || key) : key;
    const layout = usKeyLayoutForChar(ch);
    return { key: ch, code: layout.code, windowsVirtualKeyCode: layout.keyCode, text: ch };
  }
  return { key, code: key, windowsVirtualKeyCode: 0, text: "" };
}

async function cdpTypeChar(tabId, ch) {
  const needShift = /^[A-Z]$/.test(ch) || "~!@#$%^&*()_+{}|:\"<>?".includes(ch);
  let modifiers = 0;
  if (needShift) {
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 });
    modifiers = 8;
    await sleep(rng(8, 22));
  }
  const info = cdpKeyInfo(ch);
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown", key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, nativeVirtualKeyCode: info.windowsVirtualKeyCode,
    text: info.text, unmodifiedText: info.text, modifiers,
  });
  await sleep(rng(25, 90));
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, modifiers,
  });
  if (needShift) {
    await sleep(rng(5, 18));
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 });
  }
  await sleep(rng(35, 130));
}

async function domClickFallback(tabId, params, cause) {
  const results = await executeScriptTimed({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: (selector, uid, x, y) => {
      const state = window.__PI_CHROME_STATE__;
      let el = uid && state && state.elements ? state.elements[uid] : null;
      if (uid && (!el || !el.isConnected)) return { staleUid: true, reason: `snapshot uid ${uid} is stale; refresh chrome_snapshot`, url: location.href };
      if (!el && selector) el = document.querySelector(selector);
      if (!el && typeof x === "number" && typeof y === "number") el = document.elementFromPoint(x, y);
      if (!el) throw new Error(`DOM fallback target not found: ${uid || selector || `${x},${y}`}`);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const rect = el.getBoundingClientRect();
      const eventInit = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, buttons: 1 };
      el.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      el.dispatchEvent(new MouseEvent("mousedown", eventInit));
      if (typeof el.focus === "function") el.focus({ preventScroll: true });
      el.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...eventInit, buttons: 0 }));
      el.click();
      return { tag: el.tagName, url: location.href };
    },
    args: [params.selector ?? null, params.uid ?? null, params.x ?? null, params.y ?? null],
  }, `DOM click fallback in tab ${tabId}`);
  const v = results?.[0]?.result;
  if (v?.staleUid) throw new Error(v.reason || "snapshot uid is stale; refresh chrome_snapshot");
  return { input: "dom-fallback", reason: String(cause?.message || cause).slice(0, 500), tag: v?.tag };
}

// Detect Bootstrap / react-bootstrap tab toggles and dispatch a real synthetic click via
  // el.click() (with a bubbling MouseEvent so react-bootstrap's bubbling handler fires).
  // Returns { handled: true, tag } on success so the caller can skip the CDP mousePressed
  // path; returns { handled: false } when the target is not a known toggle so the existing
  // CDP path runs unchanged. Per ARCHITECTURE-v2.md §2 (A2).
  async function tryBootstrapTabSynthetic(tabId, params, resolved) {
    if (!params.selector && !params.uid) return { handled: false };
    let info = null;
    try {
      const results = await executeScriptTimed({
        target: { tabId, frameIds: [0] },
        world: "MAIN",
        func: (sel, uid) => {
          const fn = window.__piChromeInspectToggleTarget;
          if (typeof fn !== "function") return null;
          const state = window.__PI_CHROME_STATE__;
          let el = null;
          if (uid && state && state.elements && state.elements[uid]) el = state.elements[uid];
          else if (sel) el = document.querySelector(sel);
          if (!el) return null;
          return fn(el);
        },
        args: [params.selector ?? null, params.uid ?? null],
      }, `inspect toggle target in tab ${tabId}`);
      info = results?.[0]?.result || null;
    } catch {
      return { handled: false };
    }
    if (!info || (info.kind !== "react-bootstrap-tab" && info.kind !== "bootstrap-nav-link")) return { handled: false };
    try {
      await executeScriptTimed({
        target: { tabId, frameIds: [0] },
        world: "MAIN",
        func: (sel, uid) => {
          const state = window.__PI_CHROME_STATE__;
          let el = null;
          if (uid && state && state.elements && state.elements[uid]) el = state.elements[uid];
          else if (sel) el = document.querySelector(sel);
          if (!el) return false;
          // Synthesize a bubbling MouseEvent + invoke click() so react-bootstrap's
          // onClick handler (which listens via document delegation) fires.
          const evt = new MouseEvent("click", { bubbles: true, cancelable: true, view: window, button: 0 });
          const dispatched = el.dispatchEvent(evt);
          el.click();
          return dispatched !== false;
        },
        args: [params.selector ?? null, params.uid ?? null],
      }, `synthetic tab toggle click in tab ${tabId}`);
      // One animation frame so the pane swap / show.bs.tab listeners settle before the
      // caller does any follow-up snapshot.
      await sleep(16);
      const tag = resolved && resolved.tag ? resolved.tag : undefined;
      return { handled: true, tag };
    } catch {
      return { handled: false };
    }
  }

async function chromeInputClick(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  try {
    await attachDebugger(tab.id);
    const resolved = await resolveTargetInTab(tab.id, params);
    const synthetic = await tryBootstrapTabSynthetic(tab.id, params, resolved);
    if (synthetic && synthetic.handled) {
      return runClickVerify(tab.id, params, { input: "synthetic-tab", x: resolved.x, y: resolved.y, tag: synthetic.tag || resolved.tag, syntheticFallback: "react-prog" });
    }
    // Auto-fallback chain (item 3): uid-CDP -> selector-CDP -> uid-DOM -> selector-DOM -> native.
    const chained = await chromeClickViaChain(tab.id, params, resolved);
    // Reset :focus-visible (existing behavior preserved)
    if (params.selector || params.uid) {
      await executeScriptTimed({
        target: { tabId: tab.id, frameIds: [0] },
        world: "MAIN",
        func: (sel, uid) => {
          const state = window.__PI_CHROME_STATE__;
          let el = null;
          if (uid && state && state.elements && state.elements[uid]) el = state.elements[uid];
          else if (sel) el = document.querySelector(sel);
          if (el && typeof el.focus === "function" && el === document.activeElement) {
            try { el.blur(); el.focus({ preventScroll: true, focusVisible: false }); } catch {}
          }
        },
        args: [params.selector ?? null, params.uid ?? null],
      }, `reset focus style in tab ${tab.id}`).catch(() => undefined);
    }
    return runClickVerify(tab.id, params, { input: chained.syntheticFallback === "dom-click" ? "dom-fallback" : "chrome", x: chained.point?.x, y: chained.point?.y, tag: chained.tag, syntheticFallback: chained.syntheticFallback });
  } catch (error) {
    if (params.domFallback === false) throw error;
    const fallback = await domClickFallback(tab.id, params, error);
    return { ...fallback, syntheticFallback: "dom-click" };
  }
}

// Stale-CDP retry wrapper: re-fires chromeInputClick up to `retries` times when the bridge
// throws a stale-tab error (Debugger is not attached / Detached while / Target closed /
// No tab with id). Useful right after a tab activate / navigate where the active target may
// briefly report a stale handle. Backoff grows with `backoff` strategy ("linear" or
// "exponential"); per-attempt delay is capped at 5000ms. Non-stale errors short-circuit
// immediately so real failures aren't masked.
async function chromeInputClickRetry(params) {
  const retriesRaw = Number(params.retries);
  const retries = Number.isFinite(retriesRaw) ? Math.min(Math.max(0, Math.floor(retriesRaw)), 5) : 0;
  const delayRaw = Number(params.delayMs);
  const baseDelay = Number.isFinite(delayRaw) ? Math.min(Math.max(0, Math.floor(delayRaw)), 5000) : 250;
  const backoff = params.backoff === "exponential" ? "exponential" : "linear";
  const started = Date.now();
  let attempts = 0;
  let lastSyntheticFallback;
  let lastError;
  let lastResult;
  for (let attempt = 0; attempt <= retries; attempt++) {
    attempts = attempt + 1;
    if (attempt > 0) {
      const growth = backoff === "exponential" ? Math.pow(2, attempt - 1) : 1;
      const wait = Math.min(baseDelay * growth, 5000);
      if (wait > 0) await sleep(wait);
    }
    try {
      const result = await chromeInputClick(params);
      lastSyntheticFallback = result && typeof result === "object" ? result.syntheticFallback : undefined;
      lastResult = result;
      lastError = undefined;
      const totalMs = Date.now() - started;
      return { ...result, attempts, lastSyntheticFallback, lastError: undefined, totalMs };
    } catch (error) {
      lastError = String(error && error.message ? error.message : error);
      if (!isStaleCdpError(error) || attempt >= retries) {
        const totalMs = Date.now() - started;
        const err = new Error(lastError);
        err.attempts = attempts;
        err.lastError = lastError;
        err.totalMs = totalMs;
        err.lastSyntheticFallback = lastSyntheticFallback;
        throw err;
      }
    }
  }
  // Unreachable (loop returns or throws on final attempt), but keep linter happy.
  const totalMs = Date.now() - started;
  return { ...(lastResult || {}), attempts, lastSyntheticFallback, lastError, totalMs };
}

// page.sessionCheck: cheap read-only probe to detect login/SAML/SSO redirect pages without
// clicking anything. Returns url/title/innerText-readiness and a matched signature label from
// a 5-entry table (Microsoft / Google / GitHub / Auth0 / Okta). When Runtime.evaluate throws
// a CSP block, surface cspBlocked=true with documentReady=null so callers can decide whether
// to assume-proceed or surface a warning.
const SESSION_SIGNATURES = [
  { label: "Microsoft SSO", pattern: /login\.microsoftonline\.com|login\.live\.com/i },
  { label: "Google SSO", pattern: /accounts\.google\.com/i },
  { label: "GitHub Login", pattern: /github\.com\/login/i },
  { label: "Auth0", pattern: /\.auth0\.com/i },
  { label: "Okta", pattern: /\.okta\.com|\.oktacdn\.com/i },
];

async function probeSessionInTab(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  let url = "";
  let title = "";
  let documentReady = null;
  let firstInnerText = "";
  let cspBlocked = false;
  let blockedError = "";
  try {
    const results = await executeScriptTimed({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        try {
          const body = document.body || document.documentElement;
          const text = body && typeof body.innerText === "string" ? body.innerText : "";
          return {
            url: location.href || "",
            title: document.title || "",
            documentReady: document.readyState || null,
            firstInnerText: text.slice(0, 200),
          };
        } catch (innerErr) {
          return { error: String(innerErr && innerErr.message ? innerErr.message : innerErr) };
        }
      },
    }, `probeSession tab ${tab.id}`);
    const first = results && Array.isArray(results) ? results[0] : null;
    const value = first && typeof first === "object" ? first.result : null;
    if (value && typeof value === "object" && !Array.isArray(value) && "error" in value) {
      cspBlocked = true;
      blockedError = typeof value.error === "string" ? value.error : "unknown";
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      url = typeof value.url === "string" ? value.url : "";
      title = typeof value.title === "string" ? value.title : "";
      documentReady = typeof value.documentReady === "string" ? value.documentReady : null;
      firstInnerText = typeof value.firstInnerText === "string" ? value.firstInnerText : "";
    }
  } catch (error) {
    cspBlocked = true;
    blockedError = String(error && error.message ? error.message : error);
  }
  let matched = null;
  for (const entry of SESSION_SIGNATURES) {
    if (entry.pattern.test(url) || entry.pattern.test(title) || entry.pattern.test(firstInnerText)) {
      matched = entry;
      break;
    }
  }
  return {
    url,
    title,
    firstInnerText,
    documentReady,
    isLoginPage: matched !== null,
    matchedSignature: matched ? matched.label : null,
    suggestedAction: matched ? "auto-relogin" : "proceed",
    cspBlocked,
    blockedError: cspBlocked ? blockedError : undefined,
  };
}

// Save-Bubble retry: when an onClick handler defers its effect (e.g. async show of a
// confirmation bubble), the first CDP click often lands before the effect is observable.
// Run a probe (`verifyExpr`) ~150ms after the click and, if still falsy, retry the click
// up to `verifyRetries` times. Polling stays within `verifyAfterMs` total — beyond that we
// trust whatever the page has settled on and return success.
async function runClickVerify(tabId, params, baseResult) {
  const expr = typeof params.verifyExpr === "string" ? params.verifyExpr.trim() : "";
  if (!expr) return baseResult;
  const afterMs = Math.min(Math.max(0, Number(params.verifyAfterMs) || 0), 2000);
  const retriesRaw = Number(params.verifyRetries);
  const retries = Number.isFinite(retriesRaw) ? Math.min(Math.max(0, Math.floor(retriesRaw)), 3) : 1;
  let attempt = 0;
  let lastProbe = false;
  let verified = false;
  while (true) {
    const jitter = 120 + Math.floor(Math.random() * 60); // ~120-180ms
    await sleep(jitter);
    if (afterMs > 0) {
      const probeStart = Date.now();
      while (Date.now() - probeStart < afterMs) {
        const r = await runVerifyProbe(tabId, expr);
        if (r.ok) { verified = true; lastProbe = true; break; }
        await sleep(50);
      }
      if (verified) break;
      lastProbe = false;
    } else {
      const r = await runVerifyProbe(tabId, expr);
      lastProbe = r.ok;
      if (r.ok) { verified = true; break; }
    }
    attempt += 1;
    if (attempt > retries) break;
    // Re-run the click synthetically via a follow-up CDP mousePressed/Released at the same
    // point so we don't re-resolve a stale selector. Skipped for the synthetic-tab branch
    // because that already invoked the bootstrap-tab handler — re-invoking it would re-show
    // or re-toggle state the user didn't ask for.
    if (baseResult.input !== "synthetic-tab" && typeof baseResult.x === "number" && typeof baseResult.y === "number") {
      await sleep(150);
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: baseResult.x, y: baseResult.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", force: 0.5 });
      await sleep(rng(45, 140));
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: baseResult.x, y: baseResult.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
    }
  }
  return { ...baseResult, verifyExpr: expr, verified, verifyAttempts: attempt, verifyResult: lastProbe === true };
}

// Eval `expr` in the page's MAIN world. Returns { ok: boolean } — never throws, never
// throws on syntax errors, just reports false. The expression is allowed to be either a
// bare JS expression (`document.querySelector('.bubble')`) or a CSS selector (anything
// without an obvious JS identifier pattern); when it looks like a selector, the helper
// forwards it to document.querySelector so callers can write `'.save-bubble'` plainly.
async function runVerifyProbe(tabId, expr) {
  try {
    const looksLikeJs = /[(){}\[\]=;]/.test(expr);
    const results = await executeScriptTimed({
      target: { tabId, frameIds: [0] },
      world: "MAIN",
      func: (expression, isJs) => {
        try {
          if (isJs) {
            // eslint-disable-next-line no-new-func
            const v = (0, eval)(expression);
            return { ok: !!v };
          }
          return { ok: !!document.querySelector(expression) };
        } catch { return { ok: false }; }
      },
      args: [expr, looksLikeJs],
    }, `verify probe in tab ${tabId}`);
    const r = results?.[0]?.result;
    return { ok: !!(r && r.ok === true) };
  } catch {
    return { ok: false };
  }
}

async function chromeInputHover(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  await attachDebugger(tab.id);
  const resolved = await resolveTargetInTab(tab.id, params);
  const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
  await cdpMoveTo(tab.id, point.x, point.y);
  await sleep(rng(80, 220));
  return { input: "chrome", x: point.x, y: point.y, tag: resolved.tag };
}

async function chromeInputKey(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  await attachDebugger(tab.id);
  const key = String(params.key || "");
  if (!key) throw new Error("chrome.key: missing key");
  const mods = params.modifiers || {};
  const modBits = cdpModifiersFor(mods);
  // Press modifiers in standard order, then key, then release in reverse.
  const modOrder = [];
  if (mods.metaKey) modOrder.push({ key: "Meta", code: "MetaLeft", vk: 91 });
  if (mods.ctrlKey) modOrder.push({ key: "Control", code: "ControlLeft", vk: 17 });
  if (mods.altKey) modOrder.push({ key: "Alt", code: "AltLeft", vk: 18 });
  if (mods.shiftKey) modOrder.push({ key: "Shift", code: "ShiftLeft", vk: 16 });
  for (const m of modOrder) {
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers: modBits });
    await sleep(rng(6, 18));
  }
  const info = cdpKeyInfo(key, mods.shiftKey);
  // Ctrl/Meta/Alt chords must not insert literal text (e.g. Cmd+V). Shift alone
  // still types: Shift+a -> A, Shift+1 -> !, and Shift+Enter carries a newline.
  const shortcut = !!(mods.ctrlKey || mods.metaKey || mods.altKey);
  await cdp(tab.id, "Input.dispatchKeyEvent", {
    type: shortcut ? "rawKeyDown" : "keyDown", key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, nativeVirtualKeyCode: info.windowsVirtualKeyCode,
    text: shortcut ? "" : info.text, unmodifiedText: shortcut ? "" : info.text, modifiers: modBits,
  });
  await sleep(rng(25, 90));
  await cdp(tab.id, "Input.dispatchKeyEvent", {
    type: "keyUp", key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, modifiers: modBits,
  });
  for (const m of modOrder.reverse()) {
    await sleep(rng(5, 18));
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers: 0 });
  }
  return { input: "chrome", key: info.key, modifiers: mods };
}

// Read the actual focused editor, not a role=textbox lookalike. For fill, select
// the requested editor's entire contents: triple-click only selects a paragraph.
// Selection uses the DOM; deletion and insertion still use Chrome's input layer.
async function contentEditableInTab(tabId, selectAllParams = null) {
  const results = await executeScriptTimed({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: (selector, uid, selectAll) => {
      const active = document.activeElement;
      if (selectAll) {
        const state = window.__PI_CHROME_STATE__;
        const el = uid ? state?.elements?.[uid] : document.querySelector(selector);
        if (uid && (!el || !el.isConnected)) throw new Error(`snapshot uid ${uid} is stale; refresh chrome_snapshot`);
        if (!el?.isContentEditable) return false;
        if (!active?.isContentEditable || !(el === active || el.contains(active) || active.contains(el))) {
          throw new Error("chrome.fill: requested contenteditable is not focused");
        }
        const selection = window.getSelection();
        if (!selection) throw new Error("Could not select contenteditable contents");
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return active?.isContentEditable === true;
    },
    args: [selectAllParams?.selector ?? null, selectAllParams?.uid ?? null, selectAllParams !== null],
  }, `inspect contenteditable in tab ${tabId}`);
  return results?.[0]?.result === true;
}

async function typeTextInTab(tabId, text, perCharacter) {
  if (!text) return "none";
  if (!perCharacter && await contentEditableInTab(tabId)) {
    // One native edit avoids per-character delays and rich-editor render races.
    // Do not retry as keystrokes if insertion fails: it may already have applied.
    await cdp(tabId, "Input.insertText", { text });
    return "insertText";
  }
  for (const ch of Array.from(text)) await cdpTypeChar(tabId, ch);
  return "keys";
}

// Visibility gate for chromeInputType: reuses the predicate that snapshot_injected.js uses
// for chrome_snapshot (`countMatchesStable.__visible`) by injecting that helper script and
// calling `__piChromeCountMatchesStable` against the resolved element. Fast path uses the
// inline style samples returned by resolveTargetInTab; slow path schedules one rAF and
// re-checks once via the same predicate.
async function ensureTargetVisible(tabId, params) {
  const isPass = (s) => s
    && s.display !== "none"
    && s.visibility !== "hidden"
    && parseFloat(s.opacity || "1") > 0;
  // --- Fast path: rely on the style samples returned by resolveTargetInTab ---
  if (isPass(params && params.__style)) return { visible: true, fastPath: true };
  // --- Slow path: re-sample with a single rAF, then re-check via the snapshot predicate ---
  const awaitRaf = () => new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
  await awaitRaf();
  const results = await executeScriptTimed({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    files: ["snapshot_injected.js"],
    func: (uid, selector) => {
      const state = window.__PI_CHROME_STATE__;
      let el = uid && state && state.elements ? state.elements[uid] : null;
      if ((!el || !el.isConnected) && selector) el = document.querySelector(selector);
      if (!el) return { visible: false, staleUid: !!uid, reason: "element not found" };
      // Reuse the snapshot predicate by tagging the element with a unique attribute and
      // running __piChromeCountMatchesStable — its inline `visible` filter is the same
      // predicate used by chrome_snapshot, so we avoid inlining the logic here.
      const token = "__piChromeVisGate_" + Math.random().toString(36).slice(2, 10);
      el.setAttribute("data-" + token, "1");
      const sel = "[data-" + token + "=\"1\"]";
      const sample = window.__piChromeCountMatchesStable(sel, null, 0);
      el.removeAttribute("data-" + token);
      const style = getComputedStyle(el);
      return {
        visible: !!(sample && sample.count === 1),
        opacity: parseFloat(style.opacity || "1"),
        display: style.display,
        visibility: style.visibility,
      };
    },
    args: [params?.uid ?? null, params?.selector ?? null],
  }, `visibility gate for tab ${tabId}`);
  const v = results?.[0]?.result;
  if (!v || !v.visible) {
    const err = new Error("Target element is not visible (offsetParent null, display:none, visibility:hidden, or opacity 0); refresh chrome_snapshot");
    err.staleUid = params?.uid ?? null;
    err.reason = "invisible-target";
    throw err;
  }
  return { visible: true, fastPath: false, style: { opacity: v.opacity, display: v.display, visibility: v.visibility } };
}

async function chromeInputType(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  await attachDebugger(tab.id);
  if (params.selector || params.uid) {
    // Focus target by clicking it first.
    const resolved = await resolveTargetInTab(tab.id, params);
    // Pre-RAF visibility gate: bail before dispatching focus-by-click if the resolved
    // target is hidden by CSS. resolveTargetInTab returns the inline style samples
    // required for the fast path; the slow path schedules one rAF and re-checks via
    // the snapshot_injected.js predicate (no inline duplication).
    params.__style = {
      opacity: resolved.opacity,
      display: resolved.display,
      visibility: resolved.visibility,
    };
    await ensureTargetVisible(tab.id, params);
    const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
    await cdpMoveTo(tab.id, point.x, point.y);
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", force: 0.5 });
    await sleep(rng(45, 110));
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
    await sleep(rng(50, 120));
  }
  const text = String(params.text || "");
  const typing = await typeTextInTab(tab.id, text, params.perCharacter);
  if (params.pressEnter) await chromeInputKey({ ...params, targetId: tab.id, key: "Enter" });
  return { input: "chrome", length: text.length, typing };
}

async function domFillFallback(tabId, params, cause) {
  if (!(params.selector || params.uid)) throw cause;
  const results = await executeScriptTimed({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: async (selector, uid, text, submit) => {
      const state = window.__PI_CHROME_STATE__;
      let el = uid && state && state.elements ? state.elements[uid] : null;
      if (uid && (!el || !el.isConnected)) return { staleUid: true, reason: `snapshot uid ${uid} is stale; refresh chrome_snapshot`, url: location.href };
      if (!el && selector) el = document.querySelector(selector);
      if (!el) throw new Error(`DOM fallback target not found: ${uid || selector}`);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      if (typeof el.focus === "function") el.focus({ preventScroll: true });
      const value = String(text ?? "");
      if (!("value" in el) && !el.isContentEditable) {
        throw new Error(`DOM fallback target is not fillable: <${el.tagName.toLowerCase()}>`);
      }
      const compat = (() => {
        let isReact = false;
        for (const k of Object.keys(el)) {
          if (k.startsWith("__reactFiber$") || k.startsWith("__reactProps$") || k.startsWith("__reactInternalInstance$")) {
            isReact = true;
            break;
          }
        }
        if ("value" in el) {
          const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
          if (descriptor?.set) descriptor.set.call(el, value);
          else el.value = value;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { usedReact: isReact, valueMatches: el.value === value };
        } else if (el.isContentEditable) {
          el.textContent = value;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
          return { usedReact: isReact, valueMatches: el.textContent === value };
        }
        return { usedReact: false, valueMatches: false };
      })();
      if (submit) {
        const form = el.closest("form");
        if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
        else document.querySelector("button,[type=submit]")?.click();
      }
      return { valueMatches: compat.valueMatches, tag: el.tagName, url: location.href, usedReact: compat.usedReact };
    },
    args: [params.selector ?? null, params.uid ?? null, params.text ?? "", params.submit === true],
  }, `DOM fill fallback in tab ${tabId}`);
  const v = results?.[0]?.result;
  if (v?.staleUid) throw new Error(v.reason || "snapshot uid is stale; refresh chrome_snapshot");
  return { input: "dom-fallback", length: String(params.text || "").length, valueMatches: v?.valueMatches, usedReact: v?.usedReact === true, reason: String(cause?.message || cause).slice(0, 500), tag: v?.tag };
}

// page.setNativeValue: write the value via the React-aware path (detectReactControlled + reactCompatFill)
// only — no CDP key path, no focus/click preamble, no verify polling. Always uses the native value setter
// (works for both React-controlled and plain inputs/textareas/contenteditables) followed by input + change
// events in the shape React's synthetic event system listens for. Returns { ok, usedReact, valueMatches, tag }.
async function chromeInputSetNativeValue(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  if (!(params.selector || params.uid)) throw new Error("chrome.setNativeValue: selector or uid required");
  if (params.value === undefined || params.value === null) throw new Error("chrome.setNativeValue: value required");
  try {
    // Inline reactCompatFill: native value setter + input/change events. This always runs
    // through the React-safe path so the same call works for plain inputs and React-controlled ones.
    const fill = await executeScriptTimed({
      target: { tabId: tab.id, frameIds: [0] },
      world: "MAIN",
      func: (selector, uid, val) => {
        const state = window.__PI_CHROME_STATE__;
        let el = uid && state && state.elements ? state.elements[uid] : null;
        if (uid && (!el || !el.isConnected)) return { staleUid: true };
        if (!el && selector) el = document.querySelector(selector);
        if (!el) return { notFound: true };
        if (typeof el.focus === "function") el.focus({ preventScroll: true });
        // Inline detectReactControlled — page-world func cannot see service_worker helpers.
        let isReact = false;
        for (const k of Object.keys(el)) {
          if (k.startsWith("__reactFiber$") || k.startsWith("__reactProps$") || k.startsWith("__reactInternalInstance$")) {
            isReact = true;
            break;
          }
        }
        // Inline reactCompatFill: native value setter + input/change events for React.
        if ("value" in el) {
          const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
          if (descriptor?.set) descriptor.set.call(el, val);
          else el.value = val;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: val }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (el.isContentEditable) {
          el.textContent = val;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: val }));
        }
        const valueMatches = "value" in el ? el.value === val : el.textContent === val;
        return { usedReact: isReact, valueMatches, tag: el.tagName };
      },
      args: [params.selector ?? null, params.uid ?? null, String(params.value)],
    }, `setNativeValue react-compat fill in tab ${tab.id}`);
    const fr = fill?.[0]?.result || {};
    if (fr.staleUid) throw new Error("snapshot uid is stale; refresh chrome_snapshot");
    if (fr.notFound) throw new Error(`chrome.setNativeValue target not found: ${params.uid || params.selector}`);
    return { ok: true, usedReact: fr.usedReact === true, valueMatches: fr.valueMatches === true, tag: fr.tag };
  } catch (error) {
    if (params.domFallback === false) throw error;
    // Fallback path: mirror domFillFallback's plain-value branch (still via native setter, no key events).
    const fallback = await executeScriptTimed({
      target: { tabId: tab.id, frameIds: [0] },
      world: "MAIN",
      func: (selector, uid, val) => {
        const state = window.__PI_CHROME_STATE__;
        let el = uid && state && state.elements ? state.elements[uid] : null;
        if (uid && (!el || !el.isConnected)) return { staleUid: true };
        if (!el && selector) el = document.querySelector(selector);
        if (!el) throw new Error(`setNativeValue fallback target not found: ${uid || selector}`);
        if (typeof el.focus === "function") el.focus({ preventScroll: true });
        if ("value" in el) {
          el.value = val;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: val }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (el.isContentEditable) {
          el.textContent = val;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: val }));
        }
        return { usedReact: false, valueMatches: "value" in el ? el.value === val : el.textContent === val, tag: el.tagName };
      },
      args: [params.selector ?? null, params.uid ?? null, String(params.value)],
    }, `setNativeValue DOM fallback in tab ${tab.id}`);
    const fb = fallback?.[0]?.result || {};
    return { ok: true, usedReact: fb.usedReact === true, valueMatches: fb.valueMatches === true, tag: fb.tag, syntheticFallback: "dom-fallback" };
  }
}

// page.setValue: write the value directly via the React-aware path (detectReactControlled + reactCompatFill)
// OR via Chrome CDP key events when the element is not React-controlled. Unlike page.fill, this skips
// the focus/click/select-all preamble: callers are expected to have already focused the field (typically
// by clicking it). Optional verifyExpr polling re-applies the value when the probe stays falsy.
async function chromeInputSetValue(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  if (!(params.selector || params.uid)) throw new Error("chrome.setValue: selector or uid required");
  if (params.value === undefined || params.value === null) throw new Error("chrome.setValue: value required");
  const verifyRetriesRaw = typeof params.verifyRetries === "number" ? params.verifyRetries : 2;
  const verifyRetries = Math.max(0, Math.min(5, verifyRetriesRaw));
  const verifyAfterMs = typeof params.verifyAfterMs === "number" ? Math.max(0, Math.min(2000, params.verifyAfterMs)) : 0;
  const verifyExpr = params.verifyExpr;
  let attempt = 0;
  let lastResult = null;
  let staleUid = false;
  while (attempt <= verifyRetries) {
    try {
      await attachDebugger(tab.id);
      const resolved = await resolveTargetInTab(tab.id, params);
      const probe = await executeScriptTimed({
        target: { tabId: tab.id, frameIds: [0] },
        world: "MAIN",
        func: (selector, uid) => {
          const state = window.__PI_CHROME_STATE__;
          let el = uid && state && state.elements ? state.elements[uid] : null;
          if (uid && (!el || !el.isConnected)) return { staleUid: true };
          if (!el && selector) el = document.querySelector(selector);
          if (!el) return { notFound: true };
          // Inline detectReactControlled — executeScriptTimed's func runs in the page world and
          // cannot see service_worker helpers like detectReactControlled.
          let isReact = false;
          for (const k of Object.keys(el)) {
            if (k.startsWith("__reactFiber$") || k.startsWith("__reactProps$") || k.startsWith("__reactInternalInstance$")) {
              isReact = true;
              break;
            }
          }
          return { isReact, tag: el.tagName };
        },
        args: [params.selector ?? null, params.uid ?? null],
      }, `setValue react probe in tab ${tab.id}`);
      const probeResult = probe?.[0]?.result;
      if (probeResult?.staleUid) {
        staleUid = true;
        throw new Error("snapshot uid is stale; refresh chrome_snapshot");
      }
      if (probeResult?.notFound) throw new Error(`chrome.setValue target not found: ${params.uid || params.selector}`);
      const isReact = probeResult?.isReact === true;
      const tag = probeResult?.tag;
      let usedReact = false;
      let valueMatches = false;
      if (isReact) {
        // Inline reactCompatFill: native value setter + input/change events for React.
        const reactFill = await executeScriptTimed({
          target: { tabId: tab.id, frameIds: [0] },
          world: "MAIN",
          func: (selector, uid, val) => {
            const state = window.__PI_CHROME_STATE__;
            let el = uid && state && state.elements ? state.elements[uid] : null;
            if (!el && selector) el = document.querySelector(selector);
            if (!el) throw new Error(`reactCompatFill target not found: ${uid || selector}`);
            if (typeof el.focus === "function") el.focus({ preventScroll: true });
            const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
            if (descriptor?.set) descriptor.set.call(el, val);
            else el.value = val;
            el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: val }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { usedReact: true, valueMatches: el.value === val };
          },
          args: [params.selector ?? null, params.uid ?? null, String(params.value)],
        }, `setValue react-compat fill in tab ${tab.id}`);
        const fr = reactFill?.[0]?.result || {};
        usedReact = fr.usedReact === true;
        valueMatches = fr.valueMatches === true;
      } else {
        // Non-React path: native Input.dispatchKeyEvent flow mirroring chromeInputFill's tail.
        const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
        await cdpMoveTo(tab.id, point.x, point.y);
        // Triple-click selects all in input fields (matches chromeInputFill preamble).
        for (let i = 1; i <= 3; i++) {
          await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: i, pointerType: "mouse", force: 0.5 });
          await sleep(rng(20, 60));
          await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: i, pointerType: "mouse" });
          await sleep(rng(20, 60));
        }
        await contentEditableInTab(tab.id, params);
        await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
        await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
        await sleep(rng(20, 60));
        await typeTextInTab(tab.id, String(params.value), false);
        // Verify the typed value matches.
        const verify = await executeScriptTimed({
          target: { tabId: tab.id, frameIds: [0] },
          world: "MAIN",
          func: (selector, uid, val) => {
            const state = window.__PI_CHROME_STATE__;
            let el = uid && state && state.elements ? state.elements[uid] : null;
            if (!el && selector) el = document.querySelector(selector);
            if (!el) return { valueMatches: false, tag: null };
            return { valueMatches: el.value === val || el.textContent === val, tag: el.tagName };
          },
          args: [params.selector ?? null, params.uid ?? null, String(params.value)],
        }, `setValue non-react verify in tab ${tab.id}`);
        const vr = verify?.[0]?.result || {};
        usedReact = false;
        valueMatches = vr.valueMatches === true;
      }
      lastResult = { ok: true, usedReact, valueMatches, tag, input: isReact ? "react-compat" : "chrome", attempts: attempt + 1 };
      if (!verifyExpr || valueMatches) break;
      // Polling: wait verifyAfterMs, then re-probe via verifyExpr.
      if (verifyAfterMs > 0 && attempt < verifyRetries) {
        await sleep(Math.max(60, Math.min(verifyAfterMs, 250)));
        const probeVerify = await executeScriptTimed({
          target: { tabId: tab.id, frameIds: [0] },
          world: "MAIN",
          func: (expr) => {
            try {
              const looksLikeSelector = expr && !/[;{([]/.test(expr);
              if (looksLikeSelector) {
                const els = document.querySelectorAll(expr);
                return { ok: true, truthy: els.length > 0 };
              }
              // eslint-disable-next-line no-new-func
              const fn = new Function("return (" + expr + ");");
              return { ok: true, truthy: !!fn() };
            } catch (e) {
              return { ok: false, error: String(e && e.message || e) };
            }
          },
          args: [verifyExpr],
        }, `setValue verifyExpr probe in tab ${tab.id}`);
        const pvr = probeVerify?.[0]?.result;
        if (pvr?.truthy) break;
      } else if (attempt < verifyRetries) {
        await sleep(150);
      }
      attempt++;
      continue;
    } catch (error) {
      if (staleUid) throw error;
      if (params.domFallback === false) throw error;
      // Only fall back on transient attach/CDP failures; React/selector errors rethrow.
      const msg = String(error && error.message || error);
      if (!/Debugger is not attached|Target closed|No tab with id|Cannot access a chrome-extension/i.test(msg)) throw error;
      return withOptionalSnapshot(params, (p) => domSetValueFallback(tab.id, p, error));
    }
  }
  if (!lastResult) throw new Error("chrome.setValue failed without producing a result");
  if (verifyExpr && lastResult.valueMatches === false && attempt > verifyRetries) {
    lastResult.verified = false;
  }
  return lastResult;
}

async function domSetValueFallback(tabId, params, cause) {
  const results = await executeScriptTimed({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: (selector, uid, val) => {
      const state = window.__PI_CHROME_STATE__;
      let el = uid && state && state.elements ? state.elements[uid] : null;
      if (uid && (!el || !el.isConnected)) return { staleUid: true, reason: `snapshot uid ${uid} is stale; refresh chrome_snapshot`, url: location.href };
      if (!el && selector) el = document.querySelector(selector);
      if (!el) throw new Error(`setValue fallback target not found: ${uid || selector}`);
      if (typeof el.focus === "function") el.focus({ preventScroll: true });
      const isReact = (() => {
        for (const k of Object.keys(el)) {
          if (k.startsWith("__reactFiber$") || k.startsWith("__reactProps$") || k.startsWith("__reactInternalInstance$")) return true;
        }
        return false;
      })();
      if (isReact) {
        const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        if (descriptor?.set) descriptor.set.call(el, val);
        else el.value = val;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: val }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if ("value" in el) {
        el.value = val;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: val }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = val;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: val }));
      }
      return { ok: true, usedReact: isReact, valueMatches: ("value" in el ? el.value === val : el.textContent === val), tag: el.tagName };
    },
    args: [params.selector ?? null, params.uid ?? null, String(params.value ?? "")],
  }, `setValue DOM fallback in tab ${tabId}`);
  const r = results?.[0]?.result || {};
  return { input: "dom-fallback", ...r };
}

async function chromeInputFill(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  try {
    await attachDebugger(tab.id);
    if (!(params.selector || params.uid)) throw new Error("chrome.fill: selector or uid required");
    const resolved = await resolveTargetInTab(tab.id, params);
    const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
    await cdpMoveTo(tab.id, point.x, point.y);
    // Triple-click selects all in input fields.
    for (let i = 1; i <= 3; i++) {
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: i, pointerType: "mouse", force: 0.5 });
      await sleep(rng(20, 60));
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: i, pointerType: "mouse" });
      await sleep(rng(20, 60));
    }
    await contentEditableInTab(tab.id, params);
    // Detect React-controlled inputs BEFORE the proto setter path: CDP key events often
    // don't propagate to React's synthetic event system, leaving React state empty even
    // though the DOM shows the typed text. Route those targets through reactCompatFill
    // so React sees the native value setter + input/change events it expects.
    const reactProbe = await executeScriptTimed({
      target: { tabId: tab.id, frameIds: [0] },
      world: "MAIN",
      func: (selector, uid) => {
        const state = window.__PI_CHROME_STATE__;
        let el = uid && state && state.elements ? state.elements[uid] : null;
        if (uid && (!el || !el.isConnected)) return { staleUid: true };
        if (!el && selector) el = document.querySelector(selector);
        if (!el) return { notFound: true };
        // Inline React detection — executeScriptTimed's func runs in the page world and
        // cannot see service_worker helpers like detectReactControlled.
        let isReact = false;
        for (const k of Object.keys(el)) {
          if (k.startsWith("__reactFiber$") || k.startsWith("__reactProps$") || k.startsWith("__reactInternalInstance$")) {
            isReact = true;
            break;
          }
        }
        return { isReact, tag: el.tagName };
      },
      args: [params.selector ?? null, params.uid ?? null],
    }, `react probe in tab ${tab.id}`);
    const probe = reactProbe?.[0]?.result;
    if (probe?.staleUid) throw new Error("snapshot uid is stale; refresh chrome_snapshot");
    const text = String(params.text || "");
    if (probe?.isReact) {
      const fillResult = await executeScriptTimed({
        target: { tabId: tab.id, frameIds: [0] },
        world: "MAIN",
        func: (selector, uid, val) => {
          const state = window.__PI_CHROME_STATE__;
          let el = uid && state && state.elements ? state.elements[uid] : null;
          if (!el && selector) el = document.querySelector(selector);
          if (!el) throw new Error(`reactCompatFill target not found: ${uid || selector}`);
          if (typeof el.focus === "function") el.focus({ preventScroll: true });
          // Inline reactCompatFill: native value setter + input/change events for React.
          const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
          if (descriptor?.set) descriptor.set.call(el, val);
          else el.value = val;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: val }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { usedReact: true, valueMatches: el.value === val };
        },
        args: [params.selector ?? null, params.uid ?? null, text],
      }, `react-compat fill in tab ${tab.id}`);
      if (params.submit) await chromeInputKey({ ...params, targetId: tab.id, key: "Enter" });
      const fr = fillResult?.[0]?.result || {};
      return { input: "react-compat", length: text.length, usedReact: fr.usedReact === true, valueMatches: fr.valueMatches === true, tag: probe.tag };
    }
    // Delete selection.
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await sleep(rng(20, 60));
    const typing = await typeTextInTab(tab.id, text, params.perCharacter);
    if (params.submit) await chromeInputKey({ ...params, targetId: tab.id, key: "Enter" });
    return { input: "chrome", length: text.length, typing };
  } catch (error) {
    if (params.domFallback === false) throw error;
    return domFillFallback(tab.id, params, error);
  }
}

async function chromeInputScroll(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  await attachDebugger(tab.id);
  const resolved = (params.selector || params.uid) ? await resolveTargetInTab(tab.id, params) : { x: 100, y: 100, rect: null };
  const x = resolved.rect ? resolved.rect.left + Math.min(resolved.rect.width, 800) / 2 : resolved.x;
  const y = resolved.rect ? resolved.rect.top + Math.min(resolved.rect.height, 600) / 2 : resolved.y;
  const totalY = params.deltaY || 0, totalX = params.deltaX || 0;
  // Profile mimics a trackpad flick: short ramp-up (~15% of events), then geometric decay
  // with a ~12% drop per event. Gives momentum tail tests something to find, and the small
  // tail deltas (a handful of <20px events) put IntersectionObserver thresholds in range.
  const peak = Math.max(Math.abs(totalY), Math.abs(totalX));
  // Aim peak event ~22px so cumulative wheel approach to target seeds low-ratio IO samples.
  const PEAK_TARGET = 22;
  const w = [];
  // Build weights for an arbitrary n, then iterate to find an n where peak * (w_peak/sum) <= PEAK_TARGET.
  function build(n) {
    const arr = [];
    const peakIdx = Math.max(1, Math.floor(n * 0.15));
    for (let i = 0; i < n; i++) {
      if (i <= peakIdx) arr.push(0.5 + 0.5 * (i / peakIdx)); // 0.5 → 1.0
      else arr.push(Math.pow(0.88, i - peakIdx));            // ~12% drop per step
    }
    return arr;
  }
  let n = Math.max(12, params.steps || 24);
  for (let attempt = 0; attempt < 8; attempt++) {
    const arr = build(n);
    const s = arr.reduce((a, b) => a + b, 0);
    const peakStep = peak * (Math.max(...arr) / s);
    if (peakStep <= PEAK_TARGET || n >= 240) {
      w.length = 0;
      w.push(...arr);
      break;
    }
    n = Math.ceil(n * 1.4);
  }
  if (w.length === 0) w.push(...build(n));
  const sumW = w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) {
    const dy = totalY * (w[i] / sumW), dx = totalX * (w[i] / sumW);
    await cdp(tab.id, "Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX: dx, deltaY: dy, pointerType: "mouse",
    });
    // Sleep one+ frame so IntersectionObserver / rAF samples can run between events.
    await sleep(rng(22, 48));
  }
  return { input: "chrome", deltaX: totalX, deltaY: totalY, steps: n };
}

async function chromeInputTap(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  await attachDebugger(tab.id);
  const resolved = (params.selector || params.uid || (typeof params.x === "number" && typeof params.y === "number"))
    ? await resolveTargetInTab(tab.id, params)
    : null;
  if (!resolved || !resolved.found) throw new Error("chrome.tap: target not found");
  const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
  const tp = { x: point.x, y: point.y, radiusX: 8, radiusY: 8, rotationAngle: 0, force: 0.5, id: 1 };
  await cdp(tab.id, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [tp] });
  await sleep(rng(40, 110));
  await cdp(tab.id, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  return { input: "chrome", x: point.x, y: point.y, tag: resolved.tag };
}

async function chromeInputDrag(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  await attachDebugger(tab.id);
  const from = await resolveTargetInTab(tab.id, { selector: params.fromSelector ?? null, uid: params.fromUid ?? null, x: params.fromX ?? null, y: params.fromY ?? null });
  const to = await resolveTargetInTab(tab.id, { selector: params.toSelector ?? null, uid: params.toUid ?? null, x: params.toX ?? null, y: params.toY ?? null });
  const fp = from.rect ? pickInsideRect(from.rect) : { x: from.x, y: from.y };
  const tp = to.rect ? pickInsideRect(to.rect) : { x: to.x, y: to.y };
  await cdpMoveTo(tab.id, fp.x, fp.y);
  await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: fp.x, y: fp.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", force: 0.5 });
  await sleep(rng(60, 140));
  const steps = params.steps || 20;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 6;
    const x = fp.x + (tp.x - fp.x) * ease + rng(-wobble, wobble);
    const y = fp.y + (tp.y - fp.y) * ease + rng(-wobble, wobble);
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1, pointerType: "mouse" });
    await sleep(rng(10, 26));
  }
  await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: tp.x, y: tp.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
  return { input: "chrome", from: fp, to: tp, steps };
}

async function chromeInputUpload(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  await attachDebugger(tab.id);
  if (!(params.selector || params.uid)) throw new Error("chrome.upload: selector or uid required");
  const paths = Array.isArray(params.paths) ? params.paths.map(String) : [];
  if (!paths.length) throw new Error("chrome.upload: no file paths provided");
  const expression = `(() => {
    const selector = ${JSON.stringify(params.selector ?? null)};
    const uid = ${JSON.stringify(params.uid ?? null)};
    const state = window.__PI_CHROME_STATE__;
    const el = uid ? state?.elements?.[uid] : (selector ? document.querySelector(selector) : null);
    if (uid && (!el || !el.isConnected)) throw new Error("snapshot uid " + uid + " is stale; refresh chrome_snapshot");
    if (!el || el.tagName !== "INPUT" || el.type !== "file") throw new Error("Target must be <input type=file>");
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return el;
  })()`;
  const evaluated = await cdp(tab.id, "Runtime.evaluate", { expression, objectGroup: "pi-chrome-upload", includeCommandLineAPI: false, returnByValue: false });
  if (evaluated.exceptionDetails) throw new Error(cdpExceptionText(evaluated.exceptionDetails) || "Could not resolve file input");
  const objectId = evaluated.result?.objectId;
  if (!objectId) throw new Error("Could not resolve file input object");
  try {
    await cdp(tab.id, "DOM.enable", {}).catch(() => undefined);
    // Some DOM agents return nodeId:0 (or reject conversion) for a valid remote
    // element. CDP accepts that same objectId directly, before any file mutation.
    const requested = await cdp(tab.id, "DOM.requestNode", { objectId }).catch(() => null);
    const target = requested?.nodeId ? { nodeId: requested.nodeId } : { objectId };
    await cdp(tab.id, "DOM.setFileInputFiles", { ...target, files: paths });
    await cdp(tab.id, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() { this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); return this.files ? this.files.length : 0; }`,
      returnByValue: true,
    }).catch(() => undefined);
  } finally {
    await cdp(tab.id, "Runtime.releaseObject", { objectId }).catch(() => undefined);
  }
  return { input: "chrome", uploaded: paths.map((path) => ({ path })) };
}
// ===============================================================


function armKeepaliveAlarm() {
  chrome.alarms.create("pi-bridge-keepalive", { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => {
  armKeepaliveAlarm();
  void pollLoop();
});

chrome.runtime.onStartup.addListener(() => {
  armKeepaliveAlarm();
  void pollLoop();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pi-bridge-keepalive") void pollLoop();
  else if (alarm.name === RECONNECT_ALARM_NAME) void processReconnectBackoffs();
});

// Note: chrome.action.onClicked is intentionally NOT registered. The toolbar action opens the
// popup (manifest action.default_popup) — the popup shows live status and a Doctor link.

armKeepaliveAlarm();

setInterval(() => {
  void pollLoop();
}, 1000);

// Watchdog: every tick, run a fresh bridge probe and reconcile the connection state
// against ground truth. We trust the probe result and the last /next success timestamp
// together, but we run unconditionally — never short-circuit on the current state — so
// the badge can recover from "offline" once the bridge comes back.
//   - connected when the bridge is reachable (covers both fresh /next and idle periods)
//   - offline only when probe failed AND no recent /next success within the window
// The hybrid state (bridge reachable but no recent poll, OR bridge down but poll is
// fresh) is intentionally left alone so the next /next tick resolves it without
// flickering the toolbar LED on every idle window.
const OFFLINE_AFTER_MS = 8_000;
setInterval(() => {
  // Trigger a fresh probe so the watchdog decision is based on ground truth, not a stale
  // cache. We do NOT await — run the probe in parallel with the timestamp check.
  probeBridge().then((probe) => {
    const bridgeReachable = probe && probe.ok;
    const recentlyPolled = lastBridgeSuccessAt && (Date.now() - lastBridgeSuccessAt) <= OFFLINE_AFTER_MS;
    if (bridgeReachable) {
      lastBridgeError = "";
      setConnectionState("connected");
    } else if (!recentlyPolled) {
      lastBridgeError = `bridge unreachable · ${probe?.error || "no recent /next success"}`;
      setConnectionState("offline");
    }
    // else: bridge down but /next is still fresh — leave the state alone, the next
    // /next tick will resolve it.
  });
}, 2_000);

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    while (true) {
      let response;
      try {
        response = await fetch(`${BRIDGE_URL}/next?name=${encodeURIComponent(CLIENT_NAME)}`, { cache: "no-store" });
      } catch (err) {
        lastBridgeError = err?.message || String(err);
        // Watchdog will flip to offline; await below still backs off.
        await sleep(POLL_ERROR_BACKOFF_MS);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        lastBridgeError = `bridge returned HTTP ${response.status}`;
        lastBridgeAuthAt = Date.now();
        setConnectionState("authorized");
        await sleep(POLL_ERROR_BACKOFF_MS);
        continue;
      }
      if (!response.ok) throw new Error(`bridge /next HTTP ${response.status}`);
      const expected = response.headers.get("x-pi-chrome-version");
      const ours = chrome.runtime.getManifest().version;
      if (expected && expected !== ours && isVersionOlder(ours, expected)) {
        console.warn(`[pi-chrome] extension v${ours} behind pi-chrome v${expected}; reloading extension`);
        try { chrome.runtime.reload(); } catch {}
        return;
      }
      const payload = await response.json();
      lastBridgeSuccessAt = Date.now();
      lastBridgeError = "";
      setConnectionState("connected");
      if (payload.type === "command") await handleCommand(payload.command);
    }
  } catch (error) {
    await sleep(POLL_ERROR_BACKOFF_MS);
  } finally {
    polling = false;
  }
}

async function handleCommand(command) {
  try {
    const result = await withTimeout(
      dispatch(command.action, command.params ?? {}),
      COMMAND_TIMEOUT_MS,
      command.action || "Chrome command",
      () => detachAll(),
    );
    await postResult({ id: command.id, ok: true, result });
  } catch (error) {
    await postResult({ id: command.id, ok: false, error: error?.message ?? String(error) });
  }
}

async function postResult(result) {
  await fetch(`${BRIDGE_URL}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  });
}

function isVersionOlder(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

function cleanGroupTitle(value) {
  const text = String(value || "Pi").replace(/\s+/g, " ").trim().slice(0, 80);
  return text || "Pi";
}

function cleanGroupColor(value) {
  const color = String(value || DEFAULT_GROUP_COLOR).toLowerCase();
  return VALID_GROUP_COLORS.has(color) ? color : DEFAULT_GROUP_COLOR;
}

async function groupRecord(groupId) {
  if (typeof groupId !== "number" || groupId < 0 || !chrome.tabGroups) return null;
  const group = await chrome.tabGroups.get(groupId).catch(() => null);
  if (!group) return null;
  return {
    id: group.id,
    title: group.title || "",
    color: group.color || "",
    collapsed: Boolean(group.collapsed),
    windowId: group.windowId,
    piGroup: Boolean(group.title && PI_GROUP_RE.test(group.title)),
  };
}

// Find existing tab groups whose title matches `title` (case-insensitive).
// Same-window lookup is used when grouping an already-created tab. Any-window lookup is used before
// creating a new Pi tab so one Pi session keeps one tab group and new tabs are created in that
// group's window (Chrome tab groups cannot span windows).
async function findGroupByTitle(windowId, title) {
  if (!chrome.tabGroups) return null;
  const wanted = cleanGroupTitle(title).toLowerCase();
  const groups = await chrome.tabGroups.query({ windowId }).catch(() => []);
  const match = groups.find((g) => (g.title || "").trim().toLowerCase() === wanted);
  return match ? match.id : null;
}

async function findGroupRecordByTitle(title) {
  if (!chrome.tabGroups) return null;
  const wanted = cleanGroupTitle(title).toLowerCase();
  const groups = await chrome.tabGroups.query({}).catch(() => []);
  return groups.find((g) => (g.title || "").trim().toLowerCase() === wanted) || null;
}

// Add `tab` to a tab group, then set title/color. If the tab is ungrouped, reuse an
// existing same-title group in its window when present, otherwise create a new group.
async function groupTab(tab, title, color) {
  if (!chrome.tabGroups) throw new Error("chrome.tabGroups API unavailable; reload the extension after granting the tabGroups permission");
  if (!tab || typeof tab.id !== "number") throw new Error("No tab to group");
  const groupTitle = cleanGroupTitle(title);
  let groupId = tab.groupId;
  if (typeof groupId !== "number" || groupId < 0) {
    const existing = await findGroupByTitle(tab.windowId, groupTitle);
    groupId = existing !== null
      ? await chrome.tabs.group({ groupId: existing, tabIds: [tab.id] })
      : await chrome.tabs.group({ tabIds: [tab.id] });
  }
  await chrome.tabGroups.update(groupId, { title: groupTitle, color: cleanGroupColor(color), collapsed: false });
  const grouped = await chrome.tabs.get(tab.id);
  return { tab: await formatTab(grouped), group: await groupRecord(groupId) };
}

// =================== credentials.fill (worker) ===================
// Type one field of a saved credential into the active tab. The Node side calls this twice
// per fill: once with step=username, then once with step=password. Each call:
//   1. Resolves the target tab by explicit targetId or urlIncludes. credentials.fill MUST
//      NEVER fall back to creating a fresh automation target — we need a real URL to read
//      for the cross-host guard.
//   2. Re-checks (tab URL hostname) === params.host. The Node side already checked before
//      sending; the worker defends against tabs that navigated mid-flight.
//   3. Re-checks for MFA / CAPTCHA on the first step (username). The Node side already
//      probed, but the worker re-probes so the second wire call (password) only runs into
//      a tab that is still clean.
//   4. Routes through chromeInputType (CDP path) — never chrome_set_native_value. Typing is
//      the safe path here because the form is mid-flow and the value should look like real
//      keystrokes to whatever password manager / autofill detector the page is using.
async function credentialsFillInTab(params) {
  const step = params && typeof params.step === "string" ? params.step : "";
  const host = params && typeof params.host === "string" ? params.host.toLowerCase() : "";
  const value = params && typeof params.value === "string" ? params.value : "";
  const targetId = params && params.targetId !== undefined ? Number(params.targetId) : undefined;
  if (step !== "username" && step !== "password") {
    throw new Error(`credentials.fill: step must be 'username' or 'password' (got '${step}')`);
  }
  if (!host) throw new Error("credentials.fill: host is required");
  if (!value) throw new Error("credentials.fill: value is required");

  // Resolve the tab by explicit targetId or urlIncludes. credentials.fill must NEVER fall back
  // to creating a fresh automation target — we need a real URL to validate the host guard.
  let tab;
  if (targetId !== undefined && !Number.isNaN(targetId)) {
    tab = await chrome.tabs.get(targetId).catch(() => null);
  } else if (params.urlIncludes) {
    const tabs = await chrome.tabs.query({});
    tab = tabs.find((t) => (t.url || "").includes(params.urlIncludes)) || null;
  }
  if (!tab || typeof tab.id !== "number") {
    throw new Error("credentials.fill: target tab not found; pass targetId or urlIncludes explicitly");
  }

  // Cross-host guard (re-checked on the worker side). A stale URL between Node probe and our
  // dispatch would otherwise let the password leak to whatever the user navigated to.
  const currentHost = (() => {
    try { return new URL(tab.url || "").hostname.toLowerCase(); } catch { return ""; }
  })();
  if (currentHost !== host) {
    throw new Error(`credentials.fill: cross-host guard — expected host '${host}', active tab is '${currentHost || "(none)"}'`);
  }

  // MFA / CAPTCHA re-check on the first step. If a 2FA prompt appeared between the Node probe
  // and now, bail before typing anything; never type the password into a post-MFA page.
  if (step === "username") {
    const probe = await executeInTab({ targetId: tab.id, background: false }, probeLoginChallenges, []);
    if (probe && probe.hasTotpField) {
      throw new Error("credentials.fill: detected a TOTP/2FA field on the page; refusing to auto-fill. Ask the user to complete 2FA manually.");
    }
    if (probe && probe.captchaIframes > 0) {
      throw new Error("credentials.fill: detected a CAPTCHA iframe (hCaptcha/reCAPTCHA); refusing to auto-fill. Ask the user to solve the challenge.");
    }
  }

  // Drive chromeInputType directly. We pass the value as `text` and the optional uid/selector
  // through verbatim; chromeInputType already does the focus-by-click + CDP key dispatch path.
  const typeParams = {
    targetId: tab.id,
    text: value,
    background: false,
    ...(params.uid ? { uid: String(params.uid) } : {}),
    ...(params.selector ? { selector: String(params.selector) } : {}),
  };
  const typing = await chromeInputType(typeParams);
  return { ok: true, step, host, valueLength: value.length, typing };
}

// Helper for credentials.fill: detect login challenges the Node side has to short-circuit on.
// Run in MAIN world via executeInTab. Kept tiny so the worker can serialize it by toString().
function probeLoginChallenges() {
  const totpHints = ["totp", "2fa", "mfa", "verification", "authenticator", "otp", "one-time"];
  const hasTotpField = Array.from(document.querySelectorAll("input")).some((el) => {
    if (!el || el.type === "hidden") return false;
    const blob = [
      el.id || "", el.name || "", el.autocomplete || "", el.placeholder || "",
      (el.getAttribute("aria-label") || ""), (el.getAttribute("data-testid") || ""),
    ].join(" ").toLowerCase();
    return totpHints.some((hint) => blob.includes(hint));
  });
  const captchaIframes = Array.from(document.querySelectorAll("iframe")).filter((f) => {
    const src = (f.src || "").toLowerCase();
    return /hcaptcha|recaptcha/.test(src);
  }).length;
  return { hasTotpField, captchaIframes };
}

async function dispatch(action, params) {
  switch (action) {
    case "tab.version":
      return {
        extensionId: chrome.runtime.id,
        extensionVersion: chrome.runtime.getManifest().version,
        bridgeUrl: BRIDGE_URL,
        userAgent: navigator.userAgent,
        capabilities: { hardBackground: true, health: true },
      };
    case "tab.list": {
      const tabs = await chrome.tabs.query({});
      return Promise.all(tabs.map(formatTab));
    }
    case "tab.new.background":
    case "page.screenshot.background":
      // Older workers reject these action names before touching tabs. Do not replace this with
      // a capability probe followed by an old action: a reload/profile change can race the probe.
      return dispatch(action.slice(0, -".background".length), { ...params, background: true, foreground: false });
    case "tab.new": {
      // Every Pi-opened tab must join a tab group. There is intentionally no opt-out: an ungrouped
      // Pi-created tab is easy to lose among user tabs. If grouping fails after creation, close the
      // tab best-effort before surfacing the error so tab.new never leaves an ungrouped Pi tab.
      const groupTitle = params.groupTitle || "Pi";
      const existingGroup = await findGroupRecordByTitle(groupTitle);
      const createParams = { url: params.url || "about:blank", active: foregroundRequested(params) };
      if (existingGroup && typeof existingGroup.windowId === "number") createParams.windowId = existingGroup.windowId;
      const tab = await chrome.tabs.create(createParams);
      await trackSessionTab(sessionKeyOf(params), tab.id, true);
      try {
        await bringToFront(tab, params);
        return await groupTab(tab, groupTitle, params.groupColor);
      } catch (error) {
        if (typeof tab.id === "number") await chrome.tabs.remove(tab.id).catch(() => {});
        throw error;
      }
    }
    case "tab.activate": {
      if (!foregroundRequested(params)) {
        throw new Error("Tab activation is blocked by background mode. Ask the user to run /chrome background off to allow foreground work.");
      }
      // Management actions never auto-create an automation target (createOwnedTarget:false): with
      // no explicit target they act on an owned target if one exists, else error — they must never
      // fall back to (or spawn a tab just to touch) the user's active tab.
      const tab = await getTabByParams(params, { createOwnedTarget: false });
      return formatTab(await bringToFront(tab, params));
    }
    case "tab.group": {
      const tab = await getTabByParams(params, { createOwnedTarget: false });
      const grouped = await groupTab(tab, params.groupTitle || "Pi", params.groupColor);
      if (!(tab.groupId >= 0)) await trackSessionTab(sessionKeyOf(params), tab.id, false, grouped.group?.id);
      return grouped;
    }
    case "tab.ungroup": {
      const tab = await getTabByParams(params, { createOwnedTarget: false });
      if (typeof tab.groupId === "number" && tab.groupId >= 0) await chrome.tabs.ungroup(tab.id);
      return formatTab(await chrome.tabs.get(tab.id));
    }
    case "tab.close": {
      const tab = await getTabByParams(params, { createOwnedTarget: false });
      await chrome.tabs.remove(tab.id);
      return { closed: tab.id };
    }
    case "page.snapshot":
      return snapshotInTab(params);
    case "page.inspect":
      return inspectInTab(params);
    case "page.evaluate":
      return evaluateInTab(params);
    case "page.click.retry":
      return withOptionalSnapshot(params, chromeInputClickRetry);
    case "page.click":
      return withOptionalSnapshot(params, chromeInputClick);
    case "page.hover":
      return chromeInputHover(params);
    case "page.drag":
      return chromeInputDrag(params);
    case "page.upload":
      return chromeInputUpload(params);
    case "page.type":
      return withOptionalSnapshot(params, chromeInputType);
    case "page.setValue":
      return withOptionalSnapshot(params, chromeInputSetValue);
    case "page.setNativeValue":
      return withOptionalSnapshot(params, chromeInputSetNativeValue);
    case "page.sessionCheck":
      return withOptionalSnapshot(params, probeSessionInTab);
    case "page.fill":
      return withOptionalSnapshot(params, chromeInputFill);
    case "page.key":
      return withOptionalSnapshot(params, chromeInputKey);
    case "page.scroll":
      return chromeInputScroll(params);
    case "page.tap":
      return chromeInputTap(params);
    case "input.status":
      return inputStatus();
    case "input.debug":
      return inputDebug(params);
    case "page.console.list":
      return executeInTab(params, listConsoleMessages, [params.clear === true]);
    case "page.network.list":
      return executeInTab(params, listNetworkRequests, [params.includePreservedRequests === true, params.clear === true]);
    case "page.network.get":
      return executeInTab(params, getNetworkRequest, [params.requestId]);
    case "page.waitFor": {
      // Poll from the service worker via CDP (bypasses CSP). State machine:
      //   1. Resolve selector/expression each iteration.
      //   2. If selector: filter by visibility (offsetParent != null && opacity > 0 &&
      //      display != 'none' && visibility != 'hidden').
      //   3. Apply waitForSelectorCount floor (default 1).
      //   4. If waitForStable > 0: after first visible match, snapshot rect+opacity across
      //      2 RAFs + waitForStable ms; require equality before reporting found.
      // Returns { found, elapsedMs, polls, stableFor?, visibleAt?, matchCount? }.
      const tab = await getTabByParams(params);
      await bringToFront(tab, params);
      const timeoutMs = params.timeoutMs || 10000;
      const intervalMs = params.intervalMs || 250;
      const waitForVisible = params.waitForVisible !== false;
      const waitForStable = params.waitForStable || 0;
      const waitForSelectorCount = params.waitForSelectorCount || 1;
      const started = Date.now();
      let polls = 0;
      let visibleAt = 0;
      let lastMatchCount = 0;

      // Build a CSP-safe async expression. Each call returns one of:
      //   - kind=selector: { count, stable } after visibility/stability filtering
      //   - kind=expression: true/false truthiness
      // The expression avoids eval/new Function; only DOM + Promise APIs are used.
      const buildSelectorProbe = (selector) => `(async () => {
        const __sel = ${JSON.stringify(selector)};
        const __requireVisible = ${waitForVisible};
        const __requireStable = ${waitForStable};
        const __raf = (cb) => (typeof requestAnimationFrame === "function"
          ? new Promise((r) => requestAnimationFrame(() => r()))
          : new Promise((r) => setTimeout(r, 16))).then(cb);
        const __visible = (el) => {
          if (!el) return false;
          if (el.offsetParent === null) return false;
          const s = getComputedStyle(el);
          if (s.visibility === "hidden" || s.display === "none") return false;
          if (parseFloat(s.opacity || "1") <= 0) return false;
          return true;
        };
        const __sample = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return { l: Math.round(r.left*100)/100, t: Math.round(r.top*100)/100,
                   w: Math.round(r.width*100)/100, h: Math.round(r.height*100)/100,
                   o: s.opacity, v: s.visibility, d: s.display };
        };
        const all = Array.from(document.querySelectorAll(__sel));
        const matches = __requireVisible ? all.filter(__visible) : all;
        if (matches.length === 0) return { count: 0, stable: false };
        if (__requireStable <= 0) return { count: matches.length, stable: true };
        const a = __sample(matches[0]);
        await __raf(() => undefined);
        const b = __sample(matches[0]);
        await __raf(() => undefined);
        const c = __sample(matches[0]);
        await new Promise((r) => setTimeout(r, __requireStable));
        const d = __sample(matches[0]);
        const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
        return { count: matches.length, stable: eq(a,b) && eq(b,c) && eq(c,d) };
      })()`;

      const buildExpressionProbe = (value) => `(async () => Boolean((${value})))()`;

      while (Date.now() - started < timeoutMs) {
        polls++;
        try {
          const probe = params.kind === "selector"
            ? buildSelectorProbe(params.value)
            : buildExpressionProbe(params.value);
          const result = await evaluateInTab({ ...params, expression: probe, foreground: false });
          if (params.kind === "selector") {
            const r = (result && typeof result === "object") ? result : { count: 0, stable: false };
            lastMatchCount = r.count || 0;
            if (r.count >= waitForSelectorCount && r.stable) {
              if (!visibleAt) visibleAt = Date.now() - started;
              return {
                found: true,
                elapsedMs: Date.now() - started,
                polls,
                stableFor: waitForStable > 0 ? waitForStable : undefined,
                visibleAt: waitForStable > 0 ? visibleAt : undefined,
                matchCount: lastMatchCount,
              };
            }
          } else {
            if (result) {
              return { found: true, elapsedMs: Date.now() - started, polls };
            }
          }
        } catch {
          // Swallow per-poll errors; keep polling until timeout.
        }
        // Throttle polling — never run a tight loop; an absent sleep would burn CPU
        // and saturate the bridge with evaluateInTab calls.
        await sleep(intervalMs);
      }
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${params.kind}: ${params.value} (polls=${polls}, matchCount=${lastMatchCount})`);
    }
    case "page.probe":
      // Lightweight capability probe for /chrome-doctor. Runs in MAIN world.
      return executeInTab(params, probePage, []);
    case "page.navigate": {
      const tab = await getTabByParams(params);
      await bringToFront(tab, params);
      if (params.initScript) {
        // Register a one-shot document_start content script. We register, navigate, wait, then unregister.
        await registerInitScript(tab.id, params.initScript);
      }
      const wait = params.waitUntilLoad !== false ? waitForTabComplete(tab.id, params.timeoutMs || 15000) : Promise.resolve(undefined);
      const updated = await chrome.tabs.update(tab.id, { url: params.url });
      try {
        await wait;
      } finally {
        if (params.initScript) await unregisterInitScript(tab.id).catch(() => undefined);
      }
      return await formatTab(await chrome.tabs.get(updated.id));
    }
    case "page.screenshot":
      return takeScreenshot(params);
    case "automation.status": {
      // Report this session's owned automation target (ids only). Used for diagnostics/tests.
      await hydrateAutomationTargets();
      const t = automationTargets.get(sessionKeyOf(params));
      return { windowId: t?.windowId ?? null, tabId: t?.tabId ?? null };
    }
    case "automation.cleanup":
      // Close recorded creations, and only ungroup user tabs still in their adopted group.
      // Group titles are not ownership evidence.
      return cleanupSessionTabs(sessionKeyOf(params));
    case "credentials.fill":
      // Node-side helper that types a single value (username or password) into a login
      // form via chromeInputType. The Node side has already validated the alias host,
      // decrypted the credential, and detected MFA/CAPTCHA — we re-check the hostname
      // here as a defense-in-depth so a stale wire call can't fill on a tab the user
      // navigated since the Node call began. Two separate wire calls (step=username,
      // step=password) split one logical fill into two safe per-field dispatches.
      return credentialsFillInTab(params);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function formatTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    highlighted: tab.highlighted,
    title: tab.title || "",
    url: tab.url || "",
    status: tab.status,
    pinned: tab.pinned,
    incognito: tab.incognito,
    groupId: typeof tab.groupId === "number" ? tab.groupId : -1,
    group: await groupRecord(tab.groupId),
  };
}

// Resolve which Chrome tab an action targets.
//
// Explicit targeting (targetId / urlIncludes / titleIncludes) is unchanged: callers can still act
// on any existing tab, including a user tab, when they ask for it by name. Only the implicit
// "no target given" case changed — it used to grab the user's *active* tab (and page.navigate
// would then overwrite it); it now resolves to this Pi session's dedicated automation target.
//
// `createOwnedTarget` controls the implicit case:
//   - true  (default): create the automation target on first use. Used by every page/content
//     action — page.navigate, click/type/fill/key/hover/drag/scroll/tap/upload, snapshot,
//     inspect, evaluate, screenshot, waitFor, console/network list, probe. These need a live
//     surface to drive, so auto-creating is correct and they no longer touch the user's tab.
//   - false: do NOT create. Used by tab.activate/close/group/ungroup (tab *management*): with no
//     explicit target they operate on an already-owned automation target if one exists, else
//     throw asking for an explicit target — so e.g. `chrome_tab close` can never silently close
//     the user's active tab the way it used to, and never spawns a throwaway tab just to close it.
async function getTabByParams(params, { createOwnedTarget = true } = {}) {
  const tabs = await chrome.tabs.query({});
  let tab;
  if (params.targetId !== undefined) {
    const id = Number(params.targetId);
    tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab?.id) {
      // Chrome tab ids are not stable across reloads/navigations; a long session can hold a
      // stale id. Surface the current tabs so the caller can re-target instead of guessing.
      const listed = tabs
        .filter((candidate) => candidate.id !== undefined)
        .slice(0, 20)
        .map((candidate) => `  ${candidate.id}${candidate.active ? " *" : ""}\t${(candidate.title || "(untitled)").slice(0, 60)}\t${candidate.url || ""}`)
        .join("\n");
      throw new Error(
        `No Chrome tab with id ${id} (it was likely closed or replaced). ` +
        `Re-target with chrome_tab list, or pass urlIncludes/titleIncludes instead of targetId.\n` +
        `Current tabs:\n${listed || "  (none)"}`,
      );
    }
  } else if (params.urlIncludes) {
    tab = tabs.find((candidate) => (candidate.url || "").includes(params.urlIncludes));
  } else if (params.titleIncludes) {
    tab = tabs.find((candidate) => (candidate.title || "").includes(params.titleIncludes));
  } else {
    // No explicit target: use this session's dedicated automation target instead of hijacking the
    // user's active tab. This keeps human browsing and Pi automation separated — navigating here
    // never replaces whatever the user currently has open. Callers that *want* a specific
    // existing tab pass targetId/urlIncludes/titleIncludes above.
    const sessionKey = sessionKeyOf(params);
    tab = createOwnedTarget
      ? await getOrCreateAutomationTarget(sessionKey, params.sessionGroupTitle)
      : await resolveOwnedAutomationTarget(sessionKey);
    if (!tab) {
      throw new Error(
        "No target tab specified and this Pi session has no automation tab yet. " +
        "Pass targetId/urlIncludes/titleIncludes, or run chrome_navigate first.",
      );
    }
  }
	const url = tab.url || "";
	if (url.startsWith("about:") || url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("devtools://") || url.startsWith("edge://")) {
		throw new Error(`Chrome blocks extension automation on protected URL: tab=${tab.id} url=${url}. Navigate the tab to an http(s) URL and retry.`);
	}
  // Tabs Pi interacts with (page.* actions) join this session's group so the user can see exactly
  // which tabs Pi is driving. We only adopt *ungrouped* tabs — never hijack a tab the user (or
  // another Pi session) already grouped, since groupTab would otherwise rename that group.
  if (params.joinSessionGroup && params.sessionGroupTitle) {
    await joinSessionGroup(tab, params.sessionGroupTitle, sessionKeyOf(params));
  }
  return tab;
}

// Add an ungrouped tab to the session's tab group (reusing it by title, else creating it).
// No-op when the tab is already grouped or tabGroups is unavailable.
async function joinSessionGroup(tab, title, sessionKey) {
  if (!chrome.tabGroups || typeof tab.id !== "number") return;
  if (typeof tab.groupId === "number" && tab.groupId >= 0) return;
  try {
    const grouped = await groupTab(tab, title);
    await trackSessionTab(sessionKey, tab.id, false, grouped.group?.id);
  } catch {
    // Grouping is best-effort; never block the actual page action on a grouping failure.
  }
}

// Helper sources that get concatenated into the injected MAIN-world script. Kept as separate
// functions so callers below can reference them by `.toString()`. The helpers do not perform any
// eval themselves — they're plain function declarations.
const HELPER_FUNCS = [
  getPiChromeState,
  rememberElement,
  elementBySelectorOrUid,
  installPiChromeInstrumentation,
  resolvePoint,
  dispatchInputEvents,
  setNativeValue,
  normalizeKey,
  isElementVisible,
  occluderAt,
  pageHash,
  pointerEventSequence,
  sleepPage,
  rand,
  dispatchPointerLikeEvent,
  humanMoveTo,
  humanClickPoint,
  usKeyLayoutForChar,
  printableKeyCode,
  dispatchKeyEvent,
  typeCharacter,
  pressKeyInPage,
  scrollPage,
];

async function executeInTab(params, func, args) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);

  // Phase 1: define the helpers and the action function as page globals via CDP
  // Runtime.evaluate. This bypasses page CSP (no `eval`/`new Function`), which is the
  // root cause of snapshot/click/etc silently failing on `script-src 'self'` sites.
  // Each helper is a named function declaration, assigned to window.<name> so the action
  // (which references helpers by bare name) resolves them as globals at call time.
  const assignments = HELPER_FUNCS.map((helper) => `window.${helper.name}=${helper.toString()}`).join(";\n");
  const actionAssign = `window.__piAction=(${func.toString()})`;
  const defineRes = await cdpEval(tab.id, `(()=>{${assignments};\n${actionAssign};})()`);
  if (defineRes.exceptionDetails) {
    throw new Error(`Failed to inject Chrome page helpers: ${cdpExceptionText(defineRes.exceptionDetails) || "unknown error"}`);
  }

  // Phase 2: run the action via chrome.scripting.executeScript. The `func:` form is
  // injected by Chrome itself (not `new Function`), so it is CSP-safe, and it lets Chrome
  // serialize the invocation args. The wrapper references window.__piAction defined above.
  const results = await executeScriptTimed({
    target: { tabId: tab.id },
    world: "MAIN",
    func: async (invocationArgs) => {
      try {
        return { ok: true, value: await window.__piAction(...invocationArgs) };
      } catch (error) {
        return { ok: false, error: error?.stack || error?.message || String(error) };
      }
    },
    args: [args || []],
  }, `execute page action in tab ${tab.id}`);
  const first = results?.[0];
  if (first?.error) {
    const message = typeof first.error === "string" ? first.error : (first.error.message || JSON.stringify(first.error));
    throw new Error(message);
  }
  const envelope = first?.result;
  if (envelope && typeof envelope === "object" && envelope.ok === false) {
    throw new Error(envelope.error || "Chrome page script failed");
  }
  return envelope?.value;
}

// Serializer for page.evaluate results. Embedded (via .toString()) into the CDP-evaluated
// expression so we can return rich markers for values that don't survive returnByValue
// (undefined/function/symbol/bigint/Error), plus expand DOMRect-like objects whose fields
// are non-enumerable. Kept as a standalone function so it stays editable/lintable.
function piEvalStringify(v) {
  if (v === undefined) return { kind: "undefined" };
  if (typeof v === "function") return { kind: "function", source: v.toString().slice(0, 500) };
  if (typeof v === "symbol") return { kind: "symbol", description: v.description };
  if (typeof v === "bigint") return { kind: "bigint", value: v.toString() };
  if (v instanceof Error) return { kind: "error", name: v.name, message: v.message, stack: v.stack };
  // DOMRect/DOMRectReadOnly (and getBoundingClientRect results) have non-enumerable
  // properties, so JSON.stringify yields `{}`. Expand the fields explicitly.
  if ((typeof DOMRectReadOnly !== "undefined" && v instanceof DOMRectReadOnly) ||
      (typeof DOMRect !== "undefined" && v instanceof DOMRect) ||
      (v && typeof v === "object" && typeof v.toJSON === "function" &&
       typeof v.width === "number" && typeof v.height === "number" && typeof v.top === "number")) {
    return { x: v.x, y: v.y, width: v.width, height: v.height, top: v.top, right: v.right, bottom: v.bottom, left: v.left };
  }
  return v;
}

// Dedicated executor for page.evaluate. Uses CDP Runtime.evaluate (via cdpEval) which is not
// subject to the page's CSP, fixing `chrome_evaluate` silently returning null / failing on
// pages that ship `script-src 'self'` without `'unsafe-eval'` (which blocks `eval`/`new Function`).
async function evaluateInTab(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  const expression = String(params.expression ?? "");
  const stringifySrc = `(${piEvalStringify.toString()})`;
  // Wrap the user expression so the result is run through piEvalStringify in-page before it
  // crosses the returnByValue boundary. Try expression form first (so `1+1` / `document.title`
  // work without `return`); on a SyntaxError fall back to statement form for multi-statement
  // bodies (loops, var decls, etc), matching the previous new Function() two-form behavior.
  const buildWrapper = (form) => `(async () => { const __s=${stringifySrc}; const __v = await ${form}; return __s(__v); })()`;
  const exprForm = `(async () => (${expression}))()`;
  const stmtForm = `(async () => { ${expression} })()`;

  let res = await cdpEval(tab.id, buildWrapper(exprForm));
  if (res.exceptionDetails && cdpIsSyntaxError(res.exceptionDetails)) {
    res = await cdpEval(tab.id, buildWrapper(stmtForm));
  }
  if (res.exceptionDetails) {
    throw new Error(`chrome_evaluate failed: ${cdpExceptionText(res.exceptionDetails) || "evaluation failed"}`);
  }
  const result = res.result;
  if (!result || result.type === "undefined") return undefined;
  const v = result.value;
  // Unwrap special markers produced by piEvalStringify.
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (v.kind === "undefined") return undefined;
    if (v.kind === "function") return `[Function: ${v.source}]`;
    if (v.kind === "symbol") return `[Symbol: ${v.description}]`;
    if (v.kind === "bigint") return v.value;
    if (v.kind === "error") throw new Error(`${v.name}: ${v.message}\n${v.stack || ""}`);
  }
  return v;
}

async function withOptionalSnapshot(params, actionFn) {
  const result = await actionFn(params);
  const include = params.includeSnapshot;
  if (include === true || include === "auto") {
    // "auto" — only fetch a snapshot when the action produced a meaningful result.
    // For waitFor-style results, that means found=true (elapsedMs > 0). For shape {found, ...}
    // we treat absent found as truthy-neutral; for non-shape results we always snapshot when
    // include=true.
    let shouldSnapshot = true;
    if (include === "auto") {
      const r = (result && typeof result === "object") ? result : null;
      if (r && "found" in r) shouldSnapshot = r.found === true;
      else if (r && "elapsedMs" in r) shouldSnapshot = Number(r.elapsedMs) > 0;
    }
    if (shouldSnapshot) {
      const snapshot = await snapshotInTab({ ...params, foreground: false });
      return { result, snapshot };
    }
  }
  return result;
}

// Snapshot/inspect run from a packaged MAIN-world script (snapshot_injected.js) injected via
// chrome.scripting.executeScript({ files }). That file is free of eval/new Function, so it works
// on strict-CSP pages, and it installs globalThis.__piChromeSnapshotPage / __piChromeInspectTarget.
// It shares window.__PI_CHROME_STATE__ (same el- uid scheme) with the CDP-injected input helpers.
async function snapshotInTab(params) {
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  const args = [
    params.maxElements || 80,
    params.containingText ?? null,
    params.roleFilter ?? null,
    params.nearUid ?? null,
    params.mode || "auto",
    params.query ?? null,
    params.maxTextChars ?? null,
  ];
  await executeScriptTimed({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    files: ["snapshot_injected.js"],
  }, `inject snapshot script in tab ${tab.id}`);
  const results = await executeScriptTimed({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    func: async (invocationArgs) => {
      try {
        const snapshotPage = globalThis.__piChromeSnapshotPage;
        if (typeof snapshotPage !== "function") throw new Error("snapshot_injected.js did not install __piChromeSnapshotPage");
        return { ok: true, value: await snapshotPage(...invocationArgs) };
      } catch (error) {
        return { ok: false, error: error?.stack || error?.message || String(error) };
      }
    },
    args: [args],
  }, `run snapshot script in tab ${tab.id}`);
  const first = results?.[0];
  if (first?.error) {
    const message = typeof first.error === "string" ? first.error : (first.error.message || JSON.stringify(first.error));
    throw new Error(message);
  }
  const envelope = first?.result;
  if (envelope && typeof envelope === "object" && envelope.ok === false) {
    throw new Error(envelope.error || "Chrome snapshot script failed");
  }
  return envelope?.value;
}

async function inspectInTab(params) {
  if (!params.uid && !params.selector) throw new Error("chrome_inspect requires uid or selector");
  const tab = await getTabByParams(params);
  await bringToFront(tab, params);
  const args = [params.uid ?? null, params.selector ?? null, params.scrollIntoView === true];
  await executeScriptTimed({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    files: ["snapshot_injected.js"],
  }, `inject inspect script in tab ${tab.id}`);
  const results = await executeScriptTimed({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    func: async (invocationArgs) => {
      try {
        const inspectTarget = globalThis.__piChromeInspectTarget;
        if (typeof inspectTarget !== "function") throw new Error("snapshot_injected.js did not install __piChromeInspectTarget");
        return { ok: true, value: await inspectTarget(...invocationArgs) };
      } catch (error) {
        return { ok: false, error: error?.stack || error?.message || String(error) };
      }
    },
    args: [args],
  }, `run inspect script in tab ${tab.id}`);
  const first = results?.[0];
  if (first?.error) {
    const message = typeof first.error === "string" ? first.error : (first.error.message || JSON.stringify(first.error));
    throw new Error(message);
  }
  const envelope = first?.result;
  if (envelope && typeof envelope === "object" && envelope.ok === false) {
    throw new Error(envelope.error || "Chrome inspect script failed");
  }
  return envelope?.value;
}

// One-shot init script registry, scoped per tab. The source is registered with CDP
// Page.addScriptToEvaluateOnNewDocument, which runs it at document_start in the page's MAIN
// world and is NOT subject to page CSP (the old func:(code)=>new Function(code) path was
// blocked by `script-src 'self'`). page.navigate registers before the nav and unregisters
// after load, so only the intended navigation receives the script.
const initScriptIds = new Map(); // tabId -> CDP script identifier
async function registerInitScript(tabId, source) {
  await attachDebugger(tabId);
  await cdp(tabId, "Page.enable", {}).catch(() => undefined);
  const result = await cdp(tabId, "Page.addScriptToEvaluateOnNewDocument", { source });
  if (result && result.identifier !== undefined) initScriptIds.set(tabId, result.identifier);
}
async function unregisterInitScript(tabId) {
  const identifier = initScriptIds.get(tabId);
  if (identifier === undefined) return;
  initScriptIds.delete(tabId);
  await cdp(tabId, "Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(() => undefined);
}

// Always inject early console/network capture at document_start on every navigation.
// Catches console messages, errors, and network requests that fire during page load,
// before chrome_snapshot or chrome_evaluate install the instrumentation normally.
// The function installEarlyCapture sets __piChromeWrapped flags so the post-hoc
// installPiChromeInstrumentation() call is idempotent.
if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    chrome.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [0] },
      world: "MAIN",
      injectImmediately: true,
      func: installEarlyCapture,
      args: [],
    }).catch(() => undefined);
  });
}

function foregroundRequested(params) {
  // Fail quiet when unspecified, and let background veto even a contradictory foreground flag.
  return params?.foreground === true && params.background !== true;
}

async function bringToFront(tab, params) {
  if (!foregroundRequested(params)) return tab;
  await chrome.windows.update(tab.windowId, { focused: true });
  return chrome.tabs.update(tab.id, { active: true });
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for tab ${tabId} to load`));
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function captureTabScreenshot(tabId, params) {
  const format = params.format || "png";
  try {
    await attachDebugger(tabId);
    const captureParams = { format, fromSurface: true, captureBeyondViewport: false };
    if (format === "jpeg" && params.quality !== undefined) captureParams.quality = params.quality;
    const result = await cdp(tabId, "Page.captureScreenshot", captureParams);
    if (typeof result?.data !== "string" || !result.data) throw new Error("CDP returned no screenshot data");
    return `data:image/${format};base64,${result.data}`;
  } catch (error) {
    // captureVisibleTab requires activation and can race with the user switching tabs. Never
    // use it as a fallback, even when debugger attachment or background rendering fails.
    throw new Error(`Chrome screenshot via CDP failed; no tab-activation fallback was attempted. ${error?.message || error}`);
  }
}

async function takeScreenshot(params) {
  const tab = await bringToFront(await getTabByParams(params), params);
  if (params.fullPage) {
    // Preserve the existing tile + manifest contract. Every tile captures the same resolved tab,
    // without activation; selector/title changes during capture must not retarget later tiles.
    const targetParams = { ...params, targetId: tab.id, foreground: false };
    const tiles = await executeInTab(targetParams, captureFullPageTiles, []);
    const captured = [];
    try {
      for (const tile of tiles.tiles) {
        await executeInTab(targetParams, scrollToY, [tile.scrollY]);
        await sleep(120); // Let scroll/lazy-load handlers settle.
        captured.push({ y: tile.y, dataUrl: await captureTabScreenshot(tab.id, params) });
      }
    } finally {
      // A failed tile must not strand the page at a new scroll position. Restore both axes
      // best-effort, without masking the capture error if the tab/debugger is gone.
      await executeInTab(targetParams, scrollToY, [tiles.originalScrollY, tiles.originalScrollX]).catch(() => undefined);
    }
    return {
      fullPage: true,
      method: "cdp",
      tab: await formatTab(tab),
      dimensions: { width: tiles.width, height: tiles.height, viewportHeight: tiles.viewportHeight, dpr: tiles.dpr },
      tiles: captured,
    };
  }
  const dataUrl = await captureTabScreenshot(tab.id, params);
  return { dataUrl, method: "cdp", tab: await formatTab(tab) };
}

// ---------------------------------------------------------------------------
// MAIN-world helpers (function declarations injected into the page).
// ---------------------------------------------------------------------------

function getPiChromeState() {
  const state = window.__PI_CHROME_STATE__ || {
    nextElementUid: 1,
    elements: {},
    console: [],
    network: [],
    nextRequestId: 1,
    instrumentationInstalled: false,
  };
  window.__PI_CHROME_STATE__ = state;
  return state;
}

function rememberElement(element) {
  const state = getPiChromeState();
  if (!element.__piChromeUid) element.__piChromeUid = "el-" + state.nextElementUid++;
  state.elements[element.__piChromeUid] = element;
  return element.__piChromeUid;
}

function elementBySelectorOrUid(selector, uid) {
  if (uid) {
    const element = getPiChromeState().elements[uid];
    if (!element || !element.isConnected) throw new Error(`No live element for uid: ${uid}. Take a fresh chrome_snapshot.`);
    return element;
  }
  if (selector) {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`No element matches selector: ${selector}`);
    return element;
  }
  return null;
}

function isElementVisible(element) {
  if (!element || !element.getBoundingClientRect) return false;
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none") return false;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  if (rect.bottom < 0 || rect.right < 0) return false;
  if (rect.top > innerHeight || rect.left > innerWidth) return false;
  return true;
}

function occluderAt(x, y, expected) {
  const top = document.elementFromPoint(x, y);
  if (!top || top === expected) return null;
  if (expected && expected.contains(top)) return null;
  if (top.contains(expected)) return null;
  return {
    tag: top.tagName.toLowerCase(),
    id: top.id || undefined,
    className: typeof top.className === "string" ? top.className : undefined,
  };
}

function pageHash() {
  // Cheap rolling hash used for `pageMutated`. Combines first 4kb of body innerText with the
  // current values of inputs/textareas (which are not part of innerText) and the count of
  // descendants of <body>. This catches: text changes, input value edits, and DOM structure
  // changes — the three things a click/type/fill might cause.
  const body = document.body;
  const text = (body ? body.innerText : "").slice(0, 4000);
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  if (body) {
    const inputs = body.querySelectorAll("input,textarea,select");
    let valueBlob = "";
    for (let i = 0; i < inputs.length && valueBlob.length < 4000; i++) {
      const v = inputs[i].value;
      if (typeof v === "string") valueBlob += v + "\x00";
    }
    for (let i = 0; i < valueBlob.length; i++) h = (h * 31 + valueBlob.charCodeAt(i)) | 0;
    h = (h * 31 + body.getElementsByTagName("*").length) | 0;
  }
  return h;
}

function sleepPage(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function dispatchPointerLikeEvent(element, type, x, y, prevX, prevY, opts = {}) {
  const isPointer = type.startsWith("pointer");
  const Ctor = isPointer ? PointerEvent : MouseEvent;
  const isMove = type === "pointermove" || type === "mousemove";
  const isUpOrClick = type === "pointerup" || type === "mouseup" || type === "click";
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x + (window.screenX || 0),
    screenY: y + (window.screenY || 0),
    movementX: Number.isFinite(prevX) ? x - prevX : 0,
    movementY: Number.isFinite(prevY) ? y - prevY : 0,
    button: 0,
    buttons: isMove || isUpOrClick ? 0 : 1,
  };
  if (isPointer) {
    init.pointerType = "mouse";
    init.pointerId = 1;
    init.isPrimary = true;
    init.width = 1;
    init.height = 1;
    init.pressure = opts.pressure ?? (type === "pointerdown" ? 0.5 : 0);
    init.tangentialPressure = 0;
    init.tiltX = 0;
    init.tiltY = 0;
  }
  const ev = new Ctor(type, init);
  element.dispatchEvent(ev);
  return ev.defaultPrevented;
}

function pointerEventSequence(element, x, y, sequence) {
  let defaultPrevented = false;
  const state = getPiChromeState();
  const prevX = state.pointer?.x;
  const prevY = state.pointer?.y;
  for (const type of sequence) {
    defaultPrevented = dispatchPointerLikeEvent(element, type, x, y, prevX, prevY) || defaultPrevented;
  }
  state.pointer = { x, y, t: performance.now() };
  return defaultPrevented;
}

async function humanMoveTo(x, y, steps) {
  const state = getPiChromeState();
  const startX = Number.isFinite(state.pointer?.x) ? state.pointer.x : rand(12, Math.max(24, innerWidth - 12));
  const startY = Number.isFinite(state.pointer?.y) ? state.pointer.y : rand(12, Math.max(24, innerHeight - 12));
  const n = steps || Math.max(12, Math.min(42, Math.round(Math.hypot(x - startX, y - startY) / 18)));
  let prevX = startX, prevY = startY;
  let defaultPrevented = false;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 8;
    const px = startX + (x - startX) * ease + rand(-wobble, wobble);
    const py = startY + (y - startY) * ease + rand(-wobble, wobble);
    const el = document.elementFromPoint(px, py) || document.body || document.documentElement;
    defaultPrevented = dispatchPointerLikeEvent(el, "pointermove", px, py, prevX, prevY) || defaultPrevented;
    defaultPrevented = dispatchPointerLikeEvent(el, "mousemove", px, py, prevX, prevY) || defaultPrevented;
    prevX = px; prevY = py;
    await sleepPage(rand(4, 18));
  }
  state.pointer = { x, y, t: performance.now() };
  return defaultPrevented;
}

function humanClickPoint(point) {
  if (!point.rect) return { x: point.x, y: point.y };
  const rect = point.rect;
  const insetX = Math.min(rect.width * 0.35, Math.max(2, rect.width / 2 - 1));
  const insetY = Math.min(rect.height * 0.35, Math.max(2, rect.height / 2 - 1));
  return {
    x: rect.left + rect.width / 2 + rand(-insetX, insetX),
    y: rect.top + rect.height / 2 + rand(-insetY, insetY),
  };
}

function installPiChromeInstrumentation() {
  const state = getPiChromeState();
  if (state.instrumentationInstalled) return;
  state.instrumentationInstalled = true;
  const pushConsole = (level, args) => {
    state.console.push({
      id: state.console.length + 1,
      level,
      timestamp: Date.now(),
      url: location.href,
      args: Array.from(args).map((arg) => {
        try {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return { name: arg.name, message: arg.message, stack: arg.stack };
          return JSON.parse(JSON.stringify(arg));
        } catch {
          return String(arg);
        }
      }),
    });
    if (state.console.length > 500) state.console.splice(0, state.console.length - 500);
  };
  for (const level of ["debug", "log", "info", "warn", "error"]){
    const original = console[level];
    if (typeof original !== "function" || original.__piChromeWrapped) continue;
    const wrapped = function(...args) {
      pushConsole(level, args);
      return original.apply(this, args);
    };
    wrapped.__piChromeWrapped = true;
    console[level] = wrapped;
  }
  window.addEventListener("error", (event) => pushConsole("pageerror", [event.message, event.filename + ":" + event.lineno + ":" + event.colno]));
  window.addEventListener("unhandledrejection", (event) => pushConsole("unhandledrejection", [event.reason]));

  const trimBody = (text) => typeof text === "string" && text.length > 200000 ? text.slice(0, 200000) + `\n[truncated ${text.length - 200000} chars]` : text;
  const record = (entry) => {
    state.network.push(entry);
    if (state.network.length > 1000) state.network.splice(0, state.network.length - 1000);
    return entry;
  };
  if (window.fetch && !window.fetch.__piChromeWrapped) {
    const originalFetch = window.fetch.bind(window);
    const wrappedFetch = async (...args) => {
      const id = "req-" + state.nextRequestId++;
      const startedAt = Date.now();
      const input = args[0];
      const init = args[1] || {};
      const url = typeof input === "string" ? input : input?.url;
      const method = (init.method || input?.method || "GET").toUpperCase();
      const entry = record({ id, type: "fetch", method, url: String(url || ""), startedAt, pageUrl: location.href, status: "pending" });
      try {
        const response = await originalFetch(...args);
        entry.status = response.status;
        entry.statusText = response.statusText;
        entry.ok = response.ok;
        entry.responseUrl = response.url;
        entry.durationMs = Date.now() - startedAt;
        entry.responseHeaders = Array.from(response.headers.entries());
        response.clone().text().then((text) => {
          entry.responseBody = trimBody(text);
          entry.responseBodyTruncated = typeof text === "string" && text.length > 200000;
        }).catch((error) => { entry.responseBodyError = error?.message || String(error); });
        return response;
      } catch (error) {
        entry.error = error?.message || String(error);
        entry.durationMs = Date.now() - startedAt;
        throw error;
      }
    };
    wrappedFetch.__piChromeWrapped = true;
    window.fetch = wrappedFetch;
  }
  if (window.XMLHttpRequest && !XMLHttpRequest.prototype.open.__piChromeWrapped) {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__piChromeRequest = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
      return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.open.__piChromeWrapped = true;
    XMLHttpRequest.prototype.send = function(body) {
      const id = "req-" + state.nextRequestId++;
      const startedAt = Date.now();
      const info = this.__piChromeRequest || {};
      const entry = record({ id, type: "xhr", method: info.method || "GET", url: info.url || "", startedAt, pageUrl: location.href, status: "pending" });
      this.addEventListener("loadend", () => {
        entry.status = this.status;
        entry.statusText = this.statusText;
        entry.responseUrl = this.responseURL;
        entry.durationMs = Date.now() - startedAt;
        try { entry.responseHeadersText = this.getAllResponseHeaders(); } catch {}
        try {
          if (typeof this.responseText === "string") {
            entry.responseBody = trimBody(this.responseText);
            entry.responseBodyTruncated = this.responseText.length > 200000;
          }
        } catch (error) { entry.responseBodyError = error?.message || String(error); }
      });
      this.addEventListener("error", () => { entry.error = "XMLHttpRequest error"; entry.durationMs = Date.now() - startedAt; });
      return originalSend.call(this, body);
    };
  }
}

// Early-capture version of installPiChromeInstrumentation, designed to be injected
// at document_start via webNavigation.onCommitted. Wraps console, fetch, and XHR
// before the page's own JavaScript runs, so page-load errors are captured.
// Sets __piChromeWrapped flags so the post-hoc installPiChromeInstrumentation()
// sees them and skips (idempotent).
// NOTE: This function is self-contained — it does NOT close over any outer scope
// because it gets serialized by chrome.scripting.executeScript({func: ...}).
function installEarlyCapture() {
  if (window.__piChromeEarlyCaptureInstalled) return;
  window.__piChromeEarlyCaptureInstalled = true;
  var state = window.__PI_CHROME_STATE__;
  if (!state) {
    state = {
      nextElementUid: 1,
      elements: {},
      console: [],
      network: [],
      nextRequestId: 1,
      instrumentationInstalled: false,
    };
    window.__PI_CHROME_STATE__ = state;
  }
  function pushConsole(level, args) {
    state.console.push({
      id: state.console.length + 1,
      level: level,
      timestamp: Date.now(),
      url: location.href,
      args: Array.from(args).map(function(arg) {
        try {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return { name: arg.name, message: arg.message, stack: arg.stack };
          return JSON.parse(JSON.stringify(arg));
        } catch (e) {
          return String(arg);
        }
      }),
    });
    if (state.console.length > 500) state.console.splice(0, state.console.length - 500);
  }
  for (var i = 0; i < 5; i++) {
    var levels = ["debug", "log", "info", "warn", "error"];
    var level = levels[i];
    var original = console[level];
    if (typeof original !== "function" || original.__piChromeWrapped) continue;
    var wrapped = function(lvl, orig) {
      return function() {
        pushConsole(lvl, arguments);
        return orig.apply(this, arguments);
      };
    }(level, original);
    wrapped.__piChromeWrapped = true;
    console[level] = wrapped;
  }
  window.addEventListener("error", function(event) {
    pushConsole("pageerror", [event.message, event.filename + ":" + event.lineno + ":" + event.colno]);
  });
  window.addEventListener("unhandledrejection", function(event) {
    pushConsole("unhandledrejection", [event.reason]);
  });
  var trimBody = function(text) {
    return typeof text === "string" && text.length > 200000 ? text.slice(0, 200000) + "\n[truncated " + (text.length - 200000) + " chars]" : text;
  };
  var record = function(entry) {
    state.network.push(entry);
    if (state.network.length > 1000) state.network.splice(0, state.network.length - 1000);
    return entry;
  };
  if (window.fetch && !window.fetch.__piChromeWrapped) {
    var originalFetch = window.fetch.bind(window);
    var wrappedFetch = async function() {
      var args = [];
      for (var k = 0; k < arguments.length; k++) args.push(arguments[k]);
      var id = "req-" + state.nextRequestId++;
      var startedAt = Date.now();
      var input = args[0];
      var init = args[1] || {};
      var url = typeof input === "string" ? input : (input ? input.url : "");
      var method = (init.method || (input ? input.method : null) || "GET").toUpperCase();
      var entry = record({ id: id, type: "fetch", method: method, url: String(url || ""), startedAt: startedAt, pageUrl: location.href, status: "pending" });
      try {
        var response = await originalFetch.apply(window, args);
        entry.status = response.status;
        entry.statusText = response.statusText;
        entry.ok = response.ok;
        entry.responseUrl = response.url;
        entry.durationMs = Date.now() - startedAt;
        entry.responseHeaders = Array.from(response.headers.entries());
        response.clone().text().then(function(text) {
          entry.responseBody = trimBody(text);
          entry.responseBodyTruncated = typeof text === "string" && text.length > 200000;
        }).catch(function(error) { entry.responseBodyError = error ? error.message : String(error); });
        return response;
      } catch (error) {
        entry.error = error ? error.message : String(error);
        entry.durationMs = Date.now() - startedAt;
        throw error;
      }
    };
    wrappedFetch.__piChromeWrapped = true;
    window.fetch = wrappedFetch;
  }
  if (window.XMLHttpRequest && !XMLHttpRequest.prototype.open.__piChromeWrapped) {
    var originalOpen = XMLHttpRequest.prototype.open;
    var originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__piChromeRequest = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open.__piChromeWrapped = true;
    XMLHttpRequest.prototype.send = function(body) {
      var id = "req-" + state.nextRequestId++;
      var startedAt = Date.now();
      var info = this.__piChromeRequest || {};
      var entry = record({ id: id, type: "xhr", method: info.method || "GET", url: info.url || "", startedAt: startedAt, pageUrl: location.href, status: "pending" });
      this.addEventListener("loadend", function() {
        entry.status = this.status;
        entry.statusText = this.statusText;
        entry.responseUrl = this.responseURL;
        entry.durationMs = Date.now() - startedAt;
        try { entry.responseHeadersText = this.getAllResponseHeaders(); } catch (e) {}
        try {
          if (typeof this.responseText === "string") {
            entry.responseBody = trimBody(this.responseText);
            entry.responseBodyTruncated = this.responseText.length > 200000;
          }
        } catch (error) { entry.responseBodyError = error ? error.message : String(error); }
      });
      this.addEventListener("error", function() { entry.error = "XMLHttpRequest error"; entry.durationMs = Date.now() - startedAt; });
      return originalSend.apply(this, arguments);
    };
  }
  state.instrumentationInstalled = true;
}

function probePage() {
  // Sanity probe used by /chrome-doctor. Returns evidence that MAIN-world execution works.
  return {
    arithmetic: 1 + 1,
    location: location.href,
    title: document.title,
    documentReady: document.readyState,
    userAgent: navigator.userAgent.slice(0, 200),
    webdriver: !!navigator.webdriver,
  };
}

function captureFullPageTiles() {
  // Returns the plan for CDP tile capture in the worker: scroll positions and page metrics.
  const html = document.documentElement;
  const body = document.body;
  const width = Math.max(html.scrollWidth, body ? body.scrollWidth : 0, innerWidth);
  const height = Math.max(html.scrollHeight, body ? body.scrollHeight : 0, innerHeight);
  const viewportHeight = innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const originalScrollY = scrollY;
  const originalScrollX = scrollX;
  const tiles = [];
  let y = 0;
  while (y < height) {
    tiles.push({ y, scrollY: y });
    y += viewportHeight;
  }
  return { width, height, viewportHeight, dpr, originalScrollY, originalScrollX, tiles };
}

function scrollToY(y, x = 0) {
  window.scrollTo({ top: y, left: x, behavior: "instant" });
  return { scrollY };
}

function resolvePoint(selector, uid, x, y) {
  const element = elementBySelectorOrUid(selector, uid);
  if (element) {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = element.getBoundingClientRect();
    return { element, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect };
  }
  if (typeof x !== "number" || typeof y !== "number") throw new Error("Provide selector, uid, or x/y");
  return { element: document.elementFromPoint(x, y), x, y, rect: undefined };
}

async function clickPage(selector, uid, x, y) {
  installPiChromeInstrumentation();
  const before = pageHash();
  const point = resolvePoint(selector, uid, x, y);
  if (!point.element) throw new Error("No element at click point");
  const clickPoint = humanClickPoint(point);
  point.x = clickPoint.x;
  point.y = clickPoint.y;
  point.element = document.elementFromPoint(point.x, point.y) || point.element;
  const visible = isElementVisible(point.element);
  const occluded = occluderAt(point.x, point.y, point.element);
  let defaultPrevented = await humanMoveTo(point.x, point.y);
  const state = getPiChromeState();
  const prevX = state.pointer?.x;
  const prevY = state.pointer?.y;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "pointerdown", point.x, point.y, prevX, prevY, { pressure: 0.5 }) || defaultPrevented;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "mousedown", point.x, point.y, prevX, prevY) || defaultPrevented;
  if (typeof point.element.focus === "function" && /^(A|BUTTON|INPUT|TEXTAREA|SELECT|SUMMARY)$/.test(point.element.tagName)) {
    try { point.element.focus({ preventScroll: true }); } catch { try { point.element.focus(); } catch {} }
  }
  await sleepPage(rand(45, 140));
  defaultPrevented = dispatchPointerLikeEvent(point.element, "pointerup", point.x, point.y, prevX, prevY) || defaultPrevented;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "mouseup", point.x, point.y, prevX, prevY) || defaultPrevented;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "click", point.x, point.y, prevX, prevY) || defaultPrevented;
  state.pointer = { x: point.x, y: point.y, t: performance.now() };
  // Heuristic: if the clicked thing looks like a media play affordance and the page has paused
  // audio/video, the DOM-event click may not unlock autoplay. Surface a warning.
  let autoplayHint;
  const labelRaw = (point.element.getAttribute("aria-label") || point.element.textContent || "").trim();
  const label = labelRaw.toLowerCase();
  if (/^(play|start|begin|next|continue|unmute)/.test(label)) {
    const idleMedia = Array.from(document.querySelectorAll("audio,video")).some((m) => m.paused);
    if (idleMedia) autoplayHint = "This element looks like a media affordance and the page has paused media. DOM-event clicks do not satisfy user-activation gates; audio/video may not start.";
  }
  const pageMutated = pageHash() !== before;
  // Smart-auto retry hint: only set when DOM-event path produced no observable change AND the
  // element looks gated, OR the page just emitted a user-activation rejection. The dispatcher
  // uses this to decide whether to retry with Chrome input.
  let suggestChromeInput = false;
  let suggestReason;
  if (!pageMutated) {
    if (autoplayHint) { suggestChromeInput = true; suggestReason = "play/media affordance + idle media"; }
    else if (/copy(\s|$)|paste|share|download|fullscreen|sign in with|continue with|allow|enable/i.test(label)) {
      suggestChromeInput = true; suggestReason = `label '${labelRaw.slice(0, 40)}' looks gated`;
    } else {
      // Inspect recent console errors for activation-gate rejections.
      const recent = (state.console || []).slice(-8);
      const hit = recent.find((e) => /NotAllowedError|Document is not focused|requires transient activation|gesture is required/.test(
        (e.args || []).map((a) => typeof a === "string" ? a : (a && a.message) || JSON.stringify(a)).join(" ")
      ));
      if (hit) { suggestChromeInput = true; suggestReason = "recent console error indicates user-activation gate"; }
    }
  }
  return {
    x: point.x,
    y: point.y,
    selector,
    uid,
    tag: point.element.tagName,
    label: labelRaw.slice(0, 80) || undefined,
    input: "dom",
    defaultPrevented,
    elementVisible: visible,
    occludedBy: occluded || undefined,
    pageMutated,
    autoplayHint,
    suggestChromeInput: suggestChromeInput || undefined,
    suggestReason,
  };
}

async function hoverPage(selector, uid, x, y) {
  installPiChromeInstrumentation();
  const point = resolvePoint(selector, uid, x, y);
  if (!point.element) throw new Error("No element to hover");
  await humanMoveTo(point.x, point.y);
  const state = getPiChromeState();
  const prevX = state.pointer?.x, prevY = state.pointer?.y;
  let defaultPrevented = false;
  for (const type of ["pointerover", "mouseover", "pointerenter", "mouseenter"]) {
    defaultPrevented = dispatchPointerLikeEvent(point.element, type, point.x, point.y, prevX, prevY) || defaultPrevented;
  }
  // Small dwell so hover-intent handlers fire.
  await sleepPage(rand(80, 220));
  return { x: point.x, y: point.y, selector, uid, tag: point.element.tagName, defaultPrevented, input: "dom" };
}

async function dragPage(fromUid, fromSelector, fromX, fromY, toUid, toSelector, toX, toY, steps) {
  installPiChromeInstrumentation();
  const before = pageHash();
  const from = resolvePoint(fromSelector, fromUid, fromX, fromY);
  const to = resolvePoint(toSelector, toUid, toX, toY);
  if (!from.element) throw new Error("Drag source element not found");
  if (!to.element) throw new Error("Drag target element not found");
  // Move to source.
  await humanMoveTo(from.x, from.y);
  const state = getPiChromeState();
  let prevX = state.pointer?.x, prevY = state.pointer?.y;
  // Build a shared DataTransfer so HTML5 drag-and-drop handlers can populate / read it.
  const dt = new DataTransfer();
  const dragInit = (type, target, x, y) => {
    const ev = new DragEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y,
      screenX: x + (window.screenX || 0), screenY: y + (window.screenY || 0),
      button: 0, buttons: 1, view: window,
      dataTransfer: dt,
    });
    target.dispatchEvent(ev);
    return ev;
  };
  dispatchPointerLikeEvent(from.element, "pointerover", from.x, from.y, prevX, prevY);
  dispatchPointerLikeEvent(from.element, "pointerdown", from.x, from.y, prevX, prevY, { pressure: 0.5 });
  dispatchPointerLikeEvent(from.element, "mousedown", from.x, from.y, prevX, prevY);
  await sleepPage(rand(40, 110));
  dragInit("dragstart", from.element, from.x, from.y);
  dragInit("drag", from.element, from.x, from.y);
  let lastOver = from.element;
  const n = steps || 18;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 6;
    const x = from.x + (to.x - from.x) * ease + rand(-wobble, wobble);
    const y = from.y + (to.y - from.y) * ease + rand(-wobble, wobble);
    const overEl = document.elementFromPoint(x, y) || to.element;
    dispatchPointerLikeEvent(overEl, "pointermove", x, y, prevX, prevY);
    dispatchPointerLikeEvent(overEl, "mousemove", x, y, prevX, prevY);
    if (overEl !== lastOver) {
      dragInit("dragleave", lastOver, x, y);
      dragInit("dragenter", overEl, x, y);
      lastOver = overEl;
    }
    dragInit("dragover", overEl, x, y);
    dragInit("drag", from.element, x, y);
    prevX = x; prevY = y;
    await sleepPage(rand(8, 26));
  }
  dispatchPointerLikeEvent(to.element, "pointerover", to.x, to.y, prevX, prevY);
  dispatchPointerLikeEvent(to.element, "mouseover", to.x, to.y, prevX, prevY);
  dragInit("drop", to.element, to.x, to.y);
  dragInit("dragend", from.element, to.x, to.y);
  dispatchPointerLikeEvent(to.element, "pointerup", to.x, to.y, prevX, prevY);
  dispatchPointerLikeEvent(to.element, "mouseup", to.x, to.y, prevX, prevY);
  state.pointer = { x: to.x, y: to.y, t: performance.now() };
  return {
    from: { x: from.x, y: from.y },
    to: { x: to.x, y: to.y },
    steps: n,
    pageMutated: pageHash() !== before,
    note: "DOM-event drag with HTML5 DragEvent + shared DataTransfer.",
  };
}

async function scrollPage(selector, uid, deltaY, deltaX, steps) {
  installPiChromeInstrumentation();
  const before = pageHash();
  let target;
  if (selector || uid) {
    target = elementBySelectorOrUid(selector, uid);
  } else {
    target = document.scrollingElement || document.documentElement || document.body;
  }
  if (!target) throw new Error("No scroll target");
  const rect = target.getBoundingClientRect ? target.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
  const cx = Math.max(0, Math.min(innerWidth - 1, rect.left + Math.min(rect.width, innerWidth) / 2));
  const cy = Math.max(0, Math.min(innerHeight - 1, rect.top + Math.min(rect.height, innerHeight) / 2));
  const n = Math.max(3, Math.min(40, steps || Math.max(3, Math.ceil(Math.abs(deltaY || 0) / 100))));
  // Front-loaded wheel deltas, momentum-style.
  const totalY = deltaY || 0;
  const totalX = deltaX || 0;
  const weights = [];
  for (let i = 1; i <= n; i++) weights.push(1 / i);
  const sumW = weights.reduce((a, b) => a + b, 0);
  let movedY = 0, movedX = 0;
  for (let i = 0; i < n; i++) {
    const dy = totalY * (weights[i] / sumW);
    const dx = totalX * (weights[i] / sumW);
    const ev = new WheelEvent("wheel", {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: cx, clientY: cy,
      deltaX: dx, deltaY: dy, deltaMode: 0,
    });
    target.dispatchEvent(ev);
    if (!ev.defaultPrevented) {
      // Apply scroll ourselves; mirrors what the browser would do.
      if (target === document.scrollingElement || target === document.documentElement || target === document.body) {
        window.scrollBy({ left: dx, top: dy, behavior: "instant" });
      } else {
        target.scrollTop += dy;
        target.scrollLeft += dx;
      }
    }
    movedY += dy; movedX += dx;
    await sleepPage(rand(12, 28));
  }
  return {
    deltaX: movedX, deltaY: movedY, steps: n,
    scrollTop: target.scrollTop, scrollLeft: target.scrollLeft,
    pageMutated: pageHash() !== before,
    input: "dom",
  };
}

function uploadFiles(selector, uid, files) {
  installPiChromeInstrumentation();
  const element = elementBySelectorOrUid(selector, uid);
  if (!element || element.tagName !== "INPUT" || element.type !== "file") {
    throw new Error("Target must be <input type=file>");
  }
  const dt = new DataTransfer();
  for (const f of files) {
    const bytes = Uint8Array.from(atob(f.base64 || ""), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], f.name, { type: f.type || "application/octet-stream" }));
  }
  element.files = dt.files;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { uploaded: files.map((f) => ({ name: f.name, type: f.type, size: (f.base64 || "").length })) };
}

function dispatchInputEvents(element, data, inputType = "insertText") {
  element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data }));
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function setNativeValue(element, value) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) descriptor.set.call(element, value);
  else element.value = value;
}

// React-controlled inputs ignore direct value assignments: React tracks the displayed value
// via its internal state and snaps the DOM back on the next render. The fix is to (a) write
// through the native value setter so React's onChange sees a real input transition and (b)
// dispatch input + change events in the shape React's synthetic event system listens for.
// detectReactControlled returns true when the element carries a React fiber/props key — the
// same marker React 16+ installs on every host node. reactCompatFill is the single helper
// the CDP fill path and the DOM fallback both call into to actually apply the value.
function detectReactControlled(el) {
  if (!el || typeof el !== "object") return false;
  for (const key of Object.keys(el)) {
    if (key.startsWith("__reactFiber$") || key.startsWith("__reactProps$") || key.startsWith("__reactInternalInstance$")) return true;
  }
  return false;
}

function reactCompatFill(el, value) {
  if (!el) return { usedReact: false, valueMatches: false };
  const isReact = detectReactControlled(el);
  if ("value" in el) {
    setNativeValue(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  }
  return { usedReact: isReact, valueMatches: "value" in el ? el.value === value : el.textContent === value };
}

function printableKeyCode(ch) {
  return ch.length === 1 ? usKeyLayoutForChar(ch).keyCode : 0;
}

function dispatchKeyEvent(element, type, key, mods = {}) {
  const SPECIAL = { Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, " ": 32, Shift: 16, Control: 17, Alt: 18, Meta: 91 };
  const code = key.length === 1 ? usKeyLayoutForChar(key).code : (key === " " ? "Space" : key);
  const keyCode = key.length === 1 ? printableKeyCode(key) : (SPECIAL[key] ?? 0);
  const ev = new KeyboardEvent(type, {
    key,
    code,
    keyCode,
    which: keyCode,
    charCode: type === "keypress" && key.length === 1 ? key.charCodeAt(0) : 0,
    shiftKey: !!mods.shiftKey,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey,
    metaKey: !!mods.metaKey,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
  });
  element.dispatchEvent(ev);
  return ev;
}

async function typeCharacter(element, ch) {
  const needShift = ch.length === 1 && (/^[A-Z]$/.test(ch) || "~!@#$%^&*()_+{}|:\"<>?".includes(ch));
  if (needShift) {
    dispatchKeyEvent(element, "keydown", "Shift", { shiftKey: true });
    await sleepPage(rand(8, 24));
  }
  const mods = { shiftKey: needShift };
  const down = dispatchKeyEvent(element, "keydown", ch, mods);
  if (down.defaultPrevented) {
    if (needShift) dispatchKeyEvent(element, "keyup", "Shift", { shiftKey: false });
    return { defaultPrevented: true };
  }
  if (ch.length === 1) dispatchKeyEvent(element, "keypress", ch, mods);

  if (element.isContentEditable) {
    // execCommand("insertText") fires its own beforeinput + input. Don't double-dispatch.
    document.execCommand("insertText", false, ch);
  } else if ("value" in element) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? element.value.length;
    const next = element.value.slice(0, start) + ch + element.value.slice(end);
    const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: ch });
    element.dispatchEvent(before);
    if (!before.defaultPrevented) {
      setNativeValue(element, next);
      try { element.selectionStart = element.selectionEnd = start + ch.length; } catch {}
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
    }
  } else {
    throw new Error("Focused element is not text-editable");
  }

  await sleepPage(rand(25, 95));
  dispatchKeyEvent(element, "keyup", ch, mods);
  if (needShift) {
    await sleepPage(rand(5, 18));
    dispatchKeyEvent(element, "keyup", "Shift", { shiftKey: false });
  }
  await sleepPage(rand(35, 140));
  return { defaultPrevented: false };
}

async function typeIntoPage(selector, uid, text, pressEnter) {
  installPiChromeInstrumentation();
  const before = pageHash();
  let element = elementBySelectorOrUid(selector, uid) || document.activeElement;
  if (!element) throw new Error(selector || uid ? `No element for ${selector || uid}` : "No active element");
  const initialValue = "value" in element ? element.value : (element.isContentEditable ? element.textContent : null);
  element.focus();
  if (!(element.isContentEditable || "value" in element)) throw new Error("Focused element is not text-editable");
  for (const ch of Array.from(text)) await typeCharacter(element, ch);
  if (pressEnter) await pressKeyInPage("Enter");
  const finalValue = "value" in element ? element.value : element.textContent;
  const valueMatches = "value" in element ? element.value.includes(text) : (element.textContent || "").includes(text);
  const pageMutated = pageHash() !== before;
  // Smart-auto retry hint when typing didn't land at all (e.g., editor blocks DOM-event input).
  let suggestChromeInput = false, suggestReason;
  if (text.length > 0 && initialValue === finalValue) {
    suggestChromeInput = true;
    suggestReason = "value did not change — editor likely rejects DOM-event input";
  }
  return {
    selector, uid, length: text.length, pressEnter,
    input: "dom",
    valueMatches,
    pageMutated,
    suggestChromeInput: suggestChromeInput || undefined,
    suggestReason,
  };
}

async function fillPage(selector, uid, text, submit) {
  installPiChromeInstrumentation();
  const before = pageHash();
  let element = elementBySelectorOrUid(selector, uid) || document.activeElement;
  if (!element) throw new Error(selector || uid ? `No element for ${selector || uid}` : "No active element");
  element.focus();
  if (element.isContentEditable) {
    element.textContent = "";
    document.execCommand("insertText", false, text);
  } else if ("value" in element) {
    setNativeValue(element, text);
    const length = String(text).length;
    try { element.selectionStart = element.selectionEnd = length; } catch {}
    dispatchInputEvents(element, text, "insertReplacementText");
  } else {
    throw new Error("Focused element is not text-editable");
  }
  if (submit) await pressKeyInPage("Enter");
  return {
    selector, uid, length: String(text).length, submit,
    input: "dom",
    valueMatches: "value" in element ? element.value === String(text) : undefined,
    pageMutated: pageHash() !== before,
  };
}

async function pressKeyInPage(key) {
  const normalized = normalizeKey(key);
  const target = document.activeElement || document.body;
  const before = pageHash();
  const down = dispatchKeyEvent(target, "keydown", normalized);
  if (normalized.length === 1) dispatchKeyEvent(target, "keypress", normalized);
  // Character insertion for printable keys when focus is in an editable.
  if (normalized.length === 1 && !down.defaultPrevented && (target.isContentEditable || ("value" in target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")))) {
    if (target.isContentEditable) {
      const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: normalized });
      target.dispatchEvent(bi);
      if (!bi.defaultPrevented) {
        document.execCommand("insertText", false, normalized);
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: normalized }));
      }
    } else {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: normalized });
      target.dispatchEvent(bi);
      if (!bi.defaultPrevented) {
        setNativeValue(target, target.value.slice(0, start) + normalized + target.value.slice(end));
        try { target.selectionStart = target.selectionEnd = start + 1; } catch {}
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: normalized }));
      }
    }
  } else if (normalized === "Backspace" && "value" in target) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    if (start > 0 || end > start) {
      const from = start === end ? start - 1 : start;
      const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward" });
      target.dispatchEvent(bi);
      if (!bi.defaultPrevented) {
        setNativeValue(target, target.value.slice(0, from) + target.value.slice(end));
        try { target.selectionStart = target.selectionEnd = from; } catch {}
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      }
    }
  }
  await sleepPage(rand(25, 95));
  const up = dispatchKeyEvent(target, "keyup", normalized);
  if (normalized === "Enter") {
    const form = target.closest?.("form");
    if (form) form.requestSubmit?.();
  }
  return {
    key: normalized,
    input: "dom",
    defaultPrevented: down.defaultPrevented || up.defaultPrevented,
    pageMutated: pageHash() !== before,
  };
}

function listConsoleMessages(clear) {
  installPiChromeInstrumentation();
  const state = getPiChromeState();
  const messages = state.console.slice();
  if (clear) state.console = [];
  return { messages, count: messages.length };
}

function listNetworkRequests(includePreservedRequests, clear) {
  installPiChromeInstrumentation();
  const state = getPiChromeState();
  const currentUrl = location.href;
  const requests = state.network
    .filter((request) => includePreservedRequests || request.pageUrl === currentUrl)
    .map(({ responseBody, ...summary }) => ({ ...summary, hasResponseBody: responseBody !== undefined }));
  if (clear) state.network = [];
  return { requests, count: requests.length, note: "Captures fetch/XHR after instrumentation is installed. Browser-initiated document/static asset requests are not captured." };
}

function getNetworkRequest(requestId) {
  installPiChromeInstrumentation();
  const request = getPiChromeState().network.find((entry) => entry.id === requestId);
  if (!request) throw new Error(`No network request with id ${requestId}`);
  return request;
}

function normalizeKey(key) {
  const table = {
    enter: "Enter",
    escape: "Escape",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
  };
  return table[String(key).toLowerCase()] || key;
}
