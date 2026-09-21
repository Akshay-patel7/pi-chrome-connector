// Optional user configuration: ~/.pi/agent/chrome-connector.json (or $PI_CHROME_CONNECTOR_CONFIG).
// Every key is optional; defaults below apply otherwise.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PORT_RANGE } from "./bridge/protocol.ts";

export interface ConnectorConfig {
	/** Inclusive loopback port range shared with the companion extension. */
	portRange: [number, number];
	/** macOS app name for `open -a`, or an executable name/path on Linux and Windows. */
	chromeApp: string;
	/** Extra flags, only used when this package launches Chrome itself. */
	launchArgs: string[];
	/** Bring the Chrome window to the front before each action. */
	focus: boolean;
	/** Size of the dedicated agent window. */
	window: { width: number; height: number };
	/** Where screenshots and PDFs go when no path is given. */
	artifactDir: string;
	/** Reuse an existing window (the one containing the active tab) instead of opening a dedicated one. */
	reuseWindow: boolean;
	/**
	 * Named values chrome_fill / chrome_type can enter without the value passing through the model
	 * (`secret: "APP_PASSWORD"`). Environment variables are consulted when a name is missing here.
	 */
	secrets: Record<string, string>;
}

/** Resolve a secret by name from the config, then the environment. */
export function resolveSecret(config: ConnectorConfig, name: string, env: NodeJS.ProcessEnv = process.env): string {
	const value = config.secrets[name] ?? env[name];
	if (value === undefined || value === "") {
		const known = Object.keys(config.secrets);
		throw new Error(`Unknown secret "${name}". Known secret names: ${known.length ? known.join(", ") : "(none)"}. Add it under "secrets" in ~/.pi/agent/chrome-connector.json or export it as an environment variable.`);
	}
	return value;
}

export function defaultChromeApp(platform: NodeJS.Platform = process.platform): string {
	if (platform === "darwin") return "Google Chrome";
	if (platform === "win32") return "chrome";
	return "google-chrome";
}

export function loadConfig(agentDir: string, env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
	const defaults: ConnectorConfig = {
		portRange: [DEFAULT_PORT_RANGE[0], DEFAULT_PORT_RANGE[1]],
		chromeApp: defaultChromeApp(),
		// Hides the "pi-chrome-connector started debugging this browser" bar. Only applies when this
		// package launches Chrome; a Chrome that is already running keeps its own flags.
		launchArgs: ["--silent-debugger-extension-api"],
		focus: true,
		window: { width: 1280, height: 900 },
		artifactDir: join(agentDir, "chrome-connector"),
		reuseWindow: false,
		secrets: {},
	};
	const path = env.PI_CHROME_CONNECTOR_CONFIG ?? join(agentDir, "chrome-connector.json");
	if (!existsSync(path)) return defaults;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`could not parse ${path}: ${(error as Error).message}`);
	}
	if (!raw || typeof raw !== "object") return defaults;
	const user = raw as Partial<Record<keyof ConnectorConfig, unknown>>;
	const config: ConnectorConfig = { ...defaults };
	if (Array.isArray(user.portRange) && user.portRange.length === 2 && user.portRange.every((value) => Number.isInteger(value))) {
		config.portRange = [user.portRange[0] as number, user.portRange[1] as number];
	}
	if (typeof user.chromeApp === "string" && user.chromeApp.trim()) config.chromeApp = user.chromeApp.trim();
	if (Array.isArray(user.launchArgs)) config.launchArgs = user.launchArgs.filter((value): value is string => typeof value === "string");
	if (typeof user.focus === "boolean") config.focus = user.focus;
	if (user.window && typeof user.window === "object") {
		const size = user.window as { width?: unknown; height?: unknown };
		if (typeof size.width === "number" && typeof size.height === "number") config.window = { width: size.width, height: size.height };
	}
	if (typeof user.artifactDir === "string" && user.artifactDir.trim()) config.artifactDir = expandHome(user.artifactDir.trim(), env);
	if (typeof user.reuseWindow === "boolean") config.reuseWindow = user.reuseWindow;
	if (user.secrets && typeof user.secrets === "object") {
		config.secrets = Object.fromEntries(Object.entries(user.secrets as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
	}
	return config;
}

function expandHome(path: string, env: NodeJS.ProcessEnv): string {
	const home = env.HOME ?? env.USERPROFILE;
	return home && path.startsWith("~/") ? join(home, path.slice(2)) : path;
}
