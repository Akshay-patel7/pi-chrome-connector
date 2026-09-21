import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { TabSession } from "../cdp/session.ts";
import { registerChromeTool, type ToolServices } from "./shared.ts";

interface Device {
	width: number;
	height: number;
	deviceScaleFactor: number;
	mobile: boolean;
	userAgent: string;
}

const DEVICES: Record<string, Device> = {
	"iPhone 15": { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
	"iPhone SE": { width: 375, height: 667, deviceScaleFactor: 2, mobile: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
	"Pixel 8": { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36" },
	"iPad": { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
	"Laptop": { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false, userAgent: "" },
	"Desktop": { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, userAgent: "" },
};

const NETWORK_PROFILES: Record<string, { latency: number; downloadThroughput: number; uploadThroughput: number }> = {
	"slow-3g": { latency: 2000, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8 },
	"fast-3g": { latency: 563, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
	"4g": { latency: 170, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (9 * 1024 * 1024) / 8 },
	"none": { latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
};

export function registerEmulateTool(pi: ExtensionAPI, services: ToolServices): void {
	registerChromeTool(pi, services, {
		name: "chrome_emulate",
		label: "Chrome emulate",
		description:
			`Emulate conditions in the current tab (like DevTools device toolbar / rendering / network panels). Any combination of: device preset (${Object.keys(DEVICES).join(", ")}) or explicit viewport width/height (+ deviceScaleFactor, mobile touch); userAgent; colorScheme dark|light; reducedMotion; locale (e.g. de-DE) and timezone (e.g. Europe/Berlin); geolocation latitude/longitude (the site must already have location permission; it cannot be granted from here); offline; network throttling profile (${Object.keys(NETWORK_PROFILES).join(", ")}); cpuSlowdown factor (e.g. 4); mediaType print|screen. reset: true clears all emulation. Settings persist for the tab until reset. Pages without a viewport meta tag lay out at 980px in mobile mode, like on a real phone.`,
		promptSnippet: "Emulate device/viewport, dark mode, locale, geolocation, offline or slow network in the current Chrome tab",
		parameters: Type.Object({
			device: Type.Optional(StringEnum(Object.keys(DEVICES) as [string, ...string[]])),
			width: Type.Optional(Type.Integer()),
			height: Type.Optional(Type.Integer()),
			deviceScaleFactor: Type.Optional(Type.Number()),
			mobile: Type.Optional(Type.Boolean({ description: "Mobile layout + touch events" })),
			userAgent: Type.Optional(Type.String()),
			colorScheme: Type.Optional(StringEnum(["dark", "light"] as const)),
			reducedMotion: Type.Optional(Type.Boolean()),
			mediaType: Type.Optional(StringEnum(["print", "screen"] as const)),
			locale: Type.Optional(Type.String()),
			timezone: Type.Optional(Type.String()),
			latitude: Type.Optional(Type.Number()),
			longitude: Type.Optional(Type.Number()),
			offline: Type.Optional(Type.Boolean()),
			network: Type.Optional(StringEnum(Object.keys(NETWORK_PROFILES) as [string, ...string[]])),
			cpuSlowdown: Type.Optional(Type.Number({ description: "1 = no throttling" })),
			reset: Type.Optional(Type.Boolean()),
		}),
		async execute(params, run) {
			const session = await services.connector.currentSession({ focus: false, signal: run.signal });
			const applied: string[] = [];
			if (params.reset) {
				await resetEmulation(session);
				applied.push("reset all emulation");
			}
			const device = params.device ? DEVICES[params.device] : undefined;
			if (device || params.width !== undefined || params.height !== undefined) {
				const width = params.width ?? device?.width ?? (await session.evaluate<number>("innerWidth"));
				const height = params.height ?? device?.height ?? (await session.evaluate<number>("innerHeight"));
				const mobile = params.mobile ?? device?.mobile ?? false;
				await session.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: params.deviceScaleFactor ?? device?.deviceScaleFactor ?? 0, mobile });
				await session.send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
				applied.push(`viewport ${width}x${height}${mobile ? " mobile+touch" : ""}${params.device ? ` (${params.device})` : ""}`);
			}
			const userAgent = params.userAgent ?? (device?.userAgent || undefined);
			if (userAgent) {
				await session.send("Emulation.setUserAgentOverride", { userAgent, acceptLanguage: params.locale });
				applied.push(`user agent ${userAgent.slice(0, 40)}…`);
			}
			const features: Array<{ name: string; value: string }> = [];
			if (params.colorScheme) features.push({ name: "prefers-color-scheme", value: params.colorScheme });
			if (params.reducedMotion !== undefined) features.push({ name: "prefers-reduced-motion", value: params.reducedMotion ? "reduce" : "no-preference" });
			if (features.length || params.mediaType) {
				await session.send("Emulation.setEmulatedMedia", { media: params.mediaType, features });
				applied.push(...features.map((feature) => `${feature.name}=${feature.value}`), ...(params.mediaType ? [`media ${params.mediaType}`] : []));
			}
			if (params.locale) {
				await session.send("Emulation.setLocaleOverride", { locale: params.locale }).catch((error: Error) => applied.push(`locale failed: ${error.message}`));
				applied.push(`locale ${params.locale}`);
			}
			if (params.timezone) {
				await session.send("Emulation.setTimezoneOverride", { timezoneId: params.timezone });
				applied.push(`timezone ${params.timezone}`);
			}
			if (params.latitude !== undefined && params.longitude !== undefined) {
				await session.send("Emulation.setGeolocationOverride", { latitude: params.latitude, longitude: params.longitude, accuracy: 10 });
				// The Browser domain (grantPermissions) is not reachable through chrome.debugger, so the
				// site's geolocation permission cannot be granted from here.
				applied.push(`geolocation ${params.latitude},${params.longitude} (the site still needs the geolocation permission: Chrome prompts once; ask the user to click Allow, or check chrome://settings/content/location)`);
			}
			if (params.offline !== undefined || params.network) {
				const profile = NETWORK_PROFILES[params.network ?? "none"] as { latency: number; downloadThroughput: number; uploadThroughput: number };
				await session.send("Network.emulateNetworkConditions", { offline: params.offline ?? false, ...profile });
				applied.push(params.offline ? "offline" : `network ${params.network ?? "none"}`);
			}
			if (params.cpuSlowdown !== undefined) {
				await session.send("Emulation.setCPUThrottlingRate", { rate: Math.max(1, params.cpuSlowdown) });
				applied.push(`cpu slowdown x${params.cpuSlowdown}`);
			}
			if (applied.length === 0) throw new Error("Nothing to emulate; pass at least one option or reset: true.");
			return { text: `Emulation applied to tab [${session.tabId}]: ${applied.join("; ")}.` };
		},
	});
}

async function resetEmulation(session: TabSession): Promise<void> {
	const calls: Array<Promise<unknown>> = [
		session.send("Emulation.clearDeviceMetricsOverride"),
		session.send("Emulation.setTouchEmulationEnabled", { enabled: false }),
		session.send("Emulation.setEmulatedMedia", { media: "", features: [] }),
		session.send("Emulation.setLocaleOverride", {}),
		session.send("Emulation.setTimezoneOverride", { timezoneId: "" }),
		session.send("Emulation.clearGeolocationOverride"),
		session.send("Emulation.setCPUThrottlingRate", { rate: 1 }),
		session.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }),
		session.send("Emulation.setUserAgentOverride", { userAgent: "" }).catch(() => {}),
	];
	await Promise.all(calls.map((call) => call.catch(() => {})));
}
