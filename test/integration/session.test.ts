import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { TabInfo } from "../../extensions/chrome/bridge/protocol.ts";
import { DialogOpenError, TabSession } from "../../extensions/chrome/cdp/session.ts";
import { launchTestChrome, type TestChrome } from "./harness.ts";

let chrome: TestChrome;
let session: TabSession;
let tab: TabInfo;

async function navigate(url: string): Promise<void> {
	const before = session.navigationCount;
	const result = await session.send("Page.navigate", { url });
	assert.equal(result.errorText, undefined, `navigation error: ${result.errorText}`);
	assert.ok(await session.waitForLifecycle("load", 10_000, { afterNavigation: before }), "load lifecycle reached");
}

before(async () => {
	chrome = await launchTestChrome();
	tab = (await chrome.client.request("tabs.create", { url: "about:blank", active: true })) as TabInfo;
	session = await TabSession.open(chrome.client, tab.id);
});

after(async () => {
	await session.detach().catch(() => {});
	await chrome.close();
});

test("session initializes with frame tree and no diagnostics", () => {
	assert.ok(session.mainFrameId, "main frame id");
	assert.deepEqual(session.diagnostics, []);
});

test("console buffer captures console.*, uncaught exceptions and browser network errors", async () => {
	await navigate(`${chrome.fixtures.url}/console.html`);
	await new Promise((resolve) => setTimeout(resolve, 500));
	const entries = session.console.list();
	const texts = entries.map((entry) => `${entry.level}:${entry.source}:${entry.text}`);
	assert.ok(texts.some((text) => text.startsWith("log:console:plain log 42 {a: 1, b: \"two\", nested: {…}}")), `object preview: ${texts.join("\n")}`);
	assert.ok(texts.some((text) => text === "info:console:info message"));
	assert.ok(texts.some((text) => text === "warning:console:warning message"));
	assert.ok(texts.some((text) => text.startsWith("error:console:error message Error: logged error")));
	assert.ok(texts.some((text) => text === "debug:console:debug message"));
	assert.ok(texts.some((text) => text.startsWith("error:exception:Uncaught Error: uncaught after load")), `uncaught: ${texts.join("\n")}`);
	assert.ok(texts.some((text) => text.startsWith("error:network:") && text.includes("404")), `network log entry: ${texts.join("\n")}`);
	assert.equal(session.console.list({ level: "error" }).every((entry) => entry.level === "error"), true);
});

test("network buffer captures documents, fetches, failures, post data and response bodies", async () => {
	session.network.clear();
	await navigate(`${chrome.fixtures.url}/network.html`);
	assert.ok(await session.network.waitForIdle(300, 10_000), "network idle");
	await new Promise((resolve) => setTimeout(resolve, 200));
	const entries = session.network.list();
	const byPath = (needle: string) => entries.find((entry) => entry.url.includes(needle));

	const document = byPath("/network.html");
	assert.equal(document?.type, "Document");
	assert.equal(document?.status, 200);

	const json = byPath("/api/json?x=1");
	assert.equal(json?.type, "Fetch");
	assert.equal(json?.status, 200);
	assert.equal(json?.bodyState, "captured");
	assert.match(json?.body?.text ?? "", /"ok":true/);
	assert.match(json?.initiator ?? "", /^script /);

	const fail = byPath("/api/fail");
	assert.equal(fail?.status, 500);
	assert.equal(session.network.list({ status: "5xx" }).length, 1);

	const echo = byPath("/api/echo");
	assert.equal(echo?.method, "POST");
	assert.equal(echo?.postData, JSON.stringify({ hello: "world" }));
	assert.match(echo?.body?.text ?? "", /"body":"\{\\"hello\\":\\"world\\"\}"/);

	const image = byPath("/missing.png");
	assert.equal(image?.status, 404);
	assert.equal(image?.type, "Image");
	assert.ok(session.network.list({ failedOnly: true }).length >= 2, "failedOnly includes 4xx/5xx");
	assert.equal(session.network.list({ method: "post" }).length, 1);
});

