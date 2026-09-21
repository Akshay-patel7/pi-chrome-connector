// Defects found by the live sweep against hammer.staging, pinned against fixtures:
// cross-origin route mocking, credential redaction in storage, inert-drawer messages,
// chrome:// attach refusals, and scroll reports naming the container that moved.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { TabInfo } from "../../extensions/chrome/bridge/protocol.ts";
import { TabSession } from "../../extensions/chrome/cdp/session.ts";
import type { FakePi } from "./fake-pi.ts";
import type { FixtureServer } from "./harness.ts";
import { startToolTestEnv, type ToolTestEnv } from "./setup.ts";

let env: ToolTestEnv;
let pi: FakePi;
let fixtures: FixtureServer;

const evaluate = async (expression: string) => (await pi.callTool("chrome_evaluate", { expression })).text.split("\nSince: ")[0] as string;

before(async () => {
	env = await startToolTestEnv("sweep-fixes");
	({ pi, fixtures } = env);
});

after(async () => {
	await env.close();
});

test("routes answer CORS preflights and add allow-origin, so cross-origin API mocks work", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/cors.html` });
	const unrouted = JSON.parse(await evaluate("callApi('/api/json?x=1')")) as { ok: boolean };
	assert.equal(unrouted.ok, false, "without a route the browser blocks the call (fixture server sends no CORS headers)");

	await pi.callTool("chrome_route", { action: "add", url: "*/api/json*", json: { mocked: true }, status: 201 });
	await pi.callTool("chrome_route", { action: "add", url: "*/api/echo", method: "POST", mode: "abort", errorReason: "ConnectionRefused" });

	const mocked = JSON.parse(await evaluate("callApi('/api/json?x=2')")) as { ok: boolean; status: number; body: string };
	assert.deepEqual(mocked, { ok: true, status: 201, body: JSON.stringify({ mocked: true }) });
	const aborted = JSON.parse(await evaluate("callApi('/api/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: 'payload' }) })")) as { ok: boolean };
	assert.equal(aborted.ok, false);

	const list = await pi.callTool("chrome_route", { action: "list" });
	assert.match(list.text, /#1 \*\/api\/json\* → fulfill 201 — 1 hit\n    GET http:\/\/localhost:\d+\/api\/json\?x=2/, "the real GET is the hit, not its preflight");
	assert.match(list.text, /#2 POST \*\/api\/echo → abort \(ConnectionRefused\) — 1 hit\n    POST .*\/api\/echo body=\{"secret":"payload"\}/, "the POST body was captured; the preflight was answered, not aborted");
	assert.ok(!fixtures.requests.some((request) => request.body.includes("payload")), "aborted POST never reached the server");
	await pi.callTool("chrome_route", { action: "clear" });
});

test("a second pi session attached to the same tab does not answer another session's intercepted requests", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/cors.html` });
	const client = await env.connector.client();
	const tabId = env.connector.currentTab as number;
	// A second session on the same tab, with no routes of its own. chrome.debugger shares the
	// attachment, so it receives every Fetch.requestPaused this session pauses.
	const other = await TabSession.open(client, tabId);
	try {
		await pi.callTool("chrome_route", { action: "add", url: "*/api/json*", json: { mocked: true }, status: 201 });
		const result = JSON.parse(await evaluate("callApi('/api/json?x=3')")) as { ok: boolean; status?: number; body?: string };
		assert.deepEqual(result, { ok: true, status: 201, body: JSON.stringify({ mocked: true }) }, "the mock still wins");
		assert.deepEqual(other.diagnostics, [], "the other session did not try to answer it");
		await pi.callTool("chrome_route", { action: "clear" });
	} finally {
		await other.detach();
	}
});

