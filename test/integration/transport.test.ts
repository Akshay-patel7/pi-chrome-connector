import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { TabInfo, WindowInfo } from "../../extensions/chrome/bridge/protocol.ts";
import { launchTestChrome, type TestChrome } from "./harness.ts";

let chrome: TestChrome;

before(async () => {
	chrome = await launchTestChrome();
});

after(async () => {
	await chrome.close();
});

test("handshake carries protocol, version and a chrome-extension origin", () => {
	assert.equal(chrome.client.info?.protocol, 1);
	assert.match(chrome.client.info?.version ?? "", /^\d+\.\d+\.\d+$/);
	assert.match(chrome.client.origin ?? "", /^chrome-extension:\/\//);
});

test("tabs.list returns tabs and windows", async () => {
	const result = (await chrome.client.request("tabs.list")) as { tabs: TabInfo[]; windows: WindowInfo[] };
	assert.ok(result.tabs.length >= 1);
	assert.ok(result.windows.length >= 1);
	assert.equal(typeof result.tabs[0]?.id, "number");
});

test("attach + CDP Runtime.evaluate round trip, events stream back", async () => {
	const tab = (await chrome.client.request("tabs.create", { url: `${chrome.fixtures.url}/index.html`, active: true })) as TabInfo;
	const attached = (await chrome.client.request("debugger.attach", { tabId: tab.id })) as { attached: boolean; fresh: boolean };
	assert.equal(attached.attached, true);

	const events: string[] = [];
	chrome.client.on("event", (event) => {
		if (event.event === "cdp" && event.tabId === tab.id) events.push(event.method);
	});
	await chrome.client.request("cdp", { tabId: tab.id, method: "Runtime.enable" });
	const evaluated = (await chrome.client.request("cdp", {
		tabId: tab.id,
		method: "Runtime.evaluate",
		params: { expression: "document.title", returnByValue: true },
	})) as { result: { value: string } };
	assert.equal(evaluated.result.value, "Fixture index");
	assert.ok(events.includes("Runtime.executionContextCreated"), `expected Runtime.executionContextCreated in ${events.join(",")}`);

	await assert.rejects(
		chrome.client.request("cdp", { tabId: tab.id, method: "Runtime.evaluate", params: { expression: "throw new Error('x')", returnByValue: true } }).then(
			(result) => {
				// CDP reports thrown exceptions in the result, not as a protocol error.
				const value = result as { exceptionDetails?: { exception?: { description?: string } } };
				assert.match(value.exceptionDetails?.exception?.description ?? "", /Error: x/);
				throw new Error("expected-path");
			},
		),
		/expected-path/,
	);

	const detached = (await chrome.client.request("debugger.detach", { tabId: tab.id })) as { detached: boolean };
	assert.equal(detached.detached, true);
	await chrome.client.request("tabs.remove", { tabIds: [tab.id] });
});

test("unknown methods produce a remote error, not a hang", async () => {
	await assert.rejects(chrome.client.request("nope"), /unknown method nope/);
});
