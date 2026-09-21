import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { acceptWebSocketUpgrade, rejectUpgrade, type WebSocketConnection } from "./websocket.ts";
import {
	type ExtensionEvent,
	type HelloResult,
	isEventMessage,
	isResponseMessage,
	PROTOCOL_VERSION,
} from "./protocol.ts";

const HEARTBEAT_INTERVAL_MS = 20_000;
const HELLO_TIMEOUT_MS = 5_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type BridgeErrorCode = "disconnected" | "timeout" | "remote" | "protocol";

export class BridgeError extends Error {
	readonly code: BridgeErrorCode;

	constructor(message: string, code: BridgeErrorCode = "remote") {
		super(message);
		this.name = "BridgeError";
		this.code = code;
	}
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	method: string;
}

export interface ExtensionClientEvents {
	event: [event: ExtensionEvent];
	close: [reason: string];
}

/** One connected companion extension (one Chrome profile). */
export class ExtensionClient extends EventEmitter<ExtensionClientEvents> {
	readonly connectedAt = Date.now();
	info: HelloResult | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private heartbeat: NodeJS.Timeout | undefined;
	private closedReason: string | undefined;
	readonly id: number;
	private readonly connection: WebSocketConnection;

	constructor(id: number, connection: WebSocketConnection) {
		super();
		this.id = id;
		this.connection = connection;
		connection.on("message", (data) => this.onMessage(data));
		connection.on("close", (code, reason) => this.onClose(`socket closed (${code}${reason ? ` ${reason}` : ""})`));
		connection.on("error", () => {});
		this.heartbeat = setInterval(() => {
			this.request("ping", undefined, 10_000).catch(() => this.connection.terminate());
		}, HEARTBEAT_INTERVAL_MS);
		this.heartbeat.unref();
	}

	get isConnected(): boolean {
		return this.closedReason === undefined && this.connection.isOpen;
	}

	get origin(): string | undefined {
		const origin = this.connection.headers.origin;
		return typeof origin === "string" ? origin : undefined;
	}

	async handshake(): Promise<HelloResult> {
		const result = (await this.request("hello", undefined, HELLO_TIMEOUT_MS)) as HelloResult;
		if (!result || typeof result !== "object" || typeof result.version !== "string") {
			throw new BridgeError("companion extension sent an invalid hello", "protocol");
		}
		if (result.protocol !== PROTOCOL_VERSION) {
			throw new BridgeError(
				`companion extension speaks protocol ${result.protocol}, pi-chrome-connector expects ${PROTOCOL_VERSION}. Reload the extension at chrome://extensions after updating the package.`,
				"protocol",
			);
		}
		this.info = result;
		return result;
	}

	request(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
		if (!this.isConnected) {
			return Promise.reject(new BridgeError(`companion extension is disconnected (${this.closedReason ?? "socket not open"})`, "disconnected"));
		}
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new BridgeError(`${method} timed out after ${timeoutMs}ms waiting for the companion extension`, "timeout"));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer, method });
			try {
				this.connection.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	close(reason = "bridge closing"): void {
		this.connection.close(1001, reason);
		this.onClose(reason);
	}

	private onMessage(data: string): void {
		let message: unknown;
		try {
			message = JSON.parse(data);
		} catch {
			return;
		}
		if (isEventMessage(message)) {
			this.emit("event", message);
			return;
		}
		if (!isResponseMessage(message)) return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		clearTimeout(pending.timer);
		if (message.error) {
			pending.reject(new BridgeError(`${pending.method}: ${message.error.message}`, "remote"));
		} else {
			pending.resolve(message.result);
		}
	}

	private onClose(reason: string): void {
		if (this.closedReason !== undefined) return;
		this.closedReason = reason;
		if (this.heartbeat) clearInterval(this.heartbeat);
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			clearTimeout(pending.timer);
			pending.reject(new BridgeError(`companion extension disconnected while waiting for ${pending.method}`, "disconnected"));
		}
		this.emit("close", reason);
	}
}

export interface BridgeEvents {
	client: [client: ExtensionClient];
	clientClosed: [client: ExtensionClient, reason: string];
}

export interface BridgeOptions {
	/** Inclusive port range to try, in order. */
	portRange: readonly [number, number];
	/** Identifies this bridge in /status output. */
	label?: string;
}

