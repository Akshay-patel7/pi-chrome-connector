// Shared plumbing for chrome_* tools: registration wrapper, error translation, output helpers,
// and the "what changed" summary appended after actions.

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TObject } from "typebox";
import { BridgeError } from "../bridge/server.ts";
import type { Connector } from "../connector.ts";
import { DialogOpenError, EvaluateError, SessionClosedError, type TabSession } from "../cdp/session.ts";

export interface ToolImage {
	data: string;
	mimeType: string;
}

export interface ToolOutput {
	text: string;
	images?: ToolImage[];
	details?: Record<string, unknown>;
}

export interface RunContext {
	signal: AbortSignal | undefined;
	/** Streams a progress line to the UI while the tool runs. */
	progress: (message: string) => void;
	ctx: ExtensionContext;
}

export interface ChromeToolSpec<T extends TObject> {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: T;
	execute: (params: Static<T>, run: RunContext) => Promise<ToolOutput>;
}

export interface ToolServices {
	connector: Connector;
}

export function registerChromeTool<T extends TObject>(pi: ExtensionAPI, services: ToolServices, spec: ChromeToolSpec<T>): void {
	const definition: ToolDefinition<T, Record<string, unknown> | undefined> = {
		name: spec.name,
		label: spec.label,
		description: spec.description,
		promptSnippet: spec.promptSnippet,
		promptGuidelines: spec.promptGuidelines,
		parameters: spec.parameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const progress = (message: string) => onUpdate?.({ content: [{ type: "text", text: message }], details: undefined });
			const offProgress = (message: string) => progress(message);
			services.connector.on("progress", offProgress);
			try {
				const output = await spec.execute(params, { signal, progress, ctx });
				const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
				for (const image of output.images ?? []) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
				content.push({ type: "text", text: output.text });
				return { content, details: output.details };
			} catch (error) {
				throw translateError(error);
			} finally {
				services.connector.off("progress", offProgress);
			}
		},
	};
	pi.registerTool(definition);
}

export function translateError(error: unknown): Error {
	if (error instanceof DialogOpenError) return error;
	if (error instanceof SessionClosedError) {
		return new Error(`${error.message}. The tab was closed or the debugger was detached (DevTools opened on it, or Chrome closed it). Run chrome_tabs with action "list" and pick or create a tab.`);
	}
	if (error instanceof EvaluateError) return new Error(`JavaScript threw: ${error.message}`);
	if (error instanceof BridgeError) {
		if (error.code === "disconnected") return new Error(`Chrome disconnected: ${error.message}. Retry the call; the connector reconnects (and relaunches Chrome if it was closed).`);
		if (error.code === "timeout") return new Error(`${error.message}. If Chrome shows a native dialog or a page is hung, resolve that first; otherwise retry.`);
		return new Error(error.message);
	}
	if (error instanceof Error) return error;
	return new Error(String(error));
}

// --- action deltas --------------------------------------------------------------------------

export interface StateMark {
	consoleSeq: number;
	networkSeq: number;
	navigationCount: number;
	navigationStarts: number;
	url: string;
}

export function markState(session: TabSession): StateMark {
	return {
		consoleSeq: session.console.lastSeq,
		networkSeq: session.network.lastSeq,
		navigationCount: session.navigationCount,
		navigationStarts: session.navigationStarts,
		url: session.url,
	};
}

/** One line describing side effects since the mark, or an empty string when nothing notable happened. */
export function describeDelta(session: TabSession, mark: StateMark): string {
	const notes: string[] = [];
	if (session.navigationCount !== mark.navigationCount || session.url !== mark.url) notes.push(`navigated to ${session.url}`);
	const errors = session.console.countSince(mark.consoleSeq, "error");
	const warnings = session.console.countSince(mark.consoleSeq, "warning") - errors;
	if (errors > 0) notes.push(`${errors} new console error${errors === 1 ? "" : "s"} (chrome_console level=error)`);
	if (warnings > 0) notes.push(`${warnings} new console warning${warnings === 1 ? "" : "s"}`);
	const { failed, blocked, aborted, canceled } = session.network.countFailedSince(mark.networkSeq);
	if (failed > 0) notes.push(`${failed} failed request${failed === 1 ? "" : "s"} (chrome_network failedOnly=true)`);
	if (blocked > 0) notes.push(`${blocked} request${blocked === 1 ? "" : "s"} blocked by a browser extension (ad blocker; usually telemetry)`);
	if (aborted > 0) notes.push(`${aborted} request${aborted === 1 ? "" : "s"} aborted by chrome_route`);
	if (canceled > 0) notes.push(`${canceled} request${canceled === 1 ? "" : "s"} canceled by the page (navigation or abort; usually harmless)`);
	const requests = session.network.lastSeq - mark.networkSeq;
	if (requests > 0 && failed === 0) notes.push(`${requests} request${requests === 1 ? "" : "s"}`);
	if (session.dialog) notes.push(`dialog open: ${session.dialog.type} "${session.dialog.message.slice(0, 80)}"`);
	return notes.length > 0 ? `Since: ${notes.join("; ")}.` : "";
}

export function pageLine(session: TabSession): string {
	return `${session.title ? `"${session.title}" ` : ""}${session.url}`;
}

export function joinLines(...parts: Array<string | undefined | false>): string {
	return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
}

export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}
