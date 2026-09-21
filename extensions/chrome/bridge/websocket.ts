// Minimal RFC 6455 WebSocket server side. Only what the companion extension needs:
// text frames in both directions, ping/pong, close handshake, fragmented messages.
// No extensions (permessage-deflate is not negotiated), no subprotocols.

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;
const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

export function computeAcceptKey(secWebSocketKey: string): string {
	return createHash("sha1")
		.update(secWebSocketKey + WS_GUID)
		.digest("base64");
}

export interface WebSocketConnectionEvents {
	message: [data: string];
	close: [code: number, reason: string];
	error: [error: Error];
}

export class WebSocketConnection extends EventEmitter<WebSocketConnectionEvents> {
	readonly remoteAddress: string | undefined;
	readonly headers: IncomingMessage["headers"];
	private buffer: Buffer = Buffer.alloc(0);
	private fragments: Buffer[] = [];
	private fragmentOpcode: number | undefined;
	private closeSent = false;
	private closed = false;
	private readonly socket: Duplex;

	constructor(socket: Duplex, request: IncomingMessage) {
		super();
		this.socket = socket;
		this.headers = request.headers;
		this.remoteAddress = request.socket.remoteAddress;
		socket.on("data", (chunk: Buffer) => this.onData(chunk));
		socket.on("close", () => this.finish(1006, "connection lost"));
		socket.on("error", (error: Error) => {
			this.emit("error", error);
			this.finish(1006, error.message);
		});
	}

	get isOpen(): boolean {
		return !this.closed && !this.closeSent;
	}

	send(data: string): void {
		if (!this.isOpen) throw new Error("WebSocket is not open");
		this.writeFrame(OPCODE.text, Buffer.from(data, "utf8"));
	}

	ping(payload = ""): void {
		if (!this.isOpen) return;
		this.writeFrame(OPCODE.ping, Buffer.from(payload, "utf8"));
	}

	close(code = 1000, reason = ""): void {
		if (this.closed || this.closeSent) return;
		this.closeSent = true;
		const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
		const payload = Buffer.alloc(2 + reasonBytes.length);
		payload.writeUInt16BE(code, 0);
		reasonBytes.copy(payload, 2);
		this.writeFrame(OPCODE.close, payload);
		// Give the peer a moment to echo the close frame, then tear down regardless.
		setTimeout(() => this.finish(code, reason), 500).unref();
	}

	terminate(): void {
		this.finish(1006, "terminated");
	}

	private finish(code: number, reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.socket.destroy();
		this.emit("close", code, reason);
	}

	private fail(code: number, reason: string): void {
		this.close(code, reason);
		this.finish(code, reason);
	}

