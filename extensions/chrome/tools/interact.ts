// Input tools: click, hover, fill, type, press, scroll, select, upload, mouse. All input goes
// through CDP Input.* so pages see trusted events, dispatched on the session that owns the element.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { Type } from "typebox";
import { describeCharacter, macEditingCommands, MODIFIER_BITS, needsShift, parseChord, type Chord, type KeyDescription } from "../cdp/keyboard.ts";
import type { TabSession } from "../cdp/session.ts";
import { resolveSecret } from "../config.ts";
import { clampInt, describeDelta, joinLines, markState, registerChromeTool, type StateMark, type ToolServices } from "./shared.ts";
import { hasTarget, resolveTarget, type ResolvedTarget, type TargetSpec } from "./targets.ts";

const TARGET_PARAMS = {
	ref: Type.Optional(Type.String({ description: "Snapshot ref, e.g. e12" })),
	selector: Type.Optional(Type.String({ description: "CSS selector (use >> to pierce shadow roots)" })),
	text: Type.Optional(Type.String({ description: "Visible text of the element" })),
	frame: Type.Optional(Type.String({ description: "Iframe id, name or URL substring (for selector/text)" })),
};

interface Point {
	x: number;
	y: number;
}

interface PointResult extends Point {
	occluded: boolean;
	blocker?: string;
	width: number;
	height: number;
	error?: string;
}

const SETTLE_MS = 150;
const NAVIGATION_WAIT_MS = 10_000;

