---
name: chrome-connector
description: "Drive the user's real Chrome with the chrome_* tools (pi-chrome-connector) to test and verify web apps: navigate, read the page as an accessibility snapshot, click/fill/type with real input, wait for state, then prove the result with evaluate, console, network and screenshots. Use whenever a task involves opening, testing, verifying, debugging or scraping a web page in Chrome."
---

# Chrome connector

You control the user's real Chrome profile (signed-in sessions, cookies, extensions) through a
companion extension. There is no authorization step: if the tools are registered, use them.
If Chrome is not running, the first call launches it. All tools act on the **current tab**, which
lives in a dedicated agent window opened on first use; the user's own tabs are untouched unless
you `chrome_tabs use` one of them.

## The loop

```
chrome_navigate url            ->  loaded? HTTP status? console errors during load?
chrome_snapshot                ->  refs (e12) for everything interactive
chrome_click / chrome_fill /
chrome_type / chrome_press     ->  each reports "Since: navigated to…; N console errors; M failed requests"
chrome_wait                    ->  selector / text / function / url / networkidle (never sleep-and-hope)
chrome_evaluate                ->  assert exact state: text, counts, URL, app store
chrome_console level=error     ->  clean console is part of "verified"
chrome_network failedOnly=true ->  no failed API calls
chrome_screenshot              ->  visual confirmation you can see, saved to disk for the user
```

Reading the "Since:" line and network output: "failed requests" are real (network errors, HTTP
4xx/5xx). "blocked by a browser extension" is the user's ad blocker eating telemetry (Sentry,
Datadog, LaunchDarkly events); "canceled by the page" is the app closing its own streams or
navigating away; "aborted by chrome_route" is your own rule. Only the first kind is evidence of
an app problem. Console lines tagged `[error/network]` are the same events with their URL.

Snapshots are for finding and reading; screenshots are for seeing. Do both before claiming a UI
is correct. A snapshot proves an element exists, not that it is clickable: only a real
`chrome_click` followed by a state assertion proves that. Element and viewport screenshots have no
side effects; `fullPage` briefly re-lays out the page, so take it after your assertions, not
between a fill and its check.

Slow backends: `chrome_navigate` reports `networkidle not reached; N in flight: url, ...` with
the URLs it is waiting on. Long API calls on a cold staging backend are a finding about the
backend, not a reason to retry the navigation.

## Locating elements

Prefer refs from `chrome_snapshot` / `chrome_find`. Fall back to `text` (visible label) and then
`selector`. Refs are tied to DOM nodes: they survive re-renders that keep the node, and die on
navigation or when a framework replaces the node. "Ref is no longer in the DOM" means take a new
snapshot, it does not mean the element is gone.

`chrome_find text="Save"` is cheaper than a full snapshot when you know what you want.
`chrome_snapshot selector="#dialog"` scopes to one region. `mode: "full"` includes plain text.

## Forms and login

- `chrome_fill` sets a value in one go with trusted input events (React/Vue safe). Use it for
  text, textarea, contenteditable, select (by label), checkbox/radio (`"true"`/`"false"`), date
  (`YYYY-MM-DD`), number, color, range.
- `chrome_type` types key by key: use it for typeahead / autocomplete fields, then `chrome_press
  ArrowDown Enter` to pick a suggestion.
- Credentials: `chrome_fill secret: "APP_PASSWORD"` (names listed by `chrome_status`). The value
  never enters the conversation. Do not ask the user to paste passwords into chat when a secret
  exists. Sessions persist in the profile, so check whether you are already logged in before
  logging in again (navigate to the app and look at the snapshot).
- No secret configured? Say so and offer two paths: the user adds one to
  `~/.pi/agent/chrome-connector.json` under `"secrets"`, or logs in by hand in the Chrome window
  while you `chrome_wait url="/dashboard" timeoutMs=300000`.
- To test as a logged-out or different user: `chrome_storage store=site action=clear`, then
  reload.

## SPA navigation and timing

- After a click that routes client-side, the `Since:` line shows the new URL. Confirm with
  `chrome_evaluate location.pathname` and a `chrome_wait` on something the new view renders.
- `chrome_wait load=networkidle` after data-heavy actions; `chrome_wait selector=".toast"
  state=visible` for feedback; `state=hidden` for spinners to disappear.
- Never poll with repeated snapshots or `timeMs` waits when a condition can be expressed.

## When something blocks

- "covered by <div.overlay>": a modal, cookie banner or dropdown is on top. Close it (click its
  close control, `chrome_press Escape`) or scroll; `force: true` only when you know the overlay
  is transparent to clicks.
- "inside an inert container": you targeted a control in a collapsed drawer or behind an open
  dialog by selector. The snapshot never lists those, so prefer refs; otherwise open the drawer
  (click its toggle) and retry.
- "Chrome does not allow the debugger on chrome://…": internal pages, the Web Store and other
  extensions' pages cannot be automated. Pick a normal web page tab.
- "A JavaScript alert dialog is open": `chrome_dialog accept|dismiss`; set
  `chrome_dialog policy=accept` for flows that spam confirms.
- Native Chrome UI (file pickers, permission bubbles, password-manager popups, print dialogs)
  is outside the DOM. `chrome_upload` bypasses the file picker; permissions need the user.
- Tab closed / debugger detached (DevTools opened on the tab): `chrome_tabs list`, then `use` or
  `new`.
- Chrome disconnected: retry once; the connector reconnects and relaunches Chrome if needed. If
  it keeps failing, tell the user to run `/chrome doctor`.

## DevTools questions

- What did the app send? `chrome_network list urlIncludes=/api/` then `get id=#N` (headers,
  payload, response body, timing). WebSocket frames and EventSource messages are captured too.
- Why is the UI broken? `chrome_console level=error stack=true`, `chrome_dom styles`,
  `chrome_dom rect`, `chrome_dom listeners`.
- Test failure handling without touching the backend: `chrome_route add url="*/api/orders*"
  status=500 json={...}`; slow network: `chrome_emulate network=slow-3g`; offline:
  `chrome_emulate offline=true`. Capture a destructive POST instead of sending it:
  `chrome_route add url="*/api/delete*" mode=abort`, perform the action, then `chrome_route list`
  shows the captured payload. Routes work for an API on a different host than the page (the
  usual SPA setup): preflights and CORS headers are handled for you.
- Reading tokens: `chrome_storage` and `chrome_network get` redact credential-looking values.
  When you genuinely need one (decode a JWT to find the org id), pass `reveal: true` to
  chrome_storage and say so in your report.
- Mobile / dark mode / locale: `chrome_emulate device="iPhone 15" colorScheme=dark locale=de-DE`;
  `reset: true` afterwards.
- Evidence for a PR: `chrome_screenshot path="docs/feature-empty.png"`, `chrome_pdf`,
  `chrome_network action=har`.

## Iframes

`chrome_frames` lists them. Pass `frame` (id, name, or URL substring) to snapshot, find, click,
fill, evaluate and wait. Cross-origin iframes work (they run out-of-process; the tools handle it).

## Etiquette

- The Chrome window comes to the front on each action by default. Pass `focus: false` for
  read-only checks the user does not need to watch; `/chrome focus off` turns it off for the
  session.
- Do not close the user's tabs. `chrome_tabs close` without an id closes the current agent tab
  only. `/chrome cleanup` (user command) closes everything the session opened.
- Report what you verified and how (which assertion, which screenshot path), and what you could
  not verify.
