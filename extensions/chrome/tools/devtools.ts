// DevTools-panel equivalents: console, network (+HAR), request routing/mocking, DOM inspection,
// storage, frames, performance, PDF.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { Protocol } from "devtools-protocol";
import { readPackageVersion } from "../commands.ts";
import { formatConsoleEntry, type ConsoleLevel } from "../cdp/console.ts";
import { formatBytes, formatNetworkEntry, type NetworkEntry } from "../cdp/network.ts";
import { safeJson } from "../cdp/remote-object.ts";
import type { TabSession } from "../cdp/session.ts";
import { artifactPath } from "./screenshot.ts";
import { clampInt, joinLines, pageLine, registerChromeTool, type ToolServices } from "./shared.ts";
import { hasTarget, resolveTarget, type TargetSpec } from "./targets.ts";

const MAX_BODY_CHARS = 20_000;
let cachedVersion: string | undefined;
const packageVersion = () => (cachedVersion ??= readPackageVersion(fileURLToPath(new URL("../../../package.json", import.meta.url))));
const MAX_TEXT_CHARS = 40_000;

const TARGET_PARAMS = {
	ref: Type.Optional(Type.String({ description: "Snapshot ref" })),
	selector: Type.Optional(Type.String({ description: "CSS selector" })),
	text: Type.Optional(Type.String({ description: "Visible text of the element" })),
	frame: Type.Optional(Type.String({ description: "Iframe id, name or URL substring" })),
};

