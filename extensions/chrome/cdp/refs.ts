// Snapshot refs: short handles ("e12") the model uses to point at elements. Backed by CDP
// backendNodeIds, which stay valid for the lifetime of the DOM node, so a ref survives
// re-renders that keep the node and only dies when the node is removed or the page navigates.

export interface RefTarget {
	ref: string;
	backendNodeId: number;
	/** CDP child session that owns the node (undefined for the main frame session). */
	sessionId?: string;
	frameId?: string;
	role?: string;
	name?: string;
}

export class RefRegistry {
	private byRef = new Map<string, RefTarget>();
	private byNode = new Map<string, string>();
	private next = 1;
	/** Increments whenever refs are cleared (navigation). Lets callers explain stale refs. */
	generation = 0;

	get size(): number {
		return this.byRef.size;
	}

	assign(target: Omit<RefTarget, "ref">): RefTarget {
		const key = nodeKey(target.backendNodeId, target.sessionId);
		const existingRef = this.byNode.get(key);
		if (existingRef) {
			const existing = this.byRef.get(existingRef) as RefTarget;
			existing.role = target.role ?? existing.role;
			existing.name = target.name ?? existing.name;
			existing.frameId = target.frameId ?? existing.frameId;
			return existing;
		}
		const ref = `e${this.next++}`;
		const full: RefTarget = { ...target, ref };
		this.byRef.set(ref, full);
		this.byNode.set(key, ref);
		return full;
	}

	get(ref: string): RefTarget | undefined {
		return this.byRef.get(normalizeRef(ref));
	}

	forget(ref: string): void {
		const target = this.byRef.get(normalizeRef(ref));
		if (!target) return;
		this.byRef.delete(target.ref);
		this.byNode.delete(nodeKey(target.backendNodeId, target.sessionId));
	}

	clear(): void {
		this.byRef.clear();
		this.byNode.clear();
		this.next = 1;
		this.generation += 1;
	}
}

export function normalizeRef(ref: string): string {
	const trimmed = ref.trim().replace(/^@/, "");
	return /^\d+$/.test(trimmed) ? `e${trimmed}` : trimmed;
}

function nodeKey(backendNodeId: number, sessionId: string | undefined): string {
	return `${sessionId ?? "main"}:${backendNodeId}`;
}
