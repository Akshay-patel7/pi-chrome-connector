// Node-side network log for a tab, fed by CDP Network.* events. Mirrors what the DevTools
// Network panel shows: every request (documents, scripts, XHR/fetch, images, WebSocket
// frames), with headers, timing, post data and, for text-like responses, the body captured
// eagerly so it survives navigation.

import type { Protocol } from "devtools-protocol";

export interface CapturedBody {
	text: string;
	base64Encoded: boolean;
	bytes: number;
}

export type BodyState = "pending" | "captured" | "too-large" | "binary" | "unavailable" | "none";

export interface NetworkEntry {
	seq: number;
	/** CDP request id; redirect hops get a ":rN" suffix. */
	id: string;
	requestId: string;
	url: string;
	method: string;
	type: string;
	frameId?: string;
	/** Document load the request belongs to; a main-frame navigation starts a new one. */
	loaderId?: string;
	/** Which CDP session produced this (undefined for the main frame). */
	sessionId?: string;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	status?: number;
	statusText?: string;
	mimeType?: string;
	protocol?: string;
	remoteAddress?: string;
	fromCache?: boolean;
	fromServiceWorker?: boolean;
	encodedBytes?: number;
	failed?: string;
	canceled?: boolean;
	blockedReason?: string;
	initiator?: string;
	requestHeaders: Record<string, string>;
	responseHeaders?: Record<string, string>;
	postData?: string;
	hasPostData?: boolean;
	body?: CapturedBody;
	bodyState: BodyState;
	redirectedFrom?: string;
	mocked?: boolean;
	websocket?: { frames: Array<{ direction: "sent" | "received"; timestamp: number; opcode: number; data: string }>; closed?: boolean };
	eventSourceMessages?: Array<{ timestamp: number; eventName: string; data: string }>;
}

export interface NetworkFilter {
	sinceSeq?: number;
	urlIncludes?: string;
	method?: string;
	/** "2xx" | "4xx" | "5xx" | exact number | ">=400" */
	status?: string | number;
	type?: string;
	failedOnly?: boolean;
	limit?: number;
}

export interface BodyFetcher {
	(requestId: string, sessionId?: string): Promise<{ body: string; base64Encoded: boolean }>;
}

const MAX_ENTRIES = 3000;
const MAX_EAGER_BODY_BYTES = 1024 * 1024;
const MAX_TOTAL_BODY_BYTES = 40 * 1024 * 1024;
const MAX_WS_FRAMES = 100;
const MAX_POST_DATA_CHARS = 65536;
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-javascript|ecmascript|x-www-form-urlencoded|graphql|ld\+json|problem\+json)|.*\+(json|xml)$)/i;

export class NetworkLog {
	private entries: NetworkEntry[] = [];
	private byId = new Map<string, NetworkEntry>();
	private nextSeq = 1;
	private totalBodyBytes = 0;
	private pendingExtraInfo = new Map<string, Partial<NetworkEntry>>();
	private inflight = new Set<string>();
	private idleWaiters: Array<{ idleMs: number; timer?: NodeJS.Timeout; resolve: () => void }> = [];
	private readonly fetchBody: BodyFetcher;

	constructor(fetchBody: BodyFetcher) {
		this.fetchBody = fetchBody;
	}

	get size(): number {
		return this.entries.length;
	}

	get lastSeq(): number {
		return this.nextSeq - 1;
	}

	get inflightCount(): number {
		return this.inflight.size;
	}

	clear(): void {
		this.entries = [];
		this.byId.clear();
		this.totalBodyBytes = 0;
	}

	get(id: string): NetworkEntry | undefined {
		return this.byId.get(id) ?? this.entries.find((entry) => entry.id === id || entry.requestId === id);
	}

	list(filter: NetworkFilter = {}): NetworkEntry[] {
		const needle = filter.urlIncludes?.toLowerCase();
		const method = filter.method?.toUpperCase();
		const type = filter.type?.toLowerCase();
		let matched = this.entries.filter((entry) => {
			if (filter.sinceSeq !== undefined && entry.seq <= filter.sinceSeq) return false;
			if (needle && !entry.url.toLowerCase().includes(needle)) return false;
			if (method && entry.method !== method) return false;
			if (type && entry.type.toLowerCase() !== type) return false;
			if (filter.failedOnly && !entry.failed && !(entry.status !== undefined && entry.status >= 400)) return false;
			if (filter.status !== undefined && !matchStatus(entry.status, filter.status)) return false;
			return true;
		});
		if (filter.limit !== undefined && matched.length > filter.limit) matched = matched.slice(matched.length - filter.limit);
		return matched;
	}

