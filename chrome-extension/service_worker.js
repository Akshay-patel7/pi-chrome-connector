// pi-chrome-connector companion.
//
// This service worker is a thin proxy between pi's local bridge (a WebSocket server on
// 127.0.0.1) and Chrome's extension APIs: chrome.tabs, chrome.windows and chrome.debugger
// (Chrome DevTools Protocol). It contains no automation logic; everything interesting lives
// in the pi package, so this file rarely needs a reload after package updates.
//
// Wire protocol (mirrors extensions/chrome/bridge/protocol.ts):
//   pi -> extension:  { id, method, params? }
//   extension -> pi:  { id, result } | { id, error: { message } } | { event, ...payload }

const PORT_RANGE = [17417, 17426]; // inclusive. The integration harness rewrites this line.
const HOST = "127.0.0.1";
const BRIDGE_NAME = "pi-chrome-connector";
const PROTOCOL_VERSION = 1;
const CDP_VERSION = "1.3";
const PROBE_TIMEOUT_MS = 1500;
const PROBE_BACKOFF_MS = [2000, 4000, 8000, 15000];
const ALARM_NAME = "pi-chrome-connector-reconnect";

/**
 * @typedef {{ socket?: WebSocket, probing: boolean, failures: number, nextAttemptAt: number }} PortState
 * @type {Map<number, PortState>} port -> connection state
 */
const ports = new Map();
/**
 * tabId -> port -> how many attach calls that port holds. One pi process can open several sessions
 * on the same tab (nested tools); the shared chrome.debugger attachment must outlive all of them.
 * @type {Map<number, Map<number, number>>}
 */
const attachments = new Map();
/** @type {ReturnType<typeof setTimeout> | undefined} */
let ensureTimer;
/** Reason the last bridge closed our socket, when it gave one (protocol mismatch, shutdown). */
let lastCloseReason = "";

// ---------------------------------------------------------------------------------------
// Connections
//
// Each pi session runs its own bridge on the first free port of PORT_RANGE, so most ports have
// nothing behind them most of the time. A WebSocket attempt to a dead port is recorded as a
// runtime error on chrome://extensions; a failed fetch() is not. So every port is probed with a
// fetch of the bridge's /status first, and the WebSocket is opened only to ports that answer.

function portState(port) {
	let state = ports.get(port);
	if (!state) {
		state = { probing: false, failures: 0, nextAttemptAt: 0 };
		ports.set(port, state);
	}
	return state;
}

/** Probe every unconnected port that is due, then sleep until the next one is due. */
function ensureConnections() {
	clearTimeout(ensureTimer);
	ensureTimer = undefined;
	const now = Date.now();
	let nextDue = Infinity;
	for (let port = PORT_RANGE[0]; port <= PORT_RANGE[1]; port++) {
		const state = portState(port);
		if (state.socket || state.probing) continue;
		if (state.nextAttemptAt > now) {
			nextDue = Math.min(nextDue, state.nextAttemptAt);
			continue;
		}
		void probe(port, state);
	}
	if (nextDue < Infinity) ensureTimer = setTimeout(ensureConnections, Math.max(100, nextDue - now));
}