export function registerInteractionTools(pi: ExtensionAPI, services: ToolServices): void {
	const { connector } = services;

	registerChromeTool(pi, services, {
		name: "chrome_click",
		label: "Chrome click",
		description:
			"Click an element (by ref, selector, or visible text) or a viewport point (x, y) with a real mouse event. Scrolls the element into view, verifies nothing covers it (reports the covering element; force:true clicks anyway), waits for any navigation the click starts, and reports what changed (URL, new console errors, failed requests, dialogs). button: left|right|middle; clickCount 2 for double-click; modifiers like [\"Shift\"] or [\"Meta\"].",
		promptSnippet: "Click an element in Chrome by ref, selector, text, or coordinates",
		parameters: Type.Object({
			...TARGET_PARAMS,
			x: Type.Optional(Type.Number({ description: "Viewport x in CSS px (with y, instead of an element)" })),
			y: Type.Optional(Type.Number()),
			button: Type.Optional(StringEnum(["left", "right", "middle"] as const)),
			clickCount: Type.Optional(Type.Integer({ description: "1 = click, 2 = double-click, 3 = triple-click" })),
			modifiers: Type.Optional(Type.Array(StringEnum(["Alt", "Control", "Meta", "Shift"] as const))),
			force: Type.Optional(Type.Boolean({ description: "Click even if another element covers the target" })),
			focus: Type.Optional(Type.Boolean({ description: "Override focus mode for this call" })),
		}),
		async execute(params, run) {
			const session = await connector.currentSession({ focus: params.focus, signal: run.signal });
			const mark = markState(session);
			const modifiers = (params.modifiers ?? []).reduce((bits, name) => bits | MODIFIER_BITS[name], 0);
			const button = params.button ?? "left";
			const clickCount = clampInt(params.clickCount, 1, 1, 3);
			let where: string;
			if (hasTarget(params)) {
				const target = await resolveTarget(session, params);
				try {
					const point = await pointFor(session, target, { force: params.force });
					await mouseClick(session, point, { button, clickCount, modifiers, sessionId: target.sessionId });
					where = `${target.description} at (${Math.round(point.x)}, ${Math.round(point.y)})`;
				} finally {
					await session.releaseObject(target.objectId, target.sessionId);
				}
			} else if (params.x !== undefined && params.y !== undefined) {
				await mouseClick(session, { x: params.x, y: params.y }, { button, clickCount, modifiers });
				where = `(${params.x}, ${params.y})`;
			} else {
				throw new Error("Give an element (ref, selector, or text) or a point (x and y).");
			}
			await settle(session, mark);
			const verb = clickCount === 2 ? "Double-clicked" : clickCount === 3 ? "Triple-clicked" : button === "right" ? "Right-clicked" : "Clicked";
			return { text: joinLines(`${verb} ${where}.`, describeDelta(session, mark)) };
		},
	});

	registerChromeTool(pi, services, {
		name: "chrome_hover",
		label: "Chrome hover",
		description: "Move the mouse over an element (ref, selector, text) or a point to trigger hover states, tooltips and menus. Reports what changed.",
		parameters: Type.Object({ ...TARGET_PARAMS, x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), focus: Type.Optional(Type.Boolean()) }),
		async execute(params, run) {
			const session = await connector.currentSession({ focus: params.focus, signal: run.signal });
			const mark = markState(session);
			let where: string;
			if (hasTarget(params)) {
				const target = await resolveTarget(session, params);
				try {
					const point = await pointFor(session, target, { force: true });
					await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, { sessionId: target.sessionId });
					where = target.description;
				} finally {
					await session.releaseObject(target.objectId, target.sessionId);
				}
			} else if (params.x !== undefined && params.y !== undefined) {
				await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: params.x, y: params.y });
				where = `(${params.x}, ${params.y})`;
			} else {
				throw new Error("Give an element (ref, selector, or text) or a point (x and y).");
			}
			await sleep(SETTLE_MS);
			return { text: joinLines(`Hovering ${where}.`, describeDelta(session, mark)) };
		},
	});

	registerChromeTool(pi, services, {
		name: "chrome_fill",
		label: "Chrome fill",
		description:
			"Set the value of a form control the way a user would: focuses it, replaces existing content, and inserts the text with trusted input events (works with React/Vue/Angular). Handles inputs, textareas, contenteditable editors, checkboxes/radios (value \"true\"/\"false\"/\"toggle\"), selects (option value or label), and date/time/color/range inputs (native format, e.g. 2026-09-20). For passwords or other credentials pass secret: NAME instead of value; the value comes from the connector's secrets config or environment and never appears in this conversation. pressEnter submits afterwards.",
		promptSnippet: "Fill a form field in Chrome (use secret: NAME for credentials)",
		promptGuidelines: ["Use chrome_fill with secret: NAME for passwords and API keys; never ask the user to paste credentials into the chat when a secret name exists (chrome_status lists them)."],
		parameters: Type.Object({
			...TARGET_PARAMS,
			value: Type.Optional(Type.String({ description: "Text or value to set (empty string clears)" })),
			secret: Type.Optional(Type.String({ description: "Name of a configured secret to use as the value" })),
			pressEnter: Type.Optional(Type.Boolean({ description: "Press Enter after filling" })),
			focus: Type.Optional(Type.Boolean()),
		}),
		async execute(params, run) {
			if (!hasTarget(params)) throw new Error("Give the field as ref, selector, or text (its label works).");
			if (params.value === undefined && params.secret === undefined) throw new Error("Give value or secret.");
			const value = params.secret !== undefined ? resolveSecret(connector.config, params.secret) : (params.value as string);
			const shown = params.secret !== undefined ? `[secret ${params.secret}]` : JSON.stringify(value.length > 60 ? `${value.slice(0, 59)}…` : value);
			const session = await connector.currentSession({ focus: params.focus, signal: run.signal });
			const mark = markState(session);
			const target = await resolveTarget(session, params);
			let outcome: string;
			try {
				outcome = await fillTarget(session, target, value);
				if (params.pressEnter) await pressChord(session, parseChord("Enter"), target.sessionId);
			} finally {
				await session.releaseObject(target.objectId, target.sessionId);
			}
			await settle(session, mark);
			return { text: joinLines(`${outcome} ${target.description} with ${shown}${params.pressEnter ? ", then pressed Enter" : ""}.`, describeDelta(session, mark)) };
		},
	});

	registerChromeTool(pi, services, {
		name: "chrome_type",
		label: "Chrome type",
		description:
			"Type text key by key into the focused element (or into ref/selector/text first), sending real keydown/keypress/keyup events with optional delayMs between keys. Use this for autocomplete/typeahead inputs and editors that react to each keystroke; use chrome_fill to set a value in one go. \\n presses Enter. secret: NAME types a configured secret without exposing it.",
		promptSnippet: "Type text key-by-key in Chrome (for typeahead/autocomplete fields)",
		parameters: Type.Object({
			...TARGET_PARAMS,
			text: Type.Optional(Type.String({ description: "Text to type (\\n = Enter)" })),
			secret: Type.Optional(Type.String({ description: "Name of a configured secret to type" })),
			delayMs: Type.Optional(Type.Integer({ description: "Delay between keys (default 0)" })),
			clear: Type.Optional(Type.Boolean({ description: "Select-all + delete before typing" })),
			focus: Type.Optional(Type.Boolean()),
		}),
		async execute(params, run) {
			const { text: targetText, ...rest } = params;
			// `text` doubles as the target locator only when a value is not being typed; typing text is the payload.
			const payload = params.secret !== undefined ? resolveSecret(connector.config, params.secret) : targetText;
			if (payload === undefined) throw new Error("Give text to type (or secret).");
			const shown = params.secret !== undefined ? `[secret ${params.secret}]` : JSON.stringify(payload.length > 60 ? `${payload.slice(0, 59)}…` : payload);
			const session = await connector.currentSession({ focus: params.focus, signal: run.signal });
			const mark = markState(session);
			let sessionId: string | undefined;
			let where = "the focused element";
			const locator: TargetSpec = { ref: rest.ref, selector: rest.selector, frame: rest.frame };
			if (hasTarget(locator)) {
				const target = await resolveTarget(session, locator);
				try {
					await focusTarget(session, target);
					sessionId = target.sessionId;
					where = target.description;
				} finally {
					await session.releaseObject(target.objectId, target.sessionId);
				}
			}
			if (params.clear) {
				await pressChord(session, parseChord(process.platform === "darwin" ? "Meta+a" : "Control+a"), sessionId);
				await pressChord(session, parseChord("Backspace"), sessionId);
			}
			await typeText(session, payload, clampInt(params.delayMs, 0, 0, 2000), sessionId);
			await settle(session, mark);
			return { text: joinLines(`Typed ${shown} into ${where}.`, describeDelta(session, mark)) };
		},
	});

	registerChromeTool(pi, services, {
		name: "chrome_press",
		label: "Chrome press",
		description:
			"Press keys or shortcuts: \"Enter\", \"Tab\", \"Escape\", \"ArrowDown\", \"Control+a\", \"Meta+Shift+p\", \"F5\". Separate several chords with spaces (\"Control+a Backspace\"); repeat presses the sequence N times. Goes to the focused element (or focuses ref/selector first). macOS editing shortcuts (Cmd+A/C/V/X/Z) are honored.",
		promptSnippet: "Press a key or keyboard shortcut in Chrome",
		parameters: Type.Object({
			keys: Type.String({ description: "Key or chord(s), e.g. \"Enter\" or \"Control+Shift+p\" or \"ArrowDown ArrowDown Enter\"" }),
			repeat: Type.Optional(Type.Integer({ description: "Times to press the sequence (default 1)" })),
			delayMs: Type.Optional(Type.Integer({ description: "Delay between presses" })),
			ref: TARGET_PARAMS.ref,
			selector: TARGET_PARAMS.selector,
			frame: TARGET_PARAMS.frame,
			focus: Type.Optional(Type.Boolean()),
		}),
		async execute(params, run) {
			const session = await connector.currentSession({ focus: params.focus, signal: run.signal });
			const mark = markState(session);
			const chords = params.keys.trim().split(/\s+/).map(parseChord);
			let sessionId: string | undefined;
			if (params.ref || params.selector) {
				const target = await resolveTarget(session, { ref: params.ref, selector: params.selector, frame: params.frame });
				try {
					await focusTarget(session, target);
					sessionId = target.sessionId;
				} finally {
					await session.releaseObject(target.objectId, target.sessionId);
				}
			}
			const repeat = clampInt(params.repeat, 1, 1, 200);
			const delay = clampInt(params.delayMs, 0, 0, 2000);
			for (let round = 0; round < repeat; round++) {
				for (const chord of chords) {
					await pressChord(session, chord, sessionId);
					if (delay) await sleep(delay);
				}
			}
			await settle(session, mark);
			return { text: joinLines(`Pressed ${params.keys}${repeat > 1 ? ` x${repeat}` : ""}.`, describeDelta(session, mark)) };
		},
	});

	registerChromeTool(pi, services, {
		name: "chrome_scroll",
		label: "Chrome scroll",
		description:
			"Scroll the page or a scrollable container with real wheel events. deltaY > 0 scrolls down (default 600 px), deltaX for horizontal. Give ref/selector/text to scroll inside that container, or to: \"top\" | \"bottom\" | \"element\" (scroll the target into view). Reports the resulting scroll position.",
		promptSnippet: "Scroll the Chrome page or a container",
		parameters: Type.Object({
			...TARGET_PARAMS,
			deltaY: Type.Optional(Type.Number()),
			deltaX: Type.Optional(Type.Number()),
			to: Type.Optional(StringEnum(["top", "bottom", "element"] as const)),
			focus: Type.Optional(Type.Boolean()),
		}),
		async execute(params, run) {
			const session = await connector.currentSession({ focus: params.focus, signal: run.signal });
			const mark = markState(session);
			let report: string;
			if (hasTarget(params)) {
				const target = await resolveTarget(session, params);
				try {
					if (params.to === "element") {
						await session.callFunctionOn(target.objectId, "function () { this.scrollIntoView({ block: 'center', inline: 'nearest' }); }", [], { sessionId: target.sessionId });
						report = `Scrolled ${target.description} into view.`;
					} else if (params.to) {
						const { value } = await session.callFunctionOn<string>(target.objectId, SCROLL_CONTAINER_TO, [params.to], { sessionId: target.sessionId });
						report = `Scrolled ${target.description} to ${params.to}: ${value}`;
					} else {
						const point = await pointFor(session, target, { force: true });
						await wheel(session, point, params.deltaX ?? 0, params.deltaY ?? 600, target.sessionId);
						const { value } = await session.callFunctionOn<{ self: boolean; container: string; position: string }>(target.objectId, DESCRIBE_SCROLL, [], { sessionId: target.sessionId });
						report = value.self ? `Scrolled inside ${target.description}: ${value.position}` : `Scrolled ${value.container} (the nearest scrollable container of ${target.description}): ${value.position}`;
					}
				} finally {
					await session.releaseObject(target.objectId, target.sessionId);
				}
			} else if (params.to === "top" || params.to === "bottom") {
				report = `Scrolled page to ${params.to}: ${await session.evaluate<string>(`(${SCROLL_PAGE_TO})(${JSON.stringify(params.to)})`)}`;
			} else {
				const metrics = await session.send("Page.getLayoutMetrics");
				const viewport = metrics.cssVisualViewport;
				await wheel(session, { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }, params.deltaX ?? 0, params.deltaY ?? 600);
				report = `Scrolled page: ${await session.evaluate<string>(`(${DESCRIBE_PAGE_SCROLL})()`)}`;
			}
			return { text: joinLines(report, describeDelta(session, mark)) };
		},
	});

	registerChromeTool(pi, services, {
		name: "chrome_select",
		label: "Chrome select",
		description: "Choose option(s) in a <select> by option value or label (case-insensitive). Fires input and change events. For custom dropdowns (divs), use chrome_click on the trigger and then on the option.",
		parameters: Type.Object({ ...TARGET_PARAMS, values: Type.Array(Type.String(), { description: "Option values or labels; several only for multi-selects" }), focus: Type.Optional(Type.Boolean()) }),
		async execute(params, run) {
			if (!hasTarget(params)) throw new Error("Give the select as ref, selector, or text.");
			const session = await connector.currentSession({ focus: params.focus, signal: run.signal });
			const mark = markState(session);
			const target = await resolveTarget(session, params);
			try {
				const result = await selectOptions(session, target, params.values);
				await settle(session, mark);
				return { text: joinLines(`Selected ${result} in ${target.description}.`, describeDelta(session, mark)) };
			} finally {
				await session.releaseObject(target.objectId, target.sessionId);
			}
		},
	});

	registerChromeTool(pi, services, {
		name: "chrome_upload",
		label: "Chrome upload",
		description: "Attach local files to an <input type=file> (ref, selector, or text of its label) without opening the OS file picker. Paths are resolved against the working directory. Fires the input's change event.",
		parameters: Type.Object({ ...TARGET_PARAMS, files: Type.Array(Type.String(), { description: "Local file paths" }) }),
		async execute(params, run) {
			if (!hasTarget(params)) throw new Error("Give the file input as ref, selector, or text.");
			if (params.files.length === 0) throw new Error("files must not be empty.");
			const files: string[] = [];
			for (const file of params.files) {
				const absolute = isAbsolute(file) ? file : resolvePath(run.ctx.cwd, file);
				const info = await stat(absolute).catch(() => undefined);
				if (!info?.isFile()) throw new Error(`File not found: ${absolute}`);
				files.push(absolute);
			}
			const session = await connector.currentSession({ focus: false, signal: run.signal });
			const mark = markState(session);
			const target = await resolveTarget(session, params);
			try {
				const { value: inputObject } = await session.callFunctionOn<string>(target.objectId, FIND_FILE_INPUT, [], { sessionId: target.sessionId });
				if (inputObject !== "ok") throw new Error(`${target.description} is not a file input and contains none.`);
				const input = await session.callFunctionOn(target.objectId, "function () { return this.matches('input[type=file]') ? this : this.querySelector('input[type=file]'); }", [], { returnByValue: false, sessionId: target.sessionId });
				const objectId = input.object.objectId as string;
				await session.send("DOM.setFileInputFiles", { files, objectId }, { sessionId: target.sessionId });
				await session.releaseObject(objectId, target.sessionId);
				await settle(session, mark);
				return { text: joinLines(`Attached ${files.length} file${files.length === 1 ? "" : "s"} to ${target.description}: ${files.join(", ")}`, describeDelta(session, mark)) };
			} finally {
				await session.releaseObject(target.objectId, target.sessionId);
			}
		},
	});

	registerChromeTool(pi, services, {
		name: "chrome_mouse",
		label: "Chrome mouse",
		description:
			"Low-level mouse control in viewport CSS pixels for gestures the other tools don't cover: move, down, up, wheel, and drag (from x,y to toX,toY in steps, with the button held). Use chrome_click for ordinary clicks.",
		parameters: Type.Object({
			action: StringEnum(["move", "down", "up", "wheel", "drag"] as const),
			x: Type.Number(),
			y: Type.Number(),
			toX: Type.Optional(Type.Number({ description: "drag destination" })),
			toY: Type.Optional(Type.Number()),
			steps: Type.Optional(Type.Integer({ description: "intermediate moves for drag (default 10)" })),
			button: Type.Optional(StringEnum(["left", "right", "middle"] as const)),
			deltaX: Type.Optional(Type.Number()),
			deltaY: Type.Optional(Type.Number()),
			modifiers: Type.Optional(Type.Array(StringEnum(["Alt", "Control", "Meta", "Shift"] as const))),
			focus: Type.Optional(Type.Boolean()),
		}),
		async execute(params, run) {
			const session = await connector.currentSession({ focus: params.focus, signal: run.signal });
			const mark = markState(session);
			const modifiers = (params.modifiers ?? []).reduce((bits, name) => bits | MODIFIER_BITS[name], 0);
			const button = params.button ?? "left";
			const base = { x: params.x, y: params.y, modifiers };
			switch (params.action) {
				case "move":
					await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...base });
					break;
				case "down":
					await session.send("Input.dispatchMouseEvent", { type: "mousePressed", button, clickCount: 1, ...base });
					break;
				case "up":
					await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", button, clickCount: 1, ...base });
					break;
				case "wheel":
					await wheel(session, base, params.deltaX ?? 0, params.deltaY ?? 0);
					break;
				case "drag": {
					if (params.toX === undefined || params.toY === undefined) throw new Error("drag needs toX and toY.");
					const steps = clampInt(params.steps, 10, 1, 100);
					await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...base });
					await session.send("Input.dispatchMouseEvent", { type: "mousePressed", button, clickCount: 1, ...base });
					for (let step = 1; step <= steps; step++) {
						const x = params.x + ((params.toX - params.x) * step) / steps;
						const y = params.y + ((params.toY - params.y) * step) / steps;
						await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button, modifiers });
						await sleep(16);
					}
					await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: params.toX, y: params.toY, button, clickCount: 1, modifiers });
					break;
				}
			}
			await settle(session, mark);
			return { text: joinLines(`Mouse ${params.action} at (${params.x}, ${params.y})${params.action === "drag" ? ` → (${params.toX}, ${params.toY})` : ""}.`, describeDelta(session, mark)) };
		},
	});
}

