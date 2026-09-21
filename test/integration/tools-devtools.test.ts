// Phase 3 tools: console, network (+get, har), route, dom, storage, frames, performance, pdf, emulate.

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { after, before, test } from "node:test";
import type { FakePi } from "./fake-pi.ts";
import type { FixtureServer } from "./harness.ts";
import { startToolTestEnv, type ToolTestEnv } from "./setup.ts";

let env: ToolTestEnv;
let pi: FakePi;
let fixtures: FixtureServer;

/** Value of an expression without the trailing "Since: …" delta line. */
const evaluate = async (expression: string) => (await pi.callTool("chrome_evaluate", { expression })).text.split("\nSince: ")[0] as string;

before(async () => {
	env = await startToolTestEnv("tools-devtools");
	({ pi, fixtures } = env);
});

after(async () => {
	await env.close();
});

test("chrome_console filters by level, since, includes; clears; shows stacks", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/console.html`, waitUntil: "networkidle" });
	await pi.callTool("chrome_wait", { timeMs: 300 });
	const all = await pi.callTool("chrome_console", {});
	assert.match(all.text, /^\d+ of \d+ console entries \(last seq #\d+\)/);
	assert.match(all.text, /#\d+ \[log\] plain log 42 \{a: 1, b: "two", nested: \{…\}\}  @ console\.html:\d+:\d+/);
	assert.match(all.text, /\[warning\] warning message/);
	assert.match(all.text, /\[error\] error message Error: logged error/);
	assert.match(all.text, /\[error\/exception\] Uncaught Error: uncaught after load/);
	assert.match(all.text, /\[error\/network\] Failed to load resource: the server responded with a status of 404/);

	const errors = await pi.callTool("chrome_console", { level: "error", stack: true });
	assert.doesNotMatch(errors.text, /\[warning\]|\[log\]|\[info\]/);
	assert.match(errors.text, /\n    at .*console\.html/);

	const lastSeq = Number(/last seq #(\d+)/.exec(all.text)?.[1]);
	await evaluate("console.warn('after the fact')");
	const since = await pi.callTool("chrome_console", { since: lastSeq });
	assert.match(since.text, /^1 of \d+ console entries since #\d+/);
	assert.match(since.text, /\[warning\] after the fact/);

	const includes = await pi.callTool("chrome_console", { includes: "INFO MESSAGE" });
	assert.match(includes.text, /^1 of/);

	const cleared = await pi.callTool("chrome_console", { clear: true });
	assert.match(cleared.text, /buffer cleared/);
	assert.match((await pi.callTool("chrome_console", {})).text, /^0 of 0 console entries/);
});

test("chrome_network list filters, get shows headers/bodies/post data, har export", async () => {
	await pi.callTool("chrome_network", { action: "clear" });
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/network.html`, waitUntil: "networkidle" });
	await pi.callTool("chrome_wait", { function: "document.body.dataset.done === '1'" });
	const list = await pi.callTool("chrome_network", { action: "list" });
	assert.match(list.text, /^\d+ of \d+ requests \(last seq #\d+, \d+ in flight\)\. Columns:/);
	assert.match(list.text, /#\d+ GET 200 document [\d.]+K?B \d+ms http:\/\/127\.0\.0\.1:\d+\/network\.html/);
	assert.match(list.text, /#\d+ POST 200 fetch \d+B \d+ms .*\/api\/echo/);
	assert.match(list.text, /#\d+ GET 500 fetch \d+B \d+ms .*\/api\/fail/, "unread 5xx response still gets header timing");
	assert.match(list.text, /#\d+ GET 404 image .*\/missing\.png/);

	const failed = await pi.callTool("chrome_network", { action: "list", failedOnly: true });
	assert.match(failed.text, /\/api\/fail/);
	assert.doesNotMatch(failed.text, /\/api\/echo/);
	assert.match((await pi.callTool("chrome_network", { action: "list", status: "5xx" })).text, /^1 of/);
	assert.match((await pi.callTool("chrome_network", { action: "list", method: "POST" })).text, /^1 of/);
	assert.match((await pi.callTool("chrome_network", { action: "list", type: "Image" })).text, /missing\.png/);
	assert.match((await pi.callTool("chrome_network", { action: "list", urlIncludes: "api/json" })).text, /^1 of/);

	const echoSeq = /#(\d+) POST 200 fetch/.exec(list.text)?.[1];
	const detail = await pi.callTool("chrome_network", { id: `#${echoSeq}` });
	assert.match(detail.text, /initiator: script .*network\.html:\d+/);
	assert.match(detail.text, /request headers:\n(  .*\n)*  content-type: application\/json/);
	assert.match(detail.text, /request body:\n\{\n  "hello": "world"\n\}/);
	assert.match(detail.text, /response headers:\n(  .*\n)*  content-type: application\/json/);
	assert.match(detail.text, /response body:\n\{\n  "method": "POST",/);
	await assert.rejects(pi.callTool("chrome_network", { id: "#999999" }), /No network entry #999999/);

	const har = await pi.callTool("chrome_network", { action: "har" });
	const path = (har.details as { path: string }).path;
	assert.ok(existsSync(path));
	const parsed = JSON.parse(readFileSync(path, "utf8")) as { log: { entries: Array<{ request: { url: string; postData?: { text: string } }; response: { status: number; content: { text?: string } } }> } };
	const echo = parsed.log.entries.find((entry) => entry.request.url.endsWith("/api/echo"));
	assert.equal(echo?.request.postData?.text, JSON.stringify({ hello: "world" }));
	assert.match(echo?.response.content.text ?? "", /"method":"POST"/);
});

test("chrome_route mocks JSON, aborts, delays, captures payloads, and lists/removes rules", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/network.html` });
	const added = await pi.callTool("chrome_route", { action: "add", url: "*/api/json*", json: { mocked: true, items: [] }, status: 203 });
	assert.match(added.text, /^Route #1 added: \*\/api\/json\* → fulfill 203\./);
	await pi.callTool("chrome_route", { action: "add", url: "*/api/echo", method: "POST", mode: "abort", errorReason: "ConnectionRefused" });
	await pi.callTool("chrome_route", { action: "add", url: "*/api/slow*", mode: "continue", delayMs: 400, headers: { "x-added-by": "route" } });

	const mocked = await evaluate("fetch('/api/json?q=1').then(async r => ({ status: r.status, type: r.headers.get('content-type'), body: await r.json() }))");
	assert.deepEqual(JSON.parse(mocked), { status: 203, type: "application/json", body: { mocked: true, items: [] } });
	const aborted = await evaluate("fetch('/api/echo', { method: 'POST', body: JSON.stringify({ secret: 'payload' }) }).then(() => 'ok', e => 'failed: ' + e.message)");
	assert.match(aborted, /^failed: /);
	assert.ok(!fixtures.requests.some((request) => request.body.includes("secret")), "aborted POST never reached the server");
	const started = Date.now();
	const slow = await evaluate("fetch('/api/slow?ms=10').then(r => r.json())");
	assert.ok(Date.now() - started >= 400, "continue with delay slowed the request");
	assert.deepEqual(JSON.parse(slow), { slept: 10 });
	assert.equal(fixtures.requests.at(-1)?.headers["x-added-by"], "route", "continue added a request header");

	const list = await pi.callTool("chrome_route", { action: "list" });
	assert.match(list.text, /#1 \*\/api\/json\* → fulfill 203 — 1 hit\n    GET .*\/api\/json\?q=1/);
	assert.match(list.text, /#2 POST \*\/api\/echo → abort \(ConnectionRefused\) — 1 hit\n    POST .*\/api\/echo body=\{"secret":"payload"\}/);
	assert.match(list.text, /#3 \*\/api\/slow\* → continue \+headers x-added-by after 400ms — 1 hit/);

	await pi.callTool("chrome_route", { action: "remove", id: 1 });
	assert.equal(await evaluate("fetch('/api/json?q=2').then(r => r.status)"), "200");
	await pi.callTool("chrome_route", { action: "clear" });
	assert.match((await pi.callTool("chrome_route", { action: "list" })).text, /^No routes\./);
	const listAfter = await pi.callTool("chrome_network", { action: "list", urlIncludes: "api/json?q=1" });
	assert.match(listAfter.text, /\(routed\)/, "network log marks requests a route answered");
});

test("blocked telemetry and blob workers do not masquerade as failures or keep the page from going idle", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/index.html` });
	await pi.callTool("chrome_route", { action: "add", url: "*/telemetry/*", mode: "abort", errorReason: "BlockedByClient" });
	const nav = await pi.callTool("chrome_navigate", { url: `${fixtures.url}/telemetry.html`, waitUntil: "networkidle" });
	assert.match(nav.text, /^Loaded: "Telemetry fixture"/, "networkidle reached despite the blob: worker request");
	assert.match(nav.text, /2 requests aborted by chrome_route/);
	assert.doesNotMatch(nav.text, /failed request/);
	assert.doesNotMatch(nav.text, /console error/, "blocked-request console lines are not counted as console errors");

	const list = await pi.callTool("chrome_network", { action: "list", failedOnly: true, urlIncludes: "telemetry/" });
	assert.match(list.text, /ABORTED\(by chrome_route\) fetch .*\/telemetry\/rum/);
	const console = await pi.callTool("chrome_console", { level: "error" });
	assert.match(console.text, /\[error\/network\] Failed to load resource: net::ERR_BLOCKED_BY_CLIENT\.Inspector  http:\/\/127\.0\.0\.1:\d+\/telemetry\/rum/, "network console entries carry their URL");
	await pi.callTool("chrome_route", { action: "clear" });

	const detail = await pi.callTool("chrome_network", { action: "list", urlIncludes: "api/json?real=1" });
	const seq = /#(\d+) GET 200/.exec(detail.text)?.[1];
	assert.ok(seq, "real API call succeeded");
});

test("chrome_network get redacts credential headers but keeps the HAR complete", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/index.html` });
	await evaluate("fetch('/api/echo', { method: 'POST', headers: { authorization: 'Bearer secret-token-value-1234567890', 'x-api-key': 'k', 'content-type': 'text/plain' }, body: 'hello' })");
	await pi.callTool("chrome_wait", { load: "networkidle" });
	const list = await pi.callTool("chrome_network", { action: "list", urlIncludes: "/api/echo", limit: 1 });
	const seq = /#(\d+) POST 200/.exec(list.text)?.[1];
	const detail = await pi.callTool("chrome_network", { id: `#${seq}` });
	assert.match(detail.text, /authorization: Bearer secre… <redacted, 36 chars>/);
	assert.match(detail.text, /x-api-key: <redacted>/);
	assert.match(detail.text, /content-type: text\/plain/);
	assert.doesNotMatch(detail.text, /secret-token-value/);
	assert.match(detail.text, /request body:\nhello/);
	const har = await pi.callTool("chrome_network", { action: "har" });
	const text = readFileSync((har.details as { path: string }).path, "utf8");
	assert.match(text, /secret-token-value-1234567890/, "HAR on disk is complete");
});

test("chrome_dom html/text/attributes/styles/rect/count/listeners", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/form.html` });
	const html = await pi.callTool("chrome_dom", { action: "html", selector: "#submit" });
	assert.equal(html.text, '<button id="submit" type="submit">Submit form</button>');
	const text = await pi.callTool("chrome_dom", { action: "text", selector: "h1" });
	assert.equal(text.text, "Form fixture");
	const attributes = await pi.callTool("chrome_dom", { action: "attributes", selector: "#name" });
	assert.match(attributes.text, /"placeholder": "Your name"/);
	const styles = await pi.callTool("chrome_dom", { action: "styles", selector: "#overlay", properties: ["display", "position"] });
	assert.match(styles.text, /display: none\nposition: fixed/);
	const rect = await pi.callTool("chrome_dom", { action: "rect", selector: "#far-button" });
	assert.match(rect.text, /viewport rect: x=\d+ y=\d+ width=\d+ height=\d+\n.*\nvisible: true, in viewport: no/);
	const count = await pi.callTool("chrome_dom", { action: "count", selector: "input" });
	assert.match(count.text, /^10 elements match input/);
	const listeners = await pi.callTool("chrome_dom", { action: "listeners", selector: "#card" });
	assert.match(listeners.text, /click @ \d+:\d+/);
	const whole = await pi.callTool("chrome_dom", { action: "html", maxChars: 300 });
	assert.match(whole.text, /^<html lang="en">/);
	assert.match(whole.text, /more chars\]$/);
});

test("chrome_storage cookies, localStorage, sessionStorage and site clear", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/api/set-cookie` });
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/index.html` });
	const cookies = await pi.callTool("chrome_storage", { store: "cookies", action: "list" });
	assert.match(cookies.text, /^fixture=served  domain=127\.0\.0\.1 path=\/ session$/m);
	await pi.callTool("chrome_storage", { store: "cookies", action: "set", name: "token", value: "abc123", expires: Math.floor(Date.now() / 1000) + 3600 });
	assert.match((await pi.callTool("chrome_storage", { store: "cookies", action: "get", name: "token" })).text, /^token=<redacted>  .*expires=/, "a cookie named token is redacted by default");
	assert.match((await pi.callTool("chrome_storage", { store: "cookies", action: "get", name: "token", reveal: true })).text, /^token=abc123 .*expires=/);
	assert.match(await evaluate("document.cookie"), /token=abc123/);
	await pi.callTool("chrome_storage", { store: "cookies", action: "remove", name: "token" });
	assert.doesNotMatch(await evaluate("document.cookie"), /token/);

	assert.match((await pi.callTool("chrome_storage", { store: "localStorage", action: "set", name: "theme", value: "dark" })).text, /^Set localStorage/);
	assert.equal((await pi.callTool("chrome_storage", { store: "localStorage", action: "get", name: "theme" })).text, "dark");
	assert.match((await pi.callTool("chrome_storage", { store: "localStorage", action: "list" })).text, /localStorage \(1 keys\):\ntheme = dark/);
	await pi.callTool("chrome_storage", { store: "sessionStorage", action: "set", name: "draft", value: "x" });
	assert.equal(await evaluate("sessionStorage.getItem('draft')"), "x");

	const cleared = await pi.callTool("chrome_storage", { store: "site", action: "clear" });
	assert.match(cleared.text, /^Cleared cookies, storage, cache and service workers for http:\/\/127\.0\.0\.1:\d+/);
	assert.equal(await evaluate("localStorage.length + sessionStorage.length"), "0");
	assert.match((await pi.callTool("chrome_storage", { store: "cookies", action: "list" })).text, /^No cookies/);
});

test("chrome_frames lists frames with process info; chrome_performance and chrome_pdf produce output", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/frames.html` });
	await pi.callTool("chrome_wait", { timeMs: 800 });
	const frames = await pi.callTool("chrome_frames", {});
	assert.match(frames.text, /^3 frames:\nmain  id=\w+ .*frames\.html\n/);
	assert.match(frames.text, /name="same-origin-frame" .*index\.html\n/);
	assert.match(frames.text, /localhost:\d+\/index\.html \[out-of-process\]/);

	const performance = await pi.callTool("chrome_performance", {});
	assert.match(performance.text, /navigation: type=navigate TTFB=\d+ms DOMContentLoaded=\d+ms load=\d+ms/);
	assert.match(performance.text, /first-contentful-paint: \d+ms/);
	assert.match(performance.text, /CLS: [\d.]+/);
	assert.match(performance.text, /JS heap used: [\d.]+[KM]B, DOM nodes: \d+/);

	const pdf = await pi.callTool("chrome_pdf", { format: "A4" });
	const path = (pdf.details as { path: string }).path;
	assert.match(pdf.text, /^Wrote PDF \([\d.]+KB\) of "Frames fixture"/);
	assert.ok(statSync(path).size > 1000);
	assert.equal(readFileSync(path).subarray(0, 4).toString(), "%PDF");
});

