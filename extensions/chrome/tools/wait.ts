import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describeInflight } from "./navigate.ts";
import { clampInt, describeDelta, joinLines, markState, pageLine, registerChromeTool, type ToolServices } from "./shared.ts";
import { frameScope } from "./targets.ts";

const POLL_MS = 100;

export function registerWaitTool(pi: ExtensionAPI, services: ToolServices): void {
	registerChromeTool(pi, services, {
		name: "chrome_wait",
		label: "Chrome wait",
		description:
			"Wait for a condition in the current tab, polling every 100 ms until timeoutMs (default 30000). Conditions (give one or more; all must hold): selector with state visible (default) | hidden | attached | detached; text visible on the page; function (JS expression that must return truthy); url substring or /regex/; load milestone load | domcontentloaded | networkidle; timeMs plain delay. Returns as soon as the condition holds, with elapsed time and what changed meanwhile. Use a long timeout to wait for the user to do something in the browser (e.g. log in).",
		promptSnippet: "Wait for a selector, text, JS condition, URL, load state, or the user in Chrome",
		promptGuidelines: ["After chrome_click on something that loads data asynchronously, use chrome_wait (selector or text) instead of fixed delays or repeated snapshots."],
		parameters: Type.Object({
			selector: Type.Optional(Type.String()),
			state: Type.Optional(StringEnum(["visible", "hidden", "attached", "detached"] as const)),
			text: Type.Optional(Type.String({ description: "Text that must be visible" })),
			function: Type.Optional(Type.String({ description: "JS expression evaluated in the page; truthy = done" })),
			url: Type.Optional(Type.String({ description: "URL substring, or /regex/" })),
			load: Type.Optional(StringEnum(["load", "domcontentloaded", "networkidle"] as const)),
			timeMs: Type.Optional(Type.Integer({ description: "Plain delay" })),
			frame: Type.Optional(Type.String({ description: "Iframe id, name or URL substring" })),
			timeoutMs: Type.Optional(Type.Integer()),
		}),
		async execute(params, run) {
			const conditions: string[] = [];
			if (params.selector) conditions.push(`selector ${params.selector} ${params.state ?? "visible"}`);
			if (params.text) conditions.push(`text "${params.text}"`);
			if (params.function) conditions.push(`function truthy`);
			if (params.url) conditions.push(`url ~ ${params.url}`);
			if (params.load) conditions.push(`load state ${params.load}`);
			if (params.timeMs) conditions.push(`${params.timeMs}ms`);
			if (conditions.length === 0) throw new Error("Give at least one condition: selector, text, function, url, load, or timeMs.");

			const session = await services.connector.currentSession({ focus: false, signal: run.signal });
			const mark = markState(session);
			const timeoutMs = clampInt(params.timeoutMs, 30_000, 100, 30 * 60_000);
			const started = Date.now();
			const deadline = started + timeoutMs;
			const urlMatcher = params.url ? toMatcher(params.url) : undefined;
			let lastFailure = "";

			while (Date.now() < deadline) {
				if (run.signal?.aborted) throw new Error("Wait cancelled.");
				if (session.dialog) return { text: joinLines(`Stopped waiting: ${session.dialog.type} dialog open: "${session.dialog.message.slice(0, 200)}". Use chrome_dialog.`, describeDelta(session, mark)) };
				lastFailure = await check();
				if (lastFailure === "") {
					const elapsed = Date.now() - started;
					return { text: joinLines(`Condition met after ${elapsed}ms: ${conditions.join(" and ")}.`, `Page: ${pageLine(session)}`, describeDelta(session, mark)) };
				}
				await new Promise((resolveSleep) => setTimeout(resolveSleep, POLL_MS));
			}
			throw new Error(`Timed out after ${timeoutMs}ms waiting for ${conditions.join(" and ")}. Last state: ${lastFailure}. Page: ${pageLine(session)}. ${describeDelta(session, mark)}`.trim());

			/** Empty string when every condition holds, otherwise a description of the first failing one. */
			async function check(): Promise<string> {
				if (params.timeMs && Date.now() - started < params.timeMs) return `waiting ${params.timeMs}ms`;
				if (params.load) {
					if (params.load === "networkidle") {
						if (!session.lifecycleReached("load")) return "load event not fired";
						if (session.network.inflightCount > 0) return describeInflight(session).slice(2);
					} else if (!session.lifecycleReached(params.load === "load" ? "load" : "DOMContentLoaded")) {
						const ready = await session.evaluate<string>("document.readyState", { awaitPromise: false, timeoutMs: 2_000 }).catch(() => "unknown");
						if (!(ready === "complete" || (params.load === "domcontentloaded" && ready === "interactive"))) return `document.readyState is ${ready}`;
					}
				}
				if (urlMatcher && !urlMatcher(session.url)) return `url is ${session.url}`;
				if (params.selector || params.text || params.function) {
					const scope = params.frame ? frameScope(session, params.frame) : {};
					const contextMissing = params.frame && !scope.sessionId && scope.contextId === undefined;
					if (contextMissing) return "frame has no execution context yet";
					const probe = await session
						.evaluate<{ ok: boolean; reason: string }>(`(${PROBE})(${JSON.stringify(params.selector ?? null)}, ${JSON.stringify(params.state ?? "visible")}, ${JSON.stringify(params.text ?? null)}, ${JSON.stringify(params.function ?? null)})`, {
							awaitPromise: true,
							timeoutMs: 5_000,
							...scope,
						})
						.catch((error: Error) => ({ ok: false, reason: `probe failed: ${error.message.split("\n")[0]}` }));
					if (!probe.ok) return probe.reason;
				}
				return "";
			}
		},
	});
}

function toMatcher(pattern: string): (url: string) => boolean {
	const regex = /^\/(.+)\/([a-z]*)$/.exec(pattern);
	if (regex) {
		const compiled = new RegExp(regex[1] as string, regex[2]);
		return (url) => compiled.test(url);
	}
	const needle = pattern.toLowerCase();
	return (url) => url.toLowerCase().includes(needle);
}

const PROBE = `async function (selector, state, text, fn) {
	const visible = (el) => {
		if (!el) return false;
		const style = getComputedStyle(el);
		if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
		const rect = el.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	};
	if (selector) {
		const el = document.querySelector(selector);
		if (state === "attached" && !el) return { ok: false, reason: "selector not in DOM" };
		if (state === "detached" && el) return { ok: false, reason: "selector still in DOM" };
		if (state === "visible" && !visible(el)) return { ok: false, reason: el ? "selector in DOM but not visible" : "selector not in DOM" };
		if (state === "hidden" && visible(el)) return { ok: false, reason: "selector still visible" };
	}
	if (text) {
		const wanted = text.replace(/\\s+/g, " ").trim().toLowerCase();
		const body = (document.body && document.body.innerText || "").replace(/\\s+/g, " ").toLowerCase();
		if (!body.includes(wanted)) return { ok: false, reason: "text not visible" };
	}
	if (fn) {
		let value;
		try { value = await (0, eval)(fn); } catch (error) { return { ok: false, reason: "function threw: " + (error && error.message || error) }; }
		if (!value) return { ok: false, reason: "function returned " + JSON.stringify(value) };
	}
	return { ok: true, reason: "" };
}`;
