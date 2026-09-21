// Port discovery must not leave runtime errors on chrome://extensions. The staged extension's
// range covers TEST_PORT plus DEAD_PORT_SPAN ports nothing listens on; probing those with a
// WebSocket would be recorded as an error, probing with fetch is not.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Bridge } from "../../extensions/chrome/bridge/server.ts";
import { createTestLauncher, openExtensionsPage, startFixtureServer, TEST_PORT, type FixtureServer, type TestLauncher } from "./harness.ts";

let launcher: TestLauncher;
let bridge: Bridge;
let fixtures: FixtureServer;

before(async () => {
	launcher = createTestLauncher();
	bridge = await Bridge.listen({ portRange: [TEST_PORT, TEST_PORT], label: "discovery-test" });
	fixtures = await startFixtureServer();
	await launcher.launcher.launch();
	assert.ok(await bridge.waitForClient(30_000), "extension connected to the live port");
});

after(async () => {
	await bridge.close();
	await fixtures.close();
	await launcher.close();
});

test("/status identifies the bridge for the extension's probe", async () => {
	const status = (await (await fetch(`http://127.0.0.1:${TEST_PORT}/status`)).json()) as { name: string; label: string; protocol: number; clients: unknown[] };
	assert.equal(status.name, "pi-chrome-connector");
	assert.equal(status.label, "discovery-test");
	assert.equal(status.protocol, 1);
	assert.equal(status.clients.length, 1);
});

test("probing dead ports records no runtime errors and the live port reconnects after a worker restart", async () => {
	const page = await openExtensionsPage(await launcher.devtoolsUrl(), "pi-chrome-connector");
	try {
		const before = bridge.connectedClients[0];
		assert.ok(before);
		// Developer mode is on now; restart the worker so its startup probes run while errors are being collected.
		const gone = new Promise<void>((resolveClosed) => bridge.once("clientClosed", () => resolveClosed()));
		await page.reload();
		await gone;
		const again = await bridge.waitForClient(15_000);
		assert.ok(again, "extension reconnected after reload");
		assert.notEqual(again.id, before.id);
		// Give the dead-port probes (immediate, then 2 s backoff) time to run and miss at least twice.
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 3_500));
		assert.deepEqual(await page.errors(), [], "no runtime errors on chrome://extensions");
		assert.equal(bridge.connectedClients.length, 1, "exactly one connection to the live port");
	} finally {
		await page.close();
	}
});