// --- element geometry -------------------------------------------------------------------------

export async function pointFor(session: TabSession, target: ResolvedTarget, options: { force?: boolean }): Promise<Point> {
	await session.send("DOM.scrollIntoViewIfNeeded", { objectId: target.objectId }, { sessionId: target.sessionId }).catch(() => {});
	let last: PointResult | undefined;
	for (let attempt = 0; attempt < 4; attempt++) {
		const { value } = await session.callFunctionOn<PointResult>(target.objectId, CLICK_POINT, [], { sessionId: target.sessionId });
		last = value;
		if (value.error) {
			if (attempt === 0) await session.callFunctionOn(target.objectId, "function () { this.scrollIntoView({ block: 'center', inline: 'center' }); }", [], { sessionId: target.sessionId }).catch(() => {});
			await sleep(100);
			continue;
		}
		if (!value.occluded || options.force) return { x: value.x, y: value.y };
		await sleep(150);
	}
	if (last?.error) throw new Error(`${target.description} (${target.label}) cannot be clicked: ${last.error}.`);
	throw new Error(`${target.description} (${target.label}) is covered by ${last?.blocker ?? "another element"}. Close or dismiss it first, scroll, or pass force:true to click through.`);
}

async function mouseClick(session: TabSession, point: Point, options: { button: "left" | "right" | "middle"; clickCount: number; modifiers: number; sessionId?: string }): Promise<void> {
	const send = { sessionId: options.sessionId };
	await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, modifiers: options.modifiers }, send);
	for (let count = 1; count <= options.clickCount; count++) {
		await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: options.button, clickCount: count, modifiers: options.modifiers }, send);
		await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: options.button, clickCount: count, modifiers: options.modifiers }, send);
	}
}