export function registerDevtoolsTools(pi: ExtensionAPI, services: ToolServices, artifactDir: string): void {
	const { connector } = services;

	registerChromeTool(pi, services, {
		name: "chrome_console",
		label: "Chrome console",
		description:
			"Read the current tab's console: console.* calls, uncaught exceptions, and browser messages (network failures, CSP, deprecations). Captured continuously since the tab was attached, across navigations. level filters by minimum severity (error, warning, info, log, all); since returns entries after a #seq you saw before; includes filters by substring; clear empties the buffer. Duplicate consecutive lines collapse with (xN). stack: true adds stack traces for errors.",
		promptSnippet: "Read console messages and uncaught errors from the current Chrome tab",
		promptGuidelines: ["Use chrome_console level=error after reproducing a bug or finishing a flow; a clean console is part of verifying a UI change."],
		parameters: Type.Object({
			level: Type.Optional(StringEnum(["error", "warning", "info", "log", "all"] as const)),
			since: Type.Optional(Type.Integer({ description: "Only entries with seq greater than this" })),
			includes: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Integer({ description: "Most recent N (default 100)" })),
			stack: Type.Optional(Type.Boolean()),
			clear: Type.Optional(Type.Boolean({ description: "Clear the buffer after reading" })),
		}),
		async execute(params, run) {
			const session = await connector.currentSession({ focus: false, signal: run.signal });
			const entries = session.console.list({ level: params.level ?? "all", sinceSeq: params.since, includes: params.includes, limit: clampInt(params.limit, 100, 1, 1000) });
			const total = session.console.size;
			const lines = entries.map((entry) => formatConsoleEntry(entry, { includeStack: params.stack }));
			if (params.clear) session.console.clear();
			const header = `${entries.length} of ${total} console entries${params.level && params.level !== "all" ? ` at level ${params.level}+` : ""}${params.since ? ` since #${params.since}` : ""} (last seq #${session.console.lastSeq})${params.clear ? "; buffer cleared" : ""}`;
			return { text: joinLines(header, clip(lines.join("\n"), MAX_TEXT_CHARS) || "(no matching entries)") };
		},
	});

	registerChromeTool(pi, services, {
		name: "chrome_network",
		label: "Chrome network",
		description:
			"Inspect network activity of the current tab like the DevTools Network panel: every request since attach (documents, XHR/fetch, scripts, images, WebSocket frames, EventSource messages). Actions: list (filters: urlIncludes, method, status like 404 | 5xx | >=400, type like Fetch | XHR | Document | Image, failedOnly, since #seq, limit); get (one entry by #seq or requestId: headers, post data, timing, response body; credential headers like authorization and cookie are shown redacted); clear; har (write a complete HAR file with captured bodies to path). Bodies of text responses are captured eagerly so they survive navigation. Requests an ad blocker stopped show as BLOCKED(by browser extension); failedOnly includes them.",
		promptSnippet: "List or inspect network requests (headers, bodies, failures, HAR export) in the current Chrome tab",
		promptGuidelines: ["Use chrome_network get to read an API response body or a request payload instead of re-fetching it with JavaScript."],
		parameters: Type.Object({
			action: Type.Optional(StringEnum(["list", "get", "clear", "har"] as const)),
			id: Type.Optional(Type.String({ description: "Entry #seq (e.g. 12) or requestId (get)" })),
			urlIncludes: Type.Optional(Type.String()),
			method: Type.Optional(Type.String()),
			status: Type.Optional(Type.String({ description: "e.g. 404, 5xx, >=400" })),
			type: Type.Optional(Type.String({ description: "Document, Fetch, XHR, Script, Stylesheet, Image, Font, WebSocket, Other" })),
			failedOnly: Type.Optional(Type.Boolean()),
			since: Type.Optional(Type.Integer()),
			limit: Type.Optional(Type.Integer({ description: "Most recent N (default 50)" })),
			bodyChars: Type.Optional(Type.Integer({ description: "Max response body chars to show (default 20000)" })),
			path: Type.Optional(Type.String({ description: "HAR output path" })),
		}),
		async execute(params, run) {
			const session = await connector.currentSession({ focus: false, signal: run.signal });
			const action = params.action ?? (params.id ? "get" : "list");
			switch (action) {
				case "list": {
					const entries = session.network.list({ urlIncludes: params.urlIncludes, method: params.method, status: params.status, type: params.type, failedOnly: params.failedOnly, sinceSeq: params.since, limit: clampInt(params.limit, 50, 1, 500) });
					const header = `${entries.length} of ${session.network.size} requests (last seq #${session.network.lastSeq}, ${session.network.inflightCount} in flight). Columns: #seq method status type size time url`;
					return { text: joinLines(header, clip(entries.map(formatNetworkEntry).join("\n"), MAX_TEXT_CHARS) || "(no matching requests)") };
				}
				case "get": {
					if (!params.id) throw new Error("get needs id (#seq or requestId).");
					const entry = findEntry(session, params.id);
					return { text: await formatEntryDetails(session, entry, clampInt(params.bodyChars, MAX_BODY_CHARS, 0, 500_000)) };
				}
				case "clear":
					session.network.clear();
					return { text: "Network log cleared." };
				case "har": {
					const har = await buildHar(session);
					const path = artifactPath(artifactDir, "har", "har", params.path, run.ctx.cwd);
					await mkdir(join(path, ".."), { recursive: true });
					await writeFile(path, JSON.stringify(har, null, 2));
					return { text: `Wrote HAR with ${har.log.entries.length} entries to ${path}`, details: { path } };
				}
				default:
					throw new Error(`unknown action ${String(action)}`);
			}
		},
	});

	registerChromeTool(pi, services, {
		name: "chrome_route",
		label: "Chrome route",
		description:
			"Intercept requests in the current tab (like DevTools request overrides / Playwright route). add a rule with a URL glob (* matches anything, e.g. */api/users*) and optional method, then either fulfill (status, headers, body -> a mocked response), abort (errorReason e.g. Failed, ConnectionRefused, TimedOut), or continue with extra request headers; delayMs slows the response. Rules capture the requests they matched (method, url, post data) so you can verify what the app sent without it reaching the server. list shows rules with hit counts and captured requests; remove by id; clear removes all.",
		promptSnippet: "Mock, block, delay or capture requests from the current Chrome tab",
		promptGuidelines: ["Use chrome_route fulfill/abort to test how the UI handles API failures, slow responses, and specific payloads without changing backend code; use it to capture a destructive POST instead of letting it hit a real server."],
		parameters: Type.Object({
			action: StringEnum(["add", "list", "remove", "clear"] as const),
			url: Type.Optional(Type.String({ description: "URL glob, e.g. */api/users* or https://example.com/*" })),
			method: Type.Optional(Type.String({ description: "Only this HTTP method" })),
			mode: Type.Optional(StringEnum(["fulfill", "abort", "continue"] as const)),
			status: Type.Optional(Type.Integer({ description: "Response status for fulfill (default 200)" })),
			headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Response headers (fulfill) or extra request headers (continue)" })),
			body: Type.Optional(Type.String({ description: "Response body for fulfill (JSON string or text)" })),
			json: Type.Optional(Type.Unknown({ description: "Response body as JSON for fulfill (sets content-type)" })),
			errorReason: Type.Optional(Type.String({ description: "abort reason: Failed, Aborted, TimedOut, AccessDenied, ConnectionClosed, ConnectionReset, ConnectionRefused, ConnectionAborted, ConnectionFailed, NameNotResolved, InternetDisconnected, AddressUnreachable, BlockedByClient, BlockedByResponse" })),
			delayMs: Type.Optional(Type.Integer()),
			id: Type.Optional(Type.Integer({ description: "Rule id (remove)" })),
		}),
		async execute(params, run) {
			const session = await connector.currentSession({ focus: false, signal: run.signal });
			switch (params.action) {
				case "add": {
					if (!params.url) throw new Error("add needs url (glob).");
					const mode = params.mode ?? (params.errorReason ? "abort" : params.body !== undefined || params.json !== undefined ? "fulfill" : "continue");
					const rule = session.routes.add({
						urlPattern: params.url,
						method: params.method,
						action: mode,
						delayMs: params.delayMs,
						abortReason: (params.errorReason as Protocol.Network.ErrorReason | undefined) ?? "Failed",
						setHeaders: mode === "continue" ? params.headers : undefined,
						response:
							mode === "fulfill"
								? {
										status: params.status ?? 200,
										headers: { ...(params.json !== undefined ? { "content-type": "application/json" } : {}), ...(params.headers ?? {}) },
										body: params.json !== undefined ? JSON.stringify(params.json) : (params.body ?? ""),
									}
								: undefined,
					});
					await session.syncRoutes();
					return { text: `Route #${rule.id} added: ${describeRule(rule)}. Active until removed or the tab closes.` };
				}
				case "list": {
					const rules = session.routes.list();
					if (rules.length === 0) return { text: "No routes." };
					const lines = rules.map((rule) => {
						const captured = rule.captured.slice(-5).map((hit) => `    ${hit.method} ${hit.url}${hit.postData ? ` body=${clip(hit.postData, 300)}` : ""}`);
						return [`#${rule.id} ${describeRule(rule)} — ${rule.hits} hit${rule.hits === 1 ? "" : "s"}`, ...captured].join("\n");
					});
					return { text: lines.join("\n") };
				}
				case "remove": {
					if (params.id === undefined) throw new Error("remove needs id.");
					if (!session.routes.remove(params.id)) throw new Error(`No route #${params.id}.`);
					await session.syncRoutes();
					return { text: `Route #${params.id} removed.` };
				}
				case "clear":
					session.routes.clear();
					await session.syncRoutes();
					return { text: "All routes removed." };
				default:
					throw new Error(`unknown action ${String(params.action)}`);
			}
		},
	});

	registerChromeTool(pi, services, {
		name: "chrome_dom",
		label: "Chrome DOM",
		description:
			"Inspect DOM details of an element (ref, selector, text) or the document: html (outerHTML, pretty-printed and capped), text (innerText), attributes, styles (computed styles, optionally only the listed properties), rect (bounding box, visibility, scroll position), count (number of matches for selector), listeners (event listeners attached via JavaScript, with source locations).",
		promptSnippet: "Read HTML, text, attributes, computed styles, box geometry or event listeners of an element",
		parameters: Type.Object({
			action: StringEnum(["html", "text", "attributes", "styles", "rect", "count", "listeners"] as const),
			...TARGET_PARAMS,
			properties: Type.Optional(Type.Array(Type.String(), { description: "Computed style properties to include (styles)" })),
			maxChars: Type.Optional(Type.Integer({ description: "Output cap (default 40000)" })),
		}),
		async execute(params, run) {
			const session = await connector.currentSession({ focus: false, signal: run.signal });
			const maxChars = clampInt(params.maxChars, MAX_TEXT_CHARS, 200, 500_000);
			if (params.action === "count") {
				if (!params.selector) throw new Error("count needs selector.");
				const count = await session.evaluate<number>(`document.querySelectorAll(${JSON.stringify(params.selector)}).length`);
				return { text: `${count} element${count === 1 ? "" : "s"} match ${params.selector}` };
			}
			const spec: TargetSpec = { ref: params.ref, selector: params.selector, text: params.text, frame: params.frame };
			const target = hasTarget(spec) ? await resolveTarget(session, spec) : undefined;
			const objectId = target?.objectId ?? (await session.evaluateHandle("document.documentElement")).objectId;
			if (!objectId) throw new Error("Could not resolve the element.");
			const sessionId = target?.sessionId;
			try {
				switch (params.action) {
					case "html": {
						const { outerHTML } = await session.send("DOM.getOuterHTML", { objectId }, { sessionId });
						return { text: clip(prettyHtml(outerHTML), maxChars) };
					}
					case "text": {
						// innerText is the rendered text, but it is empty for shadow hosts whose content is slotted
						// and for elements CSS hides; textContent is the honest fallback there.
						const { value } = await session.callFunctionOn<string>(objectId, "function () { const rendered = this.innerText; return rendered && rendered.trim() ? rendered : (this.textContent ?? ''); }", [], { sessionId });
						return { text: clip(value, maxChars) || "(empty)" };
					}
					case "attributes": {
						const { value } = await session.callFunctionOn<Record<string, string>>(objectId, "function () { return Object.fromEntries([...this.attributes].map((a) => [a.name, a.value])); }", [], { sessionId });
						return { text: `${target?.description ?? "<html>"}\n${safeJson(value, 2)}` };
					}
					case "styles": {
						const { value } = await session.callFunctionOn<Record<string, string>>(objectId, COMPUTED_STYLES, [params.properties ?? null], { sessionId });
						return { text: clip(`${target?.description ?? "<html>"}\n${Object.entries(value).map(([key, val]) => `${key}: ${val}`).join("\n")}`, maxChars) };
					}
					case "rect": {
						const { value } = await session.callFunctionOn<string>(objectId, DESCRIBE_RECT, [], { sessionId });
						return { text: `${target?.description ?? "<html>"}\n${value}` };
					}
					case "listeners": {
						const { listeners } = await session.send("DOMDebugger.getEventListeners", { objectId, depth: 0 }, { sessionId });
						if (listeners.length === 0) return { text: `${target?.description ?? "<html>"}: no JavaScript event listeners (framework listeners are usually delegated to the root; check document/body).` };
						const lines = listeners.map((listener) => `${listener.type}${listener.useCapture ? " (capture)" : ""}${listener.passive ? " (passive)" : ""}${listener.once ? " (once)" : ""} @ ${listener.scriptId ? `${listener.lineNumber + 1}:${listener.columnNumber + 1}` : "native"}${listener.handler?.description ? ` ${clip(listener.handler.description.split("\n")[0] ?? "", 120)}` : ""}`);
						return { text: `${target?.description ?? "<html>"}\n${lines.join("\n")}` };
					}
					default:
						throw new Error(`unknown action ${String(params.action)}`);
				}
			} finally {
				await session.releaseObject(objectId, sessionId);
			}
		},
	});

	registerChromeTool(pi, services, {
		name: "chrome_storage",
		label: "Chrome storage",
		description:
			"Read or change browser storage for the current tab's site: cookies (list/get for the current URL or a given url; set name/value with optional domain, path, expires, httpOnly, secure, sameSite; delete by name; clear all cookies for the site), localStorage and sessionStorage (list/get/set/remove/clear), and clearSite (cookies, storage, cache, service workers for the origin: a clean logged-out state). Useful to reset login state or test as a different user. Values of httpOnly cookies, credential-named keys (token, session, auth, ...) and JWT-shaped values are shown redacted; pass reveal: true when you need the actual value (for example to decode a JWT).",
		promptSnippet: "Inspect or reset cookies, localStorage, sessionStorage and site data for the current Chrome tab",
		parameters: Type.Object({
			store: StringEnum(["cookies", "localStorage", "sessionStorage", "site"] as const),
			action: StringEnum(["list", "get", "set", "remove", "clear"] as const),
			name: Type.Optional(Type.String()),
			value: Type.Optional(Type.String()),
			url: Type.Optional(Type.String({ description: "Cookie URL scope (default: current page)" })),
			domain: Type.Optional(Type.String()),
			path: Type.Optional(Type.String()),
			expires: Type.Optional(Type.Number({ description: "Unix seconds" })),
			httpOnly: Type.Optional(Type.Boolean()),
			secure: Type.Optional(Type.Boolean()),
			sameSite: Type.Optional(StringEnum(["Strict", "Lax", "None"] as const)),
			reveal: Type.Optional(Type.Boolean({ description: "Show credential-looking values in full (default: redacted)" })),
		}),
		async execute(params, run) {
			const session = await connector.currentSession({ focus: false, signal: run.signal });
			const pageUrl = params.url ?? session.url;
			const show = (name: string, value: string, sensitive = false) => (params.reveal || !(sensitive || isCredentialValue(name, value)) ? clip(value, 300) : redactCredential(value));
			if (params.store === "site") {
				if (params.action !== "clear") throw new Error("store site supports only action clear.");
				const origin = new URL(pageUrl).origin;
				await session.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
				await session.send("Network.clearBrowserCookies").catch(() => {});
				// "all" does not include per-tab sessionStorage.
				await session.evaluate("sessionStorage.clear(); localStorage.clear(); 'ok'").catch(() => {});
				return { text: `Cleared cookies, storage, cache and service workers for ${origin} (and all cookies). Reload to see the logged-out state.` };
			}
			if (params.store === "cookies") {
				switch (params.action) {
					case "list":
					case "get": {
						const { cookies } = await session.send("Network.getCookies", { urls: [pageUrl] });
						const wanted = params.action === "get" ? cookies.filter((cookie) => cookie.name === params.name) : cookies;
						if (wanted.length === 0) return { text: params.action === "get" ? `No cookie named ${params.name} for ${pageUrl}.` : `No cookies for ${pageUrl}.` };
						return { text: wanted.map((cookie) => `${cookie.name}=${show(cookie.name, cookie.value, cookie.httpOnly)}  domain=${cookie.domain} path=${cookie.path}${cookie.expires > 0 ? ` expires=${new Date(cookie.expires * 1000).toISOString()}` : " session"}${cookie.httpOnly ? " httpOnly" : ""}${cookie.secure ? " secure" : ""}${cookie.sameSite ? ` sameSite=${cookie.sameSite}` : ""}`).join("\n") };
					}
					case "set": {
						if (!params.name || params.value === undefined) throw new Error("set needs name and value.");
						const result = await session.send("Network.setCookie", { name: params.name, value: params.value, url: params.domain ? undefined : pageUrl, domain: params.domain, path: params.path, expires: params.expires, httpOnly: params.httpOnly, secure: params.secure, sameSite: params.sameSite });
						if (!result.success) throw new Error(`Chrome refused to set cookie ${params.name} (check domain/secure/sameSite constraints).`);
						return { text: `Set cookie ${params.name} for ${params.domain ?? pageUrl}.` };
					}
					case "remove": {
						if (!params.name) throw new Error("remove needs name.");
						await session.send("Network.deleteCookies", { name: params.name, url: params.domain ? undefined : pageUrl, domain: params.domain, path: params.path });
						return { text: `Deleted cookie ${params.name}.` };
					}
					case "clear": {
						const { cookies } = await session.send("Network.getCookies", { urls: [pageUrl] });
						for (const cookie of cookies) await session.send("Network.deleteCookies", { name: cookie.name, domain: cookie.domain, path: cookie.path });
						return { text: `Deleted ${cookies.length} cookie${cookies.length === 1 ? "" : "s"} for ${pageUrl}.` };
					}
					default:
						throw new Error(`unknown action ${String(params.action)}`);
				}
			}
			const store = params.store;
			const result = await session.evaluate<{ message?: string; entries?: Array<[string, string]>; value?: string | null }>(`(${WEB_STORAGE})(${JSON.stringify(store)}, ${JSON.stringify(params.action)}, ${JSON.stringify(params.name ?? null)}, ${JSON.stringify(params.value ?? null)})`);
			if (result.message !== undefined) return { text: result.message };
			if (result.entries) {
				if (result.entries.length === 0) return { text: `${store} is empty.` };
				return { text: clip(`${store} (${result.entries.length} keys):\n${result.entries.map(([key, value]) => `${key} = ${show(key, value)}`).join("\n")}`, MAX_TEXT_CHARS) };
			}
			if (result.value === null || result.value === undefined) return { text: `No key ${JSON.stringify(params.name)} in ${store}.` };
			return { text: params.reveal || !isCredentialValue(params.name ?? "", result.value) ? clip(result.value, MAX_TEXT_CHARS) : redactCredential(result.value) };
		},
	});

	registerChromeTool(pi, services, {
		name: "chrome_frames",
		label: "Chrome frames",
		description: "List the frames (iframes) in the current tab with ids, names, URLs and whether each runs out-of-process. Use a frame's id, name, or a URL substring as the frame parameter of chrome_snapshot, chrome_find, chrome_click, chrome_fill, chrome_evaluate and chrome_wait.",
		parameters: Type.Object({}),
		async execute(_params, run) {
			const session = await connector.currentSession({ focus: false, signal: run.signal });
			const frames = [...session.frames.values()];
			const lines = frames.map((frame) => `${frame.id === session.mainFrameId ? "main" : frame.parentId ? `child of ${frame.parentId.slice(0, 8)}` : "detached"}  id=${frame.id.slice(0, 8)}${frame.name ? ` name="${frame.name}"` : ""} ${frame.url || "(no url)"}${frame.sessionId ? " [out-of-process]" : ""}`);
			return { text: `${frames.length} frame${frames.length === 1 ? "" : "s"}:\n${lines.join("\n")}` };
		},
	});

	registerChromeTool(pi, services, {
		name: "chrome_performance",
		label: "Chrome performance",
		description:
			"Performance snapshot of the current tab: navigation timing (TTFB, DOMContentLoaded, load), Web Vitals observed so far (FCP, LCP, CLS, INP when available), long tasks, resource summary by type (count, bytes), JS heap size, and DOM node count. For a fresh measurement, chrome_navigate first.",
		parameters: Type.Object({}),
		async execute(_params, run) {
			const session = await connector.currentSession({ focus: false, signal: run.signal });
			const [metrics, vitals] = await Promise.all([
				session.send("Performance.enable").then(() => session.send("Performance.getMetrics")).catch(() => undefined),
				session.evaluate<string>(`(${PERFORMANCE_REPORT})()`),
			]);
			const heap = metrics?.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value;
			const nodes = metrics?.metrics.find((metric) => metric.name === "Nodes")?.value;
			const extra = [heap !== undefined && `JS heap used: ${formatBytes(heap)}`, nodes !== undefined && `DOM nodes: ${nodes}`].filter(Boolean).join(", ");
			return { text: joinLines(`Page: ${pageLine(session)}`, vitals, extra) };
		},
	});

	registerChromeTool(pi, services, {
		name: "chrome_pdf",
		label: "Chrome PDF",
		description: "Print the current tab to a PDF file (like Save as PDF). Options: landscape, printBackground (default true), scale, paper format Letter|A4, path.",
		parameters: Type.Object({
			path: Type.Optional(Type.String()),
			landscape: Type.Optional(Type.Boolean()),
			printBackground: Type.Optional(Type.Boolean()),
			scale: Type.Optional(Type.Number()),
			format: Type.Optional(StringEnum(["Letter", "A4"] as const)),
		}),
		async execute(params, run) {
			const session = await connector.currentSession({ focus: false, signal: run.signal });
			const size = params.format === "A4" ? { paperWidth: 8.27, paperHeight: 11.69 } : { paperWidth: 8.5, paperHeight: 11 };
			const result = await session.send("Page.printToPDF", { landscape: params.landscape, printBackground: params.printBackground ?? true, scale: params.scale, ...size, transferMode: "ReturnAsBase64" }, { timeoutMs: 60_000 });
			const path = artifactPath(artifactDir, "pdf", "pdf", params.path, run.ctx.cwd);
			await mkdir(join(path, ".."), { recursive: true });
			const buffer = Buffer.from(result.data, "base64");
			await writeFile(path, buffer);
			return { text: `Wrote PDF (${formatBytes(buffer.length)}) of ${pageLine(session)} to ${path}`, details: { path } };
		},
	});
}