test("a navigation drops the previous document's frames instead of advertising dead ones", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/frames.html` });
	await pi.callTool("chrome_wait", { function: "document.querySelectorAll('iframe').length === 2 && [...document.querySelectorAll('iframe')].every(f => f.src)", timeoutMs: 10_000 });
	await pi.callTool("chrome_wait", { timeMs: 500 });
	const before = (await pi.callTool("chrome_frames", {})).text;
	assert.match(before, /^3 frames:/, before);
	assert.match(before, /name="same-origin-frame"/);
	assert.match(before, /\[out-of-process\]/);

	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/index.html` });
	const after = (await pi.callTool("chrome_frames", {})).text;
	assert.match(after, /^1 frame:\nmain  id=\w+ .*\/index\.html$/, `frames after navigating away: ${after}`);
});

test("open shadow roots are snapshotted, pierced by selectors, clickable, and readable", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/shadow.html` });
	const snapshot = (await pi.callTool("chrome_snapshot", { mode: "full" })).text;
	assert.match(snapshot, /- button "Shadow button" \[e\d+\]/, "a control inside the shadow root is offered");
	assert.match(snapshot, /Inside the shadow root/);
	assert.match(snapshot, /Slotted label/);

	// Selectors reach shadow content with and without the >> hop.
	assert.equal((await pi.callTool("chrome_dom", { action: "text", selector: "#inner" })).text, "Inside the shadow root");
	assert.equal((await pi.callTool("chrome_dom", { action: "text", selector: "fancy-card >> #inner" })).text, "Inside the shadow root");
	// innerText is empty for a slot-only element; the reader falls back to textContent instead of returning nothing.
	assert.equal((await pi.callTool("chrome_dom", { action: "text", selector: "fancy-card >> slot" })).text, "(empty)", "a slot element holds no text of its own; assigned nodes live in the light DOM");

	const ref = /- button "Shadow button" \[(e\d+)\]/.exec(snapshot)?.[1];
	assert.ok(ref);
	await pi.callTool("chrome_click", { ref });
	assert.equal(await evaluate("document.getElementById('result').textContent"), "shadow button clicked", "a real click reached the shadow button");
	await pi.callTool("chrome_evaluate", { expression: "document.getElementById('result').textContent = 'nothing clicked'" });
	await pi.callTool("chrome_click", { selector: "fancy-card >> #shadow-button" });
	assert.equal(await evaluate("document.getElementById('result').textContent"), "shadow button clicked", "selector piercing clicks the same control");
});

test("a click that submits a slow form reports the page it lands on, not the one it left", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/slow-form.html` });
	const click = await pi.callTool("chrome_click", { selector: "#send" });
	assert.match(click.text, /navigated to http:\/\/127\.0\.0\.1:\d+\/slow-form/, `click delta: ${click.text}`);
	assert.equal(await evaluate("document.querySelector('h1').textContent"), "Order received", "the click waited for the POST to land");
	assert.match(await evaluate("document.getElementById('echo').textContent"), /who=pi-connector/);
});