test("dialogs block sensitive commands and are surfaced instead of timing out", async () => {
	await navigate(`${chrome.fixtures.url}/dialog.html`);
	await assert.rejects(
		session.evaluate("document.getElementById('alert').click()", { timeoutMs: 5_000 }),
		(error: unknown) => error instanceof DialogOpenError && error.dialog.type === "alert" && error.dialog.message === "hello from alert",
	);
	assert.equal(session.dialog?.type, "alert");
	await assert.rejects(session.evaluate("1 + 1"), DialogOpenError);
	await session.send("Page.handleJavaScriptDialog", { accept: true });
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(session.dialog, undefined);
	assert.equal(await session.evaluate("1 + 1"), 2);

	session.dialogPolicy = "accept";
	await session.evaluate("document.getElementById('confirm').click()");
	assert.equal(await session.evaluate("document.getElementById('result').textContent"), "confirmed");
	session.dialogPolicy = "manual";
});

test("routes mock and abort requests through the Fetch domain", async () => {
	await navigate(`${chrome.fixtures.url}/network.html`);
	session.routes.add({ urlPattern: "*/api/json*", action: "fulfill", response: { status: 201, headers: { "content-type": "application/json" }, body: JSON.stringify({ mocked: true }) } });
	session.routes.add({ urlPattern: "*/api/fail", action: "abort", abortReason: "ConnectionRefused" });
	await session.syncRoutes();

	const mocked = await session.evaluate<{ status: number; body: unknown }>(
		"fetch('/api/json?x=2').then(async (r) => ({ status: r.status, body: await r.json() }))",
	);
	assert.deepEqual(mocked, { status: 201, body: { mocked: true } });
	const aborted = await session.evaluate<string>("fetch('/api/fail').then(() => 'ok', (e) => 'error:' + e.message)");
	assert.match(aborted, /^error:/);
	const rules = session.routes.list();
	assert.equal(rules[0]?.hits, 1);
	assert.equal(rules[1]?.hits, 1);
	assert.ok(chrome.fixtures.requests.every((request) => request.path !== "/api/json?x=2"), "mocked request never reached the server");

	session.routes.clear();
	await session.syncRoutes();
	const real = await session.evaluate<number>("fetch('/api/json?x=3').then((r) => r.status)");
	assert.equal(real, 200);
});

test("same-process and out-of-process iframes are tracked and evaluable", async () => {
	await navigate(`${chrome.fixtures.url}/frames.html`);
	await new Promise((resolve) => setTimeout(resolve, 1000));
	const frames = [...session.frames.values()];
	const same = frames.find((frame) => frame.name === "same-origin-frame" || (frame.url.includes("127.0.0.1") && frame.url.endsWith("/index.html")));
	const cross = frames.find((frame) => frame.url.includes("localhost"));
	assert.ok(same, `same-origin frame tracked: ${frames.map((frame) => frame.url).join(", ")}`);
	assert.ok(cross, `cross-origin frame tracked: ${frames.map((frame) => frame.url).join(", ")}`);
	assert.ok(cross.sessionId, "cross-origin frame runs in a child session");

	const sameContext = session.contextFor(same.id);
	assert.ok(sameContext, "same-origin frame has an execution context");
	assert.equal(await session.evaluate("document.title", { contextId: sameContext.id }), "Fixture index");
	assert.equal(await session.evaluate("document.title", { sessionId: cross.sessionId }), "Fixture index");
	assert.equal(await session.evaluate("document.title"), "Frames fixture");
});

test("navigation clears refs and bumps the generation", async () => {
	session.refs.assign({ backendNodeId: 1, role: "button", name: "x" });
	const generation = session.refs.generation;
	await navigate(`${chrome.fixtures.url}/index.html`);
	assert.equal(session.refs.size, 0);
	assert.equal(session.refs.generation, generation + 1);
	assert.equal(session.url, `${chrome.fixtures.url}/index.html`);
});