// --- helpers --------------------------------------------------------------------------------

function findEntry(session: TabSession, id: string): NetworkEntry {
	const seq = /^#?(\d+)$/.exec(id.trim());
	const entry = seq ? session.network.list().find((candidate) => candidate.seq === Number(seq[1])) : session.network.get(id);
	if (!entry) throw new Error(`No network entry ${id}. Run chrome_network list.`);
	return entry;
}

async function formatEntryDetails(session: TabSession, entry: NetworkEntry, bodyChars: number): Promise<string> {
	const lines = [formatNetworkEntry(entry)];
	if (entry.initiator) lines.push(`initiator: ${entry.initiator}`);
	if (entry.remoteAddress) lines.push(`remote: ${entry.remoteAddress}${entry.protocol ? ` (${entry.protocol})` : ""}`);
	if (entry.mimeType) lines.push(`mime: ${entry.mimeType}`);
	if (entry.blockedReason) lines.push(`blocked: ${entry.blockedReason}`);
	lines.push("", "request headers:", ...formatHeaders(entry.requestHeaders));
	if (entry.postData !== undefined) lines.push("", "request body:", clip(prettyMaybeJson(entry.postData), bodyChars));
	else if (entry.hasPostData) lines.push("", "request body: (not captured; larger than 64KB or streamed)");
	if (entry.responseHeaders) lines.push("", "response headers:", ...formatHeaders(entry.responseHeaders));
	if (entry.websocket) {
		lines.push("", `websocket frames (${entry.websocket.frames.length}):`);
		for (const frame of entry.websocket.frames.slice(-40)) lines.push(`  ${frame.direction === "sent" ? "→" : "←"} ${clip(frame.data, 300)}`);
	}
	if (entry.eventSourceMessages) {
		lines.push("", `event-source messages (${entry.eventSourceMessages.length}):`);
		for (const message of entry.eventSourceMessages.slice(-40)) lines.push(`  ${message.eventName}: ${clip(message.data, 300)}`);
	}
	if (bodyChars > 0 && !entry.websocket) {
		let body: string | undefined;
		let note = "";
		try {
			const captured = await session.network.getBody(entry.id);
			if (captured) body = captured.base64Encoded ? `(binary, ${formatBytes(captured.bytes)} base64)` : captured.text;
		} catch (error) {
			note = ` (unavailable: ${(error as Error).message.replace(/^Network\.getResponseBody: /, "")})`;
		}
		if (body === undefined) note ||= entry.bodyState === "binary" ? " (binary; not captured)" : entry.bodyState === "too-large" ? " (too large to capture eagerly)" : entry.failed ? " (request failed)" : " (none)";
		lines.push("", `response body${note}:`);
		if (body !== undefined) lines.push(clip(prettyMaybeJson(body), bodyChars));
	}
	return lines.join("\n");
}

