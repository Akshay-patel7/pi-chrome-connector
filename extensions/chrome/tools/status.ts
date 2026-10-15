import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Connector } from "../connector.ts";
import { joinLines, registerChromeTool, shortUrl, type ToolServices } from "./shared.ts";

export function registerStatusTool(pi: ExtensionAPI, services: ToolServices): void {
	registerChromeTool(pi, services, {
		name: "chrome_status",
		label: "Chrome status",
		description:
			"Connection status of the Chrome connector: launches Chrome if needed, waits for the companion extension, and reports the current tab, focus mode, open dialogs and buffer sizes. Cheap; use it when unsure whether Chrome is reachable.",
		parameters: Type.Object({}),
		async execute(_params, run) {
			return { text: (await statusLines(services.connector, run.signal)).join("\n") };
		},
	});
}

/**
 * The one tool declared up front when `lazyTools` is on. Calling it declares the chrome_* tools
 * for the rest of the session (pi records the change in the transcript, so a resumed session keeps
 * them) and doubles as the connection check, so the call is not wasted.
 */
export function registerChromeLoaderTool(pi: ExtensionAPI, services: ToolServices): void {
	// Snapshot the names now: the loader is registered last, and its own name must not be in the list.
	const chromeTools = [...services.toolNames];
	registerChromeTool(pi, services, {
		name: "chrome",
		label: "Chrome",
		exposure: "direct",
		description:
			`Start browser work: connects to the user's Chrome (launching it if needed), reports the current tab, and declares the chrome_* tools for this session: ${chromeTools.join(", ")}. Call it once before any of them; they are not available until then.`,
		promptSnippet: "Connect to Chrome and declare the chrome_* browser tools (navigate, snapshot, click, fill, wait, screenshot, console, network, ...)",
		parameters: Type.Object({}),
		async execute(_params, run) {
			const active = new Set(pi.getActiveTools());
			const added = chromeTools.filter((name) => !active.has(name));
			if (added.length > 0) pi.setActiveTools([...active, ...added]);
			const lines = await statusLines(services.connector, run.signal);
			return {
				text: joinLines(
					added.length > 0 ? `Declared ${added.length} chrome_* tools for this session.` : "The chrome_* tools were already declared.",
					...lines,
					"Loop: chrome_navigate → chrome_snapshot or chrome_find → act (chrome_click, chrome_fill, chrome_press) → chrome_wait for a condition → verify (chrome_evaluate, chrome_console, chrome_network, chrome_screenshot). Finds and actions wait up to 5 s for their element, so the step after a navigation or click needs no sleep.",
				),
			};
		},
	});
}

export async function statusLines(connector: Connector, signal: AbortSignal | undefined): Promise<string[]> {
	const client = await connector.client(signal);
	const listing = await connector.listTabs(signal);
	const lines = [
		`Connected: bridge 127.0.0.1:${connector.port}, extension v${client.info?.version} (${client.info?.extensionId}), ${chromeVersion(client.info?.userAgent)}`,
		`Tabs: ${listing.tabs.length} across ${listing.windows.length} window(s). Focus mode: ${connector.focus ? "on (actions bring Chrome to front)" : "off (actions stay in background)"}.`,
	];
	const current = connector.currentTab;
	if (current === undefined) {
		lines.push("Current tab: none yet. The first page action opens a dedicated agent window.");
	} else {
		const tab = listing.tabs.find((candidate) => candidate.id === current);
		lines.push(tab ? `Current tab: [${tab.id}] "${tab.title}" ${shortUrl(tab.url)}` : `Current tab: [${current}] (no longer open; next action creates a new one)`);
	}
	const secretNames = Object.keys(connector.config.secrets);
	lines.push(secretNames.length ? `Secrets available for chrome_fill/chrome_type (secret: NAME): ${secretNames.join(", ")}` : "Secrets: none configured (add a \"secrets\" map to ~/.pi/agent/chrome-connector.json to log in without exposing credentials).");
	for (const session of connector.attachedSessions()) {
		const parts = [`console ${session.console.size}`, `network ${session.network.size}`, `routes ${session.routes.size}`, `frames ${session.frames.size}`];
		if (session.dialog) parts.push(`DIALOG OPEN (${session.dialog.type}: "${session.dialog.message.slice(0, 60)}")`);
		if (session.dialogPolicy !== "manual") parts.push(`dialog policy ${session.dialogPolicy}`);
		lines.push(`Attached tab [${session.tabId}]: ${parts.join(", ")}${session.diagnostics.length ? `; diagnostics: ${session.diagnostics.join(" | ")}` : ""}`);
	}
	return lines;
}

export function chromeVersion(userAgent: string | undefined): string {
	const match = /Chrome\/([\d.]+)/.exec(userAgent ?? "");
	return match ? `Chrome ${match[1]}` : "Chrome (version unknown)";
}
