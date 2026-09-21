// Phase 1 tools through their real execute(): status, tabs, navigate, evaluate, screenshot, /chrome.

import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { after, before, test } from "node:test";
import type { Connector } from "../../extensions/chrome/connector.ts";
import type { FakePi } from "./fake-pi.ts";
import type { FixtureServer, TestLauncher } from "./harness.ts";
import { startToolTestEnv, type ToolTestEnv } from "./setup.ts";

let env: ToolTestEnv;
let pi: FakePi;
let connector: Connector;
let launcher: TestLauncher;
let fixtures: FixtureServer;

before(async () => {
	env = await startToolTestEnv("tools-core");
	({ pi, connector, launcher, fixtures } = env);
});

after(async () => {
	await env.close();
});

test("registers the phase 1 tools and the /chrome command", () => {
	for (const name of ["chrome_status", "chrome_tabs", "chrome_navigate", "chrome_evaluate", "chrome_screenshot"]) {
		assert.ok(pi.tools.has(name), `${name} registered`);
		assert.equal(pi.tools.get(name)?.executionMode, "sequential", `${name} is sequential`);
	}
	assert.ok(pi.commands.has("chrome"));
});

test("/chrome status before Chrome runs explains the state without launching", async () => {
	const lines = await pi.runCommand("chrome", "status");
	assert.match(lines.join("\n"), /Bridge: listening on 127\.0\.0\.1:\d+/);
	assert.match(lines.join("\n"), /not connected \(Chrome for Testing is not running/);
	assert.equal(await launcher.launcher.isRunning(), false);
});

test("chrome_status launches Chrome when it is not running (must-have #1)", async () => {
	const result = await pi.callTool("chrome_status");
	assert.match(result.text, /^Connected: bridge 127\.0\.0\.1:\d+, extension v\d+\.\d+\.\d+/);
	assert.match(result.text, /Chrome \d+/);
	assert.match(result.text, /Current tab: none yet/);
	assert.equal(await launcher.launcher.isRunning(), true);
});

test("chrome_navigate opens the agent window on first use and reports load details", async () => {
	const result = await pi.callTool("chrome_navigate", { url: `${fixtures.url}/index.html` });
	assert.match(result.text, /^Loaded: "Fixture index" http:\/\/127\.0\.0\.1:\d+\/index\.html \(HTTP 200\) in \d+ms$/m);
	assert.ok(connector.agentWindow !== undefined, "agent window created");
	assert.ok(connector.currentTab !== undefined, "current tab set");
	const state = pi.entries.filter((entry) => entry.customType === "pi-chrome-connector").at(-1)?.data as { currentTabId?: number };
	assert.equal(state.currentTabId, connector.currentTab, "state persisted via appendEntry");
});

test("chrome_navigate reports console errors and failed requests from the load", async () => {
	const result = await pi.callTool("chrome_navigate", { url: `${fixtures.url}/console.html`, waitUntil: "networkidle" });
	await new Promise((resolve) => setTimeout(resolve, 300));
	const followup = await pi.callTool("chrome_evaluate", { expression: "1" });
	const combined = `${result.text}\n${followup.text}`;
	assert.match(combined, /console error/);
});

test("chrome_navigate surfaces DNS/connection failures instead of hanging", async () => {
	await assert.rejects(pi.callTool("chrome_navigate", { url: "http://127.0.0.1:65530/nothing" }), /Navigation to http:\/\/127\.0\.0\.1:65530\/nothing failed: net::ERR_CONNECTION_REFUSED/);
});

test("chrome_navigate back / forward / reload", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/index.html` });
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/form.html` });
	const back = await pi.callTool("chrome_navigate", { action: "back" });
	assert.match(back.text, /index\.html/);
	const forward = await pi.callTool("chrome_navigate", { action: "forward" });
	assert.match(forward.text, /form\.html/);
	const reload = await pi.callTool("chrome_navigate", { action: "reload" });
	assert.match(reload.text, /^Loaded: .*form\.html/);
});