const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$|token|secret|password/i;
const CREDENTIAL_KEY = /token|secret|password|passwd|auth|session|jwt|api[-_]?key|credential|cookie|refresh|bearer|clearance/i;
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;
/** A long value with no structure: a bearer token, a signed session blob, a CDN clearance cookie. */
const OPAQUE_SECRET = /^[A-Za-z0-9_\-.~+/=%]{40,}$/;

/** A storage key or cookie whose name or value looks like a credential. */
export function isCredentialValue(name: string, value: string): boolean {
	const trimmed = value.trim();
	return CREDENTIAL_KEY.test(name) || JWT_SHAPE.test(trimmed) || OPAQUE_SECRET.test(trimmed);
}

/** Credential-bearing header values are shown as a short prefix plus length; the session transcript is not a safe place for them. */
function formatHeaders(headers: Record<string, string>): string[] {
	return Object.entries(headers)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => `  ${name}: ${CREDENTIAL_HEADER.test(name) ? redactCredential(value) : clip(value, 500)}`);
}

export function redactCredential(value: string): string {
	if (value.length <= 12) return "<redacted>";
	return `${value.slice(0, 12)}\u2026 <redacted, ${value.length} chars>`;
}

function prettyMaybeJson(text: string): string {
	const trimmed = text.trim();
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return text;
	try {
		return JSON.stringify(JSON.parse(trimmed), null, 2);
	} catch {
		return text;
	}
}

