// Accessibility-tree snapshots with stable refs. The model reads the page as an indented list of
// roles and names ("- button \"Save\" [e12]") and acts on refs; refs map to backendNodeIds.

import type { Protocol } from "devtools-protocol";
import type { TabSession } from "./session.ts";

export type SnapshotMode = "interactive" | "full";

export interface SnapshotOptions {
	mode: SnapshotMode;
	/** Limit to the subtree of this DOM node. */
	scopeBackendNodeId?: number;
	maxChars: number;
	/** Same-process frame to snapshot (main session). */
	frameId?: string;
	/** Out-of-process frame session. */
	sessionId?: string;
	/** Omit [offscreen] nodes entirely. */
	visibleOnly?: boolean;
}

export interface SnapshotNode {
	id: string;
	role: string;
	name: string;
	value?: string;
	description?: string;
	backendNodeId?: number;
	props: Map<string, unknown>;
	children: SnapshotNode[];
	interactive: boolean;
	clickable: boolean;
	offscreen: boolean;
	hidden: boolean;
	/** Nearest heading or landmark above this node, for chrome_find context. */
	context?: string;
	ref?: string;
	depth: number;
}

export interface SnapshotResult {
	text: string;
	lines: number;
	refs: number;
	truncated: boolean;
	nodes: SnapshotNode[];
}

const INTERACTIVE_ROLES = new Set([
	"button", "link", "textbox", "searchbox", "combobox", "listbox", "option", "checkbox", "radio", "switch", "slider",
	"spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "treeitem", "menubar", "menu", "scrollbar",
	"ColorWell", "DateTime", "InputTime", "textfield", "progressbar", "meter", "toggle", "DisclosureTriangle", "PopUpButton",
]);
const CONTEXT_ROLES = new Set([
	"heading", "navigation", "main", "banner", "contentinfo", "form", "region", "search", "complementary", "dialog", "alertdialog",
	"alert", "status", "log", "tablist", "tabpanel", "table", "grid", "treegrid", "list", "tree", "toolbar", "article", "section",
	"figure", "img", "image", "group", "radiogroup", "row", "rowgroup", "columnheader", "rowheader", "cell", "gridcell", "listitem",
	"term", "definition", "blockquote", "code", "caption", "Iframe", "iframe", "Video", "Audio", "canvas", "math", "note", "marquee", "timer",
]);
const SKIP_ROLES = new Set(["InlineTextBox", "LineBreak", "none", "presentation", "RootWebArea", "WebArea", "Ignored"]);
/** Native controls whose AX children are implementation details (date segments, inner editable divs). */
const LEAF_ROLES = new Set(["textbox", "searchbox", "spinbutton", "slider", "Date", "DateTime", "InputTime", "ColorWell", "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option", "progressbar", "meter", "img", "image"]);
/** Shown only in full mode; their text already names the control they label. */
const NOISE_ROLES = new Set(["LabelText"]);
const TEXT_ROLES = new Set(["StaticText", "paragraph", "text"]);
const BOOL_PROPS = ["disabled", "expanded", "selected", "pressed", "required", "invalid", "readonly", "focused", "multiline", "modal", "busy"] as const;

