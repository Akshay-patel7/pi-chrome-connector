// lazyTools (the default): only the `chrome` tool is declared to the model; calling it declares the
// chrome_* tools and reports the connection. Deferred tools stay callable without being declared.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FakePi } from "./fake-pi.ts";
import type { FixtureServer } from "./harness.ts";
import { startToolTestEnv, type ToolTestEnv } from "./setup.ts";

let env: ToolTestEnv;
let pi: FakePi;
let fixtures: FixtureServer;

before(async () => {
	env = await startToolTestEnv("tools-lazy", { lazyTools: true });
	({ pi, fixtures } = env);
});

after(async () => {
	await env.close();
});

test("only the chrome tool is declared until it is called; its description names every chrome_* tool", async () => {
	assert.deepEqual([...pi.activeTools], ["chrome"]);
	const chromeTools = [...pi.tools.keys()].filter((name) => name !== "chrome");
	assert.equal(chromeTools.length, 27);
	for (const name of chromeTools) {
		assert.equal(pi.tools.get(name)?.exposure, "deferred", `${name} is deferred`);
		assert.ok(pi.tools.get("chrome")?.description.includes(name), `chrome tool description names ${name}`);
	}
	assert.ok((pi.tools.get("chrome")?.description.length ?? 0) < 900, "the one declared description stays short");

	const result = await pi.callTool("chrome", {});
	assert.match(result.text, /^Declared 27 chrome_\* tools for this session\.\nConnected: bridge 127\.0\.0\.1:\d+, extension v/);
	assert.match(result.text, /Finds and actions wait up to 5 s/);
	assert.equal(pi.activeTools.size, 28);
	for (const name of chromeTools) assert.ok(pi.activeTools.has(name), `${name} active after chrome`);

	const again = await pi.callTool("chrome", {});
	assert.match(again.text, /^The chrome_\* tools were already declared\.\nConnected:/);
	assert.equal(pi.activeTools.size, 28);
});

test("deferred tools run whether or not they are declared", async () => {
	const loaded = await pi.callTool("chrome_navigate", { url: `${fixtures.url}/index.html` });
	assert.match(loaded.text, /^Loaded: "Fixture index"/);
});
