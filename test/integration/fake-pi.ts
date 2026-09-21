// Just enough of pi's ExtensionAPI to load the extension and invoke tools and commands directly.

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

type AnyTool = ToolDefinition<any, any, any>;
type Handler = (event: unknown, ctx: unknown) => unknown;

export interface ToolCallResult {
	text: string;
	images: Array<{ mimeType: string; data: string }>;
	details: unknown;
}

export class FakePi {
	readonly tools = new Map<string, AnyTool>();
	readonly commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }>();
	readonly handlers = new Map<string, Handler[]>();
	readonly entries: Array<{ customType: string; data: unknown }> = [];
	readonly notifications: string[] = [];
	confirmAnswer = false;

	get api(): ExtensionAPI {
		const self = this;
		const api: Partial<ExtensionAPI> = {
			registerTool(definition) {
				self.tools.set(definition.name, definition as AnyTool);
			},
			registerCommand(name, options) {
				self.commands.set(name, options as { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void });
			},
			on(event: string, handler: Handler) {
				const list = self.handlers.get(event) ?? [];
				list.push(handler);
				self.handlers.set(event, list);
				return () => {
					self.handlers.set(event, (self.handlers.get(event) ?? []).filter((candidate) => candidate !== handler));
				};
			},
			appendEntry(customType: string, data?: unknown) {
				self.entries.push({ customType, data });
			},
		} as Partial<ExtensionAPI>;
		return api as ExtensionAPI;
	}

	get context(): ExtensionContext {
		const self = this;
		const ui = {
			notify: (message: string) => {
				self.notifications.push(message);
			},
			confirm: async () => self.confirmAnswer,
			select: async () => undefined,
			input: async () => undefined,
			setStatus: () => {},
			setWidget: () => {},
		};
		return {
			cwd: process.cwd(),
			hasUI: false,
			mode: "print",
			ui,
			signal: undefined,
			sessionManager: {
				getBranch: () => self.entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })),
				getEntries: () => self.entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data })),
			},
		} as unknown as ExtensionContext;
	}

	async emit(event: string, payload: unknown = {}): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) await handler(payload, this.context);
	}

	async callTool(name: string, params: Record<string, unknown> = {}): Promise<ToolCallResult> {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`tool ${name} is not registered (have: ${[...this.tools.keys()].join(", ")})`);
		// pi validates tool arguments against the TypeBox schema before calling execute; do the same so
		// tests exercise the schemas rather than only the implementations.
		if (!Value.Check(tool.parameters, params)) {
			const first = [...Value.Errors(tool.parameters, params)][0];
			throw new Error(`${name}: parameters do not match the schema: ${first?.message ?? "unknown error"} (got ${JSON.stringify(params)})`);
		}
		const result = await tool.execute(`call-${Date.now()}`, params, undefined, undefined, this.context);
		const text = result.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const images = result.content.filter((part): part is { type: "image"; mimeType: string; data: string } => part.type === "image");
		return { text, images, details: result.details };
	}

	async runCommand(name: string, args = ""): Promise<string[]> {
		const command = this.commands.get(name);
		if (!command) throw new Error(`command ${name} is not registered`);
		const before = this.notifications.length;
		await command.handler(args, this.context as ExtensionCommandContext);
		return this.notifications.slice(before);
	}
}
