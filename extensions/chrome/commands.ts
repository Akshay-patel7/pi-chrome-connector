// /chrome slash command: status, onboarding, diagnostics, launch, focus toggle, cleanup.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { Connector } from "./connector.ts";
import { chromeVersion } from "./tools/status.ts";
import { formatTabList } from "./tools/tabs.ts";

const execFileAsync = promisify(execFile);

export interface CommandServices {
	connector: Connector;
	extensionDir: string;
	packageVersion: string;
}

const USAGE = [
	"/chrome            connection status (does not launch Chrome)",
	"/chrome onboard    load the companion extension into Chrome (one time)",
	"/chrome doctor     full diagnostics",
	"/chrome launch     launch Chrome and wait for the extension",
	"/chrome tabs       list tabs",
	"/chrome focus on|off   bring Chrome to the front on actions (session setting)",
	"/chrome cleanup    close tabs this session opened",
].join("\n");

export function registerChromeCommand(pi: ExtensionAPI, services: CommandServices): void {
	pi.registerCommand("chrome", {
		description: "Chrome connector: status, onboard, doctor, launch, tabs, focus on|off, cleanup",
		getArgumentCompletions: (prefix) => {
			const options = ["status", "onboard", "doctor", "launch", "tabs", "focus on", "focus off", "cleanup", "help"];
			const items = options.filter((option) => option.startsWith(prefix)).map((option) => ({ value: option, label: option }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				switch (sub) {
					case "status":
						return notifyLines(ctx, await statusLines(services));
					case "onboard":
						return onboard(ctx, services);
					case "doctor":
						return notifyLines(ctx, await doctorLines(services));
					case "launch": {
						ctx.ui.notify("Launching Chrome and waiting for the companion extension…", "info");
						const client = await services.connector.client();
						return ctx.ui.notify(`Connected: extension v${client.info?.version}, ${chromeVersion(client.info?.userAgent)}.`, "info");
					}
					case "tabs": {
						const listing = await services.connector.listTabs();
						return notifyLines(ctx, [formatTabList(listing.tabs, listing.windows, services.connector)]);
					}
					case "focus": {
						const mode = rest[0];
						if (mode !== "on" && mode !== "off") return ctx.ui.notify(`Focus mode is ${services.connector.focus ? "on" : "off"}. Use /chrome focus on|off.`, "info");
						services.connector.setFocus(mode === "on");
						return ctx.ui.notify(`Focus mode ${mode}: actions ${mode === "on" ? "bring Chrome to the front" : "leave Chrome in the background"}.`, "info");
					}
					case "cleanup": {
						const closed = await services.connector.cleanup();
						return ctx.ui.notify(`Closed ${closed} tab(s) opened by this session.`, "info");
					}
					default:
						return notifyLines(ctx, [USAGE]);
				}
			} catch (error) {
				ctx.ui.notify(`chrome: ${(error as Error).message}`, "error");
			}
		},
	});
}

function notifyLines(ctx: ExtensionCommandContext, lines: string[]): void {
	ctx.ui.notify(lines.join("\n"), "info");
}

async function statusLines(services: CommandServices): Promise<string[]> {
	const { connector } = services;
	const lines: string[] = [];
	if (!connector.isStarted) {
		lines.push("Bridge: not started (starts with the session; run /chrome launch to connect now).");
	} else {
		lines.push(`Bridge: listening on 127.0.0.1:${connector.port}`);
	}
	const client = connector.connectedClient;
	if (client) {
		lines.push(`Extension: connected, v${client.info?.version} in ${chromeVersion(client.info?.userAgent)}${client.info?.version !== services.packageVersion ? ` (package is v${services.packageVersion}; reload the extension at chrome://extensions to update)` : ""}`);
	} else {
		const running = await connector.launcher.isRunning();
		lines.push(running ? `Extension: not connected yet (${connector.launcher.name} is running; its worker wakes within ~30 s, or run /chrome doctor)` : `Extension: not connected (${connector.launcher.name} is not running; the first browser tool call launches it, or run /chrome launch)`);
	}
	lines.push(`Current tab: ${connector.currentTab === undefined ? "none yet" : `[${connector.currentTab}]`}; focus mode ${connector.focus ? "on" : "off"}; owned tabs: ${connector.state.ownedTabIds.length}`);
	return lines;
}

async function doctorLines(services: CommandServices): Promise<string[]> {
	const { connector } = services;
	const lines: string[] = [];
	const ok = (text: string) => lines.push(`✓ ${text}`);
	const bad = (text: string) => lines.push(`✗ ${text}`);

	try {
		const bridge = await connector.start();
		ok(`bridge listening on 127.0.0.1:${bridge.port} (range ${connector.config.portRange[0]}-${connector.config.portRange[1]})`);
	} catch (error) {
		bad(`bridge failed to start: ${(error as Error).message}`);
		return lines;
	}
	const running = await connector.launcher.isRunning();
	if (running) ok(`${connector.launcher.name} is running`);
	else bad(`${connector.launcher.name} is not running (run /chrome launch; config chromeApp="${connector.config.chromeApp}")`);

	const client = connector.connectedClient;
	if (!client) {
		bad(`companion extension not connected. Extension folder: ${services.extensionDir}`);
		const handshake = connector.lastHandshakeError;
		if (handshake) lines.push(`  - it connected but the handshake failed: ${handshake}`);
		lines.push("  - not installed? run /chrome onboard");
		lines.push("  - installed but asleep? it reconnects within ~30 s of pi starting; click its toolbar icon to force a reconnect");
		lines.push("  - disabled or errored? check chrome://extensions and reload it");
		return lines;
	}
	ok(`extension v${client.info?.version} connected from ${client.origin} (${chromeVersion(client.info?.userAgent)})`);
	if (client.info?.version !== services.packageVersion) lines.push(`  ! package is v${services.packageVersion}; reload the extension at chrome://extensions after updates`);
	try {
		const listing = await connector.listTabs();
		ok(`chrome.tabs works: ${listing.tabs.length} tab(s) in ${listing.windows.length} window(s)`);
	} catch (error) {
		bad(`tabs.list failed: ${(error as Error).message}`);
	}
	try {
		const session = await connector.currentSession({ focus: false });
		const title = await session.evaluate<string>("document.title");
		ok(`debugger attach + Runtime.evaluate work on tab [${session.tabId}] ("${title || session.url}")`);
		if (session.diagnostics.length) lines.push(`  ! attach diagnostics: ${session.diagnostics.join(" | ")}`);
	} catch (error) {
		bad(`page probe failed: ${(error as Error).message}`);
	}
	lines.push(`Focus mode: ${connector.focus ? "on" : "off"}. Artifacts: ${connector.config.artifactDir}`);
	return lines;
}

async function onboard(ctx: ExtensionCommandContext, services: CommandServices): Promise<void> {
	const dir = services.extensionDir;
	const steps = [
		`1. Chrome opens chrome://extensions (turn on "Developer mode", top right).`,
		`2. Click "Load unpacked" and pick this folder:`,
		`   ${dir}`,
		process.platform === "darwin" ? `   (path copied to the clipboard; press Cmd+Shift+G in the file dialog and paste)` : "",
		`3. Back in pi, run /chrome doctor.`,
	].filter(Boolean);
	if (!ctx.hasUI) {
		ctx.ui.notify(steps.join("\n"), "info");
		return;
	}
	const go = await ctx.ui.confirm("Load the pi-chrome-connector extension", `${steps.join("\n")}\n\nOpen chrome://extensions now?`);
	if (!go) return;
	try {
		if (process.platform === "darwin") {
			await execFileAsync("open", ["-a", services.connector.config.chromeApp, "chrome://extensions"]);
			await execFileAsync("open", ["-R", dir]).catch(() => {});
			await copyToClipboard(dir);
		} else if (process.platform === "win32") {
			await execFileAsync("cmd", ["/c", "start", "", "chrome://extensions"]);
		} else {
			await execFileAsync("xdg-open", ["chrome://extensions"]).catch(() => {});
		}
		ctx.ui.notify(`Load unpacked → ${dir}\nThen run /chrome doctor.`, "info");
	} catch (error) {
		ctx.ui.notify(`Could not open Chrome automatically (${(error as Error).message}). Open chrome://extensions yourself and load: ${dir}`, "warning");
	}
}

async function copyToClipboard(text: string): Promise<void> {
	await new Promise<void>((resolveCopy, reject) => {
		const child = execFile("pbcopy", (error) => (error ? reject(error) : resolveCopy()));
		child.stdin?.end(text);
	}).catch(() => {});
}

export function readPackageVersion(packageJsonPath: string): string {
	try {
		const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
		return parsed.version ?? "unknown";
	} catch {
		return "unknown";
	}
}