test("chrome_emulate viewport/device, dark mode, locale/timezone, geolocation, offline, reset", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/index.html` });
	const systemDark = await evaluate("matchMedia('(prefers-color-scheme: dark)').matches");
	const device = await pi.callTool("chrome_emulate", { device: "iPhone SE", colorScheme: "dark", locale: "de-DE", timezone: "Asia/Tokyo", latitude: 35.68, longitude: 139.69 });
	assert.match(device.text, /viewport 375x667 mobile\+touch \(iPhone SE\)/);
	assert.match(device.text, /geolocation 35\.68,139\.69 \(the site still needs the geolocation permission/);
	// No <meta name=viewport> in the fixture, so a mobile layout viewport is 980px wide like on a real phone; the screen is the device size.
	assert.equal(await evaluate("[screen.width, screen.height, navigator.maxTouchPoints].join('x')"), "375x667x5");
	assert.match(await evaluate("navigator.userAgent"), /iPhone/);
	assert.equal(await evaluate("matchMedia('(prefers-color-scheme: dark)').matches"), "true");
	await pi.callTool("chrome_emulate", { colorScheme: "light" });
	assert.equal(await evaluate("matchMedia('(prefers-color-scheme: dark)').matches"), "false");
	assert.equal(await evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone"), "Asia/Tokyo");
	assert.equal(await evaluate("navigator.language"), "de-DE");
	// navigator.geolocation.getCurrentPosition would block on Chrome's native permission bubble here (no way to grant it via chrome.debugger), so the override itself is what gets verified above.

	await pi.callTool("chrome_emulate", { offline: true });
	assert.match(await evaluate("fetch('/api/json').then(() => 'ok', e => 'failed')"), /failed/);
	await pi.callTool("chrome_emulate", { network: "none" });
	assert.equal(await evaluate("fetch('/api/json').then(r => r.status)"), "200");

	const reset = await pi.callTool("chrome_emulate", { reset: true });
	assert.match(reset.text, /reset all emulation/);
	assert.notEqual(await evaluate("screen.width"), "375");
	assert.equal(await evaluate("matchMedia('(prefers-color-scheme: dark)').matches"), systemDark, "color scheme back to the system setting");
	assert.notEqual(await evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone"), "Asia/Tokyo");
});
