// Launches Chrome for Testing (or Chromium) with the companion extension loaded from a temp
// copy whose port range points at a test-only port, starts a bridge on that port, and serves
// HTML fixtures from test/integration/fixtures over a local HTTP server.
//
// Google Chrome branded builds dropped --load-extension in Chrome 137, so this needs a
// Chrome for Testing or Chromium binary. Set PI_CHROME_TEST_BINARY to override auto-detection.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Bridge, type ExtensionClient } from "../../extensions/chrome/bridge/server.ts";
import type { ChromeLauncher } from "../../extensions/chrome/bridge/launch.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../..");
export const fixturesDir = join(here, "fixtures");
export const artifactsDir = join(here, ".artifacts");

export const TEST_PORT = Number(process.env.PI_CHROME_TEST_PORT ?? 17427);

export function findChromeForTesting(): string {
	const fromEnv = process.env.PI_CHROME_TEST_BINARY;
	if (fromEnv) {
		if (!existsSync(fromEnv)) throw new Error(`PI_CHROME_TEST_BINARY does not exist: ${fromEnv}`);
		return fromEnv;
	}
	const candidates: string[] = [];
	const playwrightCache = join(homedir(), "Library/Caches/ms-playwright");
	if (existsSync(playwrightCache)) {
		const dirs = readdirSync(playwrightCache)
			.filter((name) => /^chromium-\d+$/.test(name))
			.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
		for (const dir of dirs) {
			candidates.push(
				join(playwrightCache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
				join(playwrightCache, dir, "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
				join(playwrightCache, dir, "chrome-mac/Chromium.app/Contents/MacOS/Chromium"),
				join(playwrightCache, dir, "chrome-linux/chrome"),
			);
		}
	}
	candidates.push(
		"/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	);
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) {
		throw new Error(
			"No Chrome for Testing / Chromium binary found. Install one (for example `npx playwright install chromium`) or set PI_CHROME_TEST_BINARY.",
		);
	}
	return found;
}

/** Ports above TEST_PORT that nothing listens on; the extension must probe them without logging errors. */
export const DEAD_PORT_SPAN = 2;

/** Copy chrome-extension/ to a temp dir with the port range rewritten to the test port plus dead ports. */
export function stageExtension(port: number): string {
	const source = join(repoRoot, "chrome-extension");
	const staged = mkdtempSync(join(tmpdir(), "pi-chrome-connector-ext-"));
	for (const name of readdirSync(source)) {
		let content = readFileSync(join(source, name), "utf8");
		if (name === "service_worker.js") {
			const before = content;
			content = content.replace(/^const PORT_RANGE = \[\d+, \d+\];/m, `const PORT_RANGE = [${port}, ${port + DEAD_PORT_SPAN}];`);
			if (content === before) throw new Error("could not rewrite PORT_RANGE in service_worker.js");
		}
		writeFileSync(join(staged, name), content);
	}
	return staged;
}

export interface FixtureServer {
	readonly url: string;
	readonly port: number;
	/** Requests seen by the server, newest last. */
	readonly requests: Array<{ method: string; path: string; body: string; headers: Record<string, string | string[] | undefined> }>;
	close(): Promise<void>;
}

/** Serves test/integration/fixtures plus a few API endpoints used by the tests. */
export async function startFixtureServer(): Promise<FixtureServer> {
	const requests: FixtureServer["requests"] = [];
	const server: Server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			requests.push({ method: request.method ?? "GET", path: url.pathname + url.search, body, headers: request.headers });
			const send = (status: number, contentType: string, payload: string | Buffer, extraHeaders: Record<string, string> = {}) => {
				response.writeHead(status, { "content-type": contentType, "cache-control": "no-store", ...extraHeaders });
				response.end(payload);
			};
			switch (url.pathname) {
				case "/api/json":
					return send(200, "application/json", JSON.stringify({ ok: true, items: [1, 2, 3], query: Object.fromEntries(url.searchParams) }));
				case "/api/echo":
					return send(200, "application/json", JSON.stringify({ method: request.method, body, contentType: request.headers["content-type"] ?? null }));
				case "/slow-page": {
					// Responds after a delay, so a tab created with this URL sits on about:blank first.
					const wait = Number(url.searchParams.get("ms") ?? 900);
					setTimeout(() => send(200, "text/html; charset=utf-8", `<!doctype html><title>Slow page</title><h1 id="ready">slow page ready</h1><input id="late-input" />`), wait);
					return;
				}
				case "/status/500":
					// An error status with no body: Chrome reports this navigation as ERR_HTTP_RESPONSE_CODE_FAILURE.
					response.writeHead(500, { "content-type": "text/plain" });
					return response.end();
				case "/slow-form": {
					// A form POST whose response arrives long after the click returns.
					setTimeout(() => send(200, "text/html; charset=utf-8", `<!doctype html><title>Order received</title><h1>Order received</h1><pre id="echo">${body.replace(/[<&]/g, "")}</pre>`), 700);
					return;
				}
				case "/api/fail":
					return send(500, "application/json", JSON.stringify({ error: "boom" }));
				case "/api/notfound":
					return send(404, "text/plain", "nope");
				case "/api/slow": {
					const ms = Number(url.searchParams.get("ms") ?? 500);
					setTimeout(() => send(200, "application/json", JSON.stringify({ slept: ms })), ms);
					return;
				}
				case "/api/set-cookie":
					return send(200, "text/plain", "cookie set", { "set-cookie": "fixture=served; Path=/" });
				case "/api/redirect":
					response.writeHead(302, { location: "/api/json" });
					response.end();
					return;
				default: {
					const file = join(fixturesDir, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
					if (!file.startsWith(fixturesDir) || !existsSync(file)) return send(404, "text/plain", `no fixture at ${url.pathname}`);
					const type = file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream";
					return send(200, type, readFileSync(file));
				}
			}
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture server has no port");
	return {
		url: `http://127.0.0.1:${address.port}`,
		port: address.port,
		requests,
		close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
	};
}

export interface TestLauncher {
	launcher: ChromeLauncher;
	extensionDir: string;
	userDataDir: string;
	/** Browser-level DevTools endpoint (--remote-debugging-port=0), read from DevToolsActivePort. */
	devtoolsUrl(): Promise<string>;
	/** Kill Chrome (if running) and remove the temp profile and staged extension. */
	close(): Promise<void>;
}

export interface TestLauncherOptions {
	headless?: boolean;
	port?: number;
	/** Extra Chrome flags, e.g. --force-device-scale-factor=1 to render like a non-Retina monitor. */
	extraArgs?: string[];
}

/** A ChromeLauncher that starts Chrome for Testing with the staged extension on a throwaway profile. */
export function createTestLauncher(options: TestLauncherOptions = {}): TestLauncher {
	const binary = findChromeForTesting();
	const headless = options.headless ?? process.env.PI_CHROME_TEST_HEADLESS === "1";
	const userDataDir = mkdtempSync(join(tmpdir(), "pi-chrome-connector-profile-"));
	const extensionDir = stageExtension(options.port ?? TEST_PORT);
	mkdirSync(artifactsDir, { recursive: true });
	let child: ChildProcess | undefined;

	const launcher: ChromeLauncher = {
		name: "Chrome for Testing",
		async isRunning() {
			return child !== undefined && child.exitCode === null;
		},
		async launch() {
			const args = [
				`--user-data-dir=${userDataDir}`,
				`--load-extension=${extensionDir}`,
				`--disable-extensions-except=${extensionDir}`,
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-features=TranslateUI,MediaRouter",
				"--window-size=1280,900",
				"--window-position=40,40",
				"--silent-debugger-extension-api",
				"--remote-debugging-port=0",
			];
			if (headless) args.push("--headless=new");
			args.push(...(options.extraArgs ?? []));
			args.push("about:blank");
			child = spawn(binary, args, { stdio: "ignore" });
		},
	};

	const close = async () => {
		if (child && child.exitCode === null) {
			child.kill("SIGTERM");
			await new Promise<void>((resolveExit) => {
				const timer = setTimeout(() => {
					child?.kill("SIGKILL");
					resolveExit();
				}, 3000);
				child?.once("exit", () => {
					clearTimeout(timer);
					resolveExit();
				});
			});
		}
		rmSync(userDataDir, { recursive: true, force: true });
		rmSync(extensionDir, { recursive: true, force: true });
	};

	const devtoolsUrl = async () => {
		const file = join(userDataDir, "DevToolsActivePort");
		for (let attempt = 0; attempt < 50; attempt++) {
			if (existsSync(file)) {
				const [port, path] = readFileSync(file, "utf8").trim().split("\n");
				if (port && path) return `ws://127.0.0.1:${port}${path}`;
			}
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
		}
		throw new Error("Chrome did not write DevToolsActivePort");
	};

	return { launcher, extensionDir, userDataDir, devtoolsUrl, close };
}

/** Minimal client for the browser-level CDP endpoint (flattened sessions). */
export async function connectBrowserCdp(url: string): Promise<{ send: (method: string, params?: object, sessionId?: string) => Promise<any>; close: () => void }> {
	const socket = new WebSocket(url);
	await new Promise<void>((resolveOpen, reject) => {
		socket.addEventListener("open", () => resolveOpen(), { once: true });
		socket.addEventListener("error", () => reject(new Error(`could not connect to ${url}`)), { once: true });
	});
	let nextId = 0;
	const pending = new Map<number, (message: any) => void>();
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data));
		const resolveMessage = typeof message.id === "number" ? pending.get(message.id) : undefined;
		if (resolveMessage) {
			pending.delete(message.id);
			resolveMessage(message);
		}
	});
	return {
		send: (method, params = {}, sessionId) =>
			new Promise((resolveSend, reject) => {
				const id = ++nextId;
				pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolveSend(message.result)));
				socket.send(JSON.stringify({ id, method, params, sessionId }));
			}),
		close: () => socket.close(),
	};
}

