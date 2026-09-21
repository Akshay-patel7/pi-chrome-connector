import assert from "node:assert/strict";
import { test } from "node:test";
import type { Protocol } from "devtools-protocol";
import { failureKind, formatNetworkEntry, NetworkLog } from "../../extensions/chrome/cdp/network.ts";

function log(): NetworkLog {
	return new NetworkLog(async () => ({ body: "", base64Encoded: false }));
}

function request(id: string, url: string, method = "GET", loaderId = "loader"): Protocol.Network.RequestWillBeSentEvent {
	return {
		requestId: id,
		loaderId,
		documentURL: "http://app.test/",
		request: { url, method, headers: {}, initialPriority: "High", referrerPolicy: "no-referrer" },
		timestamp: 1,
		wallTime: 1_700_000_000,
		initiator: { type: "script" },
		type: "Fetch",
		redirectHasExtraInfo: false,
	};
}

function failed(id: string, errorText: string, blockedReason?: Protocol.Network.BlockedReason): Protocol.Network.LoadingFailedEvent {
	return { requestId: id, timestamp: 2, type: "Fetch", errorText, canceled: false, blockedReason };
}

function response(id: string, status: number): Protocol.Network.ResponseReceivedEvent {
	return {
		requestId: id,
		loaderId: "loader",
		timestamp: 2,
		type: "Fetch",
		response: { url: "http://app.test/x", status, statusText: "", headers: {}, mimeType: "application/json", charset: "", connectionReused: false, connectionId: 1, encodedDataLength: 10, securityState: "secure" },
		hasExtraInfo: false,
	};
}

test("ad-blocker blocks, chrome_route aborts and real failures are told apart (strings as Chrome reports them)", () => {
	const network = log();
	network.onRequestWillBeSent(request("a", "https://events.launchdarkly.com/events/bulk/x", "POST"));
	network.onLoadingFailed(failed("a", "net::ERR_BLOCKED_BY_CLIENT"));
	network.onRequestWillBeSent(request("b", "https://api.test/orders/1/delete", "POST"));
	network.markMocked("b");
	network.onLoadingFailed(failed("b", "net::ERR_BLOCKED_BY_CLIENT.Inspector", "inspector"));
	network.onRequestWillBeSent(request("c", "https://api.test/orders"));
	network.onResponseReceived(response("c", 500));
	network.onRequestWillBeSent(request("d", "https://api.test/down"));
	network.onLoadingFailed(failed("d", "net::ERR_CONNECTION_REFUSED"));
	network.onRequestWillBeSent(request("e", "https://api.test/ok"));
	network.onResponseReceived(response("e", 200));
	network.onRequestWillBeSent(request("f", "https://clientstream.launchdarkly.com/eval/x"));
	network.onLoadingFailed({ ...failed("f", "net::ERR_ABORTED"), canceled: true });

	const [a, b, c, d, e, f] = network.list();
	assert.equal(failureKind(f!), "canceled");
	assert.match(formatNetworkEntry(f!), /^#6 GET CANCELED\(by the page\) fetch/);
	assert.equal(failureKind(a!), "blocked");
	assert.equal(failureKind(b!), "aborted");
	assert.equal(failureKind(c!), "failed");
	assert.equal(failureKind(d!), "failed");
	assert.equal(failureKind(e!), undefined);
	assert.deepEqual(network.countFailedSince(0), { failed: 2, blocked: 1, aborted: 1, canceled: 1 });
	assert.match(formatNetworkEntry(a!), /^#1 POST BLOCKED\(by browser extension\) fetch/);
	assert.match(formatNetworkEntry(b!), /^#2 POST ABORTED\(by chrome_route\) fetch/);
	assert.match(formatNetworkEntry(c!), /^#3 GET 500 fetch/);
	assert.match(formatNetworkEntry(d!), /^#4 GET FAILED\(net::ERR_CONNECTION_REFUSED\) fetch/);
	assert.equal(network.list({ failedOnly: true }).length, 5, "failedOnly keeps every non-success so nothing is hidden");
});

test("a main-frame navigation drops in-flight requests of the previous document", async () => {
	const network = log();
	// Token refresh started by the old document; its renderer goes away before it completes.
	network.onRequestWillBeSent(request("old-post", "https://auth.test/authenticate", "POST", "loader-old"));
	network.onRequestWillBeSent(request("old-preflight", "https://auth.test/authenticate", "OPTIONS", "loader-old"));
	network.onResponseReceivedExtraInfo({ requestId: "old-preflight", blockedCookies: [], headers: {}, resourceIPAddressSpace: "Public", statusCode: 204 });
	// The new document and one of its own requests, both already carrying the new loader id.
	network.onRequestWillBeSent(request("doc", "https://app.test/home", "GET", "loader-new"));
	network.onResponseReceived(response("doc", 200));
	network.onRequestWillBeSent(request("new-api", "https://api.test/me", "GET", "loader-new"));
	assert.equal(network.inflightCount, 3);

	const idle = network.waitForIdle(20, 1_000);
	assert.equal(network.dropInflightFromOtherLoaders("loader-new"), 2);
	assert.deepEqual(network.inflightUrls(), ["https://api.test/me"], "the new document's request still counts");
	const [oldPost, oldPreflight] = network.list();
	assert.equal(failureKind(oldPost!), "canceled", "an orphaned request reads as canceled by the page");
	assert.equal(oldPreflight!.status, 204, "a request that did get a status keeps it");
	network.onResponseReceived(response("new-api", 200));
	assert.equal(await idle, true);
});

test("blob: and data: requests never count as in flight; idle resolves once responses arrive", async () => {
	const network = log();
	network.onRequestWillBeSent(request("w", "blob:https://app.test/6e42b239"));
	assert.equal(network.inflightCount, 0);
	network.onRequestWillBeSent(request("x", "https://api.test/slow"));
	assert.equal(network.inflightCount, 1);
	assert.deepEqual(network.inflightUrls(), ["https://api.test/slow"]);
	const idle = network.waitForIdle(20, 1_000);
	network.onResponseReceived(response("x", 200));
	assert.equal(await idle, true);
	assert.equal(network.inflightCount, 0);
});
