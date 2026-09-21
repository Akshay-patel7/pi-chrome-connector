import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerChromeTool, type ToolServices } from "./shared.ts";

export function registerStatusTool(pi: ExtensionAPI, services: ToolServices): void {
	registerChromeTool(pi, services, {
		name: "chrome_status",
		label: "Chrome status",
		description:
			"Connection status of the Chrome connector. Launches Chrome if it is not running and waits for the companion extension to connect. Reports the current tab, focus mode, open dialogs, and buffer sizes. Cheap; use it when unsure whether Chrome is reachable.",
		parameters: Type.Object({}),
		async execute(_params, run) {
			const { connector } = services;
			const client = await connector.client(run.signal);
			const listing = await connector.listTabs(run.signal);
			const lines = [
				`Connected: bridge 127.0.0.1:${connector.port}, extension v${client.info?.version} (${client.info?.extensionId}), ${chromeVersion(client.info?.userAgent)}`,
				`Tabs: ${listing.tabs.length} across ${listing.windows.length} window(s). Focus mode: ${connector.focus ? "on (actions bring Chrome to front)" : "off (actions stay in background)"}.`,
			];
			const current = connector.currentTab;
			if (current === undefined) {
				lines.push("Current tab: none yet. The first page action opens a dedicated agent window.");
			} else {
				const tab = listing.tabs.find((candidate) => candidate.id === current);
				lines.push(tab ? `Current tab: [${tab.id}] "${tab.title}" ${tab.url}` : `Current tab: [${current}] (no longer open; next action creates a new one)`);
			}
			const secretNames = Object.keys(connector.config.secrets);
			lines.push(secretNames.length ? `Secrets available for chrome_fill/chrome_type (secret: NAME): ${secretNames.join(", ")}` : "Secrets: none configured (add a \"secrets\" map to ~/.pi/agent/chrome-connector.json to log in without exposing credentials).");
			for (const session of connector.attachedSessions()) {
				const parts = [`console ${session.console.size}`, `network ${session.network.size}`, `routes ${session.routes.size}`, `frames ${session.frames.size}`];
				if (session.dialog) parts.push(`DIALOG OPEN (${session.dialog.type}: "${session.dialog.message.slice(0, 60)}")`);
				if (session.dialogPolicy !== "manual") parts.push(`dialog policy ${session.dialogPolicy}`);
				lines.push(`Attached tab [${session.tabId}]: ${parts.join(", ")}${session.diagnostics.length ? `; diagnostics: ${session.diagnostics.join(" | ")}` : ""}`);
			}
			return { text: lines.join("\n") };
		},
	});
}

export function chromeVersion(userAgent: string | undefined): string {
	const match = /Chrome\/([\d.]+)/.exec(userAgent ?? "");
	return match ? `Chrome ${match[1]}` : "Chrome (version unknown)";
}