function prettyHtml(html: string): string {
	// Light touch: break between tags so long minified markup stays readable without a full parser.
	return html.replace(/>\s*</g, ">\n<");
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;
}

function describeRule(rule: { urlPattern: string; method?: string; action: string; response?: { status: number }; abortReason?: string; delayMs?: number; setHeaders?: Record<string, string> }): string {
	const what = rule.action === "fulfill" ? `fulfill ${rule.response?.status}` : rule.action === "abort" ? `abort (${rule.abortReason})` : `continue${rule.setHeaders ? ` +headers ${Object.keys(rule.setHeaders).join(",")}` : ""}`;
	return `${rule.method ? `${rule.method.toUpperCase()} ` : ""}${rule.urlPattern} → ${what}${rule.delayMs ? ` after ${rule.delayMs}ms` : ""}`;
}

async function buildHar(session: TabSession): Promise<{ log: { version: string; creator: { name: string; version: string }; entries: unknown[] } }> {
	const entries: unknown[] = [];
	for (const entry of session.network.list()) {
		if (entry.websocket) continue;
		let body: { text: string; base64Encoded: boolean; bytes: number } | undefined;
		try {
			body = await session.network.getBody(entry.id);
		} catch {
			body = undefined;
		}
		entries.push({
			startedDateTime: new Date(entry.startedAt).toISOString(),
			time: entry.durationMs ?? 0,
			request: {
				method: entry.method,
				url: entry.url,
				httpVersion: entry.protocol ?? "",
				headers: Object.entries(entry.requestHeaders).map(([name, value]) => ({ name, value })),
				queryString: [...new URL(entry.url, "http://x").searchParams].map(([name, value]) => ({ name, value })),
				cookies: [],
				headersSize: -1,
				bodySize: entry.postData?.length ?? -1,
				postData: entry.postData !== undefined ? { mimeType: entry.requestHeaders["content-type"] ?? entry.requestHeaders["Content-Type"] ?? "", text: entry.postData } : undefined,
			},
			response: {
				status: entry.status ?? 0,
				statusText: entry.statusText ?? (entry.failed ?? ""),
				httpVersion: entry.protocol ?? "",
				headers: Object.entries(entry.responseHeaders ?? {}).map(([name, value]) => ({ name, value })),
				cookies: [],
				content: { size: body?.bytes ?? entry.encodedBytes ?? 0, mimeType: entry.mimeType ?? "", text: body?.text, encoding: body?.base64Encoded ? "base64" : undefined },
				redirectURL: entry.responseHeaders?.location ?? "",
				headersSize: -1,
				bodySize: entry.encodedBytes ?? -1,
			},
			cache: {},
			timings: { send: 0, wait: entry.durationMs ?? 0, receive: 0 },
			_resourceType: entry.type,
			_failed: entry.failed,
			_fromCache: entry.fromCache,
			_mocked: entry.mocked,
		});
	}
	return { log: { version: "1.2", creator: { name: "pi-chrome-connector", version: packageVersion() }, entries } };
}

