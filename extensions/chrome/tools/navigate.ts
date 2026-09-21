import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { TabSession } from "../cdp/session.ts";
import { clampInt, describeDelta, joinLines, markState, pageLine, registerChromeTool, type ToolServices } from "./shared.ts";

export type WaitUntil = "load" | "domcontentloaded" | "networkidle" | "none";

/** Page.navigate reports these as errors, but the tab still shows something the agent can inspect. */
const SOFT_NAVIGATION_ERRORS = new Set(["net::ERR_HTTP_RESPONSE_CODE_FAILURE", "net::ERR_ABORTED"]);

export function registerNavigateTool(pi: ExtensionAPI, services: ToolServices): void {
	registerChromeTool(pi, services, {
		name: "chrome_navigate",
		label: "Chrome navigate",
		description:
			"Navigate the current tab: go to a URL, or back / forward / reload. Waits for the page to load (waitUntil: load by default; domcontentloaded, networkidle, or none) and reports the final URL, title, document status, load time, and any console errors or failed requests during the load. Opens the agent window on first use.",
		promptSnippet: "Open a URL (or go back/forward/reload) in the current Chrome tab and wait for it to load",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Absolute URL (http://, https://, file://, about:). Required for action goto." })),
			action: Type.Optional(StringEnum(["goto", "back", "forward", "reload"] as const)),
			waitUntil: Type.Optional(StringEnum(["load", "domcontentloaded", "networkidle", "none"] as const)),
			timeoutMs: Type.Optional(Type.Integer({ description: "Max wait for the load milestone (default 30000)" })),
			focus: Type.Optional(Type.Boolean({ description: "Override focus mode for this call" })),
		}),
		async execute(params, run) {
			const action = params.action ?? "goto";
			const session = await services.connector.currentSession({ focus: params.focus, signal: run.signal });
			const timeoutMs = clampInt(params.timeoutMs, 30_000, 1_000, 180_000);
			const waitUntil = params.waitUntil ?? "load";
			const mark = markState(session);
			const startedAt = Date.now();
			let softError: string | undefined;

			if (action === "goto") {
				if (!params.url) throw new Error("url is required for action goto");
				const url = normalizeUrl(params.url);
				const result = await session.send("Page.navigate", { url }, { timeoutMs });
				// An HTTP error status or an aborted navigation still leaves a page worth inspecting
				// (that is the point of testing error states); only unreachable hosts are a hard failure.
				if (result.errorText && !SOFT_NAVIGATION_ERRORS.has(result.errorText)) {
					throw new Error(`Navigation to ${url} failed: ${result.errorText}`);
				}
				softError = result.errorText;
			} else if (action === "reload") {
				await session.send("Page.reload", {}, { timeoutMs });
			} else {
				const history = await session.send("Page.getNavigationHistory");
				const index = history.currentIndex + (action === "back" ? -1 : 1);
				const entry = history.entries[index];
				if (!entry) throw new Error(`Cannot go ${action}: no history entry in that direction.`);
				await session.send("Page.navigateToHistoryEntry", { entryId: entry.id });
			}

			const outcome = await waitForLoad(session, waitUntil, timeoutMs, mark.navigationCount);
			const elapsed = Date.now() - startedAt;
			const status = documentStatus(session);
			const pending = outcome.reached ? "" : describeInflight(session);
			const note = softError === "net::ERR_ABORTED" ? " (navigation aborted: a download started, or the page redirected itself)" : softError ? " (error status with no renderable body)" : "";
			const header = `${outcome.reached ? "Loaded" : `Still loading after ${timeoutMs}ms (${waitUntil} not reached${pending})`}: ${pageLine(session)}${status ? ` (${status})` : ""}${note} in ${elapsed}ms`;
			return { text: joinLines(header, describeDelta(session, mark)) };
		},
	});
}

export async function waitForLoad(session: TabSession, waitUntil: WaitUntil, timeoutMs: number, navigationBefore: number): Promise<{ reached: boolean }> {
	if (waitUntil === "none") return { reached: true };
	const milestone = waitUntil === "domcontentloaded" ? "DOMContentLoaded" : "load";
	const reached = await session.waitForLifecycle(milestone, timeoutMs, { afterNavigation: navigationBefore });
	if (!reached) return { reached: false };
	if (waitUntil === "networkidle") {
		const idle = await session.network.waitForIdle(500, Math.max(1_000, timeoutMs - 500));
		return { reached: idle };
	}
	return { reached: true };
}

/** "; 3 in flight: url, url, url" or an empty string. */
export function describeInflight(session: TabSession): string {
	const count = session.network.inflightCount;
	if (count === 0) return "";
	const urls = session.network.inflightUrls(3).map((url) => (url.length > 90 ? `${url.slice(0, 89)}\u2026` : url));
	return `; ${count} in flight: ${urls.join(", ")}${count > urls.length ? ", \u2026" : ""}`;
}

export function documentStatus(session: TabSession): string | undefined {
	const documents = session.network.list({ type: "Document" });
	const latest = documents[documents.length - 1];
	if (!latest) return undefined;
	// The server's status is the useful fact even when the load then failed (an error page with no body).
	if (latest.status !== undefined) return `HTTP ${latest.status}${latest.fromCache ? ", cached" : ""}`;
	if (latest.failed) return `document failed: ${latest.failed}`;
	return undefined;
}

export function normalizeUrl(input: string): string {
	const trimmed = input.trim();
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
	if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(trimmed)) return `http://${trimmed}`;
	return `https://${trimmed}`;
}
