
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
      $("ledDot").className = "led-dot " + meta.dotClass;
      $("ledRing").className = "led-ring " + meta.ringClass;
      $("statePill").className = "state-pill " + meta.pill;
      $("statePill").textContent = meta.label;
    }
    function renderProbe(probe) {
      const el = $("bridgeProbe");
      const text = $("probeText");
      const dot = $("probeDot");
      el.classList.remove("ok", "warn", "error");
      if (!probe) {
        dot.className = "probe-dot";
        text.textContent = "no probe yet";
        return;
      }
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
      $("ver").textContent = snapshot.companionVersion || "?";
      $("bridge").textContent = snapshot.bridgeUrl || "—";
      $("bridgeShort").textContent = shortBridge(snapshot.bridgeUrl);
      $("targets").textContent = String(snapshot.automationTargetCount ?? 0);
      renderProbe(snapshot.bridgeProbe);

      const dbg = $("debugBody");
      const rows = [
        ["companionVersion", snapshot.companionVersion],
        ["bridgeUrl",        snapshot.bridgeUrl],
        ["state",            snapshot.state],
        ["automationTargets",snapshot.automationTargetCount],
        ["lastSuccessAt",    snapshot.lastSuccessAt ? new Date(snapshot.lastSuccessAt).toISOString() : "never"],
        ["lastAuthAt",       snapshot.lastAuthAt ? new Date(snapshot.lastAuthAt).toISOString() : "never"],
        ["lastError",        snapshot.lastError || "(none)"],
      ];
      dbg.innerHTML = rows
        .map(([k, v]) => `<div><span class="k">${k}</span> <span class="v">${escapeHtml(String(v))}</span></div>`)
        .join("");
    }

    function escapeHtml(s) {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function toast(msg) {
      const el = $("toast");
      el.textContent = msg;
      el.classList.add("show");
      clearTimeout(toast._t);
      toast._t = setTimeout(() => el.classList.remove("show"), 1500);
    }
    let port = null;
    // Try a one-shot sendMessage first; if the service worker is asleep this triggers a wakeup
    // before chrome.runtime.connect succeeds. Then long-lived port for live updates.
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
    // Bootstrap: read the latest cached snapshot from chrome.storage.session synchronously.
    // The service worker pushes a fresh snapshot every ~2s, so this is never older than that
    // and always wins the race against any in-flight port/sendMessage round-trip.
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
    // status.html is in their popup cache. Falls back to '?' if chrome.runtime is missing.
    try {
      $("ver").textContent = chrome.runtime.getManifest().version;
    } catch {}
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
  