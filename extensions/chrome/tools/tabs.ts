import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { TabInfo, WindowInfo } from "../bridge/protocol.ts";
import type { Connector } from "../connector.ts";
import { joinLines, registerChromeTool, type ToolServices } from "./shared.ts";

export function registerTabsTool(pi: ExtensionAPI, services: ToolServices): void {
	registerChromeTool(pi, services, {
		name: "chrome_tabs",
		label: "Chrome tabs",
		description:
			"List Chrome tabs and windows, or manage the tab the connector acts on. Actions: list (all tabs, current tab marked), new (open a tab in the agent window and make it current; optional url), use (make an existing tab current by tabId, urlIncludes or titleIncludes; this is how you act on a tab the user already has open), close (current tab or tabId), focus (bring the current tab's window to the front). All other chrome_* tools act on the current tab.",
		promptSnippet: "List Chrome tabs; open a new tab or point the connector at an existing one",
		parameters: Type.Object({
			action: StringEnum(["list", "new", "use", "close", "focus"] as const),
			url: Type.Optional(Type.String({ description: "URL to open (new)" })),
			tabId: Type.Optional(Type.Integer({ description: "Tab id from list (use, close)" })),
			urlIncludes: Type.Optional(Type.String({ description: "Pick the tab whose URL contains this (use)" })),
			titleIncludes: Type.Optional(Type.String({ description: "Pick the tab whose title contains this (use)" })),
			focus: Type.Optional(Type.Boolean({ description: "Override focus mode for this call" })),
		}),
		async execute(params, run) {
			const { connector } = services;
			switch (params.action) {
				case "list": {
					const listing = await connector.listTabs(run.signal);
					return { text: formatTabList(listing.tabs, listing.windows, connector) };
				}
				case "new": {
					const session = await connector.newTab(params.url, { focus: params.focus, signal: run.signal });
					const loaded = params.url ? await session.waitForFirstDocument(30_000) : true;
					const pending = loaded ? "" : " (still loading after 30s; the next action may run against an incomplete page)";
					// Chrome's tab title event can lag the load; read it from the page so the report is current.
					const title = loaded ? await session.evaluate<string>("document.title").catch(() => session.title) : session.title;
					return { text: `Opened tab [${session.tabId}] ${session.url || "about:blank"}${title ? ` "${title}"` : ""}${pending}. It is now the current tab.` };
				}
				case "use": {
					const listing = await connector.listTabs(run.signal);
					const tab = pickTab(listing.tabs, params);
					const session = await connector.useTab(tab.id, { focus: params.focus, signal: run.signal });
					return { text: `Current tab is now [${tab.id}] "${tab.title}" ${tab.url}${session.diagnostics.length ? `\nAttach diagnostics: ${session.diagnostics.join(" | ")}` : ""}` };
				}
				case "close": {
					const tabId = params.tabId ?? connector.currentTab;
					if (tabId === undefined) throw new Error("No current tab to close. Pass tabId.");
					await connector.closeTab(tabId, run.signal);
					return { text: `Closed tab [${tabId}].${connector.currentTab === undefined ? " No current tab; the next page action opens a new one." : ""}` };
				}
				case "focus": {
					const session = await connector.currentSession({ focus: false, signal: run.signal });
					await session.focus();
					return { text: `Focused tab [${session.tabId}] ${session.url}` };
				}
				default:
					throw new Error(`unknown action ${String(params.action)}`);
			}
		},
	});
}

function pickTab(tabs: TabInfo[], params: { tabId?: number; urlIncludes?: string; titleIncludes?: string }): TabInfo {
	if (params.tabId !== undefined) {
		const tab = tabs.find((candidate) => candidate.id === params.tabId);
		if (!tab) throw new Error(`No tab with id ${params.tabId}. Run chrome_tabs list.`);
		return tab;
	}
	const url = params.urlIncludes?.toLowerCase();
	const title = params.titleIncludes?.toLowerCase();
	if (!url && !title) throw new Error("use needs tabId, urlIncludes or titleIncludes.");
	const matches = tabs.filter((tab) => (!url || tab.url.toLowerCase().includes(url)) && (!title || tab.title.toLowerCase().includes(title)));
	if (matches.length === 0) throw new Error(`No tab matches ${[url && `url~"${params.urlIncludes}"`, title && `title~"${params.titleIncludes}"`].filter(Boolean).join(" ")}. Run chrome_tabs list.`);
	if (matches.length > 1) {
		throw new Error(`${matches.length} tabs match; pass tabId:\n${matches.map((tab) => `  [${tab.id}] "${tab.title}" ${tab.url}`).join("\n")}`);
	}
	return matches[0] as TabInfo;
}

export function formatTabList(tabs: TabInfo[], windows: WindowInfo[], connector: Connector): string {
	const lines: string[] = [];
	const byWindow = new Map<number, TabInfo[]>();
	for (const tab of tabs) {
		const list = byWindow.get(tab.windowId) ?? [];
		list.push(tab);
		byWindow.set(tab.windowId, list);
	}
	for (const win of windows) {
		const flags = [win.focused && "focused", win.id === connector.agentWindow && "agent window", win.state !== "normal" && win.state, win.incognito && "incognito"].filter(Boolean);
		lines.push(`Window ${win.id}${flags.length ? ` (${flags.join(", ")})` : ""}`);
		for (const tab of (byWindow.get(win.id) ?? []).sort((a, b) => a.index - b.index)) {
			const marker = tab.id === connector.currentTab ? "  <- current" : "";
			lines.push(`  [${tab.id}] ${tab.active ? "*" : " "} ${truncate(tab.title || "(untitled)", 60)} — ${truncate(tab.url, 100)}${marker}`);
		}
	}
	if (lines.length === 0) return "No tabs open.";
	return joinLines(lines.join("\n"), "(* = active tab in its window)");
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