async function wheel(session: TabSession, point: Point, deltaX: number, deltaY: number, sessionId?: string): Promise<void> {
	await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, { sessionId });
	await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY }, { sessionId });
	await sleep(300);
}

/**
 * Wait for the page to settle after an action. A navigation the action triggered is awaited even
 * when it has only *started* (a form POST commits long after the click returns), so the action's
 * report names the page the user ends up on rather than the one they left.
 */
export async function settle(session: TabSession, mark: StateMark): Promise<void> {
	await sleep(SETTLE_MS);
	const started = session.navigationStarts !== mark.navigationStarts;
	const committed = session.navigationCount !== mark.navigationCount;
	if (started || committed || (!session.hasLoaded && !session.isClosed)) {
		await session.waitForLifecycle("load", NAVIGATION_WAIT_MS, { afterNavigation: committed || started ? mark.navigationCount : undefined }).catch(() => false);
	}
}

// --- keyboard -------------------------------------------------------------------------------

export async function pressChord(session: TabSession, chord: Chord, sessionId?: string): Promise<void> {
	const send = { sessionId };
	const held: KeyDescription[] = [];
	let modifiers = 0;
	for (const name of chord.modifierNames) {
		const key = describeKeyName(name);
		modifiers |= MODIFIER_BITS[name];
		await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers }, send);
		held.push(key);
	}
	const nonShift = modifiers & ~MODIFIER_BITS.Shift;
	const shifted = (modifiers & MODIFIER_BITS.Shift) !== 0 && /^[a-z]$/.test(chord.key.key);
	const keyName = shifted ? chord.key.key.toUpperCase() : chord.key.key;
	const text = nonShift === 0 ? (shifted ? keyName : chord.key.text) : undefined;
	const commands = process.platform === "darwin" ? macEditingCommands(chord) : undefined;
	await session.send(
		"Input.dispatchKeyEvent",
		{
			type: text ? "keyDown" : "rawKeyDown",
			key: keyName,
			code: chord.key.code,
			windowsVirtualKeyCode: chord.key.keyCode,
			modifiers: modifiers | chord.modifiers,
			text,
			unmodifiedText: text,
			commands,
		},
		send,
	);
	await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code: chord.key.code, windowsVirtualKeyCode: chord.key.keyCode, modifiers: modifiers | chord.modifiers }, send);
	for (const key of held.reverse()) {
		modifiers &= ~MODIFIER_BITS[key.key as keyof typeof MODIFIER_BITS];
		await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers }, send);
	}
}

