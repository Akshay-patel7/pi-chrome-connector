// Request interception rules backed by the CDP Fetch domain: mock a response, abort, delay,
// or let the request continue with modified headers.

import type { Protocol } from "devtools-protocol";

export interface RouteResponse {
	status: number;
	headers: Record<string, string>;
	/** Raw body; base64 when `base64` is true. */
	body: string;
	base64?: boolean;
}

export interface RouteRule {
	id: number;
	/** CDP Fetch glob: `*` matches any chars, `?` one char. */
	urlPattern: string;
	method?: string;
	action: "fulfill" | "abort" | "continue";
	response?: RouteResponse;
	abortReason?: Protocol.Network.ErrorReason;
	delayMs?: number;
	/** Extra request headers when action is "continue". */
	setHeaders?: Record<string, string>;
	hits: number;
	/** Captured request bodies for each hit (post data), newest last. */
	captured: Array<{ url: string; method: string; postData?: string; headers: Record<string, string>; timestamp: number }>;
}

const MAX_CAPTURED_PER_RULE = 50;

export class RouteTable {
	private rules: RouteRule[] = [];
	private nextId = 1;

	get size(): number {
		return this.rules.length;
	}

	list(): RouteRule[] {
		return [...this.rules];
	}

	add(rule: Omit<RouteRule, "id" | "hits" | "captured">): RouteRule {
		const full: RouteRule = { ...rule, id: this.nextId++, hits: 0, captured: [] };
		this.rules.push(full);
		return full;
	}

	remove(id: number): boolean {
		const before = this.rules.length;
		this.rules = this.rules.filter((rule) => rule.id !== id);
		return this.rules.length !== before;
	}

	clear(): void {
		this.rules = [];
	}

	/** Patterns to hand to Fetch.enable. */
	patterns(): Protocol.Fetch.RequestPattern[] {
		const unique = new Set(this.rules.map((rule) => rule.urlPattern));
		return [...unique].map((urlPattern) => ({ urlPattern, requestStage: "Request" as const }));
	}

	/** First rule matching the request, most recently added wins on ties. */
	match(url: string, method: string): RouteRule | undefined {
		for (let index = this.rules.length - 1; index >= 0; index--) {
			const rule = this.rules[index] as RouteRule;
			if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) continue;
			if (globToRegExp(rule.urlPattern).test(url)) return rule;
		}
		return undefined;
	}

	record(rule: RouteRule, request: Protocol.Fetch.RequestPausedEvent["request"]): void {
		rule.hits += 1;
		rule.captured.push({ url: request.url, method: request.method, postData: request.postData, headers: { ...request.headers }, timestamp: Date.now() });
		if (rule.captured.length > MAX_CAPTURED_PER_RULE) rule.captured.splice(0, rule.captured.length - MAX_CAPTURED_PER_RULE);
	}
}

const regexCache = new Map<string, RegExp>();

/** Convert a CDP-style URL glob (`*`, `?`, backslash escapes) to a RegExp. */
export function globToRegExp(pattern: string): RegExp {
	const cached = regexCache.get(pattern);
	if (cached) return cached;
	let source = "^";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index] as string;
		if (char === "\\" && index + 1 < pattern.length) {
			source += escapeRegExp(pattern[++index] as string);
		} else if (char === "*") {
			source += ".*";
		} else if (char === "?") {
			source += ".";
		} else {
			source += escapeRegExp(char);
		}
	}
	source += "$";
	const regex = new RegExp(source);
	regexCache.set(pattern, regex);
	return regex;
}

function escapeRegExp(char: string): string {
	return /[.*+?^${}()|[\]\\/]/.test(char) ? `\\${char}` : char;
}

export function headersToEntries(headers: Record<string, string>): Protocol.Fetch.HeaderEntry[] {
	return Object.entries(headers).map(([name, value]) => ({ name, value }));
}
