import assert from "node:assert/strict";
import { test } from "node:test";
import type { TabInfo } from "../../extensions/chrome/bridge/protocol.ts";
import { startToolTestEnv } from "./setup.ts";

test("scoped controls avoid full-page capture, retain offscreen state and yield usable refs", async () => {
	const env = await startToolTestEnv("scoped-performance", { focus: false });
	try {
		await env.pi.callTool("chrome_navigate", { url: `${env.fixtures.url}/form.html` });
		const session = await env.connector.currentSession({ focus: false });
		await session.evaluate(`(() => {
			const fragment = document.createDocumentFragment();
			for (let i = 0; i < 1000; i++) { const b = document.createElement('button'); b.textContent = 'Extra ' + i; fragment.append(b); }
			document.body.append(fragment);
		})()`);
		const requests: string[] = [];
		const original = session.client.request.bind(session.client);
		session.client.request = (method, params, timeout) => {
			requests.push(method === "cdp" ? (params as { method: string }).method : method);
			return original(method, params, timeout);
		};
		const shot = await env.pi.callTool("chrome_snapshot", { selector: "#far-button" });
		assert.match(shot.text, /- button "Far button" \[e\d+\] \[offscreen\]/);
		assert.doesNotMatch(shot.text, /Extra 999/);
		assert.ok(requests.includes("Accessibility.queryAXTree"));
		assert.ok(!requests.includes("Accessibility.getFullAXTree"));
		assert.ok(!requests.includes("DOMSnapshot.captureSnapshot"));
		const ref = /\[(e\d+)\]/.exec(shot.text)?.[1];
		assert.ok(ref);
		await env.pi.callTool("chrome_click", { ref });
		assert.equal(await session.evaluate("document.querySelector('#far-result').textContent"), "far clicked");
		const visible = await env.pi.callTool("chrome_snapshot", { selector: "#far-button" });
		assert.doesNotMatch(visible.text, /\[offscreen\]/);
		const card = await env.pi.callTool("chrome_snapshot", { selector: "#card" });
		assert.match(card.text, /Clickable card.*\[clickable\]/, "generic scopes keep programmatic click listeners");
	} finally { await env.close(); }
});

test("background input keeps the other tab active with focus off", async () => {
	const env = await startToolTestEnv("background-performance", { focus: false });
	try {
		await env.pi.callTool("chrome_navigate", { url: `${env.fixtures.url}/form.html` });
		const session = await env.connector.currentSession({ focus: false });
		const tab = await session.client.request("tabs.get", { tabId: session.tabId }) as TabInfo;
		const foreground = await session.client.request("tabs.create", { windowId: tab.windowId, url: "about:blank", active: true }) as TabInfo;
		assert.equal((await session.client.request("tabs.get", { tabId: session.tabId }) as TabInfo).active, false);
		const focusRequests: string[] = [];
		const original = session.client.request.bind(session.client);
		session.client.request = (method, params, timeout) => {
			if (method === "windows.update" && (params as { focused?: boolean }).focused) focusRequests.push(method);
			return original(method, params, timeout);
		};
		await env.pi.callTool("chrome_fill", { selector: "#name", value: "background input" });
		await env.pi.callTool("chrome_click", { selector: "input[name=plan][value=pro]" });
		assert.equal(await session.evaluate("document.querySelector('#name').value"), "background input");
		assert.equal(await session.evaluate("document.querySelector('input[name=plan]:checked').value"), "pro");
		assert.equal((await session.client.request("tabs.get", { tabId: session.tabId }) as TabInfo).active, false);
		assert.equal((await session.client.request("tabs.get", { tabId: foreground.id }) as TabInfo).active, true);
		assert.deepEqual(focusRequests, [], "input must not bring the browser window forward");
	} finally { await env.close(); }
});

test("input waits for rendered effects and selector searches preserve order and refs", async () => {
	const env = await startToolTestEnv("render-performance", { focus: false });
	try {
		await env.pi.callTool("chrome_navigate", { url: `${env.fixtures.url}/form.html` });
		const session = await env.connector.currentSession({ focus: false });
		await session.evaluate(`document.querySelector('#name').addEventListener('input', () => {
			requestAnimationFrame(() => { document.body.dataset.painted = document.querySelector('#name').value; });
		})`);
		await env.pi.callTool("chrome_fill", { selector: "#name", value: "rendered" });
		assert.equal(await session.evaluate("document.body.dataset.painted"), "rendered");
		const matches = await env.pi.callTool("chrome_find", { selector: "input[name=plan]" });
		const lines = matches.text.split("\n");
		assert.match(lines[1]!, /free/);
		assert.match(lines[2]!, /pro/);
		const ref = /\[(e\d+)\]/.exec(lines[2]!)?.[1];
		assert.ok(ref);
		await env.pi.callTool("chrome_click", { ref });
		assert.equal(await session.evaluate("document.querySelector('input[name=plan]:checked').value"), "pro");
	} finally { await env.close(); }
});
