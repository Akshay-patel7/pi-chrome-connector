// Auto-wait: finds and actions keep looking for their element while the page renders after `load`,
// and report a miss with the page they were looking at. Plus the about:blank tab fix.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FakePi } from "./fake-pi.ts";
import type { FixtureServer } from "./harness.ts";
import { startToolTestEnv, type ToolTestEnv } from "./setup.ts";

let env: ToolTestEnv;
let pi: FakePi;
let fixtures: FixtureServer;

const evaluate = async (expression: string) => (await pi.callTool("chrome_evaluate", { expression })).text;

before(async () => {
	env = await startToolTestEnv("tools-autowait");
	({ pi, fixtures } = env);
});

after(async () => {
	await env.close();
});

test("chrome_find and chrome_click wait for an element that mounts after load", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/late.html` });
	const started = Date.now();
	const found = await pi.callTool("chrome_find", { text: "Late button" });
	const elapsed = Date.now() - started;
	assert.match(found.text, /1 match:\n- button "Late button" \[e\d+\]/);
	assert.ok(elapsed >= 700 && elapsed < 5_000, `kept looking until the button mounted (${elapsed}ms)`);

	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/late.html` });
	const clicked = await pi.callTool("chrome_click", { text: "Late button" });
	assert.match(clicked.text, /^Clicked <button id="late-button">Late button<\/button> at \(\d+, \d+\)\./);
	assert.equal(await evaluate("document.getElementById('late-result').textContent"), "late clicked");
});

test("a matched element that is still hidden is clicked once it becomes visible", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/late.html` });
	const clicked = await pi.callTool("chrome_click", { selector: "#shown-later" });
	assert.match(clicked.text, /^Clicked <button id="shown-later">/);
	assert.equal(await evaluate("document.getElementById('late-result').textContent"), "shown clicked");
});

test("a control inside a dialog that opens after a click is reachable in the same batch", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/late.html` });
	await pi.callTool("chrome_click", { selector: "#open-late-dialog" });
	const ok = await pi.callTool("chrome_click", { text: "Late OK" });
	assert.match(ok.text, /^Clicked <button id="late-ok">/);
	assert.equal(await evaluate("document.getElementById('late-result').textContent"), "late ok clicked");
});

test("a miss names the wait and the page; timeoutMs 0 looks once", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/late.html` });
	const started = Date.now();
	const none = await pi.callTool("chrome_find", { text: "never rendered", timeoutMs: 0 });
	assert.ok(Date.now() - started < 1_500, "timeoutMs 0 returns at once");
	assert.match(none.text, /^No elements match text "never rendered"\. Page: "Late fixture" http:\/\/127\.0\.0\.1:\d+\/late\.html\. Try/);
	const waited = await pi.callTool("chrome_find", { text: "never rendered", timeoutMs: 300 });
	assert.match(waited.text, /^No elements match text "never rendered" \(waited 300ms\)\. Page: "Late fixture"/);
	await assert.rejects(pi.callTool("chrome_click", { selector: "#never", timeoutMs: 200 }), /^Error: No element matches selector "#never" \(waited 200ms\)\. Page: "Late fixture" http:\/\/127\.0\.0\.1:\d+\/late\.html\. Use chrome_find/);
	await assert.rejects(pi.callTool("chrome_click", { text: "never rendered", timeoutMs: 200 }), /^Error: No visible element contains the text "never rendered" \(waited 200ms\)\. Page: "Late fixture"/);
	await assert.rejects(pi.callTool("chrome_snapshot", { selector: "#never", timeoutMs: 0 }), /^Error: No element matches selector "#never"\. Page: "Late fixture"/);
});

test("chrome_tabs new about:blank returns without waiting for a document", async () => {
	const started = Date.now();
	const opened = await pi.callTool("chrome_tabs", { action: "new", url: "about:blank" });
	assert.match(opened.text, /^Opened tab \[\d+\] about:blank/);
	assert.doesNotMatch(opened.text, /still loading/);
	assert.ok(Date.now() - started < 5_000, `returned in ${Date.now() - started}ms`);
	await pi.callTool("chrome_tabs", { action: "close" });
});
