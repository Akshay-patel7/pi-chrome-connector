// Turn CDP RemoteObjects (console arguments, evaluate results) into compact text the model can read.

import type { Protocol } from "devtools-protocol";

const DEFAULT_MAX_CHARS = 400;

export function describeRemoteObject(object: Protocol.Runtime.RemoteObject, maxChars = DEFAULT_MAX_CHARS): string {
	return clip(describe(object), maxChars);
}

function describe(object: Protocol.Runtime.RemoteObject): string {
	if (object.type === "string") return object.value as string;
	if (object.type === "undefined") return "undefined";
	if (object.type === "number" || object.type === "boolean" || object.type === "bigint") {
		if (object.unserializableValue) return object.unserializableValue;
		return String(object.value);
	}
	if (object.type === "symbol" || object.type === "function") return object.description ?? object.type;
	if (object.subtype === "null") return "null";
	if (object.subtype === "error") return firstLines(object.description ?? "Error", 3);
	if (object.subtype === "node") return object.description ?? "<node>";
	if (object.preview) return describePreview(object.preview);
	if (object.value !== undefined) return safeJson(object.value);
	return object.description ?? object.className ?? object.type;
}

function describePreview(preview: Protocol.Runtime.ObjectPreview): string {
	if (preview.subtype === "array" || preview.subtype === "typedarray") {
		const items = preview.properties.map((property) => describeProperty(property));
		return `[${items.join(", ")}${preview.overflow ? ", …" : ""}]`;
	}
	if (preview.subtype === "map" || preview.subtype === "set") {
		const entries = (preview.entries ?? []).map((entry) =>
			entry.key ? `${describePreview(entry.key)} => ${describePreview(entry.value)}` : describePreview(entry.value),
		);
		return `${preview.description ?? preview.subtype} {${entries.join(", ")}${preview.overflow ? ", …" : ""}}`;
	}
	if (preview.subtype === "date" || preview.subtype === "regexp") return preview.description ?? preview.subtype;
	const fields = preview.properties.map((property) => `${property.name}: ${describeProperty(property)}`);
	const prefix = preview.description && preview.description !== "Object" ? `${preview.description} ` : "";
	return `${prefix}{${fields.join(", ")}${preview.overflow ? ", …" : ""}}`;
}

function describeProperty(property: Protocol.Runtime.PropertyPreview): string {
	if (property.valuePreview) return describePreview(property.valuePreview);
	if (property.type === "string") return JSON.stringify(property.value ?? "");
	if (property.type === "object" && property.subtype === "null") return "null";
	if (property.type === "object") {
		// CDP previews are one level deep; mirror DevTools' collapsed rendering for nested values.
		if (property.value === "Object") return "{…}";
		return property.value ?? property.subtype ?? "Object";
	}
	return property.value ?? property.type;
}

export function formatExceptionDetails(details: Protocol.Runtime.ExceptionDetails, maxChars = 2000): string {
	let text = "";
	if (details.exception) {
		text = details.exception.description ?? describe(details.exception);
	} else {
		text = details.text;
	}
	if (!details.exception?.description && details.stackTrace) {
		text += `\n${formatStackTrace(details.stackTrace)}`;
	} else if (!details.stackTrace && details.url) {
		text += `\n    at ${details.url}:${details.lineNumber + 1}:${details.columnNumber + 1}`;
	}
	return clip(text, maxChars);
}

export function formatStackTrace(stack: Protocol.Runtime.StackTrace, maxFrames = 8): string {
	const frames = stack.callFrames.slice(0, maxFrames).map((frame) => {
		const name = frame.functionName || "<anonymous>";
		return `    at ${name} (${frame.url || "<eval>"}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`;
	});
	if (stack.callFrames.length > maxFrames) frames.push(`    … ${stack.callFrames.length - maxFrames} more frames`);
	return frames.join("\n");
}

export function safeJson(value: unknown, indent?: number): string {
	try {
		const text = JSON.stringify(value, null, indent);
		return text === undefined ? String(value) : text;
	} catch {
		return String(value);
	}
}

export function clip(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}… [${text.length - maxChars} more chars]`;
}

export function firstLines(text: string, count: number): string {
	const lines = text.split("\n");
	if (lines.length <= count) return text;
	return `${lines.slice(0, count).join("\n")}\n    … ${lines.length - count} more lines`;
}
