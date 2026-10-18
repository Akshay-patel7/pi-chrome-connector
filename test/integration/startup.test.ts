import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChromeLauncher } from "../../extensions/chrome/bridge/launch.ts";
import type { TabInfo } from "../../extensions/chrome/bridge/protocol.ts";
import { loadConfig } from "../../extensions/chrome/config.ts";
import { Connector } from "../../extensions/chrome/connector.ts";
import { artifactsDir, createTestLauncher, TEST_PORT } from "./harness.ts";

async function withConnector(
	run: (connector: Connector, launcher: ChromeLauncher) => Promise<void>,
	reuseWindow = false,
	extraArgs = ["--window-size=1100,800"],
): Promise<void> {
	const browser = createTestLauncher({ extraArgs });
	const connector = new Connector({
		...loadConfig(artifactsDir, {}),
		portRange: [TEST_PORT, TEST_PORT],
		focus: false,
		window: { width: 1100, height: 800 },
		reuseWindow,
	}, browser.launcher);
	try {
		await run(connector, browser.launcher);
	} finally {
		await connector.stop();
		await browser.close();
	}
}

test("cold startup reuses the connector's window and tab, including cleanup", async () => {
	await withConnector(async (connector) => {
		await connector.client();
		const startup = (await connector.listTabs()).tabs[0];
		assert.ok(startup);
		assert.match(startup.url, /^http:\/\/127\.0\.0\.1:\d+\/startup#[0-9a-f-]+$/);
		const landing = await fetch(startup.url);
		assert.equal(landing.status, 200);
		assert.match(landing.headers.get("content-type") ?? "", /text\/html/);
		assert.equal(landing.headers.get("content-security-policy"), "default-src 'none'");
		const session = await connector.currentSession();
		assert.equal(session.tabId, startup.id, "the marked startup tab is adopted");
		const { tabs, windows } = await connector.listTabs();
		assert.equal(windows.length, 1, "no leftover startup window");
		assert.equal(tabs.length, 1, "no leftover startup tab");
		assert.equal(tabs[0]?.url, "about:blank");
		assert.equal(connector.agentWindow, windows[0]?.id);
		assert.equal(windows[0]?.width, 1100);
		assert.equal(windows[0]?.height, 800);
		assert.equal(connector.ownsTab(session.tabId), true);
		assert.equal(await session.evaluate("document.title = 'Agent window'; document.title"), "Agent window");
		assert.equal((await connector.currentSession()).tabId, session.tabId, "repeat calls reuse the tab");
		assert.equal(await connector.cleanup(), 1, "the adopted startup tab belongs to this session");
	});
});

test("a differently sized startup window is replaced without leaving an empty window", async () => {
	await withConnector(async (connector) => {
		await connector.client();
		const startup = (await connector.listTabs()).tabs[0];
		const session = await connector.currentSession();
		const { tabs, windows } = await connector.listTabs();
		assert.notEqual(session.tabId, startup?.id, "a new agent window replaces the startup window");
		assert.equal(windows.length, 1);
		assert.equal(tabs.length, 1);
	}, false, ["--window-size=1280,900"]);
});

test("an existing personal blank window is not adopted or closed", async () => {
	await withConnector(async (connector, launcher) => {
		await connector.start();
		await launcher.launch();
		const before = await connector.listTabs();
		const personalTab = before.tabs[0];
		assert.ok(personalTab);
		await connector.currentSession();
		const after = await connector.listTabs();
		assert.equal(after.windows.length, 2);
		const preserved = after.tabs.find((tab) => tab.id === personalTab.id);
		assert.equal(preserved?.url, personalTab.url);
		assert.equal(preserved?.windowId, personalTab.windowId);
		assert.notEqual(connector.agentWindow, personalTab.windowId);
		assert.equal(connector.ownsTab(personalTab.id), false);
	});
});

test("a startup window containing a personal tab is left intact", async () => {
	await withConnector(async (connector) => {
		const client = await connector.client();
		const startup = (await connector.listTabs()).tabs[0];
		assert.ok(startup);
		const personal = (await client.request("tabs.create", { windowId: startup.windowId, url: "about:blank#personal" })) as TabInfo;
		await connector.currentSession();
		const { tabs, windows } = await connector.listTabs();
		assert.equal(windows.length, 2);
		assert.equal(tabs.length, 2, "only the connector's temporary tab is removed");
		assert.equal(tabs.find((tab) => tab.id === personal.id)?.url, personal.url);
		assert.equal(tabs.find((tab) => tab.id === personal.id)?.windowId, personal.windowId);
		assert.equal(tabs.some((tab) => tab.id === startup.id), false);
		assert.notEqual(connector.agentWindow, personal.windowId);
	});
});

test("a startup tab the user navigated is not adopted or removed", async () => {
	await withConnector(async (connector) => {
		const client = await connector.client();
		const startup = (await connector.listTabs()).tabs[0];
		assert.ok(startup);
		await client.request("tabs.update", { tabId: startup.id, url: "about:blank#personal" });
		await connector.currentSession();
		const { tabs, windows } = await connector.listTabs();
		assert.equal(windows.length, 2);
		assert.equal(tabs.find((tab) => tab.id === startup.id)?.url, "about:blank#personal");
		assert.equal(connector.ownsTab(startup.id), false);
	});
});

test("reuseWindow also consumes the startup tab instead of leaving it behind", async () => {
	await withConnector(async (connector) => {
		await connector.currentSession();
		const { tabs, windows } = await connector.listTabs();
		assert.equal(windows.length, 1);
		assert.equal(tabs.length, 1);
		assert.equal(tabs[0]?.url, "about:blank");
	}, true);
});

test("another pi session does not claim or remove this session's startup tab", async () => {
	await withConnector(async (connector, launcher) => {
		await connector.client();
		const startup = (await connector.listTabs()).tabs[0];
		assert.ok(startup);
		const other = new Connector({ ...connector.config, portRange: [TEST_PORT + 1, TEST_PORT + 1] }, launcher);
		try {
			const otherSession = await other.currentSession();
			assert.notEqual(otherSession.tabId, startup.id);
			const preserved = (await connector.listTabs()).tabs.find((tab) => tab.id === startup.id);
			assert.equal(preserved?.url, startup.url);
			assert.equal((await connector.currentSession()).tabId, startup.id);
			const { tabs, windows } = await connector.listTabs();
			assert.equal(windows.length, 2);
			assert.equal(tabs.length, 2);
		} finally {
			await other.stop();
		}
	});
});

test("waking a windowless browser leaves only the agent window", async () => {
	const browser = createTestLauncher();
	let activated = false;
	const connector = new Connector({
		...loadConfig(artifactsDir, {}),
		portRange: [TEST_PORT, TEST_PORT],
		focus: false,
		window: { width: 1100, height: 800 },
	}, {
		name: browser.launcher.name,
		async isRunning() { return true; },
		async launch() { throw new Error("an already-running browser should not be launched"); },
		async activate(url?: string) {
			activated = true;
			await browser.launcher.launch(url);
		},
	});
	try {
		await connector.currentSession();
		assert.equal(activated, true);
		const { tabs, windows } = await connector.listTabs();
		assert.equal(windows.length, 1);
		assert.equal(tabs.length, 1);
		assert.equal(tabs[0]?.url, "about:blank");
	} finally {
		await connector.stop();
		await browser.close();
	}
});
