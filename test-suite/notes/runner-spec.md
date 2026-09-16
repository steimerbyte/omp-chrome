# Recipe runner spec

Future Node/Pi runner should:

1. Read `manifest.json`.
2. Probe environment capabilities (`trusted`, `clipboard`, `touch`, `dialogs`, `downloads`, `fileSystem`, `strictCspFallback`).
3. For each entry:
   - read `gate` (`core`, `conditional`, `quality`) and score in that bucket
   - skip if `requires` is unsatisfied and expected is `CONDITIONAL`
   - navigate to challenge URL
   - execute `recipe` in order
   - wait `verdictDelayMs || 500`
   - evaluate `JSON.stringify({v:window.__verdict,r:window.__reason,d:window.Challenge?.state?.details,e:window.__events?.slice(-20)})`, except strict-CSP pages where eval is expected to fail; read persisted verdict from dashboard/localStorage after leaving the CSP page
   - compare to `expected[mode]`
4. Output:
   - Markdown summary
   - JSON details
   - JUnit XML for CI

Runner must adapt recipe intent:

- expand `${REPO_ROOT}` path placeholders
- adapt unsupported shadow/iframe selector notation to snapshot uids or evaluate fallback
- preserve hook install ordering for console/network capture tests
- substitute dynamic tab ids from `chrome_tab list` recipes
- support screenshot/coordinate fallback for strict CSP pages where snapshot/evaluate are blocked
- record whether trusted/CDP path was used

Long-horizon task runner should read `task-manifest.json`, replace `$RUN_ID`, solve task, then evaluate task grader expression.
