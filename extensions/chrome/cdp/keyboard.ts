// Key names -> CDP Input.dispatchKeyEvent descriptions (US layout), chord parsing, and the
// macOS editing commands Chrome needs to honor Cmd-shortcuts sent through the protocol.

export interface KeyDescription {
	key: string;
	code: string;
	keyCode: number;
	/** Text inserted by the key press, when printable. */
	text?: string;
	location?: number;
}

export const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
export type ModifierName = keyof typeof MODIFIER_BITS;

type Entry = [key: string, code: string, keyCode: number, shifted?: string];

const NAMED: Record<string, Entry> = {
	Enter: ["Enter", "Enter", 13],
	Tab: ["Tab", "Tab", 9],
	Backspace: ["Backspace", "Backspace", 8],
	Delete: ["Delete", "Delete", 46],
	Escape: ["Escape", "Escape", 27],
	Space: [" ", "Space", 32],
	ArrowUp: ["ArrowUp", "ArrowUp", 38],
	ArrowDown: ["ArrowDown", "ArrowDown", 40],
	ArrowLeft: ["ArrowLeft", "ArrowLeft", 37],
	ArrowRight: ["ArrowRight", "ArrowRight", 39],
	Home: ["Home", "Home", 36],
	End: ["End", "End", 35],
	PageUp: ["PageUp", "PageUp", 33],
	PageDown: ["PageDown", "PageDown", 34],
	Insert: ["Insert", "Insert", 45],
	CapsLock: ["CapsLock", "CapsLock", 20],
	NumLock: ["NumLock", "NumLock", 144],
	ScrollLock: ["ScrollLock", "ScrollLock", 145],
	Pause: ["Pause", "Pause", 19],
	PrintScreen: ["PrintScreen", "PrintScreen", 44],
	ContextMenu: ["ContextMenu", "ContextMenu", 93],
	Shift: ["Shift", "ShiftLeft", 16],
	Control: ["Control", "ControlLeft", 17],
	Alt: ["Alt", "AltLeft", 18],
	Meta: ["Meta", "MetaLeft", 91],
};
for (let n = 1; n <= 12; n++) NAMED[`F${n}`] = [`F${n}`, `F${n}`, 111 + n];

const PUNCTUATION: Entry[] = [
	["`", "Backquote", 192, "~"],
	["-", "Minus", 189, "_"],
	["=", "Equal", 187, "+"],
	["[", "BracketLeft", 219, "{"],
	["]", "BracketRight", 221, "}"],
	["\\", "Backslash", 220, "|"],
	[";", "Semicolon", 186, ":"],
	["'", "Quote", 222, '"'],
	[",", "Comma", 188, "<"],
	[".", "Period", 190, ">"],
	["/", "Slash", 191, "?"],
];
const DIGIT_SHIFT = [")", "!", "@", "#", "$", "%", "^", "&", "*", "("];

const ALIASES: Record<string, string> = {
	return: "Enter",
	enter: "Enter",
	esc: "Escape",
	escape: "Escape",
	space: "Space",
	spacebar: "Space",
	del: "Delete",
	delete: "Delete",
	backspace: "Backspace",
	tab: "Tab",
	up: "ArrowUp",
	down: "ArrowDown",
	left: "ArrowLeft",
	right: "ArrowRight",
	arrowup: "ArrowUp",
	arrowdown: "ArrowDown",
	arrowleft: "ArrowLeft",
	arrowright: "ArrowRight",
	pgup: "PageUp",
	pageup: "PageUp",
	pgdn: "PageDown",
	pagedown: "PageDown",
	home: "Home",
	end: "End",
	insert: "Insert",
	ctrl: "Control",
	control: "Control",
	alt: "Alt",
	option: "Alt",
	opt: "Alt",
	meta: "Meta",
	cmd: "Meta",
	command: "Meta",
	super: "Meta",
	win: "Meta",
	windows: "Meta",
	shift: "Shift",
	capslock: "CapsLock",
	plus: "+",
	minus: "-",
};

/** Describe a single key by name ("Enter", "a", "A", "%", "ArrowLeft"). Throws on unknown names. */
export function describeKey(name: string): KeyDescription {
	const alias = ALIASES[name.toLowerCase()];
	const canonical = alias ?? name;
	const named = NAMED[canonical] ?? NAMED[capitalize(canonical)];
	if (named) {
		const [key, code, keyCode] = named;
		if (key === " ") return { key, code, keyCode, text: " " };
		if (key === "Enter") return { key, code, keyCode, text: "\r" };
		return { key, code, keyCode };
	}
	if (canonical.length === 1) return describeCharacter(canonical);
	if (/^F\d{1,2}$/i.test(canonical)) {
		const entry = NAMED[canonical.toUpperCase()];
		if (entry) return { key: entry[0], code: entry[1], keyCode: entry[2] };
	}
	throw new Error(`Unknown key "${name}". Use a character, a named key (Enter, Tab, Escape, ArrowDown, F5, ...), or a chord like Control+a / Meta+Shift+p.`);
}

