// One CDP session per Chrome tab. Owns the debugger attachment, keeps the DevTools-style
// buffers (console, network, dialogs, frames) up to date from streamed events, and offers
// typed helpers the tools build on.

import { EventEmitter } from "node:events";
import type { Protocol } from "devtools-protocol";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";
import type { ExtensionEvent, TabInfo } from "../bridge/protocol.ts";
import { BridgeError, type ExtensionClient } from "../bridge/server.ts";
import { ConsoleLog } from "./console.ts";
import { NetworkLog } from "./network.ts";
import { RefRegistry } from "./refs.ts";
import { formatExceptionDetails } from "./remote-object.ts";
import { headersToEntries, RouteTable } from "./routes.ts";

export type CommandName = keyof ProtocolMapping.Commands;
export type CommandParams<T extends CommandName> = ProtocolMapping.Commands[T]["paramsType"][0];
export type CommandReturn<T extends CommandName> = ProtocolMapping.Commands[T]["returnType"];
export type EventName = keyof ProtocolMapping.Events;
export type EventParams<E extends EventName> = ProtocolMapping.Events[E][0];

export interface SendOptions {
	sessionId?: string;
	timeoutMs?: number;
}

export interface FrameInfo {
	id: string;
	parentId?: string;
	url: string;
	name?: string;
	/** Child CDP session when the frame is out-of-process. */
	sessionId?: string;
}

export interface ExecutionContextInfo {
	id: number;
	frameId?: string;
	isDefault: boolean;
	name: string;
	origin: string;
	sessionId?: string;
}

export interface DialogInfo {
	type: Protocol.Page.DialogType;
	message: string;
	defaultPrompt?: string;
	url: string;
	openedAt: number;
}

export type DialogPolicy = "manual" | "accept" | "dismiss";

export class SessionClosedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionClosedError";
	}
}

export class DialogOpenError extends Error {
	readonly dialog: DialogInfo;
	constructor(dialog: DialogInfo) {
		super(describeDialog(dialog));
		this.name = "DialogOpenError";
		this.dialog = dialog;
	}
}

export class EvaluateError extends Error {
	readonly details: Protocol.Runtime.ExceptionDetails;
	constructor(details: Protocol.Runtime.ExceptionDetails) {
		super(formatExceptionDetails(details));
		this.name = "EvaluateError";
		this.details = details;
	}
}

export function describeDialog(dialog: DialogInfo): string {
	const preview = dialog.message.length > 200 ? `${dialog.message.slice(0, 200)}…` : dialog.message;
	return `A JavaScript ${dialog.type} dialog is open: "${preview}". Use chrome_dialog to accept or dismiss it before continuing.`;
}

interface SessionEvents {
	detached: [reason: string];
	closed: [];
	dialog: [dialog: DialogInfo | undefined];
	navigated: [url: string, sameDocument: boolean];
}

const DEFAULT_TIMEOUT_MS = 30_000;
// Commands the renderer must service; they hang while a JavaScript dialog blocks it.
const DIALOG_SENSITIVE = /^(Input\.|Runtime\.|DOM\.|Page\.(navigate|reload|captureScreenshot|printToPDF|getLayoutMetrics)|Accessibility\.|DOMSnapshot\.|CSS\.|Emulation\.)/;

export class TabSession extends EventEmitter<SessionEvents> {
	readonly tabId: number;
	readonly client: ExtensionClient;
	readonly console = new ConsoleLog();
	readonly network: NetworkLog;
	readonly routes = new RouteTable();
	readonly refs = new RefRegistry();
	readonly frames = new Map<string, FrameInfo>();
	readonly contexts = new Map<string, ExecutionContextInfo>();
	readonly childSessions = new Map<string, { targetId: string; type: string; url: string }>();
	readonly diagnostics: string[] = [];

	url = "";
	title = "";
	mainFrameId = "";
	dialog: DialogInfo | undefined;
	dialogPolicy: DialogPolicy = "manual";
	/** Increments on every main-frame navigation (including same-document). */
	navigationCount = 0;
	/** Increments when the main frame *starts* loading, before the new document commits. */
	navigationStarts = 0;
	private attached = false;
	private closed = false;
	private loaderId = "";
	private lifecycle = new Map<string, number>();
	private loadedOnce = false;
	private readonly cdpEvents = new EventEmitter();
	private readonly bridgeListener: (event: ExtensionEvent) => void;
	private readonly clientCloseListener: (reason: string) => void;
	private fetchEnabled = false;