function describeKeyName(name: "Alt" | "Control" | "Meta" | "Shift"): KeyDescription {
	const codes = { Alt: ["AltLeft", 18], Control: ["ControlLeft", 17], Meta: ["MetaLeft", 91], Shift: ["ShiftLeft", 16] } as const;
	const [code, keyCode] = codes[name];
	return { key: name, code, keyCode };
}

export async function typeText(session: TabSession, text: string, delayMs: number, sessionId?: string): Promise<void> {
	const send = { sessionId };
	for (const char of text) {
		if (char === "\n" || char === "\r") {
			await pressChord(session, parseChord("Enter"), sessionId);
		} else if (char === "\t") {
			await pressChord(session, parseChord("Tab"), sessionId);
		} else {
			const key = describeCharacter(char);
			const modifiers = needsShift(char) ? MODIFIER_BITS.Shift : 0;
			await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, text: char, unmodifiedText: char, modifiers }, send);
			await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers }, send);
		}
		if (delayMs) await sleep(delayMs);
	}
}

// --- fill -----------------------------------------------------------------------------------

async function focusTarget(session: TabSession, target: ResolvedTarget): Promise<void> {
	const { value: blocker } = await session.callFunctionOn<string | null>(target.objectId, NOT_INTERACTABLE_REASON, [], { sessionId: target.sessionId });
	if (blocker) throw new Error(`${target.description} (${target.label}) cannot take input: ${blocker}.`);
	await session.send("DOM.scrollIntoViewIfNeeded", { objectId: target.objectId }, { sessionId: target.sessionId }).catch(() => {});
	try {
		await session.send("DOM.focus", { objectId: target.objectId }, { sessionId: target.sessionId });
	} catch (error) {
		throw new Error(`${target.description} (${target.label}) cannot take input: Chrome refused to focus it (${(error as Error).message.replace(/^cdp: /, "")}). It may be disabled, hidden, or not a form control.`);
	}
}

