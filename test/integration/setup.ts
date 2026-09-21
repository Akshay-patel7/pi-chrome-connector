// Shared bring-up for tool-level tests: extension loaded into a FakePi, Chrome for Testing launched
// on demand, fixture server running.

import { join } from "node:path";
import type { ConnectorConfig } from "../../extensions/chrome/config.ts";
import type { Connector } from "../../extensions/chrome/connector.ts";
import { createChromeConnector } from "../../extensions/chrome/index.ts";
import { FakePi } from "./fake-pi.ts";
import { artifactsDir, createTestLauncher, startFixtureServer, TEST_PORT, type FixtureServer, type TestLauncher, type TestLauncherOptions } from "./harness.ts";

export interface ToolTestEnv {
	pi: FakePi;
	connector: Connector;
	launcher: TestLauncher;
	fixtures: FixtureServer;
	config: ConnectorConfig;
	close(): Promise<void>;
}

export async function startToolTestEnv(name: string, overrides: Partial<ConnectorConfig> = {}, launcherOptions: TestLauncherOptions = {}): Promise<ToolTestEnv> {
	const launcher = createTestLauncher(launcherOptions);
	const fixtures = await startFixtureServer();
	const pi = new FakePi();
	const config: ConnectorConfig = {
		portRange: [TEST_PORT, TEST_PORT],
		chromeApp: "Chrome for Testing",
		launchArgs: [],
		focus: true,
		window: { width: 1100, height: 800 },
		artifactDir: join(artifactsDir, name),
		reuseWindow: false,
		secrets: {},
		...overrides,
	};
	const connector = createChromeConnector(pi.api, { config, launcher: launcher.launcher });
	await pi.emit("session_start", { reason: "startup" });
	return {
		pi,
		connector,
		launcher,
		fixtures,
		config,
		async close() {
			await pi.emit("session_shutdown", { reason: "quit" });
			await fixtures.close();
			await launcher.close();
		},
	};
}