test("navigating to an HTTP error status reports the status instead of throwing", async () => {
	const result = await pi.callTool("chrome_navigate", { url: `${fixtures.url}/status/500` });
	assert.match(result.text, /\(HTTP 500\)/, `navigate result: ${result.text}`);
	assert.match(result.text, /\(HTTP 500\) \(error status with no renderable body\)/);
	// Chrome swaps in its own error document (chrome-error://chromewebdata/), so the page's own
	// location is not the requested URL; the connector reports the tab's URL, which is.
	assert.match(await evaluate("location.href"), /^chrome-error:\/\/chromewebdata\//);
	assert.match(await evaluate("document.body.innerText"), /This page isn.t working/);
	assert.match((await pi.callTool("chrome_status")).text, /Current tab: \[\d+\] "127\.0\.0\.1" http:\/\/127\.0\.0\.1:\d+\/status\/500/);
	assert.match((await pi.callTool("chrome_network", { action: "list", type: "Document", limit: 1 })).text, /GET 500 FAILED\(net::ERR_HTTP_RESPONSE_CODE_FAILURE\) document/, "the list shows the status and the load failure");
	// A host that does not exist is still a hard failure.
	await assert.rejects(pi.callTool("chrome_navigate", { url: "http://127.0.0.1:65530/nothing" }), /failed: net::ERR_CONNECTION_REFUSED/);
});

test("the frame id chrome_frames prints is accepted by the frame parameter", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/frames.html` });
	await pi.callTool("chrome_wait", { function: "document.querySelectorAll('iframe').length === 2", timeoutMs: 10_000 });
	await pi.callTool("chrome_wait", { timeMs: 600 });
	const listing = (await pi.callTool("chrome_frames", {})).text;
	const printedIds = [...listing.matchAll(/id=(\w+)/g)].map((m) => m[1] as string);
	assert.equal(printedIds.length, 3, listing);
	for (const id of printedIds.slice(1)) {
		const origin = (await pi.callTool("chrome_evaluate", { expression: "location.origin", frame: id })).text.split("\n")[0];
		assert.match(origin ?? "", /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, `frame id ${id} from the listing resolved to ${origin}`);
	}
	await assert.rejects(pi.callTool("chrome_evaluate", { expression: "1", frame: "nosuchframe" }), /No frame matches "nosuchframe"/);
});

test("a tab opened with a URL is ready to act on, not still on about:blank", async () => {
	// The server holds this page for 900ms; the tab exists (on about:blank) long before it arrives.
	const opened = await pi.callTool("chrome_tabs", { action: "new", url: `${fixtures.url}/slow-page?ms=900` });
	assert.match(opened.text, /Opened tab \[\d+\] http:\/\/127\.0\.0\.1:\d+\/slow-page\?ms=900 "Slow page"\. It is now the current tab\./, opened.text);
	// No wait in between: the very next action must find the real page.
	await pi.callTool("chrome_fill", { selector: "#late-input", value: "ready" });
	assert.equal(await evaluate("document.getElementById('late-input').value"), "ready");
	assert.equal(await evaluate("document.getElementById('ready').textContent"), "slow page ready");
	await pi.callTool("chrome_tabs", { action: "close" });
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/index.html` });
});

