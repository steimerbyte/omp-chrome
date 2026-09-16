# BrowserGym compatibility contract

Pi-chrome benchmark tasks mirror BrowserGym without importing Gymnasium.

## Task fields

Each `task-manifest.json` entry maps to `AbstractBrowserTask` concepts:

- `taskId` / `id` — stable namespaced id
- `seed` — deterministic state seed
- `viewport`, `slowMoMs`, `timeoutMs`, `locale`, `timezoneId`
- `goal` and `goalObject` — text and OpenAI-style message objects
- `setupUrl` — page URL that performs setup from `task`, `run`, `seed`
- `validateScript` — JS validate hook returning reward contract
- `cheatScript` — gold recipe used to sanity-check grader
- `maxSteps`, `humanBaseline`, `difficulty`, `tags`
- `actionSubsets`, `allowedActions` — BrowserGym HighLevelActionSet metadata

## Reset / step return

Runner should expose:

```text
reset() -> (obs, info)
step(action) -> (obs, reward, terminated, truncated, info)
```

`terminated` means task done. `truncated` means max step or timeout.

## Validate return

In-page validators return:

```js
{ reward, done, message, info }
```

`reward` is incremental. Current hermetic tasks use binary terminal reward. `info.rubric` carries per-check details.

## Observation schema target

Runner observations should include BrowserGym-like keys:

- `chat_messages`
- `goal`, `goal_object`
- `open_pages_urls`, `open_pages_titles`, `active_page_index`
- `url`, `screenshot`, `dom_object`, `axtree_object`
- `extra_element_properties`
- `focused_element_bid`
- `last_action`, `last_action_error`
- `elapsed_time`

## BID plan

BrowserGym uses `bid` attributes as stable element handles. Pi-chrome currently returns snapshot `uid`. Compatibility path:

1. During snapshot, assign every interactive element a deterministic `bid`.
2. Return both `uid` and `bid`.
3. Add `visibility`, `bbox`, `clickable`, `set_of_marks` metadata.
4. Maintain uid↔bid mapping so agents can use either addressing mode.

Target attributes:

- `bid`
- `browsergym_visibility_ratio`
- `browsergym_set_of_marks`

## Action subsets

See `../browsergym-action-space.json` for BrowserGym-compatible subsets and function signatures.