	/**
	 * Since seq: real failures (network errors, HTTP >= 400), requests a browser extension such as an
	 * ad blocker stopped, requests a chrome_route rule aborted, and requests the page itself canceled
	 * (navigation, EventSource.close(), AbortController), counted apart.
	 */
	countFailedSince(seq: number): { failed: number; blocked: number; aborted: number; canceled: number } {
		const counts = { failed: 0, blocked: 0, aborted: 0, canceled: 0 };
		for (const entry of this.entries) {
			if (entry.seq <= seq) continue;
			const kind = failureKind(entry);
			if (kind) counts[kind] += 1;
		}
		return counts;
	}

	/** URLs of requests still waiting for a response, oldest first. */
	inflightUrls(limit = 3): string[] {
		const urls: string[] = [];
		for (const entry of this.entries) {
			if (!this.inflight.has(entry.requestId)) continue;
			urls.push(entry.url);
			if (urls.length >= limit) break;
		}
		return urls;
	}

	/**
	 * Resolves once no request has been waiting for a response for idleMs. A request counts as
	 * settled at responseReceived, not loadingFinished: Chrome only reports loadingFinished for a
	 * fetch() once the page reads the body, so an unread body would keep "idle" from ever arriving.
	 */
	waitForIdle(idleMs: number, timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			let settled = false;
			const waiter = { idleMs, resolve: () => finish(true) } as { idleMs: number; timer?: NodeJS.Timeout; resolve: () => void };
			const finish = (idle: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(deadline);
				if (waiter.timer) clearTimeout(waiter.timer);
				this.idleWaiters = this.idleWaiters.filter((candidate) => candidate !== waiter);
				resolve(idle);
			};
			const deadline = setTimeout(() => finish(false), timeoutMs);
			this.idleWaiters.push(waiter);
			this.armIdleWaiters();
		});
	}

	private armIdleWaiters(): void {
		for (const waiter of this.idleWaiters) {
			if (waiter.timer) {
				clearTimeout(waiter.timer);
				waiter.timer = undefined;
			}
			if (this.inflight.size === 0) waiter.timer = setTimeout(() => waiter.resolve(), waiter.idleMs);
		}
	}

	async getBody(id: string): Promise<CapturedBody | undefined> {
		const entry = this.get(id);
		if (!entry) return undefined;
		if (entry.body) return entry.body;
		if (entry.bodyState === "none") return undefined;
		try {
			const response = await this.fetchBody(entry.requestId, entry.sessionId);
			const body = toCapturedBody(response);
			entry.body = body;
			entry.bodyState = "captured";
			return body;
		} catch (error) {
			entry.bodyState = "unavailable";
			throw error;
		}
	}

	// --- CDP event adapters -----------------------------------------------------------------

	onRequestWillBeSent(params: Protocol.Network.RequestWillBeSentEvent, sessionId?: string): NetworkEntry {
		const existing = this.byId.get(params.requestId);
		let redirectedFrom: string | undefined;
		if (existing && params.redirectResponse) {
			// Same requestId continues after a redirect: freeze the hop under a suffixed id.
			const hopIndex = this.entries.filter((entry) => entry.requestId === params.requestId).length;
			existing.id = `${params.requestId}:r${hopIndex}`;
			this.applyResponse(existing, params.redirectResponse);
			existing.endedAt = wallMs(params.wallTime);
			existing.durationMs = Math.max(0, existing.endedAt - existing.startedAt);
			existing.bodyState = "none";
			this.byId.set(existing.id, existing);
			this.byId.delete(params.requestId);
			redirectedFrom = existing.id;
		}
		const entry: NetworkEntry = {
			seq: this.nextSeq++,
			id: params.requestId,
			requestId: params.requestId,
			url: params.request.url + (params.request.urlFragment ?? ""),
			method: params.request.method,
			type: params.type ?? "Other",
			frameId: params.frameId,
			loaderId: params.loaderId,
			sessionId,
			startedAt: wallMs(params.wallTime),
			initiator: describeInitiator(params.initiator),
			requestHeaders: { ...params.request.headers },
			postData: params.request.postData !== undefined ? params.request.postData.slice(0, MAX_POST_DATA_CHARS) : undefined,
			hasPostData: params.request.hasPostData,
			bodyState: "pending",
			redirectedFrom,
		};
		const pending = this.pendingExtraInfo.get(params.requestId);
		if (pending) {
			Object.assign(entry, pending);
			this.pendingExtraInfo.delete(params.requestId);
		}
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		// blob: and data: URLs never touch the network and Chrome does not always report them finished.
		if (/^(https?|wss?):/i.test(entry.url)) {
			this.inflight.add(params.requestId);
			this.armIdleWaiters();
		}
		this.trim();
		return entry;
	}

	onRequestWillBeSentExtraInfo(params: Protocol.Network.RequestWillBeSentExtraInfoEvent): void {
		const entry = this.byId.get(params.requestId);
		if (entry) {
			entry.requestHeaders = { ...entry.requestHeaders, ...params.headers };
			return;
		}
		const pending = this.pendingExtraInfo.get(params.requestId) ?? {};
		pending.requestHeaders = { ...(pending.requestHeaders ?? {}), ...params.headers };
		this.pendingExtraInfo.set(params.requestId, pending);
	}

	onResponseReceived(params: Protocol.Network.ResponseReceivedEvent): void {
		this.inflight.delete(params.requestId);
		this.armIdleWaiters();
		const entry = this.byId.get(params.requestId);
		if (!entry) return;
		entry.type = params.type;
		this.applyResponse(entry, params.response);
		// Provisional timing (time to response headers). Chrome never reports loadingFinished for a
		// fetch() whose body the page did not read, so this may be the only timing we get.
		entry.endedAt = Date.now();
		entry.durationMs = Math.max(0, entry.endedAt - entry.startedAt);
		entry.encodedBytes ??= params.response.encodedDataLength;
	}

	onResponseReceivedExtraInfo(params: Protocol.Network.ResponseReceivedExtraInfoEvent): void {
		const entry = this.byId.get(params.requestId);
		if (!entry) return;
		entry.responseHeaders = { ...(entry.responseHeaders ?? {}), ...params.headers };
		if (entry.status === undefined) entry.status = params.statusCode;
	}

	onRequestServedFromCache(params: Protocol.Network.RequestServedFromCacheEvent): void {
		const entry = this.byId.get(params.requestId);
		if (entry) entry.fromCache = true;
	}

	onLoadingFinished(params: Protocol.Network.LoadingFinishedEvent): void {
		this.inflight.delete(params.requestId);
		this.armIdleWaiters();
		const entry = this.byId.get(params.requestId);
		if (!entry) return;
		entry.endedAt = Date.now();
		entry.durationMs = Math.max(0, entry.endedAt - entry.startedAt);
		entry.encodedBytes = params.encodedDataLength;
		void this.captureBodyEagerly(entry);
	}

	onLoadingFailed(params: Protocol.Network.LoadingFailedEvent): void {
		this.inflight.delete(params.requestId);
		this.armIdleWaiters();
		const entry = this.byId.get(params.requestId);
		if (!entry) return;
		entry.endedAt = Date.now();
		entry.durationMs = Math.max(0, entry.endedAt - entry.startedAt);
		entry.failed = params.errorText || (params.canceled ? "canceled" : "failed");
		entry.canceled = params.canceled;
		entry.blockedReason = params.blockedReason;
		entry.bodyState = "none";
		if (params.type) entry.type = params.type;
	}

	onWebSocketCreated(params: Protocol.Network.WebSocketCreatedEvent): void {
		const entry: NetworkEntry = {
			seq: this.nextSeq++,
			id: params.requestId,
			requestId: params.requestId,
			url: params.url,
			method: "GET",
			type: "WebSocket",
			startedAt: Date.now(),
			initiator: params.initiator ? describeInitiator(params.initiator) : undefined,
			requestHeaders: {},
			bodyState: "none",
			websocket: { frames: [] },
		};
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.trim();
	}

	onWebSocketHandshakeResponseReceived(params: Protocol.Network.WebSocketHandshakeResponseReceivedEvent): void {
		const entry = this.byId.get(params.requestId);
		if (!entry) return;
		entry.status = params.response.status;
		entry.statusText = params.response.statusText;
		entry.responseHeaders = { ...params.response.headers };
		if (params.response.requestHeaders) entry.requestHeaders = { ...params.response.requestHeaders };
	}

	onWebSocketFrame(direction: "sent" | "received", params: Protocol.Network.WebSocketFrameSentEvent | Protocol.Network.WebSocketFrameReceivedEvent): void {
		const entry = this.byId.get(params.requestId);
		if (!entry?.websocket) return;
		entry.websocket.frames.push({
			direction,
			timestamp: Date.now(),
			opcode: params.response.opcode,
			data: params.response.payloadData.slice(0, 2000),
		});
		if (entry.websocket.frames.length > MAX_WS_FRAMES) entry.websocket.frames.splice(0, entry.websocket.frames.length - MAX_WS_FRAMES);
	}

	onWebSocketClosed(params: Protocol.Network.WebSocketClosedEvent): void {
		const entry = this.byId.get(params.requestId);
		if (!entry?.websocket) return;
		entry.websocket.closed = true;
		entry.endedAt = Date.now();
	}

	onEventSourceMessage(params: Protocol.Network.EventSourceMessageReceivedEvent): void {
		const entry = this.byId.get(params.requestId);
		if (!entry) return;
		entry.eventSourceMessages ??= [];
		entry.eventSourceMessages.push({ timestamp: Date.now(), eventName: params.eventName, data: params.data.slice(0, 2000) });
		if (entry.eventSourceMessages.length > MAX_WS_FRAMES) entry.eventSourceMessages.splice(0, entry.eventSourceMessages.length - MAX_WS_FRAMES);
	}

	markMocked(networkRequestId: string): void {
		const entry = this.byId.get(networkRequestId);
		if (entry) entry.mocked = true;
	}

	/** Forget in-flight bookkeeping for a session that went away (navigation to a new process, detach). */
	resetInflight(): void {
		this.inflight.clear();
		this.armIdleWaiters();
	}

	/**
	 * A main-frame navigation committed with loaderId. Requests of earlier documents may never report
	 * completion (their renderer is gone; Chrome still delivers browser-side ExtraInfo events for them),
	 * so they must stop counting as in flight. Returns how many were dropped.
	 */
	dropInflightFromOtherLoaders(loaderId: string): number {
		let dropped = 0;
		for (const entry of this.entries) {
			if (!this.inflight.has(entry.requestId) || entry.loaderId === loaderId) continue;
			this.inflight.delete(entry.requestId);
			if (entry.failed === undefined && entry.status === undefined) {
				entry.failed = "net::ERR_ABORTED";
				entry.canceled = true;
				entry.bodyState = "none";
				entry.endedAt = Date.now();
				entry.durationMs = Math.max(0, entry.endedAt - entry.startedAt);
			}
			dropped += 1;
		}
		if (dropped > 0) this.armIdleWaiters();
		return dropped;
	}

	// --- internals --------------------------------------------------------------------------

	private applyResponse(entry: NetworkEntry, response: Protocol.Network.Response): void {
		entry.status = response.status;
		entry.statusText = response.statusText;
		entry.mimeType = response.mimeType;
		entry.protocol = response.protocol;
		entry.remoteAddress = response.remoteIPAddress ? `${response.remoteIPAddress}:${response.remotePort ?? ""}` : undefined;
		entry.fromCache = response.fromDiskCache || response.fromPrefetchCache || entry.fromCache;
		entry.fromServiceWorker = response.fromServiceWorker;
		entry.responseHeaders = { ...(entry.responseHeaders ?? {}), ...response.headers };
		if (response.requestHeaders) entry.requestHeaders = { ...entry.requestHeaders, ...response.requestHeaders };
	}

	private async captureBodyEagerly(entry: NetworkEntry): Promise<void> {
		if (entry.bodyState !== "pending") return;
		const size = entry.encodedBytes ?? 0;
		const textLike = entry.mimeType ? TEXT_MIME.test(entry.mimeType) : false;
		if (!textLike) {
			entry.bodyState = "binary";
			return;
		}
		if (size > MAX_EAGER_BODY_BYTES || this.totalBodyBytes > MAX_TOTAL_BODY_BYTES) {
			entry.bodyState = "too-large";
			return;
		}
		try {
			const response = await this.fetchBody(entry.requestId, entry.sessionId);
			const body = toCapturedBody(response);
			entry.body = body;
			entry.bodyState = "captured";
			this.totalBodyBytes += body.bytes;
		} catch {
			entry.bodyState = "unavailable";
		}
	}

	private trim(): void {
		if (this.entries.length <= MAX_ENTRIES) return;
		const removed = this.entries.splice(0, this.entries.length - MAX_ENTRIES);
		for (const entry of removed) {
			this.byId.delete(entry.id);
			if (entry.body) this.totalBodyBytes -= entry.body.bytes;
		}
	}
}

