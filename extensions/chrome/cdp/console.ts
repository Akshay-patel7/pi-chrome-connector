// Node-side buffer of everything the DevTools console would show for a tab:
// console.* calls, uncaught exceptions, and browser-level log entries (network failures,
// CSP violations, deprecations, mixed content).

import type { Protocol } from "devtools-protocol";
import { describeRemoteObject, formatExceptionDetails, formatStackTrace } from "./remote-object.ts";

export type ConsoleLevel = "error" | "warning" | "info" | "log" | "debug";
export type ConsoleSource = "console" | "exception" | "browser" | "network";

export interface ConsoleEntry {
	seq: number;
	timestamp: number;
	level: ConsoleLevel;
	source: ConsoleSource;
	/** Message text, arguments already joined. */
	text: string;
	/** Category for browser log entries (network, security, deprecation, ...). */
	category?: string;
	location?: string;
	stack?: string;
	/** For duplicate consecutive messages. */
	count: number;
}

export interface ConsoleFilter {
	/** Minimum severity to include. "error" = errors only; "warning" = warnings and errors; "log" = everything but debug. */
	level?: ConsoleLevel | "all";
	/** Only entries with seq greater than this. */
	sinceSeq?: number;
	/** Substring match on text, case-insensitive. */
	includes?: string;
	limit?: number;
}

const LEVEL_RANK: Record<ConsoleLevel, number> = { error: 0, warning: 1, info: 2, log: 2, debug: 3 };
const MAX_ENTRIES = 2000;

export class ConsoleLog {
	private entries: ConsoleEntry[] = [];
	private nextSeq = 1;

	get size(): number {
		return this.entries.length;
	}

	get lastSeq(): number {
		return this.nextSeq - 1;
	}

	clear(): void {
		this.entries = [];
	}

	push(entry: Omit<ConsoleEntry, "seq" | "count">): ConsoleEntry {
		const last = this.entries[this.entries.length - 1];
		// Network failures for different URLs stay separate; the URL is what matters.
		if (last && last.text === entry.text && last.level === entry.level && last.source === entry.source && last.location === entry.location) {
			last.count += 1;
			last.timestamp = entry.timestamp;
			return last;
		}
		const full: ConsoleEntry = { ...entry, seq: this.nextSeq++, count: 1 };
		this.entries.push(full);
		if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
		return full;
	}

	list(filter: ConsoleFilter = {}): ConsoleEntry[] {
		const minRank = filter.level === undefined || filter.level === "all" ? Number.POSITIVE_INFINITY : LEVEL_RANK[filter.level];
		const needle = filter.includes?.toLowerCase();
		let matched = this.entries.filter((entry) => {
			if (filter.sinceSeq !== undefined && entry.seq <= filter.sinceSeq) return false;
			if (LEVEL_RANK[entry.level] > minRank) return false;
			if (needle && !entry.text.toLowerCase().includes(needle)) return false;
			return true;
		});
		if (filter.limit !== undefined && matched.length > filter.limit) matched = matched.slice(matched.length - filter.limit);
		return matched;
	}

	/** Entries at or above a level since seq. Network failures are excluded: the network log already counts them. */
	countSince(seq: number, level: ConsoleLevel): number {
		return this.entries.filter((entry) => entry.seq > seq && entry.source !== "network" && LEVEL_RANK[entry.level] <= LEVEL_RANK[level]).length;
	}

	// --- CDP event adapters -----------------------------------------------------------------

	onConsoleApiCalled(params: Protocol.Runtime.ConsoleAPICalledEvent): ConsoleEntry {
		const level = consoleApiLevel(params.type);
		const text = params.args.map((arg) => describeRemoteObject(arg)).join(" ");
		const top = params.stackTrace?.callFrames[0];
		return this.push({
			timestamp: params.timestamp,
			level,
			source: "console",
			text: params.type === "log" || params.type === "info" || params.type === "warning" || params.type === "error" || params.type === "debug" ? text : `console.${params.type}: ${text}`,
			location: top ? `${top.url}:${top.lineNumber + 1}:${top.columnNumber + 1}` : undefined,
			stack: level === "error" && params.stackTrace ? formatStackTrace(params.stackTrace, 5) : undefined,
		});
	}

	onExceptionThrown(params: Protocol.Runtime.ExceptionThrownEvent): ConsoleEntry {
		const details = params.exceptionDetails;
		const text = formatExceptionDetails(details);
		const top = details.stackTrace?.callFrames[0];
		return this.push({
			timestamp: params.timestamp,
			level: "error",
			source: "exception",
			text: text.startsWith("Uncaught") ? text : `Uncaught ${text}`,
			location: top ? `${top.url}:${top.lineNumber + 1}:${top.columnNumber + 1}` : details.url ? `${details.url}:${details.lineNumber + 1}:${details.columnNumber + 1}` : undefined,
		});
	}

	onLogEntryAdded(params: Protocol.Log.EntryAddedEvent): ConsoleEntry {
		const entry = params.entry;
		const level: ConsoleLevel = entry.level === "error" ? "error" : entry.level === "warning" ? "warning" : entry.level === "info" ? "info" : "log";
		const location = entry.url ? `${entry.url}${entry.lineNumber !== undefined ? `:${entry.lineNumber + 1}` : ""}` : undefined;
		return this.push({
			timestamp: entry.timestamp,
			level,
			source: entry.source === "network" ? "network" : "browser",
			category: entry.source,
			text: entry.text,
			location,
			stack: entry.stackTrace && level === "error" ? formatStackTrace(entry.stackTrace, 5) : undefined,
		});
	}
}

function consoleApiLevel(type: Protocol.Runtime.ConsoleAPICalledEvent["type"]): ConsoleLevel {
	switch (type) {
		case "error":
		case "assert":
			return "error";
		case "warning":
			return "warning";
		case "info":
			return "info";
		case "debug":
		case "trace":
			return "debug";
		default:
			return "log";
	}
}

export function formatConsoleEntry(entry: ConsoleEntry, options: { includeStack?: boolean; includeLocation?: boolean } = {}): string {
	const prefix = `[${entry.level}${entry.source !== "console" ? `/${entry.category ?? entry.source}` : ""}]`;
	let line = `#${entry.seq} ${prefix} ${entry.text}`;
	if (entry.count > 1) line += ` (x${entry.count})`;
	if (options.includeLocation !== false && entry.location) {
		// For network entries the URL is the message; for console calls it is the call site.
		line += entry.source === "network" ? `  ${entry.location}` : entry.source === "console" ? `  @ ${shortLocation(entry.location)}` : "";
	}
	if (options.includeStack && entry.stack) line += `\n${entry.stack}`;
	return line;
}

export function shortLocation(location: string): string {
	try {
		const match = /^(.*?)(:\d+(?::\d+)?)?$/.exec(location);
		const urlPart = match?.[1] ?? location;
		const suffix = match?.[2] ?? "";
		const url = new URL(urlPart);
		const path = url.pathname.split("/").filter(Boolean).slice(-2).join("/") || url.host;
		return `${path}${suffix}`;
	} catch {
		return location;
	}
}
