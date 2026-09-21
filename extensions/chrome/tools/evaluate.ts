import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { safeJson } from "../cdp/remote-object.ts";
import type { TabSession } from "../cdp/session.ts";
import { resolveRef } from "./targets.ts";
import { clampInt, describeDelta, joinLines, markState, registerChromeTool, type ToolServices } from "./shared.ts";

const MAX_RESULT_CHARS = 20_000;
// A function *expression* the caller wants invoked: `function ...`, `(a, b) => ...`, `x => ...`.
// Parameter lists never start with "(", so an IIFE like `(() => {...})()` is left alone.
const FUNCTION_SYNTAX = /^\s*(async\s+)?(function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;

export function registerEvaluateTool(pi: ExtensionAPI, services: ToolServices): void {
	registerChromeTool(pi, services, {
		name: "chrome_evaluate",
		label: "Chrome evaluate",
		description:
			"Run JavaScript in the current tab and return the JSON-serialized result (promises are awaited). Pass an expression (`document.title`) or a function (`() => [...document.querySelectorAll('a')].map(a => a.href)`). With ref (from chrome_snapshot / chrome_find) the element is available as `el` and a function receives it as its argument. With frame, runs inside that iframe (id, name, or URL substring from chrome_frames). Errors return the exception message and stack. Runs even on pages with a strict CSP.",
		promptSnippet: "Run JavaScript in the page (optionally against a snapshot ref or inside an iframe) and get the result",
		promptGuidelines: [
			"Use chrome_evaluate to assert page state precisely (element text, counts, URL, app state) instead of inferring it from a snapshot after an action.",
		],
		parameters: Type.Object({
			expression: Type.String({ description: "JavaScript expression or function source" }),
			ref: Type.Optional(Type.String({ description: "Snapshot ref (e.g. e12); bound as `el`" })),
			frame: Type.Optional(Type.String({ description: "Iframe id, name or URL substring" })),
			awaitPromise: Type.Optional(Type.Boolean({ description: "Await a returned promise (default true)" })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Default 30000" })),
		}),
		async execute(params, run) {
			const session = await services.connector.currentSession({ focus: false, signal: run.signal });
			const timeoutMs = clampInt(params.timeoutMs, 30_000, 500, 300_000);
			const mark = markState(session);
			const value = await evaluateInPage(session, params.expression, { ref: params.ref, frame: params.frame, awaitPromise: params.awaitPromise ?? true, timeoutMs });
			return { text: joinLines(formatValue(value), describeDelta(session, mark)) };
		},
	});
}

export interface EvaluateOptions {
	ref?: string;
	frame?: string;
	awaitPromise?: boolean;
	timeoutMs?: number;
}

export async function evaluateInPage(session: TabSession, expression: string, options: EvaluateOptions): Promise<unknown> {
	const isFunction = FUNCTION_SYNTAX.test(expression);
	if (options.ref) {
		const target = await resolveRef(session, options.ref);
		try {
			const declaration = isFunction
				? `function() { return (${expression}).call(this, this); }`
				: `function() { const el = this; return (${expression}); }`;
			const { value } = await session.callFunctionOn(target.objectId, declaration, [], { sessionId: target.sessionId, awaitPromise: options.awaitPromise ?? true });
			return value;
		} finally {
			await session.releaseObject(target.objectId, target.sessionId);
		}
	}
	let contextId: number | undefined;
	let sessionId: string | undefined;
	if (options.frame) {
		const frame = session.findFrame(options.frame);
		if (!frame) throw new Error(`No frame matches "${options.frame}". Run chrome_frames to list them.`);
		if (frame.sessionId) {
			sessionId = frame.sessionId;
		} else {
			const context = session.contextFor(frame.id);
			if (!context) throw new Error(`Frame ${frame.id} (${frame.url}) has no execution context yet; wait for it to load.`);
			contextId = context.id;
		}
	}
	const source = isFunction ? `(${expression})()` : expression;
	return session.evaluate(source, { awaitPromise: options.awaitPromise ?? true, contextId, sessionId, timeoutMs: options.timeoutMs });
}

export function formatValue(value: unknown): string {
	if (value === undefined) return "undefined";
	if (typeof value === "string") return value.length > MAX_RESULT_CHARS ? `${value.slice(0, MAX_RESULT_CHARS)}… [${value.length - MAX_RESULT_CHARS} more chars]` : value;
	const json = safeJson(value, 2);
	return json.length > MAX_RESULT_CHARS ? `${json.slice(0, MAX_RESULT_CHARS)}… [${json.length - MAX_RESULT_CHARS} more chars; narrow the expression]` : json;
}
