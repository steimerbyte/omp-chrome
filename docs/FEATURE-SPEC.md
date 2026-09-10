# Feature Spec — pi-chrome Companion Status Popup

> Living document. Add new sections at the bottom with the next planned
> feature, then implement. Update the "Status" column as work progresses.

## Architecture recap

- The **service worker** in `extensions/chrome-profile-bridge/browser-extension/service_worker.js`
  polls `http://127.0.0.1:17318` for commands and posts results back. It owns
  the connection state machine (`offline` / `online` / `auth`) and pushes a
  fresh `StatusSnapshot` into `chrome.storage.session` every 2 seconds.
- The **popup** (`ui/status.html` + `ui/status.js`) reads the latest snapshot
  from storage synchronously on open, then opens a long-lived port for live
  updates. It calls back into the worker for any command the operator wants
  to run (authorize, revoke, doctor, background toggle, etc.).
- **omp** (the Pi-side plugin in `~/.omp/agent/extensions/index.ts`) owns the
  HTTP bridge on `127.0.0.1:17318`. It exposes:
  - `/status` — connection snapshot (used by the popup's bridge probe)
  - `/next`, `/result` — long-poll command queue
  - `/__pi_chrome_shell` — automation-target HTML page
  - `GET /__pi_chrome_control` — Two-Way API for popup commands (next feature)

## Features

| ID  | Title                            | Status      | Where                                                                                                |
| --- | -------------------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| F1  | Connection status toolbar LED   | shipped 0.15.53 | `service_worker.js` — `chrome.action.setBadgeBackgroundColor` / `setBadgeText` driven by `connectionState` |
| F2  | Bridge probe (popup side)       | shipped 0.15.55 | `service_worker.js` — `probeBridge()` does `GET /status` with 1.5s AbortController                     |
| F3  | chrome.storage.session snapshot | shipped 0.15.56 | `service_worker.js` — `pushStatusToStorage()` every 2s, popup reads in `bootstrap()`                  |
| F4  | NVIDIA + AMOLED popup theme     | shipped 0.15.55 | `ui/status.html` — CSS color tokens                                                                  |
| F5  | Debug accordion                  | shipped 0.15.55 | `ui/status.html` — `<details>` with full snapshot JSON rendered                                      |
| F6  | Copy diagnostic / Doctor clip   | shipped 0.15.55 | `ui/status.js` — `navigator.clipboard.writeText`                                                      |
| F7  | Refresh button                   | planned       | `ui/status.html` + `ui/status.js`                                                                     |
| F8  | Two-Way API: authorize / revoke  | planned       | new `GET /__pi_chrome_control` route on omp + popup UI                                              |
| F9  | Two-Way API: doctor run          | planned       | new `GET /__pi_chrome_control?action=doctor` route on omp + popup UI                                  |
| F10 | Two-Way API: background toggle   | planned       | new `GET /__pi_chrome_control?action=background&on=false` route on omp + popup UI                      |
| F11 | Force-reload companion           | planned       | popup button → `chrome.runtime.reload()`                                                              |
| F12 | Open /chrome picker in a tab     | planned       | popup button → `chrome.tabs.create({ url: '...' })` after writing the command to bridge storage        |

## Snapshot shape

```ts
type StatusSnapshot = {
  type: "status";
  state: "offline" | "online" | "auth";
  companionVersion: string;
  bridgeUrl: string;
  bridgeProbe: {
    ok: boolean;
    status: number;
    latencyMs: number;
    mode: "server" | "client" | "?";
    error: string;
    url: string;
  };
  lastSuccessAt: number;        // epoch ms, 0 if never
  lastAuthAt: number;            // epoch ms, 0 if never
  lastError: string;
  automationTargetCount: number;
};
```

## Bridge HTTP surface (current + planned)

| Method | Path                       | Purpose                                              | Status |
| ------ | -------------------------- | ---------------------------------------------------- | ------ |
| GET    | `/status`                  | connection snapshot for probe                         | shipped |
| GET    | `/next?name=<extensionId>` | long-poll for commands                               | shipped |
| POST   | `/result`                  | command result                                       | shipped |
| GET    | `/__pi_chrome_shell`        | automation target HTML                               | shipped |
| GET    | `/__pi_chrome_control?action=authorize&duration=30m` | authorize this Pi session for chrome_* tools | planned |
| GET    | `/__pi_chrome_control?action=revoke`             | revoke Chrome control                          | planned |
| GET    | `/__pi_chrome_control?action=doctor`              | run `/chrome doctor`, return formatted text    | planned |
| GET    | `/__pi_chrome_control?action=background&on=true`  | toggle background mode, return new state       | planned |
| GET    | `/__pi_chrome_control?action=companion-reload`    | ask companion to self-reload                   | planned |

All `/__pi_chrome_control` routes return JSON: `{ ok: boolean, result?: unknown, error?: string }`.
omp-side authentication: only allowed from `chrome-extension://` origins (mirror the
existing `isBrowserOriginAllowed` check used for `/next`).

## Testing strategy

- **Unit (`test-suite/unit/*.test.mjs`)** — run with `npm test`. Existing
  suites cover automation targets, csp-eval, session-cleanup,
  background-policy, input-reliability, chrome-command, badge-status.
- **Integration (`test-suite/integration/popup-race.test.cjs`)** —
  loads the companion in real headless Chromium via puppeteer-core,
  opens the popup as a tab, asserts the DOM after the storage round-trip.
  Runs when `node test-suite/integration/popup-race.test.cjs` is invoked
  explicitly (no CI required).
- **Bridge contract test (`test-suite/integration/bridge-control.test.cjs`)** —
  planned. Spins up a real omp bridge on a random port and exercises
  each `/__pi_chrome_control` route from a fake browser origin.

## Decision log

- **Why chrome.storage.session and not chrome.storage.local?**
  MV3 worker suspension + the popup's short-lived scope. Local would
  survive forever and leak stale state across sessions. Session is
  scoped to the browser session, which is exactly what we want.
- **Why push every 2s instead of on state change?**
  State-change pushes would need event listeners across the worker /
  popup / bridge boundary. A periodic push keeps the worker dumb and
  the popup tolerant to missed events.
- **Why externalize status.js?**
  MV3 default CSP for extension pages is `script-src 'self'`. Inline
  `<script>` blocks are silently rejected.
