# Companion Status Popup — Architecture & Lessons Learned

This document captures the design and the four pitfalls that took several
attempts to find. Read it before touching the popup, the service worker,
or omp's bridge HTTP surface.

## Why a popup at all

The companion extension (`extensions/chrome-profile-bridge/browser-extension/`)
runs in the user's real Chrome profile. It polls `http://127.0.0.1:17318` for
commands from omp and posts results back. Operators have no other channel
to see whether the bridge is alive without opening a terminal, running
`/chrome doctor`, and parsing text output.

The toolbar action (`chrome.action`) is the standard place to surface this.
Manifest wires `default_popup: "ui/status.html"`, the worker maintains a
status state machine, and the popup renders a fresh snapshot on every
toolbar click.

## Status snapshot

The snapshot is a single object produced by `buildStatusSnapshot()` in
`service_worker.js`:

```ts
{
  type: "status",
  state: "connected" | "authorized" | "offline",
  companionVersion: string,
  bridgeUrl: string,
  bridgeProbe: { ok, status, latencyMs, mode, error, url },
  lastSuccessAt: number | 0,
  lastAuthAt: number | 0,
  lastError: string,
  automationTargetCount: number,
}
```

`bridgeProbe` is the result of an actual `GET ${BRIDGE_URL}/status`
round-trip the worker performs on every snapshot build. It is cached
for 1.5s and bounded by a 1.5s `AbortController` timeout.

## Race-condition problem and the storage workaround

**Symptom (took four commits to reproduce):** Popup renders empty
(`v—`, `OFFLINE`, `0` automation targets) even though
- `chrome.action` Badge updates correctly (green when bridge is reachable)
- `chrome.runtime.connect({ name: "popup" })` is wired up on both sides
- `chrome.runtime.sendMessage({ type: "popup.getStatus" })` returns the snapshot

**Cause:** MV3 action popups can close before the service worker finishes
the async chain that produces the snapshot. The popup reads its DOM
content, the user clicks elsewhere or the popup loses focus, and the
popup is gone before `port.postMessage(snapshot)` lands. The badge uses
`chrome.action` writes that don't depend on the popup being open, so
the badge updates but the popup never receives data.

**Fix:** The service worker continuously writes the latest snapshot into
`chrome.storage.session` every 2s (`pushStatusToStorage()`). The popup
reads that key synchronously in its bootstrap before any port round-trip:

```js
async function bootstrap() {
  const stored = await chrome.storage.session.get("piChromePopupSnapshot");
  if (stored?.piChromePopupSnapshot) render(stored.piChromePopupSnapshot);
  fetchOnce();
  connect();
}
bootstrap();
```

`chrome.storage.session` survives MV3 worker suspension but not browser
restart, which matches the popup's short-lived usage.

## Inline-script CSP problem

**Symptom (took an integration test to find):** Popup DOM renders, but
`ver.textContent` stays `'undefined'`, state pill stays `'offline'` even
though the worker is correctly pushing snapshots, and the JS console
shows:

```
Executing inline script violates the following Content Security Policy
directive 'script-src 'self''. Either the 'unsafe-inline' keyword, a
hash, or a nonce is required to enable inline execution. The action has
been blocked.
```

**Cause:** MV3 default CSP for `chrome-extension://<id>/` pages is
`script-src 'self'`. The popup had a `<script>` block with all the
runtime code; Chromium silently rejected it. The DOM rendered because
the `<style>` block is allowed by default; the JS never ran so
`render()` never fired.

**Fix:** Externalize the script to `ui/status.js` and load it via
`<script src="status.js"></script>`. Also add an explicit
`content_security_policy.extension_pages` entry to the manifest that
allows `style-src 'unsafe-inline'` so the inline `<style>` block keeps
working without externalizing CSS.

## Service-worker suspension and the version-mismatch reload

The service worker is a separate process that MV3 can suspend at any
time. To keep it from running stale code, the worker compares its
manifest version against the `x-pi-chrome-version` header that omp
sends with every `/next` response. If omp expects a newer version:

```js
if (expected && expected !== ours && isVersionOlder(ours, expected)) {
  chrome.runtime.reload();
}
```

The reload only fires when the worker is **older** than what omp
expects. If the worker is **newer** than omp's package.json, the
worker stays alive — omp picks up the new version from disk after
restart.

omp reads `pi-chrome` from these candidates in order:

1. `/mnt/c/Users/benjamin.steimer/pi-chrome/package.json` (Brave user's local fork — authoritative)
2. `<__dirname>/../../package.json` (standard sibling layout)
3. `<__dirname>/../../../package.json` (one level higher)

The first candidate is the one Brave actually loaded, so its version
matches the manifest the worker is running.

## Verifying with the integration test

`test-suite/integration/popup-race.test.cjs` loads the companion in a
real headless Chromium via puppeteer-core, opens the popup as a tab,
and asserts the DOM after the storage round-trip:

- service worker registers and pushes the snapshot to `storage.session`
- popup DOM contains a `<script src="status.js">` (not inline)
- `chrome.storage.session.get('piChromePopupSnapshot')` resolves with
  `{ companionVersion, bridgeUrl, state, bridgeProbe }`
- `bridgeProbe` has `{ ok: true, url, latencyMs, mode }`
- DOM after render shows real values (`ver = '0.15.56'`,
  `probeText = 'reachable · 200 server · 4ms'`)
- worker `chrome.action.getBadgeText({})` returns the state label

The test uses a fresh persistent profile at `/tmp/pi-chrome-integration-profile`
so the extension id is stable across runs and the tests are isolated.

## What this layout buys

- Popup opens in <1s after click; data is rendered before any async
  round-trip can be lost to a close
- The probe gives an honest "is omp reachable on this URL" signal that
  is independent of the long-poll connection state
- The popup renders identically whether the service worker just started
  or has been alive for hours — no stale state, no first-paint flicker
- The integration test catches every regression of this class because it
  drives a real Chromium with the same CSP and IPC surface the user has