function toCapturedBody(response: { body: string; base64Encoded: boolean }): CapturedBody {
	return {
		text: response.body,
		base64Encoded: response.base64Encoded,
		bytes: response.base64Encoded ? Math.floor((response.body.length * 3) / 4) : Buffer.byteLength(response.body, "utf8"),
	};
}

function wallMs(wallTimeSeconds: number): number {
	return Math.round(wallTimeSeconds * 1000);
}

function describeInitiator(initiator: Protocol.Network.Initiator): string {
	if (initiator.type === "parser") return `parser ${initiator.url ?? ""}`.trim();
	if (initiator.type === "script") {
		const frame = initiator.stack?.callFrames.find((candidate) => candidate.url);
		return frame ? `script ${frame.url}:${frame.lineNumber + 1}` : "script";
	}
	return initiator.type;
}

function matchStatus(status: number | undefined, wanted: string | number): boolean {
	if (status === undefined) return false;
	if (typeof wanted === "number") return status === wanted;
	const text = wanted.trim();
	if (/^\d{3}$/.test(text)) return status === Number(text);
	const range = /^(\d)xx$/i.exec(text);
	if (range) return Math.floor(status / 100) === Number(range[1]);
	const compare = /^(>=|<=|>|<|=)\s*(\d{3})$/.exec(text);
	if (compare) {
		const value = Number(compare[2]);
		switch (compare[1]) {
			case ">=":
				return status >= value;
			case "<=":
				return status <= value;
			case ">":
				return status > value;
			case "<":
				return status < value;
			default:
				return status === value;
		}
	}
	return false;
}

