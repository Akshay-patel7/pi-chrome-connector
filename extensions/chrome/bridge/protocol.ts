// Wire protocol between pi (this package) and the companion extension (chrome-extension/service_worker.js).
// Keep this file and the service worker in sync; the service worker is plain JS and cannot import it.
//
// pi -> extension:   { id, method, params? }
// extension -> pi:   { id, result }  |  { id, error: { message } }  |  { event, ...payload }

export const PROTOCOL_VERSION = 1;

/** Default loopback port range. Each pi session binds the first free port; the extension connects to all of them. */
export const DEFAULT_PORT_RANGE: readonly [number, number] = [17417, 17426];

export interface HelloResult {
	protocol: number;
	extensionId: string;
	version: string;
	userAgent: string;
}

export interface TabInfo {
	id: number;
	windowId: number;
	index: number;
	url: string;
	title: string;
	active: boolean;
	status: string;
	pinned: boolean;
	groupId: number;
}

export interface WindowInfo {
	id: number;
	focused: boolean;
	state: string;
	type: string;
	width: number;
	height: number;
	left: number;
	top: number;
	incognito: boolean;
	tabs?: TabInfo[];
}

export interface CdpRequest {
	tabId: number;
	sessionId?: string;
	method: string;
	params?: Record<string, unknown>;
}

export type ExtensionEvent =
	| { event: "cdp"; tabId: number; sessionId?: string; method: string; params: Record<string, unknown> }
	| { event: "debugger.detached"; tabId: number; reason: string }
	| { event: "tab.created"; tab: TabInfo }
	| { event: "tab.removed"; tabId: number; windowId: number }
	| { event: "tab.updated"; tabId: number; changeInfo: { status?: string; url?: string; title?: string } }
	| { event: "window.removed"; windowId: number };

export interface RequestMessage {
	id: number;
	method: string;
	params?: unknown;
}

export interface ResponseMessage {
	id: number;
	result?: unknown;
	error?: { message: string };
}

export type IncomingMessage = ResponseMessage | ExtensionEvent;

export function isEventMessage(message: unknown): message is ExtensionEvent {
	return typeof message === "object" && message !== null && typeof (message as { event?: unknown }).event === "string";
}

export function isResponseMessage(message: unknown): message is ResponseMessage {
	return typeof message === "object" && message !== null && typeof (message as { id?: unknown }).id === "number";
}