// --- in-page functions ----------------------------------------------------------------------

const COMPUTED_STYLES = `function (only) {
	const cs = getComputedStyle(this);
	const out = {};
	const names = only && only.length ? only : ["display", "position", "visibility", "opacity", "z-index", "width", "height", "margin", "padding", "border", "color", "background-color", "font-size", "font-weight", "font-family", "line-height", "overflow", "cursor", "pointer-events", "transform", "transition", "flex", "grid-template-columns", "text-align", "white-space"];
	for (const name of names) out[name] = cs.getPropertyValue(name);
	return out;
}`;

const DESCRIBE_RECT = `function () {
	const r = this.getBoundingClientRect();
	const cs = getComputedStyle(this);
	const inert = !!this.closest("[inert]");
	const ariaHidden = !!this.closest("[aria-hidden=true]");
	const rendered = this.checkVisibility ? this.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
	const visible = rendered && r.width > 0 && r.height > 0 && !inert;
	const fullyInViewport = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
	const partlyInViewport = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
	const why = inert ? " (inside an inert container: a collapsed drawer or a layer behind a dialog)" : ariaHidden ? " (inside an aria-hidden region)" : !rendered ? " (display/visibility/opacity hides it)" : "";
	const lines = [
		"viewport rect: x=" + Math.round(r.x) + " y=" + Math.round(r.y) + " width=" + Math.round(r.width) + " height=" + Math.round(r.height),
		"page rect: x=" + Math.round(r.x + scrollX) + " y=" + Math.round(r.y + scrollY),
		"visible: " + visible + why + ", in viewport: " + (fullyInViewport ? "yes" : partlyInViewport ? "partly" : "no"),
		"scroll: scrollTop=" + Math.round(this.scrollTop) + " scrollHeight=" + this.scrollHeight + " clientHeight=" + this.clientHeight,
		"viewport: " + innerWidth + "x" + innerHeight + ", page scroll: " + Math.round(scrollX) + "," + Math.round(scrollY),
	];
	return lines.join("\\n");
}`;