interface ControlKind {
	kind: "text" | "contenteditable" | "select" | "checkbox" | "radio" | "native" | "file" | "button" | "delegate" | "unknown";
	type?: string;
	checked?: boolean;
	disabled?: boolean;
	readOnly?: boolean;
}

async function fillTarget(session: TabSession, target: ResolvedTarget, value: string): Promise<string> {
	const send = { sessionId: target.sessionId };
	const { value: kind } = await session.callFunctionOn<ControlKind>(target.objectId, CLASSIFY_CONTROL, [], send);
	switch (kind.kind) {
		case "delegate": {
			const inner = await session.callFunctionOn(target.objectId, "function () { return this.control || this.querySelector('input, textarea, select, [contenteditable=true], [contenteditable=\"\"]'); }", [], { returnByValue: false, ...send });
			const objectId = inner.object.objectId;
			if (!objectId) throw new Error(`${target.description} has no form control inside it.`);
			try {
				return await fillTarget(session, { ...target, objectId }, value);
			} finally {
				await session.releaseObject(objectId, target.sessionId);
			}
		}
		case "select":
			return `Selected ${await selectOptions(session, target, [value])} in`;
		case "checkbox":
		case "radio": {
			const wanted = value === "toggle" ? !kind.checked : ["true", "1", "on", "yes", "checked"].includes(value.toLowerCase());
			if (wanted === kind.checked) return `Left ${kind.kind} already ${kind.checked ? "checked" : "unchecked"}:`;
			const point = await pointFor(session, target, { force: true });
			await mouseClick(session, point, { button: "left", clickCount: 1, modifiers: 0, sessionId: target.sessionId });
			return `${wanted ? "Checked" : "Unchecked"}`;
		}
		case "native": {
			const { value: result } = await session.callFunctionOn<string>(target.objectId, SET_NATIVE_VALUE, [value], send);
			if (result !== value) throw new Error(`Set ${target.description} but its value is now ${JSON.stringify(result)}; ${kind.type} inputs need the native format (date: YYYY-MM-DD, time: HH:MM, month: YYYY-MM, color: #rrggbb).`);
			return "Set";
		}
		case "file":
			throw new Error(`${target.description} is a file input; use chrome_upload.`);
		case "button":
			throw new Error(`${target.description} is a button; use chrome_click.`);
		case "unknown":
			throw new Error(`${target.description} is not an editable control. Pass the input itself (chrome_find role=textbox) or use chrome_click then chrome_type.`);
		default:
			break;
	}
	if (kind.disabled) throw new Error(`${target.description} is disabled.`);
	if (kind.readOnly) throw new Error(`${target.description} is read-only.`);
	await focusTarget(session, target);
	await session.callFunctionOn(target.objectId, SELECT_ALL_CONTENT, [], send);
	if (value === "") {
		await pressChord(session, parseChord("Backspace"), target.sessionId);
		return "Cleared";
	}
	await session.send("Input.insertText", { text: value }, send);
	return "Filled";
}