/** Value of `name` in /status; the companion extension only opens a WebSocket to ports that report it. */
export const BRIDGE_NAME = "pi-chrome-connector";

/** Local WebSocket server the companion extension connects to. One per pi session. */
export class Bridge extends EventEmitter<BridgeEvents> {
	readonly clients = new Map<number, ExtensionClient>();
	/** Why the most recent companion connection was dropped during handshake, for diagnostics. */
	lastHandshakeError: string | undefined;
	private nextClientId = 1;
	private readonly sockets = new Set<Duplex>();
	readonly port: number;
	private readonly server: Server;
	private readonly label: string;

	private constructor(port: number, server: Server, label: string) {
		super();
		this.port = port;
		this.server = server;
		this.label = label;
		server.on("upgrade", (request, socket, head) => this.onUpgrade(request, socket, head));
		server.on("connection", (socket) => {
			this.sockets.add(socket);
			socket.on("close", () => this.sockets.delete(socket));
		});
	}

	static async listen(options: BridgeOptions): Promise<Bridge> {
		const [first, last] = options.portRange;
		let lastError: Error | undefined;
		for (let port = first; port <= last; port++) {
			const server = createServer();
			try {
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(port, "127.0.0.1", () => {
						server.off("error", reject);
						resolve();
					});
				});
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				server.close();
				continue;
			}
			const bridge = new Bridge(port, server, options.label ?? "pi-chrome-connector");
			server.on("request", (request, response) => bridge.onRequest(request.url ?? "/", response));
			return bridge;
		}
		throw new BridgeError(`no free port in ${first}-${last} for the Chrome bridge (${lastError?.message ?? "unknown error"})`, "protocol");
	}

	get connectedClients(): ExtensionClient[] {
		return [...this.clients.values()].filter((client) => client.isConnected && client.info !== undefined);
	}

	/** Resolve with a ready client, waiting up to timeoutMs for one to connect. */
	waitForClient(timeoutMs: number, signal?: AbortSignal): Promise<ExtensionClient | undefined> {
		const existing = this.connectedClients[0];
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve) => {
			const done = (client: ExtensionClient | undefined) => {
				clearTimeout(timer);
				this.off("client", onClient);
				signal?.removeEventListener("abort", onAbort);
				resolve(client);
			};
			const onClient = (client: ExtensionClient) => done(client);
			const onAbort = () => done(undefined);
			const timer = setTimeout(() => done(undefined), timeoutMs);
			this.on("client", onClient);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	async close(): Promise<void> {
		for (const client of this.clients.values()) client.close();
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private onRequest(url: string, response: import("node:http").ServerResponse): void {
		if (url === "/status") {
			const body = JSON.stringify({
				name: BRIDGE_NAME,
				label: this.label,
				protocol: PROTOCOL_VERSION,
				port: this.port,
				clients: this.connectedClients.map((client) => ({
					id: client.id,
					extensionId: client.info?.extensionId,
					version: client.info?.version,
					connectedAt: client.connectedAt,
				})),
			});
			response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			response.end(body);
			return;
		}
		response.writeHead(404, { "content-type": "text/plain" });
		response.end("pi-chrome-connector bridge. The companion extension connects at /extension over WebSocket.");
	}

	private onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
		const origin = request.headers.origin;
		if (request.url !== "/extension") {
			rejectUpgrade(socket, 404, "Not Found");
			return;
		}
		// Web pages cannot open this socket: the Origin header is set by the browser and
		// only the companion extension carries a chrome-extension:// origin.
		if (typeof origin !== "string" || !origin.startsWith("chrome-extension://")) {
			rejectUpgrade(socket, 403, "Forbidden");
			return;
		}
		const connection = acceptWebSocketUpgrade(request, socket, head);
		if (!connection) return;
		const client = new ExtensionClient(this.nextClientId++, connection);
		this.clients.set(client.id, client);
		client.on("close", (reason) => {
			this.clients.delete(client.id);
			this.emit("clientClosed", client, reason);
		});
		client
			.handshake()
			.then(() => {
				this.lastHandshakeError = undefined;
				this.emit("client", client);
			})
			.catch((error: Error) => {
				this.lastHandshakeError = error.message;
				client.close(error.message);
			});
	}
}
