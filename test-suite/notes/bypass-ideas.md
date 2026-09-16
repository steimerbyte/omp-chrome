# Historical bypass notes

This file predates the current `trusted:true` / `chrome.debugger` path and is
kept as design history. For current benchmark expectations, recipes, and
capability notes, use `../manifest.json`.

Older context: `pi-chrome` originally ran mostly through a content-script bridge.
That limited the solution space — most "real-event" tricks needed the
`chrome.debugger` API or `chrome.input.synthesizeMouseEvent`.

## 01–02 isTrusted click / keyboard
**Hard.** `Event.isTrusted` is true only for events the browser dispatched
itself. Two viable paths:

- **`chrome.debugger` + `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`.**
  Adds `"debugger"` permission. Chrome shows a "X is debugging this browser"
  banner, but events arrive as `isTrusted=true`. Best fix for the highest-value
  cases; gate it behind a toggle the user opts into.
- **`chrome.input.ime.*`** — not applicable for general typing.

Today's `dispatchEvent` path will always fail any `isTrusted` check.

## 03 / 12 webdriver + fingerprint
Cheap wins:
- Stub `navigator.webdriver` via `chrome.scripting.executeScript({ world: "MAIN", injectImmediately: true, … })` that defines `navigator.webdriver` getter to `undefined`. Already half-supported through `initScript` on `chrome_navigate` — extend to a per-tab content script registered with `chrome.scripting.registerContentScripts({ runAt: "document_start", world: "MAIN" })`.
- Spoof languages/plugins/permissions only if the user explicitly enables it — by default the real Chrome profile already looks legitimate. The bigger risk is `chrome_evaluate` *itself* leaving traces (Function-constructor stack frames in errors).

## 04 mouse entropy
Generate a humanised pointer path before any click:
- Bezier interpolation from current cursor pos (or a random off-target start) to the target point.
- 20–60 steps, easing curve, ±jitter on each step, varying `movementX/Y`.
- Implement in `clickPage` before the existing pointerdown sequence; reuse `pointerEventSequence` for each interpolated point.

## 05 event timing
- Insert `await sleep(rand(40,140))` between `pointerdown` and `pointerup`.
- Insert `await sleep(rand(80,220))` between successive synthesised clicks when
  the caller issues them in a loop.
- Vary by ±20%.

## 06 click coordinates
- After resolving target rect in `clickPage`, pick `(cx ± rand(-rw*0.3,rw*0.3), cy ± rand(-rh*0.3,rh*0.3))` instead of dead center. Already returns the chosen point — keep that.

## 07 pointer properties
- Set `pressure: 0.5` for `pointerdown` (currently inits don't set pressure; browser default for mouse pointerdown is 0.5).
- Set `pointerId: 1` for mouse (already done) and 2+ for touch.
- Carry `movementX/Y` from the previous interpolated step (needs path state).

## 08 / 09 keyboard cadence + framework invariants
- Per character: dispatch `keydown` (cancelable, fills `key` + `code` + `keyCode`), then `keypress` for printables, then `beforeinput` `{inputType:"insertText", data:ch}`, then mutate the input's value to `cur+ch` via the native setter, then `input` `{inputType:"insertText", data:ch}`, then `keyup`. Sleep 40–120 ms between chars.
- Today the bridge fills the entire value in one go and emits one `beforeinput`/`input`. Replace with the per-char loop above.
- Make sure not to dispatch `compositionstart`/`compositionend` for plain ASCII.

## 10 user activation
**Impossible with synthetic events.** `navigator.userActivation.isActive` only
flips on browser-trusted events. Same fix as 01/02 — `chrome.debugger` path.
Document the limitation; offer a `useDebuggerForActivationGates` opt-in.

## 11 honeypot
Pure agent-side concern. Before filling/clicking by selector, the bridge could:
- Reject targets with `display:none`, `visibility:hidden`, `aria-hidden=true`,
  or off-screen position (`getBoundingClientRect()` outside viewport bounds and
  not scrolled-into-view), unless the caller passes `force: true`.
- That logic largely exists (`elementVisible` / `occludedBy` are returned) —
  promote it from informational to a guard.

## 13 focus order
- When clicking a focusable element, dispatch `pointerdown` first; only after
  `mousedown` defaults run let focus settle naturally (browser will move focus
  on the synthetic `mousedown` only if `isTrusted` is true — alas, no). Manual
  workaround: dispatch the pointer/mouse sequence, then explicitly call
  `target.focus({ preventScroll: true })`, then dispatch `focus` with
  `{ relatedTarget: previouslyFocused }`. Set `:focus-visible` heuristic via
  `target.blur(); target.focus({ focusVisible: false })` (Chrome 124+).

## 14 wheel scroll
- For scroll operations, dispatch sequential `wheel` events with `deltaY`
  chunks (e.g., 60–120 per tick), and let the browser scroll, instead of
  setting `scrollTop` directly. Provide `chrome_scroll({ uid, dy, dx })` as a
  first-class tool.
