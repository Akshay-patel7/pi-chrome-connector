// Session-scoped state: the bridge, the connected extension client, attached tab sessions,
// the dedicated agent window and the current tab. Everything the tools share.

import { EventEmitter } from "node:events";
import { type ChromeLauncher, ensureConnected } from "./bridge/launch.ts";
import type { TabInfo, WindowInfo } from "./bridge/protocol.ts";
import { Bridge, type ExtensionClient } from "./bridge/server.ts";
import { TabSession } from "./cdp/session.ts";
import type { ConnectorConfig } from "./config.ts";

export interface ConnectorState {
	currentTabId?: number;
	agentWindowId?: number;
	ownedTabIds: number[];
	focus: boolean;
}

export interface ConnectorEvents {
	stateChanged: [state: ConnectorState];
	progress: [message: string];
}

export interface TabListing {
	tabs: TabInfo[];
	windows: WindowInfo[];
}

export interface SessionOptions {
	/** Bring the window to the front (defaults to the session-wide focus setting). */
	focus?: boolean;
	signal?: AbortSignal;
}

export class Connector extends EventEmitter<ConnectorEvents> {
	readonly config: ConnectorConfig;
	readonly launcher: ChromeLauncher;
	private bridge: Bridge | undefined;
	private readonly sessions = new Map<number, TabSession>();
	private currentTabId: number | undefined;
	private agentWindowId: number | undefined;
	private readonly ownedTabIds = new Set<number>();
	private focusEnabled: boolean;
	private starting: Promise<Bridge> | undefined;

	constructor(config: ConnectorConfig, launcher: ChromeLauncher) {
		super();
		this.config = config;
		this.launcher = launcher;
		this.focusEnabled = config.focus;
	}

	// --- lifecycle --------------------------------------------------------------------------

	async start(): Promise<Bridge> {
		if (this.bridge) return this.bridge;
		if (!this.starting) {
			this.starting = Bridge.listen({ portRange: this.config.portRange }).then((bridge) => {
				this.bridge = bridge;
				bridge.on("clientClosed", () => {
					for (const session of this.sessions.values()) if (session.isClosed) this.sessions.delete(session.tabId);
				});
				bridge.on("client", (client) => this.watchClient(client));
				return bridge;
			});
			this.starting.catch(() => {
				this.starting = undefined;
			});
		}
		return this.starting;
	}

	async stop(): Promise<void> {
		const bridge = this.bridge;
		this.bridge = undefined;
		this.starting = undefined;
		const detachAll = [...this.sessions.values()].map((session) => session.detach().catch(() => {}));
		this.sessions.clear();
		await Promise.all(detachAll);
		if (bridge) await bridge.close();
	}

	get isStarted(): boolean {
		return this.bridge !== undefined;
	}

	get port(): number | undefined {
		return this.bridge?.port;
	}

	get connectedClient(): ExtensionClient | undefined {
		return this.bridge?.connectedClients[0];
	}

	get lastHandshakeError(): string | undefined {
		return this.bridge?.lastHandshakeError;
	}

	restoreState(state: Partial<ConnectorState>): void {
		if (typeof state.currentTabId === "number") this.currentTabId = state.currentTabId;
		if (typeof state.agentWindowId === "number") this.agentWindowId = state.agentWindowId;
		if (Array.isArray(state.ownedTabIds)) for (const id of state.ownedTabIds) if (typeof id === "number") this.ownedTabIds.add(id);
		if (typeof state.focus === "boolean") this.focusEnabled = state.focus;
	}

	get state(): ConnectorState {
		return { currentTabId: this.currentTabId, agentWindowId: this.agentWindowId, ownedTabIds: [...this.ownedTabIds], focus: this.focusEnabled };
	}

	get focus(): boolean {
		return this.focusEnabled;
	}

	setFocus(enabled: boolean): void {
		this.focusEnabled = enabled;
		this.emit("stateChanged", this.state);
	}

	private watchClient(client: ExtensionClient): void {
		client.on("event", (event) => {
			if (event.event === "tab.removed") {
				this.ownedTabIds.delete(event.tabId);
				this.sessions.delete(event.tabId);
				if (this.currentTabId === event.tabId) {
					this.currentTabId = undefined;
					this.emit("stateChanged", this.state);
				}
			} else if (event.event === "window.removed" && event.windowId === this.agentWindowId) {
				this.agentWindowId = undefined;
				this.emit("stateChanged", this.state);
			}
		});
	}

	// --- connection -------------------------------------------------------------------------

	/** Connected extension client, launching Chrome when needed. */
	async client(signal?: AbortSignal): Promise<ExtensionClient> {
		const bridge = await this.start();
		return ensureConnected({
			bridge,
			launcher: this.launcher,
			signal,
			onProgress: (message) => this.emit("progress", message),
		});
	}

	async listTabs(signal?: AbortSignal): Promise<TabListing> {
		const client = await this.client(signal);
		return (await client.request("tabs.list")) as TabListing;
	}

	// --- tabs and sessions ------------------------------------------------------------------

	get currentTab(): number | undefined {
		return this.currentTabId;
	}