	private writeFrame(opcode: number, payload: Buffer): void {
		const length = payload.length;
		let header: Buffer;
		if (length < 126) {
			header = Buffer.alloc(2);
			header[1] = length;
		} else if (length < 65536) {
			header = Buffer.alloc(4);
			header[1] = 126;
			header.writeUInt16BE(length, 2);
		} else {
			header = Buffer.alloc(10);
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(length), 2);
		}
		header[0] = 0x80 | opcode; // FIN set, no RSV bits
		this.socket.write(Buffer.concat([header, payload]));
	}

	private onData(chunk: Buffer): void {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		while (!this.closed) {
			const frame = this.readFrame();
			if (!frame) return;
			this.handleFrame(frame.fin, frame.opcode, frame.payload);
		}
	}

	private readFrame(): { fin: boolean; opcode: number; payload: Buffer } | undefined {
		const buf = this.buffer;
		if (buf.length < 2) return undefined;
		const b0 = buf[0] as number;
		const b1 = buf[1] as number;
		const fin = (b0 & 0x80) !== 0;
		const rsv = b0 & 0x70;
		const opcode = b0 & 0x0f;
		const masked = (b1 & 0x80) !== 0;
		let length = b1 & 0x7f;
		let offset = 2;

		if (rsv !== 0) {
			this.fail(1002, "reserved bits set");
			return undefined;
		}
		if (!masked) {
			this.fail(1002, "client frames must be masked");
			return undefined;
		}
		if (length === 126) {
			if (buf.length < offset + 2) return undefined;
			length = buf.readUInt16BE(offset);
			offset += 2;
		} else if (length === 127) {
			if (buf.length < offset + 8) return undefined;
			const big = buf.readBigUInt64BE(offset);
			if (big > BigInt(MAX_MESSAGE_BYTES)) {
				this.fail(1009, "frame too large");
				return undefined;
			}
			length = Number(big);
			offset += 8;
		}
		if (buf.length < offset + 4 + length) return undefined;
		const mask = buf.subarray(offset, offset + 4);
		offset += 4;
		const payload = Buffer.allocUnsafe(length);
		for (let i = 0; i < length; i++) {
			payload[i] = (buf[offset + i] as number) ^ (mask[i & 3] as number);
		}
		this.buffer = buf.subarray(offset + length);
		return { fin, opcode, payload };
	}

	private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
		switch (opcode) {
			case OPCODE.text:
			case OPCODE.binary: {
				if (this.fragmentOpcode !== undefined) {
					this.fail(1002, "new data frame while a fragmented message is in progress");
					return;
				}
				if (fin) {
					this.deliver(opcode, payload);
				} else {
					this.fragmentOpcode = opcode;
					this.fragments = [payload];
				}
				return;
			}
			case OPCODE.continuation: {
				if (this.fragmentOpcode === undefined) {
					this.fail(1002, "continuation frame without a start frame");
					return;
				}
				this.fragments.push(payload);
				const total = this.fragments.reduce((sum, part) => sum + part.length, 0);
				if (total > MAX_MESSAGE_BYTES) {
					this.fail(1009, "message too large");
					return;
				}
				if (fin) {
					const dataOpcode = this.fragmentOpcode;
					const data = Buffer.concat(this.fragments);
					this.fragmentOpcode = undefined;
					this.fragments = [];
					this.deliver(dataOpcode, data);
				}
				return;
			}
			case OPCODE.ping: {
				if (this.isOpen) this.writeFrame(OPCODE.pong, payload);
				return;
			}
			case OPCODE.pong:
				return;
			case OPCODE.close: {
				const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
				const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
				if (!this.closeSent) {
					this.closeSent = true;
					this.writeFrame(OPCODE.close, payload.subarray(0, 2));
				}
				this.finish(code, reason);
				return;
			}
			default:
				this.fail(1002, `unknown opcode ${opcode}`);
		}
	}

	private deliver(opcode: number, payload: Buffer): void {
		if (opcode === OPCODE.binary) {
			this.fail(1003, "binary frames are not supported");
			return;
		}
		this.emit("message", payload.toString("utf8"));
	}
}

/**
 * Complete the HTTP upgrade handshake. Returns undefined (and responds with an HTTP error)
 * when the request is not a valid WebSocket upgrade.
 */
export function acceptWebSocketUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): WebSocketConnection | undefined {
	const key = request.headers["sec-websocket-key"];
	const version = request.headers["sec-websocket-version"];
	const upgrade = request.headers.upgrade?.toLowerCase();
	if (upgrade !== "websocket" || typeof key !== "string" || version !== "13") {
		socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
		socket.destroy();
		return undefined;
	}
	socket.write(
		[
			"HTTP/1.1 101 Switching Protocols",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Accept: ${computeAcceptKey(key)}`,
			"",
			"",
		].join("\r\n"),
	);
	if ("setNoDelay" in socket && typeof socket.setNoDelay === "function") socket.setNoDelay(true);
	const connection = new WebSocketConnection(socket, request);
	if (head.length > 0) socket.unshift(head);
	return connection;
}

export function rejectUpgrade(socket: Duplex, status: number, message: string): void {
	socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
	socket.destroy();
}
