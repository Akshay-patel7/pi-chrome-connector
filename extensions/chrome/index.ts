// pi-chrome-connector: drive the user's real Chrome from pi through a companion extension.
//
// Layout:
//   bridge/     WebSocket server the extension connects to; Chrome launch/detection
//   cdp/        per-tab DevTools Protocol session with console/network/dialog/frame tracking
//   tools/      chrome_* tools registered with pi
//   commands.ts /chrome slash command

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ChromeLauncher, createSystemLauncher } from "./bridge/launch.ts";
import { readPackageVersion, registerChromeCommand } from "./commands.ts";
import { type ConnectorConfig, loadConfig } from "./config.ts";
import { Connector, type ConnectorState } from "./connector.ts";
import { registerDevtoolsTools } from "./tools/devtools.ts";
import { registerDialogTool } from "./tools/dialog.ts";
import { registerEmulateTool } from "./tools/emulate.ts";
import { registerEvaluateTool } from "./tools/evaluate.ts";
import { registerInteractionTools } from "./tools/interact.ts";
import { registerNavigateTool } from "./tools/navigate.ts";
import { registerScreenshotTool } from "./tools/screenshot.ts";
import { registerSnapshotTools } from "./tools/snapshot.ts";
import { registerStatusTool } from "./tools/status.ts";
import { registerTabsTool } from "./tools/tabs.ts";
import { registerWaitTool } from "./tools/wait.ts";

const STATE_ENTRY_TYPE = "pi-chrome-connector";

export interface ChromeConnectorOptions {
	config?: ConnectorConfig;
	launcher?: ChromeLauncher;
}

export default function chromeConnector(pi: ExtensionAPI): void {
	createChromeConnector(pi);
}

/** Wire the connector into pi. Options exist so tests can inject a config and launcher. */
export function createChromeConnector(pi: ExtensionAPI, options: ChromeConnectorOptions = {}): Connector {
	const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const config = options.config ?? loadConfig(getAgentDir());
	const launcher = options.launcher ?? createSystemLauncher({ app: config.chromeApp, args: config.launchArgs });
	const connector = new Connector(config, launcher);
	const services = { connector };

	connector.on("stateChanged", (state) => pi.appendEntry(STATE_ENTRY_TYPE, state));

	pi.on("session_start", async (_event, ctx) => {
		let restored: Partial<ConnectorState> | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) restored = entry.data as Partial<ConnectorState>;
		}
		if (restored) connector.restoreState(restored);
		// Listen right away so the companion extension connects before the first browser call.
		try {
			await connector.start();
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Chrome connector bridge failed to start: ${(error as Error).message}`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		await connector.stop().catch(() => {});
	});

	registerStatusTool(pi, services);
	registerTabsTool(pi, services);
	registerNavigateTool(pi, services);
	registerSnapshotTools(pi, services);
	registerInteractionTools(pi, services);
	registerEvaluateTool(pi, services);
	registerWaitTool(pi, services);
	registerScreenshotTool(pi, services, config.artifactDir);
	registerDialogTool(pi, services);
	registerDevtoolsTools(pi, services, config.artifactDir);
	registerEmulateTool(pi, services);

	registerChromeCommand(pi, {
		connector,
		extensionDir: join(packageRoot, "chrome-extension"),
		packageVersion: readPackageVersion(join(packageRoot, "package.json")),
	});
	return connector;
}