export async function buildSnapshot(session: TabSession, options: SnapshotOptions): Promise<SnapshotResult> {
	const send = { sessionId: options.sessionId, timeoutMs: 30_000 };
	const [axTree, domSnapshot, metrics] = await Promise.all([
		session.send("Accessibility.getFullAXTree", { frameId: options.frameId }, send),
		session.send("DOMSnapshot.captureSnapshot", { computedStyles: [], includeDOMRects: true }, send).catch(() => undefined),
		session.send("Page.getLayoutMetrics", undefined, send).catch(() => undefined),
	]);
	const layout = indexLayout(domSnapshot, metrics);
	const byId = new Map<string, Protocol.Accessibility.AXNode>();
	for (const node of axTree.nodes) byId.set(node.nodeId, node);
	const root = axTree.nodes.find((node) => !node.parentId) ?? axTree.nodes[0];
	if (!root) return { text: "(empty accessibility tree)", lines: 0, refs: 0, truncated: false, nodes: [] };

	// Build a pruned tree: ignored nodes and skip-roles hoist their children, unless they carry a
	// click handler (a "clickable div"), in which case they surface as a generic clickable node.
	let lastHeading: string | undefined;
	const build = (axNode: Protocol.Accessibility.AXNode, depth: number, context: string | undefined): SnapshotNode[] => {
		let role = axNode.role?.value ? String(axNode.role.value) : "generic";
		const children: SnapshotNode[] = [];
		const collect = (nextDepth: number, nextContext: string | undefined) => {
			for (const childId of axNode.childIds ?? []) {
				const child = byId.get(childId);
				if (child) children.push(...build(child, nextDepth, nextContext));
			}
		};
		const backendNodeId = axNode.backendDOMNodeId;
		const geometry = backendNodeId !== undefined ? layout.get(backendNodeId) : undefined;
		if (axNode.ignored || SKIP_ROLES.has(role)) {
			if (!geometry?.clickable || backendNodeId === undefined || role === "RootWebArea" || role === "InlineTextBox") {
				collect(depth, context);
				return children;
			}
			role = "generic";
		}
		const props = new Map<string, unknown>();
		for (const property of axNode.properties ?? []) props.set(property.name, property.value.value);
		const editable = props.get("editable");
		if (role === "generic" && (editable === "richtext" || editable === "plaintext")) role = "editable";
		let name = axNode.name?.value !== undefined ? String(axNode.name.value).replace(/\s+/g, " ").trim() : "";
		const value = axNode.value?.value !== undefined && axNode.value.value !== "" ? String(axNode.value.value) : undefined;
		if (role === "heading" && name) lastHeading = `heading "${name}"`;
		const node: SnapshotNode = {
			id: axNode.nodeId,
			role,
			name,
			value,
			description: axNode.description?.value !== undefined ? String(axNode.description.value) : undefined,
			backendNodeId,
			props,
			children,
			interactive: INTERACTIVE_ROLES.has(role) || props.get("focusable") === true || props.get("editable") === "richtext" || props.get("editable") === "plaintext",
			clickable: geometry?.clickable === true,
			offscreen: geometry?.offscreen === true,
			hidden: props.get("hidden") === true,
			context: context ?? lastHeading,
			depth,
		};
		const ownContext = role !== "heading" && CONTEXT_ROLES.has(role) && name ? `${role} "${name}"` : context;
		if (!LEAF_ROLES.has(role)) collect(depth + 1, ownContext);
		// A nameless generic that is clickable only because of a listener and holds actionable children
		// (a <label> around a checkbox, <body> or the app root with a global click handler) is a
		// container; the children carry the actions. Whether Chrome exposed it or ignored it is irrelevant.
		if (role === "generic" && !name && node.clickable && !node.interactive && hasInteractiveDescendant(children)) return children;
		// A nameless, empty, non-interactive generic (an icon-less click anchor) has nothing to act on.
		if (role === "generic" && !name && children.length === 0 && !node.interactive) return [];
		if (!name && (node.clickable || node.interactive || NOISE_ROLES.has(role))) {
			name = textOf(children, 60);
			node.name = name;
		}
		return [node];
	};
	let forest = build(root, 0, undefined);

	if (options.scopeBackendNodeId !== undefined) {
		const scoped = findByBackendNodeId(forest, options.scopeBackendNodeId);
		if (!scoped) throw new Error("The scope element is not in the accessibility tree (it may be hidden or presentational).");
		forest = [scoped];
	}

	const lines: string[] = [];
	let chars = 0;
	let truncated = false;
	let omitted = 0;
	let refs = 0;
	const all: SnapshotNode[] = [];
	let lastTextLine = "";
	// Descriptions repeated across many nodes (drag-and-drop instructions on every row) become footnotes.
	const footnotes = collectRepeatedDescriptions(forest);

	const emit = (node: SnapshotNode, indent: number): void => {
		all.push(node);
		const include = shouldEmit(node, options.mode) && !(options.visibleOnly && node.offscreen);
		let childIndent = indent;
		if (include) {
			if (node.backendNodeId !== undefined && !TEXT_ROLES.has(node.role)) {
				node.ref = session.refs.assign({ backendNodeId: node.backendNodeId, sessionId: options.sessionId, frameId: options.frameId, role: node.role, name: node.name }).ref;
				refs += 1;
			}
			const line = `${"  ".repeat(indent)}${formatNode(node, footnotes)}`;
			const isText = TEXT_ROLES.has(node.role);
			if (!(isText && line.trim() === lastTextLine)) {
				if (truncated) {
					omitted += 1;
				} else if (chars + line.length + 1 > options.maxChars) {
					truncated = true;
					omitted += 1;
				} else {
					lines.push(line);
					chars += line.length + 1;
				}
			}
			lastTextLine = isText ? line.trim() : "";
			childIndent = indent + 1;
		}
		for (const child of node.children) emit(child, childIndent);
	};
	for (const node of forest) emit(node, 0);

	if (truncated) lines.push(`… ${omitted} more line${omitted === 1 ? "" : "s"} omitted (${options.maxChars} char limit). Scope with selector/ref, use mode "interactive", or raise maxChars.`);
	const used = [...footnotes.entries()].filter(([description]) => lines.some((line) => line.includes(`desc=[${footnotes.get(description)}]`)));
	for (const [description, index] of used) lines.push(`[${index}] ${description}`);
	return { text: lines.join("\n"), lines: lines.length, refs, truncated, nodes: all };
}

