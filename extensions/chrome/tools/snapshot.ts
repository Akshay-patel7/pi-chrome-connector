import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { buildSnapshot, findElements } from "../cdp/snapshot.ts";
import type { TabSession } from "../cdp/session.ts";
import { clampInt, joinLines, pageLine, registerChromeTool, type ToolServices } from "./shared.ts";
import { backendNodeIdOf, resolveTarget, timeoutFrom } from "./targets.ts";

export function registerSnapshotTools(pi: ExtensionAPI, services: ToolServices): void {
	registerChromeTool(pi, services, {
		name: "chrome_snapshot",
		label: "Chrome snapshot",
		description:
			"Read the current tab as an accessibility tree: one line per element with role, name, state, and a ref like [e12] for chrome_click / chrome_fill / chrome_evaluate. mode interactive (default) lists controls, headings and landmarks; full includes all text. Scope with selector or ref (waits up to timeoutMs for it). Refs survive re-renders that keep the node and reset on navigation. [offscreen] = outside the viewport (still clickable); [clickable] = plain element with a click handler.",
		promptSnippet: "Read the Chrome page as an accessibility tree with refs to act on",
		promptGuidelines: [
			"Use chrome_snapshot (not chrome_screenshot) to find elements and read page structure; use refs from it in chrome_click and chrome_fill.",
			"After an action that changes the page, take a fresh chrome_snapshot before reusing refs; a stale ref error means the element was re-rendered.",
		],
		parameters: Type.Object({
			mode: Type.Optional(StringEnum(["interactive", "full"] as const)),
			selector: Type.Optional(Type.String({ description: "Scope: CSS selector" })),
			ref: Type.Optional(Type.String({ description: "Scope: ref" })),
			frame: Type.Optional(Type.String({ description: "Iframe id, name or URL substring" })),
			visibleOnly: Type.Optional(Type.Boolean({ description: "Drop [offscreen] elements" })),
			maxChars: Type.Optional(Type.Integer({ description: "Output cap (default 30000)" })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Wait for the scope element, ms (default 5000; 0 = none)" })),
			focus: Type.Optional(Type.Boolean({ description: "Override focus mode" })),
		}),
		async execute(params, run) {
			const session = await services.connector.currentSession({ focus: params.focus ?? false, signal: run.signal });
			const target = frameTarget(session, params.frame);
			let scopeBackendNodeId: number | undefined;
			if (params.ref || params.selector) {
				const resolved = await resolveTarget(session, { ref: params.ref, selector: params.selector, frame: params.frame }, { timeoutMs: params.timeoutMs });
				scopeBackendNodeId = resolved.backendNodeId ?? (await backendNodeIdOf(session, resolved.objectId, resolved.sessionId));
				await session.releaseObject(resolved.objectId, resolved.sessionId);
				if (scopeBackendNodeId === undefined) throw new Error("Could not resolve the scope element to a DOM node.");
			}
			const snapshot = await buildSnapshot(session, {
				mode: params.mode ?? "interactive",
				scopeBackendNodeId,
				maxChars: clampInt(params.maxChars, 30_000, 500, 200_000),
				visibleOnly: params.visibleOnly,
				...target,
			});
			const header = `Page: ${pageLine(session)} — ${snapshot.refs} refs, mode ${params.mode ?? "interactive"}${session.dialog ? ` — DIALOG OPEN: ${session.dialog.type} "${session.dialog.message.slice(0, 80)}"` : ""}`;
			return { text: joinLines(header, snapshot.text || "(nothing matched; try mode \"full\")") };
		},
	});

	registerChromeTool(pi, services, {
		name: "chrome_find",
		label: "Chrome find",
		description:
			"Find elements and get refs without reading a whole snapshot: by visible/accessible text (substring, case-insensitive), ARIA role (button, link, textbox, ...), both, or a CSS selector. Waits up to timeoutMs for a match (pass 0 to just check). Returns up to limit matches with their snapshot line, ref, and surrounding heading/landmark.",
		promptSnippet: "Find elements by text, role or CSS selector and get refs",
		parameters: Type.Object({
			text: Type.Optional(Type.String({ description: "Accessible name or text (substring)" })),
			role: Type.Optional(Type.String({ description: "ARIA role, e.g. button, link, textbox" })),
			selector: Type.Optional(Type.String({ description: "CSS selector (ignores text/role)" })),
			frame: Type.Optional(Type.String({ description: "Iframe id, name or URL substring" })),
			limit: Type.Optional(Type.Integer({ description: "Max matches (default 10)" })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Keep looking, ms (default 5000; 0 = once)" })),
		}),
		async execute(params, run) {
			if (!params.text && !params.role && !params.selector) throw new Error("Give text, role, or selector.");
			const session = await services.connector.currentSession({ focus: false, signal: run.signal });
			const timeoutMs = timeoutFrom(params.timeoutMs);
			const matches = await findElements(session, { text: params.text, role: params.role, selector: params.selector, limit: clampInt(params.limit, 10, 1, 100), timeoutMs, ...frameTarget(session, params.frame) });
			if (matches.length === 0) {
				const what = params.selector ? `selector ${params.selector}` : [params.role && `role ${params.role}`, params.text && `text "${params.text}"`].filter(Boolean).join(" with ");
				return { text: `No elements match ${what}${timeoutMs > 0 ? ` (waited ${timeoutMs}ms)` : ""}. Page: ${pageLine(session)}. Try a shorter text, mode "full" in chrome_snapshot, or check the page loaded.` };
			}
			const lines = matches.map((match) => `${match.line}${match.context ? `    (in ${match.context})` : ""}`);
			return { text: `${matches.length} match${matches.length === 1 ? "" : "es"}:\n${lines.join("\n")}` };
		},
	});
}

export function frameTarget(session: TabSession, frame: string | undefined): { frameId?: string; sessionId?: string } {
	if (!frame) return {};
	const info = session.findFrame(frame);
	if (!info) throw new Error(`No frame matches "${frame}". Run chrome_frames to list them.`);
	return info.sessionId ? { sessionId: info.sessionId } : { frameId: info.id };
}
