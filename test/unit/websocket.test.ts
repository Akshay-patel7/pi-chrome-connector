import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { acceptWebSocketUpgrade, computeAcceptKey, type WebSocketConnection } from "../../extensions/chrome/bridge/websocket.ts";

// Node's built-in WebSocket client (undici) is an independent, spec-compliant peer.

async function startServer(): Promise<{ port: number; connections: WebSocketConnection[]; close: () => Promise<void> }> {
	const connections: WebSocketConnection[] = [];
	const server = createServer();
	server.on("upgrade", (request, socket, head) => {
		const connection = acceptWebSocketUpgrade(request, socket, head);
		if (connection) connections.push(connection);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no address");
	return {
		port: address.port,
		connections,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

function waitForOpen(socket: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("socket error")), { once: true });
	});
}

function nextMessage(socket: WebSocket): Promise<string> {
	return new Promise((resolve) => socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true }));
}

test("accept key follows RFC 6455 example", () => {
	assert.equal(computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("echoes small, medium (16-bit length) and large (64-bit length) text messages", async () => {
	const server = await startServer();
	try {
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}/extension`);
		await waitForOpen(socket);
		const connection = server.connections[0];
		assert.ok(connection);
		connection.on("message", (data) => connection.send(data));

		for (const size of [10, 200, 70_000, 1_500_000]) {
			const payload = "x".repeat(size - 1) + "€"; // multi-byte tail exercises utf8 boundaries
			const reply = nextMessage(socket);
			socket.send(payload);
			assert.equal(await reply, payload, `round trip of ${size} chars`);
		}
		socket.close();
	} finally {
		await server.close();
	}
});

test("close handshake reports the peer's code and reason", async () => {
	const server = await startServer();
	try {
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}/extension`);
		await waitForOpen(socket);
		const connection = server.connections[0];
		assert.ok(connection);
		const closed = new Promise<[number, string]>((resolve) => connection.on("close", (code, reason) => resolve([code, reason])));
		socket.close(4001, "done testing");
		const [code, reason] = await closed;
		assert.equal(code, 4001);
		assert.equal(reason, "done testing");
		assert.equal(connection.isOpen, false);
	} finally {
		await server.close();
	}
});

test("server-initiated close is observed by the client", async () => {
	const server = await startServer();
	try {
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}/extension`);
		await waitForOpen(socket);
		const clientClosed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
		server.connections[0]?.close(1001, "going away");
		const event = await clientClosed;
		assert.equal(event.code, 1001);
		assert.equal(event.reason, "going away");
	} finally {
		await server.close();
	}
});

test("rejects non-websocket upgrade requests", async () => {
	const server = await startServer();
	try {
		const response = await fetch(`http://127.0.0.1:${server.port}/extension`, {
			headers: { connection: "upgrade", upgrade: "websocket" },
		}).catch((error: Error) => error);
		// Either an HTTP 400 or a socket error is acceptable; a hang is not.
		if (response instanceof Response) assert.equal(response.status, 400);
	} finally {
		await server.close();
	}
});
