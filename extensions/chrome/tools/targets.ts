// Resolve what the model points at (a snapshot ref, a CSS selector, or visible text) to a live
// DOM object the CDP commands can act on.

import type { TabSession } from "../cdp/session.ts";

export interface TargetSpec {
	ref?: string;
	selector?: string;
	text?: string;
	/** Iframe id, name or URL substring for selector/text lookups. */
	frame?: string;
}

export interface ResolvedTarget {
	objectId: string;
	sessionId?: string;
	backendNodeId?: number;
	/** Short human description like `<button id="save">Save</button>`. */
	description: string;
	/** How the target was specified, for messages. */
	label: string;
}

export function hasTarget(spec: TargetSpec): boolean {
	return Boolean(spec.ref || spec.selector || spec.text);
}

export async function resolveTarget(session: TabSession, spec: TargetSpec): Promise<ResolvedTarget> {
	if (spec.ref) return resolveRef(session, spec.ref);
	if (spec.selector) return resolveSelector(session, spec.selector, spec.frame);
	if (spec.text) return resolveText(session, spec.text, spec.frame);
	throw new Error("Specify the element with ref (from chrome_snapshot/chrome_find), selector (CSS), or text (visible text).");
}

export async function resolveRef(session: TabSession, ref: string): Promise<ResolvedTarget> {
	const target = session.refs.get(ref);
	if (!target) {
		throw new Error(
			session.refs.size === 0
				? `Unknown ref "${ref}": no snapshot refs exist for this page (refs reset on navigation). Run chrome_snapshot or chrome_find first.`
				: `Unknown ref "${ref}". Run chrome_snapshot or chrome_find to get current refs.`,
		);
	}
	let objectId: string | undefined;
	try {
		const resolved = await session.send("DOM.resolveNode", { backendNodeId: target.backendNodeId }, { sessionId: target.sessionId });
		objectId = resolved.object.objectId;
		if (!objectId) throw new Error("no objectId");
		// A node a framework has replaced can still be resolved (something holds a reference to it)
		// but is no longer in the document. Acting on it would silently do nothing.
		const { value: connected } = await session.callFunctionOn<boolean>(objectId, "function () { return this.isConnected; }", [], { sessionId: target.sessionId });
		if (!connected) throw new Error("detached from the document");
		const description = await describeObject(session, objectId, target.sessionId);
		return { objectId, sessionId: target.sessionId, backendNodeId: target.backendNodeId, description, label: `ref ${target.ref}` };
	} catch (error) {
		if (objectId) await session.releaseObject(objectId, target.sessionId);
		session.refs.forget(target.ref);
		throw new Error(`Ref ${target.ref} (${target.role ?? "element"}${target.name ? ` "${target.name}"` : ""}) is no longer in the DOM; it was removed or re-rendered. Take a new chrome_snapshot. (${(error as Error).message})`);
	}
}

export async function resolveSelector(session: TabSession, selector: string, frame?: string): Promise<ResolvedTarget> {
	const scope = frameScope(session, frame);
	const handle = await session.evaluateHandle(`(${QUERY_DEEP})(${JSON.stringify(selector)})`, scope);
	if (!handle.objectId || handle.subtype === "null" || handle.type !== "object") {
		throw new Error(`No element matches selector ${JSON.stringify(selector)}${frame ? ` in frame ${frame}` : ""}.`);
	}
	const description = await describeObject(session, handle.objectId, scope.sessionId);
	return { objectId: handle.objectId, sessionId: scope.sessionId, description, label: `selector ${selector}` };
}

export async function resolveText(session: TabSession, text: string, frame?: string): Promise<ResolvedTarget> {
	const scope = frameScope(session, frame);
	const handle = await session.evaluateHandle(`(${FIND_BY_TEXT})(${JSON.stringify(text)})`, scope);
	if (!handle.objectId || handle.subtype === "null" || handle.type !== "object") {
		throw new Error(`No visible element contains the text ${JSON.stringify(text)}${frame ? ` in frame ${frame}` : ""}. Try chrome_find or a snapshot ref.`);
	}
	const description = await describeObject(session, handle.objectId, scope.sessionId);
	return { objectId: handle.objectId, sessionId: scope.sessionId, description, label: `text "${text}"` };
}

export function frameScope(session: TabSession, frame: string | undefined): { contextId?: number; sessionId?: string } {
	if (!frame) return {};
	const info = session.findFrame(frame);
	if (!info) throw new Error(`No frame matches "${frame}". Run chrome_frames to list them.`);
	if (info.sessionId) return { sessionId: info.sessionId };
	const context = session.contextFor(info.id);
	if (!context) throw new Error(`Frame ${info.id} (${info.url}) has no execution context yet; wait for it to load.`);
	return { contextId: context.id };
}

