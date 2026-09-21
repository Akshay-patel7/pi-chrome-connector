# pi-chrome-connector

Agent-first Chrome connector for the [pi coding agent](https://pi.dev). Pi drives your real,
signed-in Chrome through a small companion extension: tabs, keyboard and mouse, accessibility
snapshots, screenshots, console, network (with bodies and HAR export), request mocking, storage,
device emulation, iframes, dialogs, PDF.

Built for one workflow: the agent tests and verifies web apps in the browser you already use.

## How it works

```
 pi (one bridge per session)                     Chrome (your profile)
 +--------------------------------+              +------------------------------+
 | chrome_* tools, /chrome        |   WebSocket  | pi-chrome-connector          |
 | WebSocket server 127.0.0.1     |<============>| (unpacked MV3 extension)     |
 |   :17417-17426                 |              | thin proxy for chrome.tabs,  |
 | CDP logic: snapshots, input,   |              | chrome.windows and           |
 |   console/network buffers,     |              | chrome.debugger (CDP)        |
 |   routes, emulation            |              +---------------+--------------+
 +--------------------------------+                              | DevTools Protocol
                                                          tabs and frames
```

- All automation logic runs inside pi in TypeScript. The extension is a ~300-line proxy that
  rarely changes, so package updates do not need an extension reload.
- The bridge only listens on loopback and only accepts sockets whose `Origin` is a
  `chrome-extension://` URL, so web pages cannot reach it. It does not verify *which* extension
  is on the other end; read [Security](#security) before installing this on a machine you share
  or alongside extensions you do not trust.
- The extension finds live sessions by fetching `/status` on each port in the range and opens a
  WebSocket only where a bridge answers. Ports with nothing behind them are probed with backoff
  (2, 4, 8, then every 15 s) and never show up as errors on `chrome://extensions`.
- A 20 s heartbeat over the socket keeps the extension's service worker alive (Chrome 116+), and
  a 30 s alarm wakes it if it ever sleeps.
- No authorization gate and no expiry: once the extension is connected, the tools work.
- The agent gets its own window; your tabs are left alone unless the agent is told to use one.
- Agent-created tabs stay open when the session ends so you can inspect the result.
  `/chrome cleanup` closes them.

## Install

```bash
pi install npm:pi-chrome-connector      # or: pi install /path/to/this/repo
```

Then, once, load the companion extension into Chrome:

```
/chrome onboard
```

It opens `chrome://extensions`, reveals the extension folder and copies its path. Turn on
**Developer mode**, click **Load unpacked**, pick the folder (Cmd+Shift+G and paste on macOS).
The extension shows up as "pi-chrome-connector". If you used pi-chrome before, remove its
"Pi Chrome Connector" entry and `pi remove npm:pi-chrome`, since both register `chrome_*` tools.
Then:

```
/chrome doctor
```

Everything should be a ✓. From now on, asking pi to "open localhost:3000 and check the
dashboard" just works, including launching Chrome when it is closed.

Requirements: Chrome 125+ (Chrome for Testing and Chromium work too), Node 24+, pi 0.86+.

## Tools

| Tool | Purpose |
| --- | --- |
| `chrome_status` | Connection state; launches Chrome if needed; lists secret names |
| `chrome_tabs` | list / new / use (by id, url, title) / close / focus |
| `chrome_navigate` | goto / back / forward / reload with load, domcontentloaded or networkidle |
| `chrome_snapshot` | Accessibility tree with refs (`e12`), `[offscreen]` and `[clickable]` markers |
| `chrome_find` | Elements by text, role, or CSS selector, with refs |
| `chrome_click` | Real mouse click by ref / selector / text / coordinates; occlusion detection |
| `chrome_hover` | Pointer move |
| `chrome_fill` | Set any form control's value with trusted input events; `secret: NAME` for credentials |
| `chrome_type` | Key-by-key typing for typeahead fields |
| `chrome_press` | Keys and chords: `Enter`, `Control+a`, `Meta+Shift+p`, sequences |
| `chrome_scroll` | Wheel scrolling of page or container; to top / bottom / element |
| `chrome_select` | `<select>` options by value or label |
| `chrome_upload` | Attach files to a file input without the OS picker |
| `chrome_mouse` | Raw move / down / up / wheel / drag |
| `chrome_evaluate` | JavaScript with awaited promises, refs bound as `el`, iframe support, CSP-proof |
| `chrome_wait` | selector state, text, function, URL, load state, networkidle, or plain time |
| `chrome_screenshot` | Viewport / full page / element, returned inline and saved to disk |
| `chrome_console` | console.*, uncaught exceptions, browser log entries; level / since / includes filters |
| `chrome_network` | Every request with headers, payloads, bodies, timing; filters; HAR export |
| `chrome_route` | Mock, abort, delay or capture requests by URL glob |
| `chrome_dom` | outerHTML, innerText, attributes, computed styles, box geometry, event listeners |
| `chrome_storage` | Cookies, localStorage, sessionStorage, clear site data |
| `chrome_emulate` | Device presets, viewport, UA, dark mode, reduced motion, locale, timezone, geolocation, offline, throttling |
| `chrome_dialog` | Accept / dismiss JavaScript dialogs, auto-handling policy |
| `chrome_frames` | List iframes (same-process and out-of-process) |
| `chrome_performance` | Navigation timing, Web Vitals, long tasks, resource summary, heap |
| `chrome_pdf` | Print to PDF |

Every action reports what changed since it started: navigation, new console errors, failed
requests, open dialogs. Requests an ad blocker stopped, requests the page canceled itself, and
requests a `chrome_route` rule aborted are counted apart from real failures, so telemetry noise
never reads as an app error. Credential headers (`authorization`, `cookie`, API keys) are
redacted in tool output, and so are credential-looking cookie and storage values (`reveal: true`
shows them); the HAR export on disk stays complete. `chrome_route` mocks work for APIs on another
origin than the page: CORS preflights are answered and `access-control-allow-origin` is added
automatically. The bundled skill (`skills/chrome-connector`) teaches the agent the navigate →
snapshot → act → wait → verify loop.

## Commands

```
/chrome              status
/chrome onboard      load the companion extension (one time)
/chrome doctor       diagnostics
/chrome launch       launch Chrome and wait for the extension
/chrome tabs         list tabs
/chrome focus on|off bring Chrome to the front on actions (default on)
/chrome cleanup      close tabs this session opened
```

## Configuration

Optional `~/.pi/agent/chrome-connector.json` (or `$PI_CHROME_CONNECTOR_CONFIG`):

```json
{
  "chromeApp": "Google Chrome",
  "launchArgs": ["--silent-debugger-extension-api"],
  "focus": true,
  "window": { "width": 1280, "height": 900 },
  "artifactDir": "~/.pi/agent/chrome-connector",
  "portRange": [17417, 17426],
  "reuseWindow": false,
  "secrets": {
    "APP_EMAIL": "you@example.com",
    "APP_PASSWORD": "..."
  }
}
```

`secrets` lets the agent log in with `chrome_fill secret: "APP_PASSWORD"` without the value ever
appearing in the conversation or the session transcript. Environment variables are used as a
fallback for names not in the file. The agent can still read a value back out of the page after
typing it (it is a browser, not a vault); treat this as convenience for test accounts, not as
protection against a malicious model, and see [Security](#security) for who else could receive a
secret while pi is running. Logins persist because the agent runs in your real
profile: cookies and "remember me" state survive Chrome restarts as usual. To test logged out,
ask for `chrome_storage store=site action=clear`.

`launchArgs` only apply when the connector launches Chrome itself (`open -a` on macOS opens
your default profile; the extension must be loaded in that profile). The default flag hides the
"pi-chrome-connector started debugging this browser" bar. A Chrome you started yourself shows
that bar; it is harmless, but its Cancel button detaches the agent from the tab (the next tool
call reattaches). Quit Chrome and let the connector relaunch it if you want the bar gone.

Change `portRange` only if you also edit `PORT_RANGE` in `chrome-extension/service_worker.js`.

## Security

Read this before installing. The trade-offs are deliberate, but you should accept them knowingly.

**The bridge does not authenticate the extension on the other end.** It listens on
`127.0.0.1:17417-17426` and accepts any WebSocket whose `Origin` header starts with
`chrome-extension://`. That check keeps web pages out, because browsers set `Origin` themselves
and a page can never forge that value. It does not identify *which* extension connected, and any
process running as your user can set that header by hand. So two things can take the companion's
place:

- another extension installed in your Chrome profile, and
- any local program running as you.

An impostor that wins the handshake becomes "the browser" as far as pi is concerned. It receives
whatever the agent sends, which includes values resolved from `secrets`, and it can answer with
invented page content that the agent will then act on and report to you as fact. It cannot drive
your real Chrome by itself; the damage is what it is told and what it tells the agent back.

What this does and does not change about your threat model:

- A local program running as you can already read your files, your Chrome profile and your
  cookies. If one is running, this package is not what is protecting you.
- Other **browser extensions** are the case worth thinking about. They are sandboxed from your
  filesystem but can open a WebSocket to localhost, so an extension that could not otherwise read
  your agent's traffic can read it while pi is running.
- Nothing off your machine can reach the bridge. It binds to loopback only.

How to keep the exposure small:

- Install browser extensions you trust, and prefer a Chrome profile without unknown ones.
- Put test-account credentials in `secrets`, not production ones.
- The bridge only exists while a pi session is running; it closes on exit.
- On a shared or multi-user machine, treat this as unsuitable until extension pinning lands.

Planned: pin the companion's extension id on first connect and require an explicit confirmation
before a different id may take over. Until that ships, the paragraph above is the honest state.

Two more things worth knowing:

- The companion has `debugger` and `<all_urls>` permissions in the profile you load it into, and
  page content the agent reads is sent to your configured model provider.
- Credential-looking values are redacted in tool output (`authorization` headers, session
  cookies, JWT-shaped storage values), but a determined agent can still read a secret out of the
  page after typing it. Redaction reduces accidental exposure in transcripts; it is not a vault.

## Limits

- Native Chrome UI is outside the DOM: file pickers (use `chrome_upload`), permission bubbles,
  password-manager popups, print dialogs, CAPTCHAs.
- Site permissions (geolocation, notifications) cannot be granted from the connector; Chrome
  prompts once and the user clicks Allow.
- Opening DevTools on a tab the agent controls detaches the agent from that tab.
- Google Chrome branded builds no longer accept `--load-extension`; the integration tests use
  Chrome for Testing, and real use loads the extension unpacked through `chrome://extensions`.

## Development

```bash
npm install
npm run typecheck
npm test                  # unit tests (WebSocket framing, keyboard layout)
npm run test:integration  # launches Chrome for Testing with the extension; ~1 min
```

Integration tests need a Chrome for Testing or Chromium binary. They look in Playwright's cache
(`npx playwright install chromium`) or use `PI_CHROME_TEST_BINARY`. Set `PI_CHROME_TEST_HEADLESS=1`
to run headless.

Layout:

```
chrome-extension/         the companion (load this folder unpacked)
extensions/chrome/
  index.ts                pi entry point
  bridge/                 WebSocket server, wire protocol, Chrome launch
  cdp/                    per-tab CDP session, console/network logs, snapshot, keyboard, routes
  tools/                  chrome_* tools
  commands.ts             /chrome
skills/chrome-connector/  agent skill
test/unit, test/integration
```

## License

MIT