async function probe(port, state) {
	state.probing = true;
	let live = false;
	try {
		const response = await fetch(`http://${HOST}:${port}/status`, { cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		const info = await response.json();
		live = Boolean(info) && info.name === BRIDGE_NAME;
	} catch {
		live = false;
	}
	state.probing = false;
	if (live) connect(port, state);
	else defer(state);
	ensureConnections();
}

/** Back off on this port: 2 s after the first miss, then 4, 8, and 15 s between later probes. */
function defer(state) {
	state.failures += 1;
	state.nextAttemptAt = Date.now() + PROBE_BACKOFF_MS[Math.min(state.failures, PROBE_BACKOFF_MS.length) - 1];
}

function connect(port, state) {
	let socket;
	try {
		socket = new WebSocket(`ws://${HOST}:${port}/extension`);
	} catch (error) {
		defer(state);
		return;
	}
	state.socket = socket;
	socket.addEventListener("open", () => {
		state.failures = 0;
		lastCloseReason = "";
		updateBadge();
	});
	socket.addEventListener("message", (message) => {
		void handleMessage(port, socket, message.data);
	});
	socket.addEventListener("close", (event) => {
		if (state.socket !== socket) return;
		state.socket = undefined;
		if (event.reason) lastCloseReason = event.reason;
		releaseAllForPort(port);
		updateBadge();
		// A bridge that just went away (pi exit or /reload) often returns on the same port shortly.
		defer(state);
		ensureConnections();
	});
	socket.addEventListener("error", () => {
		// "close" always follows "error"; the retry is scheduled there.
	});
}

function openSockets() {
	const open = [];
	for (const state of ports.values()) {
		if (state.socket && state.socket.readyState === WebSocket.OPEN) open.push(state.socket);
	}
	return open;
}

function updateBadge() {
	const count = openSockets().length;
	void chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
	void chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
	const title = count > 0 ? `${BRIDGE_NAME}: ${count} pi session(s) connected` : `${BRIDGE_NAME}: waiting for pi${lastCloseReason ? ` (last bridge said: ${lastCloseReason})` : ""}`;
	void chrome.action.setTitle({ title });
}

function send(socket, payload) {
	if (socket.readyState !== WebSocket.OPEN) return;
	socket.send(JSON.stringify(payload));
}

function broadcast(payload, onlyPorts) {
	for (const [port, state] of ports) {
		if (!state.socket) continue;
		if (onlyPorts && !onlyPorts.has(port)) continue;
		send(state.socket, payload);
	}
}

// ---------------------------------------------------------------------------------------
// Requests from pi

async function handleMessage(port, socket, raw) {
	let message;
	try {
		message = JSON.parse(raw);
	} catch {
		return;
	}
	if (typeof message.id !== "number" || typeof message.method !== "string") return;
	try {
		const result = await dispatch(port, message.method, message.params || {});
		send(socket, { id: message.id, result: result === undefined ? null : result });
	} catch (error) {
		send(socket, { id: message.id, error: { message: errorMessage(error) } });
	}
}

function errorMessage(error) {
	if (error && typeof error.message === "string") return error.message;
	return String(error);
}

async function dispatch(port, method, params) {
	switch (method) {
		case "ping":
			return "pong";
		case "hello":
			return {
				protocol: PROTOCOL_VERSION,
				extensionId: chrome.runtime.id,
				version: chrome.runtime.getManifest().version,
				userAgent: navigator.userAgent,
			};

		case "tabs.list": {
			const [tabs, windows] = await Promise.all([chrome.tabs.query({}), chrome.windows.getAll()]);
			return { tabs: tabs.map(tabInfo), windows: windows.map(windowInfo) };
		}
		case "tabs.get":
			return tabInfo(await chrome.tabs.get(requireNumber(params.tabId, "tabId")));
		case "tabs.create": {
			const createProperties = { active: params.active !== false };
			if (typeof params.url === "string") createProperties.url = params.url;
			if (typeof params.windowId === "number") createProperties.windowId = params.windowId;
			if (typeof params.index === "number") createProperties.index = params.index;
			return tabInfo(await chrome.tabs.create(createProperties));
		}
		case "tabs.update": {
			const tabId = requireNumber(params.tabId, "tabId");
			const updateProperties = {};
			for (const key of ["url", "active", "muted", "pinned", "highlighted"]) {
				if (params[key] !== undefined) updateProperties[key] = params[key];
			}
			return tabInfo(await chrome.tabs.update(tabId, updateProperties));
		}
		case "tabs.remove": {
			const tabIds = Array.isArray(params.tabIds) ? params.tabIds : [requireNumber(params.tabId, "tabId")];
			await chrome.tabs.remove(tabIds);
			return { removed: tabIds };
		}

		case "windows.get":
			return windowInfo(await chrome.windows.get(requireNumber(params.windowId, "windowId"), { populate: true }));
		case "windows.create": {
			const createData = {};
			for (const key of ["url", "focused", "width", "height", "left", "top", "state", "type", "incognito"]) {
				if (params[key] !== undefined) createData[key] = params[key];
			}
			return windowInfo(await chrome.windows.create(createData));
		}
		case "windows.update": {
			const windowId = requireNumber(params.windowId, "windowId");
			const updateInfo = {};
			for (const key of ["focused", "state", "width", "height", "left", "top", "drawAttention"]) {
				if (params[key] !== undefined) updateInfo[key] = params[key];
			}
			return windowInfo(await chrome.windows.update(windowId, updateInfo));
		}
		case "windows.remove":
			await chrome.windows.remove(requireNumber(params.windowId, "windowId"));
			return { removed: params.windowId };

		case "debugger.attach":
			return attach(port, requireNumber(params.tabId, "tabId"));
		case "debugger.detach":
			return detach(port, requireNumber(params.tabId, "tabId"));
		case "debugger.targets":
			return chrome.debugger.getTargets();
		case "cdp": {
			const tabId = requireNumber(params.tabId, "tabId");
			const holders = attachments.get(tabId);
			if (!holders || !holders.get(port)) {
				throw new Error(`debugger is not attached to tab ${tabId} for this pi session`);
			}
			const debuggee = { tabId };
			if (typeof params.sessionId === "string") debuggee.sessionId = params.sessionId;
			return chrome.debugger.sendCommand(debuggee, params.method, params.params || {});
		}
		default:
			throw new Error(`unknown method ${method}`);
	}
}

function requireNumber(value, name) {
	if (typeof value !== "number") throw new Error(`${name} must be a number`);
	return value;
}

function tabInfo(tab) {
	return {
		id: tab.id,
		windowId: tab.windowId,
		index: tab.index,
		url: tab.url || tab.pendingUrl || "",
		title: tab.title || "",
		active: Boolean(tab.active),
		status: tab.status || "",
		pinned: Boolean(tab.pinned),
		groupId: typeof tab.groupId === "number" ? tab.groupId : -1,
	};
}

function windowInfo(win) {
	return {
		id: win.id,
		focused: Boolean(win.focused),
		state: win.state || "",
		type: win.type || "",
		width: win.width || 0,
		height: win.height || 0,
		left: win.left || 0,
		top: win.top || 0,
		incognito: Boolean(win.incognito),
		tabs: Array.isArray(win.tabs) ? win.tabs.map(tabInfo) : undefined,
	};
}

// ---------------------------------------------------------------------------------------
// Debugger attachments (one chrome.debugger attach per tab, shared by pi sessions)

async function attach(port, tabId) {
	let holders = attachments.get(tabId);
	let fresh = false;
	if (!holders || holders.size === 0) {
		try {
			await chrome.debugger.attach({ tabId }, CDP_VERSION);
			fresh = true;
		} catch (error) {
			const message = errorMessage(error);
			// Our own attachment can outlive this worker's memory (worker restart). Treat that as attached.
			if (!/already attached/i.test(message)) throw new Error(message);
		}
		holders = new Map();
		attachments.set(tabId, holders);
	}
	holders.set(port, (holders.get(port) || 0) + 1);
	return { attached: true, fresh };
}

async function detach(port, tabId) {
	const holders = attachments.get(tabId);
	if (holders) {
		const remaining = (holders.get(port) || 0) - 1;
		if (remaining > 0) holders.set(port, remaining);
		else holders.delete(port);
		if (holders.size > 0) return { detached: false, otherSessions: [...holders.values()].reduce((sum, count) => sum + count, 0) };
		attachments.delete(tabId);
	}
	try {
		await chrome.debugger.detach({ tabId });
	} catch {
		// Already gone (tab closed, DevTools took over). Nothing to clean up.
	}
	return { detached: true };
}

function releaseAllForPort(port) {
	for (const [tabId, holders] of attachments) {
		if (!holders.has(port)) continue;
		holders.delete(port);
		if (holders.size === 0) {
			attachments.delete(tabId);
			chrome.debugger.detach({ tabId }).catch(() => {});
		}
	}
}

chrome.debugger.onEvent.addListener((source, method, params) => {
	if (typeof source.tabId !== "number") return;
	const holders = attachments.get(source.tabId);
	if (!holders || holders.size === 0) return;
	const payload = { event: "cdp", tabId: source.tabId, method, params: params || {} };
	if (source.sessionId) payload.sessionId = source.sessionId;
	broadcast(payload, holders);
});

chrome.debugger.onDetach.addListener((source, reason) => {
	if (typeof source.tabId !== "number") return;
	const holders = attachments.get(source.tabId);
	attachments.delete(source.tabId);
	if (holders && holders.size > 0) broadcast({ event: "debugger.detached", tabId: source.tabId, reason }, holders);
});

// ---------------------------------------------------------------------------------------
// Tab and window lifecycle (broadcast to every pi session; cheap and lets pi keep state fresh)

chrome.tabs.onCreated.addListener((tab) => broadcast({ event: "tab.created", tab: tabInfo(tab) }));
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
	attachments.delete(tabId);
	broadcast({ event: "tab.removed", tabId, windowId: removeInfo.windowId });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	const filtered = {};
	if (changeInfo.status !== undefined) filtered.status = changeInfo.status;
	if (changeInfo.url !== undefined) filtered.url = changeInfo.url;
	if (changeInfo.title !== undefined) filtered.title = changeInfo.title;
	if (Object.keys(filtered).length === 0) return;
	broadcast({ event: "tab.updated", tabId, changeInfo: filtered });
});
chrome.windows.onRemoved.addListener((windowId) => broadcast({ event: "window.removed", windowId }));

// ---------------------------------------------------------------------------------------
// Keep trying to reach pi. Chrome may terminate this worker after 30 s idle; while a socket is
// open, pi's heartbeat resets that timer (Chrome 116+). The alarm revives the worker otherwise,
// and a fresh worker probes every port at once (its backoff state starts empty).

chrome.runtime.onInstalled.addListener(() => ensureConnections());
chrome.runtime.onStartup.addListener(() => ensureConnections());
chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === ALARM_NAME) ensureConnections();
});
chrome.alarms.get(ALARM_NAME).then((alarm) => {
	if (!alarm) chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
});
// Clicking the toolbar icon means "connect now": drop every backoff.
chrome.action.onClicked.addListener(() => {
	for (const state of ports.values()) {
		state.failures = 0;
		state.nextAttemptAt = 0;
	}
	ensureConnections();
});

updateBadge();
ensureConnections();
