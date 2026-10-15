import assert from "node:assert/strict";
import { test } from "node:test";
import { shortUrl } from "../../extensions/chrome/tools/shared.ts";
import { timeoutFrom } from "../../extensions/chrome/tools/targets.ts";

test("shortUrl keeps short URLs and cuts long query strings after the path", () => {
	assert.equal(shortUrl("https://app.example.com/home"), "https://app.example.com/home");
	const oauth = `https://accounts.google.com/v3/signin/accountchooser?client_id=${"x".repeat(300)}&state=${"y".repeat(500)}`;
	const short = shortUrl(oauth);
	assert.ok(short.length <= 120, `cut to ${short.length} chars`);
	assert.ok(short.startsWith("https://accounts.google.com/v3/signin/accountchooser?client_id="), "origin, path and the start of the query survive");
	assert.ok(short.endsWith("\u2026"));
	const longPath = `https://example.com/${"segment/".repeat(40)}`;
	assert.equal(shortUrl(longPath).length, 120);
	assert.equal(shortUrl("not a url ".repeat(20)).length, 120, "non-URL text is cut too");
	assert.equal(shortUrl("https://example.com/a?b=c", 10), "https://e\u2026", "a cap smaller than the base falls back to a plain cut");
});

test("timeoutFrom applies the default and clamps", () => {
	assert.equal(timeoutFrom(undefined), 5_000);
	assert.equal(timeoutFrom(0), 0);
	assert.equal(timeoutFrom(-5), 0);
	assert.equal(timeoutFrom(250.9), 250);
	assert.equal(timeoutFrom(10_000_000), 120_000);
	assert.equal(timeoutFrom(Number.NaN), 5_000);
});