export async function describeObject(session: TabSession, objectId: string, sessionId?: string): Promise<string> {
	try {
		const { value } = await session.callFunctionOn<string>(objectId, DESCRIBE_ELEMENT, [], { sessionId });
		return value;
	} catch {
		return "<element>";
	}
}

export async function backendNodeIdOf(session: TabSession, objectId: string, sessionId?: string): Promise<number | undefined> {
	try {
		const described = await session.send("DOM.describeNode", { objectId }, { sessionId });
		return described.node.backendNodeId;
	} catch {
		return undefined;
	}
}

// --- in-page helpers (kept as source strings; they run inside the page) ----------------------

/** querySelector that also descends into open shadow roots and supports `>>` to hop across them. */
const QUERY_DEEP = `function (selector) {
	const hops = selector.split(">>").map((part) => part.trim()).filter(Boolean);
	const queryIn = (root, sel) => {
		const direct = root.querySelector(sel);
		if (direct) return direct;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
		for (let el = walker.currentNode; el; el = walker.nextNode()) {
			if (el.shadowRoot) {
				const found = queryIn(el.shadowRoot, sel);
				if (found) return found;
			}
		}
		return null;
	};
	let root = document;
	let found = null;
	for (const hop of hops) {
		found = queryIn(root, hop);
		if (!found) return null;
		root = found.shadowRoot || found;
	}
	return found;
}`;

/** Smallest visible element whose text contains the query; prefers an interactive ancestor when the text sits inside one. */
const FIND_BY_TEXT = `function (query) {
	const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
	const wanted = norm(query);
	if (!wanted) return null;
	const visible = (el) => {
		if (!(el instanceof Element)) return false;
		const style = getComputedStyle(el);
		if (style.visibility === "hidden" || style.display === "none") return false;
		return el.getClientRects().length > 0;
	};
	const interactive = (el) => el.closest("button, a[href], [role=button], [role=link], [role=menuitem], [role=tab], [role=option], label, summary, input, select, textarea, [contenteditable=true]");
	let best = null;
	let bestLength = Infinity;
	const consider = (el, text) => {
		if (!el || !visible(el)) return;
		const t = norm(text);
		if (!t.includes(wanted)) return;
		if (t.length < bestLength) { best = el; bestLength = t.length; }
	};
	const walkText = (root) => {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
		for (let node = walker.currentNode; node; node = walker.nextNode()) {
			if (node.nodeType === Node.TEXT_NODE) {
				consider(node.parentElement, node.nodeValue);
			} else if (node instanceof Element) {
				if (node.shadowRoot) walkText(node.shadowRoot);
				if (node instanceof HTMLInputElement && (node.type === "button" || node.type === "submit" || node.type === "reset")) consider(node, node.value);
				const label = node.getAttribute("aria-label") || node.getAttribute("title") || node.getAttribute("placeholder");
				if (label) consider(node, label);
			}
		}
	};
	walkText(document.body || document.documentElement);
	if (!best) {
		// Text split across inline elements: fall back to innerText of small elements.
		const all = document.querySelectorAll("button, a, [role=button], label, li, td, th, span, div, p, h1, h2, h3, h4, h5, h6");
		for (const el of all) {
			if (el.children.length > 8) continue;
			consider(el, el.innerText);
		}
	}
	if (!best) return null;
	const container = interactive(best);
	return container && container !== best && norm(container.innerText || container.value).length <= bestLength + 40 ? container : best;
}`;

const DESCRIBE_ELEMENT = `function () {
	const el = this;
	if (!(el instanceof Element)) return String(el && el.nodeName || el);
	const tag = el.tagName.toLowerCase();
	const attrs = [];
	if (el.id) attrs.push('id="' + el.id + '"');
	const cls = (el.getAttribute("class") || "").split(/\\s+/).filter(Boolean).slice(0, 2).join(" ");
	if (cls) attrs.push('class="' + cls + '"');
	for (const name of ["name", "type", "role", "aria-label", "href", "placeholder", "value"]) {
		const value = el.getAttribute(name);
		if (value !== null && value !== "" && !(name === "value" && el.type === "password")) attrs.push(name + '="' + value.slice(0, 40) + '"');
	}
	const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40);
	return "<" + tag + (attrs.length ? " " + attrs.join(" ") : "") + ">" + text + (text ? "</" + tag + ">" : "");
}`;
