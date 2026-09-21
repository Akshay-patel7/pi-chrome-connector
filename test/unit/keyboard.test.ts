import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCharacter, describeKey, macEditingCommands, needsShift, parseChord } from "../../extensions/chrome/cdp/keyboard.ts";

test("named keys, aliases and function keys", () => {
	assert.deepEqual(describeKey("Enter"), { key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
	assert.equal(describeKey("return").code, "Enter");
	assert.equal(describeKey("esc").key, "Escape");
	assert.equal(describeKey("down").code, "ArrowDown");
	assert.deepEqual(describeKey("F5"), { key: "F5", code: "F5", keyCode: 116 });
	assert.equal(describeKey("cmd").code, "MetaLeft");
	assert.throws(() => describeKey("Bogus"), /Unknown key "Bogus"/);
});

test("characters map to US layout codes, shifted symbols keep their physical key", () => {
	assert.deepEqual(describeCharacter("a"), { key: "a", code: "KeyA", keyCode: 65, text: "a" });
	assert.deepEqual(describeCharacter("A"), { key: "A", code: "KeyA", keyCode: 65, text: "A" });
	assert.deepEqual(describeCharacter("7"), { key: "7", code: "Digit7", keyCode: 55, text: "7" });
	assert.deepEqual(describeCharacter("&"), { key: "&", code: "Digit7", keyCode: 55, text: "&" });
	assert.deepEqual(describeCharacter("?"), { key: "?", code: "Slash", keyCode: 191, text: "?" });
	assert.deepEqual(describeCharacter("é"), { key: "é", code: "", keyCode: 0, text: "é" });
	assert.equal(needsShift("A"), true);
	assert.equal(needsShift("a"), false);
	assert.equal(needsShift("!"), true);
});

test("chords combine modifiers and infer Shift for uppercase or shifted symbols", () => {
	const chord = parseChord("Control+Shift+p");
	assert.equal(chord.key.code, "KeyP");
	assert.equal(chord.modifiers, 2 | 8);
	assert.deepEqual(chord.modifierNames, ["Control", "Shift"]);

	const upper = parseChord("Meta+P");
	assert.equal(upper.modifiers, 4 | 8, "uppercase letter implies Shift");

	const plus = parseChord("Shift++");
	assert.equal(plus.key.key, "+");
	assert.equal(plus.modifiers, 8);

	const lone = parseChord("+");
	assert.equal(lone.key.key, "+");

	const modifierOnly = parseChord("Shift");
	assert.equal(modifierOnly.key.code, "ShiftLeft");
	assert.equal(modifierOnly.modifiers, 0);

	assert.throws(() => parseChord("a+b"), /names two keys/);
});

test("macOS editing commands are attached to Cmd shortcuts", () => {
	assert.deepEqual(macEditingCommands(parseChord("Meta+a")), ["selectAll"]);
	assert.deepEqual(macEditingCommands(parseChord("Cmd+Shift+z")), ["redo"]);
	assert.deepEqual(macEditingCommands(parseChord("Option+Backspace")), ["deleteWordBackward"]);
	assert.equal(macEditingCommands(parseChord("Control+c")), undefined);
	assert.equal(macEditingCommands(parseChord("Enter")), undefined);
});