function hasInteractiveDescendant(nodes: SnapshotNode[]): boolean {
	return nodes.some((node) => node.interactive || hasInteractiveDescendant(node.children));
}

const FOOTNOTE_MIN_REPEATS = 3;

function collectRepeatedDescriptions(forest: SnapshotNode[]): Map<string, number> {
	const counts = new Map<string, number>();
	const walk = (nodes: SnapshotNode[]) => {
		for (const node of nodes) {
			if (node.description && node.description !== node.name) counts.set(node.description, (counts.get(node.description) ?? 0) + 1);
			walk(node.children);
		}
	};
	walk(forest);
	const footnotes = new Map<string, number>();
	for (const [description, count] of counts) if (count >= FOOTNOTE_MIN_REPEATS) footnotes.set(description, footnotes.size + 1);
	return footnotes;
}

function textOf(nodes: SnapshotNode[], max: number): string {
	const parts: string[] = [];
	const walk = (list: SnapshotNode[]) => {
		for (const node of list) {
			if (TEXT_ROLES.has(node.role) && node.name) parts.push(node.name);
			else if (node.name && !node.interactive) parts.push(node.name);
			else walk(node.children);
			if (parts.join(" ").length > max) return;
		}
	};
	walk(nodes);
	const text = parts.join(" ").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function shouldEmit(node: SnapshotNode, mode: SnapshotMode): boolean {
	if (node.hidden) return false;
	if (mode === "interactive" && NOISE_ROLES.has(node.role)) return false;
	if (mode === "full") {
		if (node.role === "generic" || node.role === "none") return node.clickable || Boolean(node.name);
		if (TEXT_ROLES.has(node.role)) return Boolean(node.name);
		return true;
	}
	if (node.interactive || node.clickable) return true;
	if (node.role === "heading") return true;
	if (CONTEXT_ROLES.has(node.role) && (node.name || ["dialog", "alertdialog", "alert", "navigation", "main", "form", "table", "grid", "tablist", "menu", "listbox", "tree"].includes(node.role))) return true;
	return false;
}

export function formatNode(node: SnapshotNode, footnotes: Map<string, number> = new Map()): string {
	if (TEXT_ROLES.has(node.role)) return `- text: ${quote(node.name, 200)}`;
	const parts = [`- ${node.role}`];
	if (node.name) parts.push(quote(node.name, 120));
	if (node.ref) parts.push(`[${node.ref}]`);
	if (node.value !== undefined && node.value !== node.name) parts.push(`value=${quote(node.value, 80)}`);
	const checked = node.props.get("checked");
	if (checked !== undefined) parts.push(checked === true || checked === "true" ? "checked" : checked === "mixed" ? "mixed" : "unchecked");
	for (const prop of BOOL_PROPS) {
		const value = node.props.get(prop);
		if (value === true || value === "true") parts.push(prop);
		else if (prop === "expanded" && (value === false || value === "false")) parts.push("collapsed");
	}
	const level = node.props.get("level");
	if (level !== undefined) parts.push(`level=${level}`);
	const url = node.props.get("url");
	if (typeof url === "string" && url && node.role === "link") parts.push(`href=${quote(url, 80)}`);
	const hasPopup = node.props.get("hasPopup");
	if (hasPopup && hasPopup !== "false") parts.push(`haspopup=${hasPopup}`);
	const autocomplete = node.props.get("autocomplete");
	if (autocomplete && autocomplete !== "none") parts.push(`autocomplete=${autocomplete}`);
	if (node.description && node.description !== node.name) {
		const footnote = footnotes.get(node.description);
		parts.push(footnote !== undefined ? `desc=[${footnote}]` : `desc=${quote(node.description, 80)}`);
	}
	if (node.clickable && !node.interactive) parts.push("[clickable]");
	if (node.offscreen) parts.push("[offscreen]");
	return parts.join(" ");
}

export function quote(text: string, max: number): string {
	const clipped = text.length > max ? `${text.slice(0, max - 1)}…` : text;
	return JSON.stringify(clipped);
}

function findByBackendNodeId(nodes: SnapshotNode[], backendNodeId: number): SnapshotNode | undefined {
	for (const node of nodes) {
		if (node.backendNodeId === backendNodeId) return node;
		const found = findByBackendNodeId(node.children, backendNodeId);
		if (found) return found;
	}
	return undefined;
}

interface Geometry {
	offscreen: boolean;
	clickable: boolean;
}

function indexLayout(snapshot: Protocol.DOMSnapshot.CaptureSnapshotResponse | undefined, metrics: Protocol.Page.GetLayoutMetricsResponse | undefined): Map<number, Geometry> {
	const map = new Map<number, Geometry>();
	if (!snapshot) return map;
	const viewport = metrics?.cssVisualViewport;
	// DOMSnapshot reports layout in device pixels (2x on Retina); the deprecated contentSize is in
	// the same units as the css one is in CSS pixels, so their ratio is the scale to undo.
	const scale = metrics && metrics.cssContentSize.height > 0 ? metrics.contentSize.height / metrics.cssContentSize.height : 1;
	for (const document of snapshot.documents) {
		const backendIds = document.nodes.backendNodeId ?? [];
		const clickableIndexes = new Set(document.nodes.isClickable?.index ?? []);
		const scrollX = (document.scrollOffsetX ?? 0) / scale;
		const scrollY = (document.scrollOffsetY ?? 0) / scale;
		const layoutByNode = new Map<number, Protocol.DOMSnapshot.Rectangle>();
		document.layout.nodeIndex.forEach((nodeIndex, layoutIndex) => {
			const bounds = document.layout.bounds[layoutIndex];
			if (bounds && !layoutByNode.has(nodeIndex)) layoutByNode.set(nodeIndex, bounds);
		});
		backendIds.forEach((backendNodeId, nodeIndex) => {
			const bounds = layoutByNode.get(nodeIndex);
			let offscreen = false;
			if (bounds && viewport) {
				const [x, y, width, height] = (bounds as [number, number, number, number]).map((value) => value / scale) as [number, number, number, number];
				// Bounds are document-absolute; the viewport is scrolled by scrollX/scrollY.
				const left = x - scrollX;
				const top = y - scrollY;
				offscreen = width > 0 && height > 0 && (left + width <= 0 || top + height <= 0 || left >= viewport.clientWidth || top >= viewport.clientHeight);
			}
			map.set(backendNodeId, { offscreen, clickable: clickableIndexes.has(nodeIndex) });
		});
	}
	return map;
}

export interface FindOptions {
	text?: string;
	role?: string;
	selector?: string;
	limit: number;
	frameId?: string;
	sessionId?: string;
}

export interface FindMatch {
	ref?: string;
	line: string;
	context?: string;
}

/** Search the accessibility tree (or the DOM by selector) and hand back refs. */
export async function findElements(session: TabSession, options: FindOptions): Promise<FindMatch[]> {
	if (options.selector) return findBySelector(session, options);
	const snapshot = await buildSnapshot(session, { mode: "full", maxChars: 1, frameId: options.frameId, sessionId: options.sessionId });
	const text = options.text?.toLowerCase().replace(/\s+/g, " ").trim();
	const role = options.role?.toLowerCase();
	const matches: FindMatch[] = [];
	for (const node of snapshot.nodes) {
		if (node.hidden) continue;
		if (role && node.role.toLowerCase() !== role) continue;
		if (text) {
			const haystack = `${node.name} ${node.value ?? ""} ${node.description ?? ""}`.toLowerCase().replace(/\s+/g, " ");
			if (!haystack.includes(text)) continue;
			// Prefer the element itself over text-only descendants that repeat the name.
			if (TEXT_ROLES.has(node.role) && matches.some((match) => match.line.includes(quote(node.name, 120)))) continue;
		}
		if (!text && !role) continue;
		if (node.backendNodeId !== undefined && !TEXT_ROLES.has(node.role)) {
			node.ref = session.refs.assign({ backendNodeId: node.backendNodeId, sessionId: options.sessionId, frameId: options.frameId, role: node.role, name: node.name }).ref;
		}
		matches.push({ ref: node.ref, line: formatNode(node), context: node.context });
		if (matches.length >= options.limit) break;
	}
	return matches;
}

async function findBySelector(session: TabSession, options: FindOptions): Promise<FindMatch[]> {
	const send = { sessionId: options.sessionId };
	const scope = options.frameId && !options.sessionId ? session.contextFor(options.frameId) : undefined;
	const list = await session.evaluateHandle(`Array.from(document.querySelectorAll(${JSON.stringify(options.selector)})).slice(0, ${options.limit})`, { contextId: scope?.id, sessionId: options.sessionId });
	if (!list.objectId) return [];
	try {
		const { result } = await session.send("Runtime.getProperties", { objectId: list.objectId, ownProperties: true }, send);
		const matches: FindMatch[] = [];
		for (const property of result) {
			if (!/^\d+$/.test(property.name) || !property.value?.objectId) continue;
			const described = await session.send("DOM.describeNode", { objectId: property.value.objectId }, send);
			const { value: line } = await session.callFunctionOn<string>(property.value.objectId, DESCRIBE_FOR_FIND, [], { sessionId: options.sessionId });
			const ref = session.refs.assign({ backendNodeId: described.node.backendNodeId, sessionId: options.sessionId, frameId: options.frameId, role: described.node.localName }).ref;
			matches.push({ ref, line: `- ${line} [${ref}]` });
			await session.releaseObject(property.value.objectId, options.sessionId);
		}
		return matches;
	} finally {
		await session.releaseObject(list.objectId, options.sessionId);
	}
}

const DESCRIBE_FOR_FIND = `function () {
	const el = this;
	const tag = el.tagName.toLowerCase();
	const bits = [tag];
	if (el.id) bits.push("#" + el.id);
	const role = el.getAttribute("role"); if (role) bits.push("role=" + role);
	const type = el.getAttribute("type"); if (type) bits.push("type=" + type);
	const text = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").replace(/\\s+/g, " ").trim().slice(0, 60);
	if (text) bits.push(JSON.stringify(text));
	const r = el.getBoundingClientRect();
	if (r.width === 0 && r.height === 0) bits.push("[no box]");
	return bits.join(" ");
}`;