	private constructor(client: ExtensionClient, tabId: number) {
		super();
		this.client = client;
		this.tabId = tabId;
		this.network = new NetworkLog(async (requestId, sessionId) => {
			const result = await this.send("Network.getResponseBody", { requestId }, { sessionId, timeoutMs: 10_000 });
			return { body: result.body, base64Encoded: result.base64Encoded };
		});
		this.bridgeListener = (event) => this.onBridgeEvent(event);
		this.clientCloseListener = (reason) => this.markClosed(`companion extension disconnected (${reason})`);
		this.cdpEvents.setMaxListeners(100);
	}

	static async open(client: ExtensionClient, tabId: number): Promise<TabSession> {
		const session = new TabSession(client, tabId);
		client.on("event", session.bridgeListener);
		client.on("close", session.clientCloseListener);
		try {
			await client.request("debugger.attach", { tabId });
			session.attached = true;
			await session.initialize();
		} catch (error) {
			session.dispose();
			const message = (error as Error).message;
			if (/Cannot access|Cannot attach|chrome:\/\/|Not allowed/i.test(message)) {
				const tab = (await client.request("tabs.get", { tabId }).catch(() => undefined)) as TabInfo | undefined;
				throw new Error(
					`Chrome does not allow the debugger on ${tab?.url ?? `tab ${tabId}`} (chrome:// pages, the Chrome Web Store and other extensions' pages are off limits). Pick a normal web page with chrome_tabs "use", or open one with chrome_tabs "new". (${message})`,
				);
			}
			throw error;
		}
		return session;
	}