export interface ExtensionsPage {
	id: string;
	/** Runtime errors chrome://extensions currently lists for the extension. */
	errors: () => Promise<string[]>;
	/** Restart the extension (its service worker starts fresh). */
	reload: () => Promise<void>;
	close: () => Promise<void>;
}

/** Open chrome://extensions in the background, turn on developer mode, and expose error/reload controls for one extension. */
export async function openExtensionsPage(devtoolsUrl: string, extensionName: string): Promise<ExtensionsPage> {
	const cdp = await connectBrowserCdp(devtoolsUrl);
	try {
		const { targetId } = await cdp.send("Target.createTarget", { url: "chrome://extensions/", background: true });
		const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
		const evaluate = async (expression: string): Promise<any> => {
			const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
			if (exceptionDetails) throw new Error(exceptionDetails.text);
			return result.value;
		};
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
		await evaluate("new Promise((r) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => r(chrome.runtime.lastError?.message ?? 'ok')))");
		const lookup = `chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, (list) => { const e = list.find((x) => x.name === ${JSON.stringify(extensionName)}); r(e ? { id: e.id, errors: e.runtimeErrors.map((x) => x.message) } : null); })`;
		const info = (await evaluate(`new Promise((r) => ${lookup})`)) as { id: string; errors: string[] } | null;
		if (!info) throw new Error(`extension ${extensionName} not found on chrome://extensions`);
		return {
			id: info.id,
			errors: async () => ((await evaluate(`new Promise((r) => ${lookup})`)) as { errors: string[] }).errors,
			reload: async () => {
				await evaluate(`new Promise((r) => chrome.developerPrivate.reload(${JSON.stringify(info.id)}, { failQuietly: true }, () => r(chrome.runtime.lastError?.message ?? 'ok')))`);
			},
			close: async () => {
				await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
				cdp.close();
			},
		};
	} catch (error) {
		cdp.close();
		throw error;
	}
}

export interface TestChrome {
	bridge: Bridge;
	client: ExtensionClient;
	fixtures: FixtureServer;
	launcher: ChromeLauncher;
	userDataDir: string;
	close(): Promise<void>;
}

/** Bridge + launched Chrome + fixture server, for tests below the tool layer. */
export async function launchTestChrome(options: TestLauncherOptions = {}): Promise<TestChrome> {
	const test = createTestLauncher(options);
	const bridge = await Bridge.listen({ portRange: [TEST_PORT, TEST_PORT], label: "pi-chrome-connector-test" });
	const fixtures = await startFixtureServer();
	const closeAll = async () => {
		await bridge.close().catch(() => {});
		await fixtures.close().catch(() => {});
		await test.close();
	};
	await test.launcher.launch();
	const client = await bridge.waitForClient(30_000);
	if (!client) {
		await closeAll();
		throw new Error(`companion extension did not connect to test port ${TEST_PORT} within 30 s`);
	}
	return { bridge, client, fixtures, launcher: test.launcher, userDataDir: test.userDataDir, close: closeAll };
}
