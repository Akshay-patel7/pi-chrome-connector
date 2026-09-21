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
	launch(): Promise<void>;
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
		async launch() {
			if (platform === "darwin") {
				const args = ["-a", app];
				if (options.args.length > 0) args.push("--args", ...options.args);
				await execFileAsync("open", args);
				return;
			}
			if (platform === "win32") {
				spawn("cmd", ["/c", "start", "", app, ...options.args], { detached: true, stdio: "ignore", windowsHide: true }).unref();
				return;
			}
			if (app.includes("/") && !existsSync(app)) throw new Error(`Chrome binary not found at ${app}`);
			spawn(app, options.args, { detached: true, stdio: "ignore" }).unref();
		},
	};
}

export interface EnsureConnectedOptions {
	bridge: Bridge;
	launcher: ChromeLauncher;
	/** How long to wait for the extension after we launched the browser ourselves. */
	launchTimeoutMs?: number;
	/** How long to wait for the extension when the browser is already running (covers the 30 s alarm wake-up). */
	wakeTimeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

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
		await launcher.launch();
		const client = await bridge.waitForClient(options.launchTimeoutMs ?? 30_000, signal);
		if (client) return client;
		throw new Error(
			`Launched ${launcher.name} but the pi-chrome-connector extension did not connect to the bridge on port ${bridge.port}. ` +
				(bridge.lastHandshakeError
					? `It connected but the handshake failed: ${bridge.lastHandshakeError}`
					: "The extension is probably not installed or is disabled. Ask the user to run /chrome onboard, then /chrome doctor."),
		);
	}

	onProgress?.(`${launcher.name} is running; waiting for the companion extension to connect (up to 35 s if its worker is asleep)`);
	const client = await bridge.waitForClient(options.wakeTimeoutMs ?? 35_000, signal);
	if (client) return client;
	throw new Error(
		`${launcher.name} is running but the pi-chrome-connector extension did not connect to the bridge on port ${bridge.port} within the wait window. ` +
			(bridge.lastHandshakeError
				? `It connected but the handshake failed: ${bridge.lastHandshakeError}`
				: "Likely causes: the extension is not installed (run /chrome onboard), it is disabled, or it needs a reload at chrome://extensions. Run /chrome doctor for details."),
	);
}