/** Describe a printable character, including the Shift-produced symbols on a US layout. */
export function describeCharacter(char: string): KeyDescription {
	if (/^[a-z]$/.test(char)) return { key: char, code: `Key${char.toUpperCase()}`, keyCode: char.toUpperCase().charCodeAt(0), text: char };
	if (/^[A-Z]$/.test(char)) return { key: char, code: `Key${char}`, keyCode: char.charCodeAt(0), text: char };
	if (/^[0-9]$/.test(char)) return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), text: char };
	const digitIndex = DIGIT_SHIFT.indexOf(char);
	if (digitIndex >= 0) return { key: char, code: `Digit${digitIndex}`, keyCode: 48 + digitIndex, text: char };
	if (char === " ") return { key: " ", code: "Space", keyCode: 32, text: " " };
	if (char === "\n" || char === "\r") return { key: "Enter", code: "Enter", keyCode: 13, text: "\r" };
	if (char === "\t") return { key: "Tab", code: "Tab", keyCode: 9 };
	for (const [key, code, keyCode, shifted] of PUNCTUATION) {
		if (char === key) return { key, code, keyCode, text: key };
		if (char === shifted) return { key: shifted, code, keyCode, text: shifted };
	}
	// Anything else (unicode, accented letters): no physical key, Chrome inserts the text.
	return { key: char, code: "", keyCode: 0, text: char };
}

/** Does producing this character on a US keyboard require Shift? */
export function needsShift(char: string): boolean {
	return /^[A-Z]$/.test(char) || DIGIT_SHIFT.includes(char) || PUNCTUATION.some(([, , , shifted]) => shifted === char);
}

export interface Chord {
	key: KeyDescription;
	modifiers: number;
	modifierNames: ModifierName[];
}

/** Parse "Control+Shift+p", "Meta+a", "Enter", "Shift++" into a key plus modifier bitmask. */
export function parseChord(chord: string): Chord {
	const trimmed = chord.trim();
	if (!trimmed) throw new Error("Empty key chord.");
	const parts = trimmed.split("+");
	// "Shift++" or "+" alone: a trailing empty part means the literal plus key.
	const keys: string[] = [];
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index] as string;
		if (part === "" && index === parts.length - 1 && keys.length < parts.length) keys.push("+");
		else if (part !== "") keys.push(part);
	}
	if (keys.length === 0) keys.push("+");
	const modifierNames: ModifierName[] = [];
	let modifiers = 0;
	let keyName: string | undefined;
	for (const part of keys) {
		const alias = ALIASES[part.toLowerCase()] ?? part;
		if (alias === "Control" || alias === "Alt" || alias === "Meta" || alias === "Shift") {
			if (!modifierNames.includes(alias)) {
				modifierNames.push(alias);
				modifiers |= MODIFIER_BITS[alias];
			}
			continue;
		}
		if (keyName !== undefined) throw new Error(`Chord "${chord}" names two keys (${keyName} and ${part}). Use one key plus modifiers, or separate chords with spaces.`);
		keyName = part;
	}
	if (keyName === undefined) {
		// Modifier alone, e.g. "Shift": press the modifier key itself.
		const last = modifierNames.pop();
		if (!last) throw new Error(`Chord "${chord}" has no key.`);
		modifiers &= ~MODIFIER_BITS[last];
		return { key: describeKey(last), modifiers, modifierNames };
	}
	const key = describeKey(keyName);
	if (keyName.length === 1 && needsShift(keyName) && !modifierNames.includes("Shift")) {
		modifierNames.push("Shift");
		modifiers |= MODIFIER_BITS.Shift;
	}
	return { key, modifiers, modifierNames };
}

/** Cocoa editing commands Chrome must receive alongside Cmd/Option shortcuts on macOS. */
const MAC_EDITING_COMMANDS: Record<string, string[]> = {
	"Meta+a": ["selectAll"],
	"Meta+c": ["copy"],
	"Meta+v": ["paste"],
	"Meta+x": ["cut"],
	"Meta+z": ["undo"],
	"Meta+Shift+z": ["redo"],
	"Meta+ArrowLeft": ["moveToBeginningOfLine"],
	"Meta+ArrowRight": ["moveToEndOfLine"],
	"Meta+ArrowUp": ["moveToBeginningOfDocument"],
	"Meta+ArrowDown": ["moveToEndOfDocument"],
	"Meta+Shift+ArrowLeft": ["moveToBeginningOfLineAndModifySelection"],
	"Meta+Shift+ArrowRight": ["moveToEndOfLineAndModifySelection"],
	"Meta+Shift+ArrowUp": ["moveToBeginningOfDocumentAndModifySelection"],
	"Meta+Shift+ArrowDown": ["moveToEndOfDocumentAndModifySelection"],
	"Meta+Backspace": ["deleteToBeginningOfLine"],
	"Alt+ArrowLeft": ["moveWordLeft"],
	"Alt+ArrowRight": ["moveWordRight"],
	"Alt+Shift+ArrowLeft": ["moveWordLeftAndModifySelection"],
	"Alt+Shift+ArrowRight": ["moveWordRightAndModifySelection"],
	"Alt+Backspace": ["deleteWordBackward"],
	"Alt+Delete": ["deleteWordForward"],
	"Control+a": ["moveToBeginningOfParagraph"],
	"Control+e": ["moveToEndOfParagraph"],
	"Control+k": ["deleteToEndOfParagraph"],
};

export function macEditingCommands(chord: Chord): string[] | undefined {
	const order: ModifierName[] = ["Control", "Alt", "Meta", "Shift"];
	const names = order.filter((name) => chord.modifierNames.includes(name));
	const keyName = chord.key.key.length === 1 ? chord.key.key.toLowerCase() : chord.key.key;
	return MAC_EDITING_COMMANDS[[...names, keyName].join("+")];
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}