	get isAttached(): boolean {
		return this.attached && !this.closed;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	get currentLoaderId(): string {
		return this.loaderId;
	}

	get hasLoaded(): boolean {
		return this.loadedOnce;
	}

	// --- lifecycle --------------------------------------------------------------------------

	private async initialize(): Promise<void> {
		const tab = (await this.client.request("tabs.get", { tabId: this.tabId })) as TabInfo;
		this.url = tab.url;
		this.title = tab.title;

		const enable = async (method: CommandName, params?: Record<string, unknown>) => {
			try {
				await this.rawSend(method, params, {});
			} catch (error) {
				this.diagnostics.push(`${method}: ${(error as Error).message}`);
			}
		};
		await Promise.all([
			enable("Page.enable"),
			enable("Runtime.enable"),
			enable("Log.enable"),
			enable("DOM.enable"),
			enable("Network.enable", { maxTotalBufferSize: 50 * 1024 * 1024, maxResourceBufferSize: 10 * 1024 * 1024, maxPostDataSize: 65536 }),
		]);
		await Promise.all([
			enable("Page.setLifecycleEventsEnabled", { enabled: true }),
			// Pages behave as if focused even when the Chrome window is in the background.
			enable("Emulation.setFocusEmulationEnabled", { enabled: true }),
			enable("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe", exclude: false }] }),
		]);
		try {
			const tree = await this.send("Page.getFrameTree");
			this.adoptFrameTree(tree.frameTree);
		} catch (error) {
			this.diagnostics.push(`Page.getFrameTree: ${(error as Error).message}`);
		}
	}

	private adoptFrameTree(node: Protocol.Page.FrameTree, sessionId?: string): void {
		const frame = node.frame;
		if (!frame.parentId && !sessionId) {
			this.mainFrameId = frame.id;
			this.loaderId = frame.loaderId;
			if (frame.url && frame.url !== "about:blank") this.url = frame.url;
		}
		this.frames.set(frame.id, { id: frame.id, parentId: frame.parentId, url: frame.url, name: frame.name, sessionId });
		for (const child of node.childFrames ?? []) this.adoptFrameTree(child, sessionId);
	}

	async detach(): Promise<void> {
		if (!this.attached) return;
		this.attached = false;
		try {
			await this.client.request("debugger.detach", { tabId: this.tabId }, 5_000);
		} catch {
			// The tab or the extension may already be gone.
		}
		this.dispose();
	}

	private dispose(): void {
		this.client.off("event", this.bridgeListener);
		this.client.off("close", this.clientCloseListener);
		this.markClosed("session disposed");
	}

	private markClosed(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.attached = false;
		this.network.resetInflight();
		this.emit("closed");
		this.emit("detached", reason);
	}

	// --- commands ---------------------------------------------------------------------------

	async send<T extends CommandName>(method: T, params?: CommandParams<T>, options: SendOptions = {}): Promise<CommandReturn<T>> {
		if (this.closed) throw new SessionClosedError(`tab ${this.tabId} session is closed`);
		if (this.dialog && DIALOG_SENSITIVE.test(method)) throw new DialogOpenError(this.dialog);
		return this.rawSend(method, params as Record<string, unknown> | undefined, options) as Promise<CommandReturn<T>>;
	}

	private rawSend(method: string, params: Record<string, unknown> | undefined, options: SendOptions): Promise<unknown> {
		const request = this.client.request(
			"cdp",
			{ tabId: this.tabId, sessionId: options.sessionId, method, params },
			options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		);
		if (!DIALOG_SENSITIVE.test(method)) return request;
		// A dialog opened by the command (alert() in a click handler) blocks the renderer, so the
		// response never arrives. Surface the dialog instead of waiting for the timeout, unless a
		// dialog policy will close it and let the command complete on its own.
		return new Promise((resolve, reject) => {
			const onDialog = (dialog: DialogInfo | undefined) => {
				if (dialog && this.dialogPolicy === "manual") reject(new DialogOpenError(dialog));
			};
			this.on("dialog", onDialog);
			request.then(resolve, reject).finally(() => this.off("dialog", onDialog));
		});
	}

	// --- events -----------------------------------------------------------------------------

	onCdp<E extends EventName>(event: E, handler: (params: EventParams<E>, sessionId?: string) => void): () => void {
		this.cdpEvents.on(event, handler);
		return () => this.cdpEvents.off(event, handler);
	}

	waitForCdp<E extends EventName>(
		event: E,
		predicate: (params: EventParams<E>, sessionId?: string) => boolean,
		timeoutMs: number,
	): Promise<EventParams<E> | undefined> {
		return new Promise((resolve) => {
			const off = this.onCdp(event, (params, sessionId) => {
				if (!predicate(params, sessionId)) return;
				clearTimeout(timer);
				off();
				resolve(params);
			});
			const timer = setTimeout(() => {
				off();
				resolve(undefined);
			}, timeoutMs);
		});
	}

	private onBridgeEvent(event: ExtensionEvent): void {
		switch (event.event) {
			case "cdp":
				if (event.tabId === this.tabId) this.onCdpEvent(event.method as EventName, event.params, event.sessionId);
				return;
			case "debugger.detached":
				if (event.tabId === this.tabId) {
					this.attached = false;
					this.markClosed(`debugger detached (${event.reason})`);
				}
				return;
			case "tab.removed":
				if (event.tabId === this.tabId) this.markClosed("tab closed");
				return;
			case "tab.updated":
				if (event.tabId === this.tabId) {
					if (event.changeInfo.title !== undefined) this.title = event.changeInfo.title;
					if (event.changeInfo.url !== undefined) this.url = event.changeInfo.url;
				}
				return;
			default:
				return;
		}
	}

	private onCdpEvent(method: EventName, params: Record<string, unknown>, sessionId?: string): void {
		this.trackState(method, params, sessionId);
		this.cdpEvents.emit(method, params, sessionId);
	}

	private trackState(method: EventName, rawParams: Record<string, unknown>, sessionId?: string): void {
		const params = rawParams as never;
		switch (method) {
			// Console ---------------------------------------------------------------------
			case "Runtime.consoleAPICalled":
				this.console.onConsoleApiCalled(params);
				return;
			case "Runtime.exceptionThrown":
				this.console.onExceptionThrown(params);
				return;
			case "Log.entryAdded":
				this.console.onLogEntryAdded(params);
				return;

			// Network ---------------------------------------------------------------------
			case "Network.requestWillBeSent":
				this.network.onRequestWillBeSent(params, sessionId);
				return;
			case "Network.requestWillBeSentExtraInfo":
				this.network.onRequestWillBeSentExtraInfo(params);
				return;
			case "Network.responseReceived":
				this.network.onResponseReceived(params);
				return;
			case "Network.responseReceivedExtraInfo":
				this.network.onResponseReceivedExtraInfo(params);
				return;
			case "Network.requestServedFromCache":
				this.network.onRequestServedFromCache(params);
				return;
			case "Network.loadingFinished":
				this.network.onLoadingFinished(params);
				return;
			case "Network.loadingFailed":
				this.network.onLoadingFailed(params);
				return;
			case "Network.webSocketCreated":
				this.network.onWebSocketCreated(params);
				return;
			case "Network.webSocketHandshakeResponseReceived":
				this.network.onWebSocketHandshakeResponseReceived(params);
				return;
			case "Network.webSocketFrameSent":
				this.network.onWebSocketFrame("sent", params);
				return;
			case "Network.webSocketFrameReceived":
				this.network.onWebSocketFrame("received", params);
				return;
			case "Network.webSocketClosed":
				this.network.onWebSocketClosed(params);
				return;
			case "Network.eventSourceMessageReceived":
				this.network.onEventSourceMessage(params);
				return;

			// Interception ----------------------------------------------------------------
			case "Fetch.requestPaused":
				void this.onRequestPaused(params, sessionId);
				return;

			// Page / frames ---------------------------------------------------------------
			case "Page.frameNavigated": {
				const event = params as Protocol.Page.FrameNavigatedEvent;
				const frame = event.frame;
				this.frames.set(frame.id, { id: frame.id, parentId: frame.parentId, url: frame.url, name: frame.name, sessionId });
				if (!sessionId && !frame.parentId) {
					// The previous document's subframes are gone; Chrome does not always report them detached.
					// Leaving them listed makes chrome_frames advertise frames that can never be targeted.
					for (const [id, tracked] of this.frames) if (id !== frame.id && tracked.parentId !== undefined) this.frames.delete(id);
					this.mainFrameId = frame.id;
					this.loaderId = frame.loaderId;
					this.lifecycle.clear();
					this.url = frame.url;
					this.navigationCount += 1;
					this.refs.clear();
					this.dialog = undefined;
					// Requests of the document that just went away can no longer report completion.
					this.network.dropInflightFromOtherLoaders(frame.loaderId);
					this.emit("navigated", frame.url, false);
				}
				return;
			}
			case "Page.navigatedWithinDocument": {
				const event = params as Protocol.Page.NavigatedWithinDocumentEvent;
				const frame = this.frames.get(event.frameId);
				if (frame) frame.url = event.url;
				if (event.frameId === this.mainFrameId) {
					this.url = event.url;
					this.navigationCount += 1;
					this.emit("navigated", event.url, true);
				}
				return;
			}
			case "Page.frameStartedLoading": {
				const event = params as Protocol.Page.FrameStartedLoadingEvent;
				// Fires when the navigation request goes out, well before frameNavigated. A click that
				// submits a form is otherwise reported as "nothing happened" while the POST is in flight.
				if (!sessionId && event.frameId === this.mainFrameId) this.navigationStarts += 1;
				return;
			}
			case "Page.frameAttached": {
				const event = params as Protocol.Page.FrameAttachedEvent;
				if (!this.frames.has(event.frameId)) this.frames.set(event.frameId, { id: event.frameId, parentId: event.parentFrameId, url: "", sessionId });
				return;
			}
			case "Page.frameDetached": {
				const event = params as Protocol.Page.FrameDetachedEvent;
				if (event.reason !== "swap") this.frames.delete(event.frameId);
				return;
			}
			case "Page.lifecycleEvent": {
				const event = params as Protocol.Page.LifecycleEventEvent;
				if (!sessionId && event.frameId === this.mainFrameId) {
					if (event.name === "init") {
						this.loaderId = event.loaderId;
						this.lifecycle.clear();
					}
					if (event.loaderId === this.loaderId) this.lifecycle.set(event.name, event.timestamp);
					if (event.name === "load") this.loadedOnce = true;
				}
				return;
			}
			case "Page.javascriptDialogOpening": {
				const event = params as Protocol.Page.JavascriptDialogOpeningEvent;
				this.dialog = { type: event.type, message: event.message, defaultPrompt: event.defaultPrompt, url: event.url, openedAt: Date.now() };
				this.emit("dialog", this.dialog);
				if (this.dialogPolicy !== "manual") {
					void this.rawSend("Page.handleJavaScriptDialog", { accept: this.dialogPolicy === "accept" }, { sessionId }).catch(() => {});
				}
				return;
			}
			case "Page.javascriptDialogClosed":
				this.dialog = undefined;
				this.emit("dialog", undefined);
				return;

			// Execution contexts ----------------------------------------------------------
			case "Runtime.executionContextCreated": {
				const event = params as Protocol.Runtime.ExecutionContextCreatedEvent;
				const aux = (event.context.auxData ?? {}) as { frameId?: string; isDefault?: boolean; type?: string };
				this.contexts.set(contextKey(event.context.id, sessionId), {
					id: event.context.id,
					frameId: aux.frameId,
					isDefault: aux.isDefault === true,
					name: event.context.name,
					origin: event.context.origin,
					sessionId,
				});
				return;
			}
			case "Runtime.executionContextDestroyed": {
				const event = params as Protocol.Runtime.ExecutionContextDestroyedEvent;
				this.contexts.delete(contextKey(event.executionContextId, sessionId));
				return;
			}
			case "Runtime.executionContextsCleared":
				for (const key of [...this.contexts.keys()]) {
					if (key.startsWith(`${sessionId ?? "main"}:`)) this.contexts.delete(key);
				}
				return;

			// Child targets (out-of-process iframes) --------------------------------------
			case "Target.attachedToTarget": {
				const event = params as Protocol.Target.AttachedToTargetEvent;
				this.childSessions.set(event.sessionId, { targetId: event.targetInfo.targetId, type: event.targetInfo.type, url: event.targetInfo.url });
				void this.initializeChildSession(event.sessionId);
				return;
			}
			case "Target.detachedFromTarget": {
				const event = params as Protocol.Target.DetachedFromTargetEvent;
				this.childSessions.delete(event.sessionId);
				for (const [key, context] of this.contexts) if (context.sessionId === event.sessionId) this.contexts.delete(key);
				for (const [id, frame] of this.frames) if (frame.sessionId === event.sessionId) this.frames.delete(id);
				return;
			}
			default:
				return;
		}
	}

	private async initializeChildSession(sessionId: string): Promise<void> {
		const enable = async (method: CommandName, params?: Record<string, unknown>) => {
			try {
				await this.rawSend(method, params, { sessionId, timeoutMs: 10_000 });
			} catch (error) {
				this.diagnostics.push(`${method} (child ${sessionId.slice(0, 8)}): ${(error as Error).message}`);
			}
		};
		await Promise.all([enable("Runtime.enable"), enable("Page.enable"), enable("Log.enable"), enable("Network.enable"), enable("DOM.enable")]);
		try {
			const tree = await this.rawSend("Page.getFrameTree", undefined, { sessionId, timeoutMs: 10_000 });
			this.adoptFrameTree((tree as Protocol.Page.GetFrameTreeResponse).frameTree, sessionId);
		} catch {
			// Frame tree is optional; frameNavigated events fill it in.
		}
		await enable("Runtime.runIfWaitingForDebugger");
	}

	// --- interception -----------------------------------------------------------------------

	async syncRoutes(): Promise<void> {
		const patterns = this.routes.patterns();
		if (patterns.length === 0) {
			if (this.fetchEnabled) {
				await this.send("Fetch.disable").catch(() => {});
				this.fetchEnabled = false;
			}
			return;
		}
		await this.send("Fetch.enable", { patterns });
		this.fetchEnabled = true;
	}

	private async onRequestPaused(params: Protocol.Fetch.RequestPausedEvent, sessionId?: string): Promise<void> {
		// chrome.debugger shares one attachment per tab, so the companion broadcasts CDP events to every
		// pi session attached to it. Interception belongs to whichever session enabled Fetch; answering
		// a request another session paused would race it ("Invalid state for continueInterceptedRequest").
		if (!this.fetchEnabled) return;
		const options = { sessionId, timeoutMs: 10_000 };
		const request = params.request;
		// A CORS preflight announces the real method; match rules by that so `POST */api/x` owns its preflight too.
		const preflight = isPreflight(request);
		const rule = this.routes.match(request.url, preflight ? (headerValue(request.headers, "access-control-request-method") ?? request.method) : request.method);
		if (!rule) {
			await this.rawSend("Fetch.continueRequest", { requestId: params.requestId }, options).catch(() => {});
			return;
		}
		// Answer the preflight ourselves (SPA on one host, API on another) so the real request follows
		// and meets the rule; the preflight itself is not a hit.
		if (preflight && rule.method?.toUpperCase() !== "OPTIONS") {
			if (rule.action === "continue") {
				await this.rawSend("Fetch.continueRequest", { requestId: params.requestId }, options).catch(() => {});
			} else {
				await this.rawSend("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 204, responseHeaders: corsHeaders(request, {}) }, options).catch(() => {});
			}
			return;
		}
		this.routes.record(rule, request);
		if (params.networkId) this.network.markMocked(params.networkId);
		if (rule.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs));
		try {
			if (rule.action === "abort") {
				await this.rawSend("Fetch.failRequest", { requestId: params.requestId, errorReason: rule.abortReason ?? "Failed" }, options);
			} else if (rule.action === "fulfill" && rule.response) {
				const body = rule.response.base64 ? rule.response.body : Buffer.from(rule.response.body, "utf8").toString("base64");
				const responseHeaders = [...headersToEntries(rule.response.headers), ...corsHeaders(request, rule.response.headers)];
				await this.rawSend("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: rule.response.status, responseHeaders, body }, options);
			} else {
				const headers = rule.setHeaders ? headersToEntries({ ...params.request.headers, ...rule.setHeaders }) : undefined;
				await this.rawSend("Fetch.continueRequest", { requestId: params.requestId, headers }, options);
			}
		} catch (error) {
			this.diagnostics.push(`route ${rule.id}: ${(error as Error).message}`);
		}
	}

	// --- helpers ----------------------------------------------------------------------------

	/** Evaluate an expression and return its JSON value. Throws EvaluateError on exceptions. */
	async evaluate<T = unknown>(
		expression: string,
		options: { awaitPromise?: boolean; contextId?: number; sessionId?: string; timeoutMs?: number; includeCommandLineAPI?: boolean } = {},
	): Promise<T> {
		const result = await this.send(
			"Runtime.evaluate",
			{
				expression,
				returnByValue: true,
				awaitPromise: options.awaitPromise ?? true,
				contextId: options.contextId,
				includeCommandLineAPI: options.includeCommandLineAPI ?? false,
				userGesture: true,
			},
			{ sessionId: options.sessionId, timeoutMs: options.timeoutMs },
		);
		if (result.exceptionDetails) throw new EvaluateError(result.exceptionDetails);
		return result.result.value as T;
	}

	/** Evaluate and keep the result as a remote object (for DOM nodes). Caller releases it. */
	async evaluateHandle(expression: string, options: { contextId?: number; sessionId?: string } = {}): Promise<Protocol.Runtime.RemoteObject> {
		const result = await this.send(
			"Runtime.evaluate",
			{ expression, returnByValue: false, awaitPromise: true, contextId: options.contextId, userGesture: true },
			{ sessionId: options.sessionId },
		);
		if (result.exceptionDetails) throw new EvaluateError(result.exceptionDetails);
		return result.result;
	}

	async callFunctionOn<T = unknown>(
		objectId: string,
		functionDeclaration: string,
		args: unknown[] = [],
		options: { returnByValue?: boolean; sessionId?: string; awaitPromise?: boolean } = {},
	): Promise<{ value: T; object: Protocol.Runtime.RemoteObject }> {
		const result = await this.send(
			"Runtime.callFunctionOn",
			{
				objectId,
				functionDeclaration,
				arguments: args.map((value) => ({ value })),
				returnByValue: options.returnByValue ?? true,
				awaitPromise: options.awaitPromise ?? true,
				userGesture: true,
			},
			{ sessionId: options.sessionId },
		);
		if (result.exceptionDetails) throw new EvaluateError(result.exceptionDetails);
		return { value: result.result.value as T, object: result.result };
	}

	async releaseObject(objectId: string, sessionId?: string): Promise<void> {
		await this.send("Runtime.releaseObject", { objectId }, { sessionId, timeoutMs: 5_000 }).catch(() => {});
	}

	/** Default execution context of a frame (main frame when frameId is omitted). */
	contextFor(frameId?: string): ExecutionContextInfo | undefined {
		const wanted = frameId ?? this.mainFrameId;
		for (const context of this.contexts.values()) {
			if (context.isDefault && context.frameId === wanted) return context;
		}
		return undefined;
	}

	/** Resolve a frame selector (id, url substring or name) to a frame. */
	findFrame(frame: string): FrameInfo | undefined {
		if (this.frames.has(frame)) return this.frames.get(frame);
		const needle = frame.trim().toLowerCase();
		// chrome_frames prints shortened ids, so a prefix of an id must resolve; then names, then URLs.
		for (const info of this.frames.values()) if (info.id.toLowerCase().startsWith(needle)) return info;
		for (const info of this.frames.values()) if (info.name?.toLowerCase() === needle) return info;
		for (const info of this.frames.values()) if (info.url.toLowerCase().includes(needle)) return info;
		return undefined;
	}

	lifecycleReached(name: string): boolean {
		return this.lifecycle.has(name);
	}

	/**
	 * Wait until the tab has left its initial empty document and finished loading. A tab created with
	 * a URL starts on about:blank, which is already "complete", so a plain load wait can return before
	 * the requested page exists.
	 */
	async waitForFirstDocument(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.closed) return false;
			if (this.dialog) return true;
			// chrome.tabs reports the requested URL before the document exists, so ask the page itself:
			// while it is still about:blank the requested document has not committed.
			const state = await this.evaluate<{ href: string; ready: string }>("({ href: location.href, ready: document.readyState })", { awaitPromise: false, timeoutMs: 2_000 }).catch(() => undefined);
			if (state && state.href !== "about:blank" && state.ready === "complete") return true;
			await new Promise((resolve) => setTimeout(resolve, 75));
		}
		return false;
	}

	/**
	 * Wait for the main frame to reach a load milestone. With afterNavigation, first waits for a
	 * navigation newer than that count. Lifecycle events are the primary signal; document.readyState
	 * is the fallback for loads we could not observe (back-forward cache restores emit no load event,
	 * and a tab may finish loading before the debugger attaches).
	 */
	async waitForLifecycle(name: "DOMContentLoaded" | "load", timeoutMs: number, options: { afterNavigation?: number } = {}): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		const targetNavigation = options.afterNavigation;
		let lastProbe = 0;
		while (Date.now() < deadline) {
			if (this.closed) return false;
			if (this.dialog) return true;
			const navigated = targetNavigation === undefined || this.navigationCount > targetNavigation;
			if (navigated) {
				if (this.lifecycle.has(name)) return true;
				if (Date.now() - lastProbe >= 200) {
					lastProbe = Date.now();
					const state = await this.evaluate<string>("document.readyState", { awaitPromise: false, timeoutMs: 2_000 }).catch(() => undefined);
					if (state === "complete" || (name === "DOMContentLoaded" && state === "interactive")) return true;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return false;
	}

	/** Bring this tab's window to the front and make the tab active. */
	async focus(): Promise<void> {
		const tab = (await this.client.request("tabs.get", { tabId: this.tabId })) as TabInfo;
		if (!tab.active) await this.client.request("tabs.update", { tabId: this.tabId, active: true });
		await this.client.request("windows.update", { windowId: tab.windowId, focused: true }).catch(() => {});
	}
}

function contextKey(id: number, sessionId: string | undefined): string {
	return `${sessionId ?? "main"}:${id}`;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
	return key === undefined ? undefined : headers[key];
}

function isPreflight(request: Protocol.Network.Request): boolean {
	return request.method === "OPTIONS" && headerValue(request.headers, "access-control-request-method") !== undefined;
}

/**
 * CORS response headers a mocked response needs when the page called it cross-origin, skipping
 * any the rule set itself. Without them the browser rejects the mock and the page sees a network error.
 */
export function corsHeaders(request: Protocol.Network.Request, already: Record<string, string>): Protocol.Fetch.HeaderEntry[] {
	const origin = headerValue(request.headers, "origin");
	if (origin === undefined) return [];
	const has = (name: string) => Object.keys(already).some((candidate) => candidate.toLowerCase() === name);
	const entries: Protocol.Fetch.HeaderEntry[] = [];
	if (!has("access-control-allow-origin")) entries.push({ name: "access-control-allow-origin", value: origin });
	if (!has("access-control-allow-credentials") && origin !== "null") entries.push({ name: "access-control-allow-credentials", value: "true" });
	if (isPreflight(request)) {
		const method = headerValue(request.headers, "access-control-request-method") ?? "GET";
		const requested = headerValue(request.headers, "access-control-request-headers");
		if (!has("access-control-allow-methods")) entries.push({ name: "access-control-allow-methods", value: method });
		if (requested && !has("access-control-allow-headers")) entries.push({ name: "access-control-allow-headers", value: requested });
		if (!has("access-control-max-age")) entries.push({ name: "access-control-max-age", value: "0" });
	} else if (!has("access-control-expose-headers")) {
		entries.push({ name: "access-control-expose-headers", value: "*" });
	}
	return entries;
}

export function isBridgeDisconnect(error: unknown): boolean {
	return error instanceof BridgeError && error.code === "disconnected";
}