async function selectOptions(session: TabSession, target: ResolvedTarget, values: string[]): Promise<string> {
	const { value: result } = await session.callFunctionOn<{ selected?: Array<{ value: string; label: string }>; missing?: string[]; available?: Array<{ value: string; label: string }>; error?: string }>(
		target.objectId,
		SELECT_OPTIONS,
		[values],
		{ sessionId: target.sessionId },
	);
	if (result.error) throw new Error(`${target.description}: ${result.error}`);
	if (result.missing?.length) {
		const available = (result.available ?? []).map((option) => `${JSON.stringify(option.label)} (value ${JSON.stringify(option.value)})`).join(", ");
		throw new Error(`No option matches ${result.missing.map((item) => JSON.stringify(item)).join(", ")} in ${target.description}. Available: ${available}`);
	}
	return (result.selected ?? []).map((option) => `${JSON.stringify(option.label)}${option.label !== option.value ? ` (value ${JSON.stringify(option.value)})` : ""}`).join(", ");
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

// --- in-page functions ----------------------------------------------------------------------

/** Why an element cannot receive input right now, or null. Shared by click, fill, type and press. */
const NOT_INTERACTABLE_REASON = `function () {
	const el = this;
	if (!(el instanceof Element)) return "it is not an element";
	if (!el.isConnected) return "it is no longer in the document";
	if (el.closest("[inert]")) return "it is inside an inert container (a collapsed drawer or a layer behind an open dialog); open that container first, or use a control that is currently shown";
	if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return "it is hidden (display: none, visibility: hidden, or content-visibility)";
	if (el.closest("[aria-hidden=true]")) return "it is inside an aria-hidden region (usually a closed menu or an inactive layer)";
	if ("disabled" in el && el.disabled) return "it is disabled";
	return null;
}`;

const CLICK_POINT = `function () {
	const el = this;
	const reason = (${NOT_INTERACTABLE_REASON}).call(el);
	if (reason) return { error: reason, x: 0, y: 0, occluded: false, width: 0, height: 0 };
	const rect = el.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) return { error: "it has no layout box (display:none or detached)", x: 0, y: 0, occluded: false, width: 0, height: 0 };
	const doc = el.ownerDocument;
	const win = doc.defaultView;
	const vw = win.innerWidth, vh = win.innerHeight;
	const left = Math.max(rect.left, 0), top = Math.max(rect.top, 0), right = Math.min(rect.right, vw), bottom = Math.min(rect.bottom, vh);
	if (right <= left || bottom <= top) return { error: "it is outside the viewport even after scrolling", x: 0, y: 0, occluded: false, width: rect.width, height: rect.height };
	let cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
	if (cx < left || cx > right) cx = (left + right) / 2;
	if (cy < top || cy > bottom) cy = (top + bottom) / 2;
	// elementFromPoint stops at a shadow host, so descend through open shadow roots to the element
	// a real click would land on; otherwise every web component looks like it occludes its own content.
	let hit = doc.elementFromPoint(cx, cy);
	while (hit && hit.shadowRoot) {
		const deeper = hit.shadowRoot.elementFromPoint(cx, cy);
		if (!deeper || deeper === hit) break;
		hit = deeper;
	}
	let occluded = false, blocker;
	if (hit && hit !== el) {
		let node = hit, inside = false;
		while (node) { if (node === el) { inside = true; break; } node = node.parentNode || node.host; }
		if (!inside && !hit.contains(el)) {
			occluded = true;
			const tag = hit.tagName.toLowerCase();
			const id = hit.id ? "#" + hit.id : "";
			const cls = (hit.getAttribute("class") || "").split(/\\s+/).filter(Boolean).slice(0, 2).map((c) => "." + c).join("");
			const text = (hit.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40);
			blocker = "<" + tag + id + cls + ">" + (text ? " \\"" + text + "\\"" : "");
		}
	}
	let ox = 0, oy = 0, w = win;
	while (w.frameElement) {
		const fr = w.frameElement.getBoundingClientRect();
		const cs = w.getComputedStyle ? w.parent.getComputedStyle(w.frameElement) : null;
		ox += fr.left + (cs ? parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) : 0);
		oy += fr.top + (cs ? parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) : 0);
		w = w.parent;
	}
	return { x: cx + ox, y: cy + oy, occluded, blocker, width: rect.width, height: rect.height };
}`;

const CLASSIFY_CONTROL = `function () {
	const el = this;
	const tag = el.tagName ? el.tagName.toLowerCase() : "";
	if (tag === "select") return { kind: "select" };
	if (tag === "input") {
		const type = (el.type || "text").toLowerCase();
		if (type === "checkbox" || type === "radio") return { kind: type, checked: el.checked };
		if (["date", "time", "datetime-local", "month", "week", "color", "range"].includes(type)) return { kind: "native", type };
		if (type === "file") return { kind: "file" };
		if (["button", "submit", "reset", "image"].includes(type)) return { kind: "button" };
		return { kind: "text", type, readOnly: el.readOnly, disabled: el.disabled };
	}
	if (tag === "textarea") return { kind: "text", type: "textarea", readOnly: el.readOnly, disabled: el.disabled };
	if (el.isContentEditable) return { kind: "contenteditable" };
	if (tag === "button" || tag === "a" || el.getAttribute("role") === "button") return { kind: "button" };
	if (el.querySelector && el.querySelector("input, textarea, select, [contenteditable=true], [contenteditable='']")) return { kind: "delegate" };
	if (tag === "label" && el.control) return { kind: "delegate" };
	return { kind: "unknown" };
}`;

const SELECT_ALL_CONTENT = `function () {
	const el = this;
	if (typeof el.select === "function" && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) { el.select(); return; }
	const range = el.ownerDocument.createRange();
	range.selectNodeContents(el);
	const selection = el.ownerDocument.getSelection();
	selection.removeAllRanges();
	selection.addRange(range);
}`;

const SET_NATIVE_VALUE = `function (value) {
	const proto = Object.getPrototypeOf(this);
	const descriptor = Object.getOwnPropertyDescriptor(proto, "value") || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
	this.focus();
	descriptor.set.call(this, value);
	this.dispatchEvent(new Event("input", { bubbles: true }));
	this.dispatchEvent(new Event("change", { bubbles: true }));
	return this.value;
}`;

const SELECT_OPTIONS = `function (wanted) {
	const el = this.tagName === "SELECT" ? this : (this.control && this.control.tagName === "SELECT" ? this.control : this.querySelector && this.querySelector("select"));
	if (!el) return { error: "not a <select> element" };
	const options = Array.from(el.options);
	const chosen = [], missing = [];
	for (const w of wanted) {
		const lower = String(w).toLowerCase();
		const option = options.find((o) => o.value === w) || options.find((o) => o.label.trim().toLowerCase() === lower) || options.find((o) => o.label.toLowerCase().includes(lower));
		if (option) chosen.push(option); else missing.push(w);
	}
	if (missing.length) return { missing, available: options.map((o) => ({ value: o.value, label: o.label })) };
	if (!el.multiple && chosen.length > 1) return { error: "several values given but the select is single-choice" };
	if (el.multiple) { for (const o of options) o.selected = chosen.includes(o); }
	else { const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; setter.call(el, chosen[0].value); }
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	return { selected: chosen.map((o) => ({ value: o.value, label: o.label })) };
}`;

const FIND_FILE_INPUT = `function () {
	if (this.matches && this.matches("input[type=file]")) return "ok";
	if (this.querySelector && this.querySelector("input[type=file]")) return "ok";
	if (this.control && this.control.type === "file") return "ok";
	return "no";
}`;

const SCROLL_CONTAINER_TO = `function (where) {
	if (where === "top") this.scrollTop = 0; else this.scrollTop = this.scrollHeight;
	return "scrollTop " + Math.round(this.scrollTop) + " of " + Math.round(this.scrollHeight - this.clientHeight);
}`;

const DESCRIBE_SCROLL = `function () {
	const scrollable = (el) => { const cs = getComputedStyle(el); return /(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth); };
	let el = this;
	while (el && el !== document.documentElement && !scrollable(el)) el = el.parentElement;
	if (!el) el = document.scrollingElement || document.documentElement;
	const describe = (node) => node === document.scrollingElement || node === document.documentElement ? "the page" : "<" + node.tagName.toLowerCase() + (node.id ? "#" + node.id : "") + ((node.getAttribute("class") || "").split(/\\s+/).filter(Boolean).slice(0, 2).map((c) => "." + c).join("")) + ">";
	return { self: el === this, container: describe(el), position: "scrollTop " + Math.round(el.scrollTop) + " of " + Math.round(el.scrollHeight - el.clientHeight) + ", scrollLeft " + Math.round(el.scrollLeft) };
}`;

const SCROLL_PAGE_TO = `function (where) {
	window.scrollTo({ top: where === "top" ? 0 : document.documentElement.scrollHeight, left: 0, behavior: "instant" });
	return "scrollY " + Math.round(window.scrollY) + " of " + Math.round(document.documentElement.scrollHeight - window.innerHeight);
}`;

const DESCRIBE_PAGE_SCROLL = `function () {
	return "scrollY " + Math.round(window.scrollY) + " of " + Math.round(document.documentElement.scrollHeight - window.innerHeight) + ", scrollX " + Math.round(window.scrollX);
}`;