	get agentWindow(): number | undefined {
		return this.agentWindowId;
	}

	ownsTab(tabId: number): boolean {
		return this.ownedTabIds.has(tabId);
	}

	/** Session for the current tab, creating the agent window and a tab on first use. */
	async currentSession(options: SessionOptions = {}): Promise<TabSession> {
		const client = await this.client(options.signal);
		if (this.currentTabId !== undefined) {
			const existing = await this.sessionFor(client, this.currentTabId).catch(() => undefined);
			if (existing) {
				await this.applyFocus(existing, options.focus);
				return existing;
			}
			this.currentTabId = undefined;
		}
		return this.newTab(undefined, options);
	}

	/** Open a new tab in the agent window (created on demand) and make it current. */
	async newTab(url: string | undefined, options: SessionOptions = {}): Promise<TabSession> {
		const client = await this.client(options.signal);
		const focus = options.focus ?? this.focusEnabled;
		const target = url ?? "about:blank";
		let tab: TabInfo;
		const windowId = await this.resolveAgentWindow(client);
		if (windowId === undefined) {
			const created = (await client.request("windows.create", {
				url: target,
				focused: focus,
				width: this.config.window.width,
				height: this.config.window.height,
			})) as WindowInfo;
			const first = created.tabs?.[0];
			if (!first) throw new Error("Chrome created a window without a tab");
			this.agentWindowId = created.id;
			tab = first;
		} else {
			tab = (await client.request("tabs.create", { url: target, windowId, active: true })) as TabInfo;
			if (focus) await client.request("windows.update", { windowId, focused: true }).catch(() => {});
		}
		this.ownedTabIds.add(tab.id);
		this.currentTabId = tab.id;
		this.emit("stateChanged", this.state);
		const session = await this.sessionFor(client, tab.id);
		return session;
	}

	/** Point the connector at an existing tab (yours or the user's) and attach to it. */
	async useTab(tabId: number, options: SessionOptions = {}): Promise<TabSession> {
		const client = await this.client(options.signal);
		const session = await this.sessionFor(client, tabId);
		this.currentTabId = tabId;
		this.emit("stateChanged", this.state);
		await this.applyFocus(session, options.focus);
		return session;
	}

	/** Attached session for a tab without changing the current tab. */
	async sessionForTab(tabId: number, signal?: AbortSignal): Promise<TabSession> {
		const client = await this.client(signal);
		return this.sessionFor(client, tabId);
	}

	async closeTab(tabId: number, signal?: AbortSignal): Promise<void> {
		const client = await this.client(signal);
		const session = this.sessions.get(tabId);
		if (session) {
			this.sessions.delete(tabId);
			await session.detach().catch(() => {});
		}
		await client.request("tabs.remove", { tabIds: [tabId] });
		this.ownedTabIds.delete(tabId);
		if (this.currentTabId === tabId) this.currentTabId = undefined;
		this.emit("stateChanged", this.state);
	}

	/** Close every tab this pi session created. Returns the number closed. */
	async cleanup(signal?: AbortSignal): Promise<number> {
		const client = await this.client(signal);
		const { tabs } = (await client.request("tabs.list")) as TabListing;
		const alive = tabs.filter((tab) => this.ownedTabIds.has(tab.id)).map((tab) => tab.id);
		for (const tabId of alive) {
			const session = this.sessions.get(tabId);
			if (session) {
				this.sessions.delete(tabId);
				await session.detach().catch(() => {});
			}
		}
		if (alive.length > 0) await client.request("tabs.remove", { tabIds: alive });
		this.ownedTabIds.clear();
		this.currentTabId = undefined;
		this.agentWindowId = undefined;
		this.emit("stateChanged", this.state);
		return alive.length;
	}

	attachedSessions(): TabSession[] {
		return [...this.sessions.values()].filter((session) => session.isAttached);
	}

	private async sessionFor(client: ExtensionClient, tabId: number): Promise<TabSession> {
		const existing = this.sessions.get(tabId);
		if (existing?.isAttached && existing.client === client) return existing;
		if (existing) this.sessions.delete(tabId);
		const session = await TabSession.open(client, tabId);
		session.on("closed", () => {
			if (this.sessions.get(tabId) === session) this.sessions.delete(tabId);
		});
		this.sessions.set(tabId, session);
		return session;
	}

	private async resolveAgentWindow(client: ExtensionClient): Promise<number | undefined> {
		if (this.agentWindowId !== undefined) {
			try {
				const win = (await client.request("windows.get", { windowId: this.agentWindowId })) as WindowInfo;
				if (win.type === "normal") return win.id;
			} catch {
				// Window closed since we last used it.
			}
			this.agentWindowId = undefined;
		}
		if (!this.config.reuseWindow) return undefined;
		const { tabs } = (await client.request("tabs.list")) as TabListing;
		const active = tabs.find((tab) => tab.active);
		return active?.windowId;
	}

	private async applyFocus(session: TabSession, focus: boolean | undefined): Promise<void> {
		if (focus ?? this.focusEnabled) await session.focus().catch(() => {});
	}
}