const WEB_STORAGE = `function (store, action, name, value) {
	const s = window[store];
	switch (action) {
		case "list": { const entries = []; for (let i = 0; i < s.length; i++) { const k = s.key(i); entries.push([k, s.getItem(k) || ""]); } return { entries }; }
		case "get": return { value: s.getItem(name) };
		case "set": { s.setItem(name, value); return { message: "Set " + store + "[" + JSON.stringify(name) + "]." }; }
		case "remove": { s.removeItem(name); return { message: "Removed " + store + "[" + JSON.stringify(name) + "]." }; }
		case "clear": { const n = s.length; s.clear(); return { message: "Cleared " + n + " keys from " + store + "." }; }
	}
	return { message: "unknown action" };
}`;

const PERFORMANCE_REPORT = `function () {
	const lines = [];
	const nav = performance.getEntriesByType("navigation")[0];
	if (nav) {
		lines.push("navigation: type=" + nav.type + " TTFB=" + Math.round(nav.responseStart) + "ms DOMContentLoaded=" + Math.round(nav.domContentLoadedEventEnd) + "ms load=" + Math.round(nav.loadEventEnd) + "ms transfer=" + Math.round(nav.transferSize / 1024) + "KB");
	}
	const paint = performance.getEntriesByType("paint");
	for (const p of paint) lines.push(p.name + ": " + Math.round(p.startTime) + "ms");
	const lcp = performance.getEntriesByType("largest-contentful-paint");
	if (lcp.length) { const last = lcp[lcp.length - 1]; lines.push("LCP: " + Math.round(last.startTime) + "ms (" + (last.element ? last.element.tagName.toLowerCase() + (last.element.id ? "#" + last.element.id : "") : "?") + ")"); }
	let cls = 0; for (const e of performance.getEntriesByType("layout-shift")) if (!e.hadRecentInput) cls += e.value;
	lines.push("CLS: " + cls.toFixed(3));
	const longTasks = performance.getEntriesByType("longtask");
	if (longTasks.length) lines.push("long tasks: " + longTasks.length + " (total " + Math.round(longTasks.reduce((a, t) => a + t.duration, 0)) + "ms)");
	const byType = {};
	for (const r of performance.getEntriesByType("resource")) { const t = r.initiatorType || "other"; byType[t] = byType[t] || { count: 0, bytes: 0, ms: 0 }; byType[t].count++; byType[t].bytes += r.transferSize || 0; byType[t].ms = Math.max(byType[t].ms, r.responseEnd); }
	const summary = Object.entries(byType).sort((a, b) => b[1].bytes - a[1].bytes).map(([t, v]) => t + ": " + v.count + " (" + Math.round(v.bytes / 1024) + "KB)").join(", ");
	if (summary) lines.push("resources: " + summary);
	return lines.join("\\n") || "(no performance entries yet)";
}`;