/** How a request ended when it did not succeed, or undefined when it did (or is still pending). */
export function failureKind(entry: NetworkEntry): "failed" | "blocked" | "aborted" | "canceled" | undefined {
	if (entry.failed === undefined) return entry.status !== undefined && entry.status >= 400 ? "failed" : undefined;
	// A chrome_route abort surfaces as ERR_BLOCKED_BY_CLIENT.Inspector; an ad blocker as plain ERR_BLOCKED_BY_CLIENT.
	if (entry.mocked) return "aborted";
	if (entry.failed.startsWith("net::ERR_BLOCKED_BY_CLIENT")) return "blocked";
	if (entry.canceled || entry.failed === "net::ERR_ABORTED") return "canceled";
	return "failed";
}

export function formatBytes(bytes: number | undefined): string {
	if (bytes === undefined) return "-";
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatNetworkEntry(entry: NetworkEntry): string {
	const kind = failureKind(entry);
	const failure = kind === "blocked" ? "BLOCKED(by browser extension)" : kind === "aborted" ? "ABORTED(by chrome_route)" : kind === "canceled" ? "CANCELED(by the page)" : entry.failed !== undefined ? `FAILED(${entry.failed})` : undefined;
	// When the server answered and the load then failed (an error page with no body), both facts matter.
	const status = entry.status !== undefined && failure ? `${entry.status} ${failure}` : (failure ?? (entry.status !== undefined ? String(entry.status) : "…"));
	const parts = [`#${entry.seq}`, entry.method, status, entry.type.toLowerCase(), formatBytes(entry.encodedBytes), entry.durationMs !== undefined ? `${entry.durationMs}ms` : "-"];
	if (entry.fromCache) parts.push("(cache)");
	if (entry.mocked && entry.failed === undefined) parts.push("(routed)");
	let line = `${parts.join(" ")} ${entry.url}`;
	if (entry.redirectedFrom) line += ` (redirected)`;
	if (entry.websocket) line += ` [ws frames: ${entry.websocket.frames.length}${entry.websocket.closed ? ", closed" : ""}]`;
	return line;
}
