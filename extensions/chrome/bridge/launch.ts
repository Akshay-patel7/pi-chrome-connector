// Detect whether Chrome is running and launch it when it is not. The companion extension
// starts with the browser and connects to the bridge on its own, so launching is all we need.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { Bridge, ExtensionClient } from "./server.ts";

const execFileAsync = promisify(execFile);

export interface ChromeLauncher {
	/** Human-readable name of the browser being controlled, for messages. */
	readonly name: string;
	isRunning(): Promise<boolean>;
	launch(url?: string): Promise<void>;
	/**
	 * Ask a running browser to show a window. On macOS Chrome keeps running after its last window
	 * closes, and an extension only runs while its profile has a window: its service worker is gone
	 * and the reconnect alarm never fires. Opening a window starts it again within a few seconds.
	 */
	activate(url?: string): Promise<void>;
}

export interface SystemLauncherOptions {
	/** macOS application name (open -a) or Linux/Windows executable path or name. */
	app: string;
	/** Extra command-line flags. Only applied when this package launches the browser. */
	args: string[];
	platform?: NodeJS.Platform;
}

/** Launcher backed by the operating system: `open -a` on macOS, a detached spawn elsewhere. */
export function createSystemLauncher(options: SystemLauncherOptions): ChromeLauncher {
	const platform = options.platform ?? process.platform;
	const app = options.app;
	return {
		name: app,
		async isRunning() {
			try {
				if (platform === "darwin") {
					// The main process of "/Applications/Google Chrome.app" is named "Google Chrome".
					await execFileAsync("pgrep", ["-x", app]);
					return true;
				}
				if (platform === "win32") {
					const image = app.toLowerCase().endsWith(".exe") ? app : `${app}.exe`;
					const { stdout } = await execFileAsync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH"]);
					return stdout.toLowerCase().includes(image.toLowerCase());
				}
				await execFileAsync("pgrep", ["-x", app.split("/").pop() ?? app]);
				return true;
			} catch {
				return false;
			}
		},
		async launch(url?: string) {
			if (platform === "darwin") {
				const args = ["-a", app];
				if (url) args.push(url);
				if (options.args.length > 0) args.push("--args", ...options.args);
				await execFileAsync("open", args);
				return;
			}
			if (platform === "win32") {
				spawn("cmd", ["/c", "start", "", app, ...options.args, ...(url ? [url] : [])], { detached: true, stdio: "ignore", windowsHide: true }).unref();
				return;
			}
			if (app.includes("/") && !existsSync(app)) throw new Error(`Chrome binary not found at ${app}`);
			spawn(app, [...options.args, ...(url ? [url] : [])], { detached: true, stdio: "ignore" }).unref();
		},
		async activate(url?: string) {
			// Hand the URL to the running browser. It opens a window if there is none, or a tab in an
			// existing window. The connector only adopts a window containing its own startup tab.
			if (platform === "darwin") {
				await execFileAsync("open", ["-a", app, ...(url ? [url] : [])]);
				return;
			}
			if (platform === "win32") {
				spawn("cmd", ["/c", "start", "", app, ...(url ? [url] : [])], { detached: true, stdio: "ignore", windowsHide: true }).unref();
				return;
			}
			if (app.includes("/") && !existsSync(app)) return;
			spawn(app, url ? [url] : [], { detached: true, stdio: "ignore" }).unref();
		},
	};
}

export interface EnsureConnectedOptions {
	bridge: Bridge;
	launcher: ChromeLauncher;
	/** Session-specific landing page identifying the tab opened by launch or activation. */
	startupUrl?: string;
	/** How long to wait for the extension after we launched the browser ourselves. */
	launchTimeoutMs?: number;
	/**
	 * How long to wait for the extension when the browser is already running. An awake worker probes
	 * every 2 s; an idle one is revived by a 30 s alarm that Chrome may fire late, so this covers two
	 * alarm periods.
	 */
	wakeTimeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

/** How long an already-running Chrome gets to connect on its own before a window is requested. */
export const ACTIVATE_AFTER_MS = 3_000;

/**
 * Return a connected companion client, launching Chrome if it is not running.
 * Throws a diagnostic error when the extension never connects.
 */
export async function ensureConnected(options: EnsureConnectedOptions): Promise<ExtensionClient> {
	const { bridge, launcher, signal, onProgress } = options;
	const existing = bridge.connectedClients[0];
	if (existing) return existing;

	const running = await launcher.isRunning();
	if (!running) {
		onProgress?.(`${launcher.name} is not running; launching it`);
		await launcher.launch(options.startupUrl);
		const client = await bridge.waitForClient(options.launchTimeoutMs ?? 30_000, signal);
		if (client) return client;
		throw new Error(
			`Launched ${launcher.name} but the pi-chrome-connector extension did not connect to the bridge on port ${bridge.port}. ` +
				(bridge.lastHandshakeError
					? `It connected but the handshake failed: ${bridge.lastHandshakeError}`
					: "The extension is probably not installed or is disabled. Ask the user to run /chrome onboard, then /chrome doctor."),
		);
	}

	const wakeTimeoutMs = options.wakeTimeoutMs ?? 60_000;
	onProgress?.(`${launcher.name} is running; waiting for the companion extension to connect`);
	// An awake worker probes every 2 s. Silence past that usually means Chrome has no window for the
	// extension's profile (the worker is not running at all), so ask for one and keep waiting.
	const early = await bridge.waitForClient(Math.min(ACTIVATE_AFTER_MS, wakeTimeoutMs), signal);
	if (early) return early;
	onProgress?.(`${launcher.name} has not answered in ${ACTIVATE_AFTER_MS / 1000} s; opening a window so its extension runs (an idle worker can also take up to 30 s; giving up after ${Math.round(wakeTimeoutMs / 1000)} s)`);
	await launcher.activate(options.startupUrl);
	const client = await bridge.waitForClient(Math.max(0, wakeTimeoutMs - ACTIVATE_AFTER_MS), signal);
	if (client) return client;
	throw new Error(
		`${launcher.name} is running but the pi-chrome-connector extension did not connect to the bridge on port ${bridge.port} within ${Math.round(wakeTimeoutMs / 1000)} s. ` +
			(bridge.lastHandshakeError
				? `It connected but the handshake failed: ${bridge.lastHandshakeError}`
				: "Likely causes: the extension is not installed (run /chrome onboard), it is disabled, it is installed in a profile other than the one whose window just opened, or it needs a reload at chrome://extensions (clicking its toolbar icon forces a reconnect). Run /chrome doctor for details."),
	);
}

