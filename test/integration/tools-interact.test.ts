// Phase 2 tools: snapshot, find, click, hover, fill (incl. secrets), type, press, scroll, select, upload, mouse, wait, dialog.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FakePi } from "./fake-pi.ts";
import { artifactsDir, type FixtureServer } from "./harness.ts";
import { startToolTestEnv, type ToolTestEnv } from "./setup.ts";

let env: ToolTestEnv;
let pi: FakePi;
let fixtures: FixtureServer;

const evaluate = async (expression: string) => (await pi.callTool("chrome_evaluate", { expression })).text;

before(async () => {
	env = await startToolTestEnv("tools-interact", { secrets: { TEST_PASSWORD: "hunter2-secret" } });
	({ pi, fixtures } = env);
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/form.html` });
});

after(async () => {
	await env.close();
});

test("chrome_snapshot lists controls with refs, states, offscreen and clickable markers", async () => {
	const snapshot = await pi.callTool("chrome_snapshot", {});
	assert.match(snapshot.text, /^Page: "Form fixture" .* — \d+ refs, mode interactive/);
	assert.match(snapshot.text, /^Page: [^\n]*\n- heading "Form fixture" \[e1\] level=1/, "a body-level click listener does not wrap the page in a named clickable generic");
	assert.match(snapshot.text, /- heading "Form fixture" \[e\d+\] level=1/);
	assert.match(snapshot.text, /- textbox "Name" \[e\d+\]/);
	assert.match(snapshot.text, /- textbox "Email" \[e\d+\] value="old@example.com"/);
	assert.match(snapshot.text, /- combobox "Favorite color" \[e\d+\]/);
	assert.match(snapshot.text, /- checkbox "I agree" \[e\d+\] unchecked/);
	assert.match(snapshot.text, /- button "Submit form" \[e\d+\]/);
	assert.match(snapshot.text, /- button "Far button" \[e\d+\] \[offscreen\]/);
	assert.match(snapshot.text, /- editable "editable text" \[e\d+\]\n/, "a control inside the viewport is not marked offscreen (Retina scaling)");
	assert.match(snapshot.text, /Clickable card.*\[clickable\]/, "div with click handler is flagged clickable");
	assert.doesNotMatch(snapshot.text, /Far away paragraph/, "plain text is not in interactive mode");
	assert.doesNotMatch(snapshot.text, /- generic \[e\d+\] \[clickable\]/, "nameless empty clickable divs are dropped");
	assert.match(snapshot.text, /- button "Row one" \[e\d+\] desc=\[1\][^\n]*\n.*- button "Row two" \[e\d+\] desc=\[1\]/, "repeated descriptions become footnotes");
	assert.match(snapshot.text, /\n\[1\] To pick up a draggable item, press the space bar\./);

	const full = await pi.callTool("chrome_snapshot", { mode: "full" });
	assert.match(full.text, /- text: "Far away paragraph"/);

	const scoped = await pi.callTool("chrome_snapshot", { selector: "#form" });
	assert.match(scoped.text, /Submit form/);
	assert.doesNotMatch(scoped.text, /Far button/);

	const capped = await pi.callTool("chrome_snapshot", { mode: "full", maxChars: 600 });
	assert.match(capped.text, /more lines? omitted/);
});

test("refs to nodes a framework replaced are reported stale instead of acted on", async () => {
	const ref = /textbox "Sidebar search" \[(e\d+)\]/.exec((await pi.callTool("chrome_snapshot", {})).text)?.[1];
	assert.ok(ref, "ref for the sidebar search");
	await evaluate("mountSidebar()");
	await assert.rejects(pi.callTool("chrome_fill", { ref, value: "x" }), /is no longer in the DOM; it was removed or re-rendered\. Take a new chrome_snapshot\. \(detached from the document\)/);
	await assert.rejects(pi.callTool("chrome_click", { ref }), /Unknown ref/, "stale ref is forgotten after the first failure");
	const fresh = /textbox "Sidebar search" \[(e\d+)\]/.exec((await pi.callTool("chrome_snapshot", {})).text)?.[1];
	assert.ok(fresh && fresh !== ref, "new snapshot yields a new ref");
	await pi.callTool("chrome_fill", { ref: fresh, value: "works" });
	assert.equal(await evaluate("document.getElementById('sidebar-search').value"), "works");
});

test("element screenshots have no side effects on responsive layouts", async () => {
	await pi.callTool("chrome_fill", { selector: "#sidebar-search", value: "keep me" });
	const mountsBefore = await evaluate("window.sidebarMounts");
	const shot = await pi.callTool("chrome_screenshot", { selector: "#sidebar-search", padding: 30, returnImage: false });
	assert.match(shot.text, /element <input id="sidebar-search"/);
	assert.equal(await evaluate("window.sidebarMounts"), mountsBefore, "no resize event fired by the element capture");
	assert.equal(await evaluate("document.getElementById('sidebar-search').value"), "keep me");
	const tall = await pi.callTool("chrome_screenshot", { selector: "body", returnImage: false });
	assert.match(tall.text, /larger than the viewport; captured the visible part/);
});

test("chrome_find by text, role and selector returns refs with context", async () => {
	await pi.callTool("chrome_scroll", { to: "top" });
	const byText = await pi.callTool("chrome_find", { text: "submit form" });
	assert.match(byText.text, /1 match:\n- button "Submit form" \[e\d+\]/);
	const byRole = await pi.callTool("chrome_find", { role: "textbox" });
	assert.match(byRole.text, /^4 matches:/);
	assert.match(byRole.text, /textbox "Name"/);
	assert.match(byRole.text, /textbox "Name" \[e\d+\]    \(in heading "Form fixture"\)/);
	const bySelector = await pi.callTool("chrome_find", { selector: "input[type=radio]" });
	assert.match(bySelector.text, /2 matches:\n- input type=radio "free" \[e\d+\]\n- input type=radio "pro" \[e\d+\]/);
	const none = await pi.callTool("chrome_find", { text: "does not exist anywhere" });
	assert.match(none.text, /No elements match/);
});

test("chrome_click by ref, text, selector; scrolls offscreen targets; reports occlusion", async () => {
	const ref = /button "Far button" \[(e\d+)\]/.exec((await pi.callTool("chrome_snapshot", {})).text)?.[1];
	assert.ok(ref, "ref for far button");
	const clicked = await pi.callTool("chrome_click", { ref });
	assert.match(clicked.text, /^Clicked <button id="far-button">Far button<\/button> at \(\d+, \d+\)\./);
	assert.equal(await evaluate("document.getElementById('far-result').textContent"), "far clicked");

	await pi.callTool("chrome_click", { text: "Clickable card" });
	assert.equal(await evaluate("document.getElementById('card-result').textContent"), "card clicked");

	await pi.callTool("chrome_click", { selector: "#open-modal" });
	await assert.rejects(pi.callTool("chrome_click", { selector: "#submit" }), /is covered by <div#overlay\.open> "Modal is open Close modal"\. Close or dismiss it first/);
	await pi.callTool("chrome_click", { text: "Close modal" });
	const submit = await pi.callTool("chrome_click", { selector: "#submit" });
	assert.match(submit.text, /^Clicked <button id="submit"/);
	assert.match(await evaluate("document.getElementById('submitted').textContent"), /^submitted:/);

	await assert.rejects(pi.callTool("chrome_click", { ref: "e9999" }), /Unknown ref "e9999"/);
	await assert.rejects(pi.callTool("chrome_click", { selector: "#nope" }), /No element matches selector "#nope"/);
});

test("chrome_fill covers text, textarea, email, checkbox, radio, select, date, number, contenteditable and secrets", async () => {
	const name = await pi.callTool("chrome_fill", { selector: "#name", value: "Ada Lovelace" });
	assert.match(name.text, /^Filled <input id="name" .*> with "Ada Lovelace"\./);
	assert.equal(await evaluate("document.getElementById('name').value"), "Ada Lovelace");
	assert.equal(await evaluate("document.body.dataset.lastInput"), "Ada Lovelace", "input event fired");

	await pi.callTool("chrome_fill", { selector: "#email", value: "new@example.com" });
	assert.equal(await evaluate("document.getElementById('email').value"), "new@example.com", "existing value replaced");
	await pi.callTool("chrome_fill", { selector: "#email", value: "" });
	assert.equal(await evaluate("document.getElementById('email').value"), "", "cleared");

	await pi.callTool("chrome_fill", { text: "Bio", value: "line one\nline two" });
	assert.equal(await evaluate("document.getElementById('bio').value"), "line one\nline two");

	const agree = await pi.callTool("chrome_fill", { selector: "#agree", value: "true" });
	assert.match(agree.text, /^Checked/);
	assert.equal(await evaluate("document.getElementById('agree').checked"), "true");
	assert.match((await pi.callTool("chrome_fill", { selector: "#agree", value: "true" })).text, /^Left checkbox already checked/);
	await pi.callTool("chrome_fill", { selector: "#agree", value: "toggle" });
	assert.equal(await evaluate("document.getElementById('agree').checked"), "false");

	await pi.callTool("chrome_fill", { text: "Pro", value: "true" });
	assert.equal(await evaluate("document.querySelector('input[name=plan]:checked')?.value"), "pro");

	const color = await pi.callTool("chrome_fill", { selector: "#color", value: "green" });
	assert.match(color.text, /^Selected "Green" \(value "green"\)/);
	assert.equal(await evaluate("document.getElementById('color').value"), "green");

	await pi.callTool("chrome_fill", { selector: "#when", value: "2026-09-20" });
	assert.equal(await evaluate("document.getElementById('when').value"), "2026-09-20");
	await assert.rejects(pi.callTool("chrome_fill", { selector: "#when", value: "Sept 20" }), /native format/);

	await pi.callTool("chrome_fill", { selector: "#qty", value: "42" });
	assert.equal(await evaluate("document.getElementById('qty').valueAsNumber"), "42");

	await pi.callTool("chrome_fill", { selector: "#editor", value: "rich text here" });
	assert.equal(await evaluate("document.getElementById('editor').textContent"), "rich text here");

	const secret = await pi.callTool("chrome_fill", { selector: "#name", secret: "TEST_PASSWORD" });
	assert.match(secret.text, /with \[secret TEST_PASSWORD\]\./);
	assert.doesNotMatch(secret.text, /hunter2/);
	assert.equal(await evaluate("document.getElementById('name').value"), "hunter2-secret");
	await assert.rejects(pi.callTool("chrome_fill", { selector: "#name", secret: "NOPE" }), /Unknown secret "NOPE". Known secret names: TEST_PASSWORD/);

	await assert.rejects(pi.callTool("chrome_fill", { selector: "#submit", value: "x" }), /is a button; use chrome_click/);
	await assert.rejects(pi.callTool("chrome_fill", { selector: "#file", value: "x" }), /use chrome_upload/);
});

test("chrome_type sends per-key events and chrome_press handles chords, sequences and mac shortcuts", async () => {
	await pi.callTool("chrome_fill", { selector: "#name", value: "" });
	await evaluate("document.getElementById('keys').textContent = ''");
	const typed = await pi.callTool("chrome_type", { selector: "#name", text: "Hi!\n" });
	assert.match(typed.text, /^Typed "Hi!\\n" into <input id="name"/);
	assert.equal(await evaluate("document.getElementById('name').value"), "Hi!");
	const keys = await evaluate("document.getElementById('keys').textContent");
	assert.match(keys, /Shift\+H\(KeyH\) i\(KeyI\) Shift\+!\(Digit1\) Enter\(Enter\)/);
	assert.match(await evaluate("document.getElementById('submitted').textContent"), /"name":"Hi!"/, "Enter submitted the form");

	await evaluate("document.getElementById('keys').textContent = ''");
	await pi.callTool("chrome_press", { keys: "Control+Shift+p Escape F5", selector: "#name" });
	assert.match(await evaluate("document.getElementById('keys').textContent"), /Control\+Control\(ControlLeft\) Control\+Shift\+Shift\(ShiftLeft\) Control\+Shift\+P\(KeyP\) Escape\(Escape\) F5\(F5\)/);

	await pi.callTool("chrome_fill", { selector: "#name", value: "select me" });
	await pi.callTool("chrome_press", { keys: process.platform === "darwin" ? "Meta+a" : "Control+a", selector: "#name" });
	assert.equal(await evaluate("(() => { const el = document.getElementById('name'); return el.selectionEnd - el.selectionStart; })()"), "9", "select-all shortcut selected the text");
	await pi.callTool("chrome_press", { keys: "Backspace" });
	assert.equal(await evaluate("document.getElementById('name').value"), "");

	const typedSecret = await pi.callTool("chrome_type", { selector: "#name", secret: "TEST_PASSWORD" });
	assert.doesNotMatch(typedSecret.text, /hunter2/);
	assert.equal(await evaluate("document.getElementById('name').value"), "hunter2-secret");
	await pi.callTool("chrome_type", { selector: "#name", text: "fresh", clear: true });
	assert.equal(await evaluate("document.getElementById('name').value"), "fresh");
});

test("chrome_select by label and value, with helpful errors", async () => {
	const byLabel = await pi.callTool("chrome_select", { selector: "#color", values: ["Blue"] });
	assert.match(byLabel.text, /^Selected "Blue" \(value "blue"\) in <select/);
	assert.equal(await evaluate("document.getElementById('color').value"), "blue");
	await pi.callTool("chrome_select", { text: "Favorite color", values: ["red"] });
	assert.equal(await evaluate("document.getElementById('color').value"), "red");
	await assert.rejects(pi.callTool("chrome_select", { selector: "#color", values: ["purple"] }), /No option matches "purple".*Available: "Pick" \(value ""\), "Red"/);
});

test("chrome_scroll on the page and inside a container; chrome_hover fires hover handlers", async () => {
	const down = await pi.callTool("chrome_scroll", { deltaY: 800 });
	assert.match(down.text, /^Scrolled page: scrollY (\d+) of \d+/);
	assert.ok(Number(/scrollY (\d+)/.exec(down.text)?.[1]) > 0);
	const top = await pi.callTool("chrome_scroll", { to: "top" });
	assert.match(top.text, /scrollY 0 of/);
	const container = await pi.callTool("chrome_scroll", { selector: "#scroller", deltaY: 300 });
	assert.match(container.text, /^Scrolled inside <div id="scroller".*: scrollTop (\d+) of/);
	assert.ok(Number(/scrollTop (\d+)/.exec(container.text)?.[1]) > 0, "container scrolled");
	const bottom = await pi.callTool("chrome_scroll", { selector: "#scroller", to: "bottom" });
	assert.match(bottom.text, /to bottom: scrollTop (\d+) of \1/);
	const into = await pi.callTool("chrome_scroll", { selector: "#far", to: "element" });
	assert.match(into.text, /into view/);

	await pi.callTool("chrome_scroll", { to: "top" });
	const hover = await pi.callTool("chrome_hover", { selector: "#hover-target" });
	assert.match(hover.text, /^Hovering <div id="hover-target">Hover me<\/div>\./);
	assert.equal(await evaluate("document.getElementById('hover-result').textContent"), "hovered");
});

test("chrome_upload attaches a file and chrome_mouse drags", async () => {
	const file = join(artifactsDir, "upload-fixture.txt");
	writeFileSync(file, "hello upload");
	const upload = await pi.callTool("chrome_upload", { selector: "#file", files: [file] });
	assert.match(upload.text, /^Attached 1 file to <input id="file"/);
	assert.equal(await evaluate("document.body.dataset.file"), "upload-fixture.txt:12");
	await assert.rejects(pi.callTool("chrome_upload", { selector: "#file", files: ["/definitely/missing.txt"] }), /File not found/);

	await evaluate("document.getElementById('keys').textContent = ''");
	await evaluate(`(() => { const c = document.getElementById('card'); c.addEventListener('mousedown', () => c.dataset.down = '1'); c.addEventListener('mouseup', (e) => c.dataset.up = e.clientX + ',' + e.clientY); })()`);
	const rect = JSON.parse(await evaluate("(() => { const r = document.getElementById('card').getBoundingClientRect(); return { x: Math.round(r.x + 10), y: Math.round(r.y + 10) }; })()")) as { x: number; y: number };
	const drag = await pi.callTool("chrome_mouse", { action: "drag", x: rect.x, y: rect.y, toX: rect.x + 50, toY: rect.y + 5, steps: 5 });
	assert.match(drag.text, /^Mouse drag at/);
	assert.equal(await evaluate("document.getElementById('card').dataset.down"), "1");
	assert.equal(await evaluate("document.getElementById('card').dataset.up"), `${Math.round(rect.x + 50)},${Math.round(rect.y + 5)}`);
});

test("chrome_wait resolves on selector/text/function/url conditions and times out with the last state", async () => {
	await evaluate("setTimeout(() => { const p = document.createElement('p'); p.id = 'late'; p.textContent = 'late content'; document.body.append(p); }, 400)");
	const late = await pi.callTool("chrome_wait", { selector: "#late", text: "late content" });
	assert.match(late.text, /^Condition met after \d+ms: selector #late visible and text "late content"\./);
	const fn = await pi.callTool("chrome_wait", { function: "document.querySelectorAll('p').length > 3" });
	assert.match(fn.text, /Condition met/);
	await assert.rejects(pi.callTool("chrome_wait", { selector: "#never", timeoutMs: 400 }), /Timed out after 400ms waiting for selector #never visible\. Last state: selector not in DOM/);
	await evaluate("setTimeout(() => history.pushState({}, '', '/form.html?stage=2'), 200)");
	const url = await pi.callTool("chrome_wait", { url: "/stage=\\d/" });
	assert.match(url.text, /Condition met after \d+ms: url ~/);
	const time = await pi.callTool("chrome_wait", { timeMs: 150 });
	assert.match(time.text, /Condition met after [12]\d\dms/);
});

test("chrome_dialog reports, accepts, dismisses and applies policies; blocked tools explain themselves", async () => {
	await pi.callTool("chrome_navigate", { url: `${fixtures.url}/dialog.html` });
	await assert.rejects(pi.callTool("chrome_click", { text: "Alert" }), /A JavaScript alert dialog is open: "hello from alert"/);
	await assert.rejects(pi.callTool("chrome_snapshot", {}), /alert dialog is open/);
	const status = await pi.callTool("chrome_dialog", { action: "status" });
	assert.match(status.text, /^Open alert dialog: "hello from alert"/);
	assert.match((await pi.callTool("chrome_dialog", { action: "accept" })).text, /^Accepted the alert dialog/);

	await assert.rejects(pi.callTool("chrome_click", { text: "Prompt" }), /prompt dialog is open/);
	await pi.callTool("chrome_dialog", { action: "accept", promptText: "Grace" });
	assert.equal(await evaluate("document.getElementById('result').textContent"), "name:Grace");

	await pi.callTool("chrome_dialog", { action: "policy", policy: "dismiss" });
	const confirm = await pi.callTool("chrome_click", { text: "Confirm" });
	assert.match(confirm.text, /^Clicked/);
	assert.equal(await evaluate("document.getElementById('result').textContent"), "declined");
	await pi.callTool("chrome_dialog", { action: "policy", policy: "manual" });
});