test("chrome_evaluate handles expressions, functions, promises, refs-less errors, and frames", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/frames.html` });
	assert.equal((await pi.callTool("chrome_evaluate", { expression: "document.title" })).text, "Frames fixture");
	assert.equal((await pi.callTool("chrome_evaluate", { expression: "() => 1 + 2" })).text, "3");
	assert.equal((await pi.callTool("chrome_evaluate", { expression: "new Promise(r => setTimeout(() => r('later'), 50))" })).text, "later");
	assert.equal((await pi.callTool("chrome_evaluate", { expression: "({ a: [1, 2], b: null })" })).text, JSON.stringify({ a: [1, 2], b: null }, null, 2));
	assert.equal((await pi.callTool("chrome_evaluate", { expression: "undefined" })).text, "undefined");
	await assert.rejects(pi.callTool("chrome_evaluate", { expression: "nope.x" }), /JavaScript threw: ReferenceError: nope is not defined/);
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.equal((await pi.callTool("chrome_evaluate", { expression: "document.title", frame: "same-origin-frame" })).text, "Fixture index");
	assert.equal((await pi.callTool("chrome_evaluate", { expression: "location.hostname", frame: "localhost" })).text, "localhost");
});

test("chrome_screenshot returns an inline image at CSS-pixel scale and writes the file", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/index.html` });
	const result = await pi.callTool("chrome_screenshot", {});
	assert.equal(result.images.length, 1);
	assert.equal(result.images[0]?.mimeType, "image/png");
	const details = result.details as { path: string; width: number; height: number };
	assert.ok(existsSync(details.path), `file written at ${details.path}`);
	assert.ok(statSync(details.path).size > 1000);
	const viewport = JSON.parse((await pi.callTool("chrome_evaluate", { expression: "({ w: innerWidth, h: innerHeight })" })).text) as { w: number; h: number };
	assert.equal(details.width, viewport.w, "width equals CSS viewport width");
	assert.equal(details.height, viewport.h, "height equals CSS viewport height");
	assert.match(result.text, /^Screenshot \d+x\d+ png \(\d+KB\) saved to /);

	const element = await pi.callTool("chrome_screenshot", { selector: "h1", padding: 4, format: "jpeg", returnImage: false });
	assert.equal(element.images.length, 0);
	const elementDetails = element.details as { width: number; height: number };
	assert.ok(elementDetails.width > 100 && elementDetails.height > 20 && elementDetails.height < 200, `element clip ${elementDetails.width}x${elementDetails.height}`);

	const full = await pi.callTool("chrome_screenshot", { fullPage: true, returnImage: false });
	assert.match(full.text, /full page/);
});

test("chrome_tabs list / new / use / close", async () => {
	const list = await pi.callTool("chrome_tabs", { action: "list" });
	assert.match(list.text, /agent window/);
	assert.match(list.text, /<- current/);

	const created = await pi.callTool("chrome_tabs", { action: "new", url: `${fixtures.url}/console.html` });
	const createdId = Number(/\[(\d+)\]/.exec(created.text)?.[1]);
	assert.equal(connector.currentTab, createdId);

	const previous = await pi.callTool("chrome_tabs", { action: "use", titleIncludes: "Fixture index" });
	assert.match(previous.text, /Current tab is now \[\d+\] "Fixture index"/);
	assert.notEqual(connector.currentTab, createdId);

	await assert.rejects(pi.callTool("chrome_tabs", { action: "use", urlIncludes: "127.0.0.1" }), /tabs match; pass tabId/);

	const closed = await pi.callTool("chrome_tabs", { action: "close", tabId: createdId });
	assert.match(closed.text, new RegExp(`Closed tab \\[${createdId}\\]`));
	const after = await pi.callTool("chrome_tabs", { action: "list" });
	assert.ok(!after.text.includes(`[${createdId}]`), "closed tab is gone");
});

test("/chrome doctor reports a healthy stack and /chrome cleanup closes owned tabs", async () => {
	const doctor = await pi.runCommand("chrome", "doctor");
	const text = doctor.join("\n");
	assert.match(text, /✓ bridge listening/);
	assert.match(text, /✓ extension v/);
	assert.match(text, /✓ debugger attach \+ Runtime\.evaluate work/);
	assert.doesNotMatch(text, /✗/);

	const focusOff = await pi.runCommand("chrome", "focus off");
	assert.match(focusOff.join("\n"), /Focus mode off/);
	assert.equal(connector.focus, false);

	const cleanup = await pi.runCommand("chrome", "cleanup");
	assert.match(cleanup.join("\n"), /Closed \d+ tab\(s\)/);
	assert.equal(connector.currentTab, undefined);
});