test("chrome_storage redacts credential-looking values unless reveal is passed", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/index.html` });
	const jwt = "eyJhbGciOiJSUzI1NiIsImtpZCI6InNzbyJ9.eyJzdWIiOiJ1c2VyXzEyMyIsImVtYWlsIjoiYUBiLmMifQ.c2lnbmF0dXJl";
	await pi.callTool("chrome_storage", { store: "localStorage", action: "set", name: "cached-token-for-app", value: jwt });
	await pi.callTool("chrome_storage", { store: "localStorage", action: "set", name: "theme", value: "dark" });
	await pi.callTool("chrome_storage", { store: "localStorage", action: "set", name: "profile", value: jwt });
	await pi.callTool("chrome_storage", { store: "cookies", action: "set", name: "session_id", value: "s3cr3t-session-value-abc" });
	await pi.callTool("chrome_storage", { store: "cookies", action: "set", name: "locale", value: "en-US" });
	// A long opaque value under a harmless name (cf_clearance, a signed blob) is a credential too.
	await pi.callTool("chrome_storage", { store: "cookies", action: "set", name: "cdn_pass", value: "gH7xK2mQ9pL4vR8tY3wZ6bN1cD5fS0jA7hU2kM9nP4qT6xV8yB3eG5iL7oR1sW4z" });
	await pi.callTool("chrome_storage", { store: "localStorage", action: "set", name: "layout", value: '{"sidebar":256,"collapsed":false,"panels":["grants","agents","artifacts"],"note":"structured JSON stays readable"}' });

	const list = (await pi.callTool("chrome_storage", { store: "localStorage", action: "list" })).text;
	assert.match(list, /cached-token-for-app = eyJhbGciOiJS… <redacted, \d+ chars>/, "credential-named key redacted");
	assert.match(list, /profile = eyJhbGciOiJS… <redacted, \d+ chars>/, "JWT-shaped value redacted even under a harmless key");
	assert.match(list, /theme = dark/);
	assert.doesNotMatch(list, /c2lnbmF0dXJl/);
	assert.equal((await pi.callTool("chrome_storage", { store: "localStorage", action: "get", name: "cached-token-for-app" })).text, "eyJhbGciOiJS… <redacted, 96 chars>");
	assert.equal((await pi.callTool("chrome_storage", { store: "localStorage", action: "get", name: "cached-token-for-app", reveal: true })).text, jwt);

	const cookies = (await pi.callTool("chrome_storage", { store: "cookies", action: "list" })).text;
	assert.match(cookies, /^session_id=s3cr3t-sessi… <redacted, 24 chars>  domain=/m);
	assert.match(cookies, /^locale=en-US  domain=/m);
	assert.match(cookies, /^cdn_pass=gH7xK2mQ9pL4… <redacted, 64 chars>  domain=/m, "long opaque value redacted regardless of its name");
	assert.match(list, /layout = \{"sidebar":256/, "structured JSON is not mistaken for a secret");
	assert.match((await pi.callTool("chrome_storage", { store: "cookies", action: "get", name: "session_id", reveal: true })).text, /^session_id=s3cr3t-session-value-abc  domain=/);
	await pi.callTool("chrome_storage", { store: "site", action: "clear" });
});

test("controls inside an inert drawer are refused with a reason instead of Chrome's raw error", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/form.html` });
	await assert.rejects(pi.callTool("chrome_fill", { selector: "#drawer-input", value: "x" }), /cannot take input: it is inside an inert container \(a collapsed drawer or a layer behind an open dialog\); open that container first/);
	await assert.rejects(pi.callTool("chrome_type", { selector: "#drawer-input", text: "x" }), /inside an inert container/);
	await assert.rejects(pi.callTool("chrome_click", { selector: "#drawer-input" }), /cannot be clicked: it is inside an inert container/);
	const rect = (await pi.callTool("chrome_dom", { action: "rect", selector: "#drawer-input" })).text;
	assert.match(rect, /visible: false \(inside an inert container: a collapsed drawer or a layer behind a dialog\), in viewport: partly/);
	assert.match((await pi.callTool("chrome_dom", { action: "rect", selector: "#submit" })).text, /visible: true, in viewport: yes/);
	assert.match((await pi.callTool("chrome_dom", { action: "rect", selector: "#far-button" })).text, /visible: true, in viewport: no/);
	// The snapshot never offers inert controls, so refs cannot lead here.
	assert.doesNotMatch((await pi.callTool("chrome_snapshot", { mode: "full" })).text, /Drawer search/);
});

test("attaching to a chrome:// tab explains the restriction and leaves the current tab alone", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/index.html` });
	const current = env.connector.currentTab;
	const client = await env.connector.client();
	const internal = (await client.request("tabs.create", { url: "chrome://version/", active: false })) as TabInfo;
	try {
		await assert.rejects(pi.callTool("chrome_tabs", { action: "use", tabId: internal.id }), /Chrome does not allow the debugger on chrome:\/\/version\/ \(chrome:\/\/ pages, the Chrome Web Store and other extensions' pages are off limits\)\. Pick a normal web page with chrome_tabs "use", or open one with chrome_tabs "new"\./);
		assert.equal(env.connector.currentTab, current, "current tab unchanged after the refusal");
		assert.equal(await evaluate("document.title"), "Fixture index", "the original tab still works");
	} finally {
		await client.request("tabs.remove", { tabIds: [internal.id] });
	}
});

test("chrome_scroll reports the container that moved when the target itself is not scrollable", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/form.html` });
	await pi.callTool("chrome_scroll", { selector: "#scroller", to: "top" });
	const report = (await pi.callTool("chrome_scroll", { selector: "#scroller > div", deltaY: 250 })).text;
	assert.match(report, /^Scrolled <div#scroller> \(the nearest scrollable container of <div>tall content deep item<\/div>\): scrollTop 250 of \d+, scrollLeft 0/);
	assert.equal(await evaluate("document.getElementById('scroller').scrollTop"), "250");
	const self = (await pi.callTool("chrome_scroll", { selector: "#scroller", deltaY: 100 })).text;
	assert.match(self, /^Scrolled inside <div id="scroller"/);
});
