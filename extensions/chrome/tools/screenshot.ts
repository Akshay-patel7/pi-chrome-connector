import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import type { Protocol } from "devtools-protocol";
import type { TabSession } from "../cdp/session.ts";
import { clampInt, joinLines, pageLine, registerChromeTool, type ToolServices } from "./shared.ts";
import { hasTarget, resolveTarget, type TargetSpec } from "./targets.ts";

const MAX_FULL_PAGE_HEIGHT = 8000;
/**
 * Default cap on output width. A 1280 px viewport at 1:1 costs the model about 1,300 image tokens;
 * at 1024 wide about 850, and layout and most text stay readable. `scale` overrides it.
 */
const MAX_DEFAULT_WIDTH = 1024;

export interface ScreenshotOptions extends TargetSpec {
	fullPage?: boolean;
	format?: "png" | "jpeg";
	quality?: number;
	/** Output pixels per CSS pixel. Default: 1, reduced so the image is at most MAX_DEFAULT_WIDTH wide. */
	scale?: number;
	/** Extra CSS pixels of context around an element capture. */
	padding?: number;
}

export interface ScreenshotResult {
	data: string;
	mimeType: string;
	width: number;
	height: number;
	bytes: number;
	note?: string;
}

export async function captureScreenshot(session: TabSession, options: ScreenshotOptions): Promise<ScreenshotResult> {
	const format = options.format ?? "png";
	const metrics = await session.send("Page.getLayoutMetrics");
	const dpr = (await session.evaluate<number>("window.devicePixelRatio").catch(() => 1)) || 1;
	// Page scale factor: 1 normally, but Chrome zooms a non-responsive page out under device emulation
	// (a 1120 CSS px layout shown on a 393 px screen). Folding it in keeps one output pixel per
	// device-independent pixel, so a phone screenshot is phone-sized instead of a 9x zoomed-out render.
	const pageScale = metrics.cssVisualViewport.scale || 1;
	const viewport = metrics.cssVisualViewport;
	// Each clip starts at scale 1; the real scale is set below, once the clip width is known.
	const scale = 1;
	let clip: Protocol.Page.Viewport;
	let captureBeyondViewport = false;
	let note: string | undefined;

	if (hasTarget(options)) {
		const target = await resolveTarget(session, options);
		try {
			// Capture within the viewport. captureBeyondViewport re-lays out the page and fires resize
			// events, which responsive apps react to (re-mounting sidebars, dropping input state).
			await session.send("DOM.scrollIntoViewIfNeeded", { objectId: target.objectId }, { sessionId: target.sessionId }).catch(() => {});
			const rect = await session.callFunctionOn<{ x: number; y: number; width: number; height: number }>(
				target.objectId,
				"function () { const r = this.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }",
				[],
				{ sessionId: target.sessionId },
			);
			const box = rect.value;
			if (box.width === 0 || box.height === 0) throw new Error(`${target.description} has no visible box to screenshot.`);
			const padding = options.padding ?? 0;
			const after = await session.send("Page.getLayoutMetrics");
			const view = after.cssVisualViewport;
			const left = Math.max(0, box.x - padding);
			const top = Math.max(0, box.y - padding);
			const right = Math.min(view.clientWidth, box.x + box.width + padding);
			const bottom = Math.min(view.clientHeight, box.y + box.height + padding);
			if (right <= left || bottom <= top) throw new Error(`${target.description} is outside the viewport even after scrolling it into view.`);
			clip = { x: view.pageX + left, y: view.pageY + top, width: right - left, height: bottom - top, scale };
			const cropped = box.height + padding * 2 > view.clientHeight || box.width + padding * 2 > view.clientWidth;
			note = `element ${target.description}${cropped ? " (larger than the viewport; captured the visible part)" : ""}`;
		} finally {
			await session.releaseObject(target.objectId, target.sessionId);
		}
	} else if (options.fullPage) {
		const content = metrics.cssContentSize;
		const height = Math.min(content.height, MAX_FULL_PAGE_HEIGHT);
		clip = { x: 0, y: 0, width: content.width, height, scale };
		captureBeyondViewport = true;
		note = content.height > MAX_FULL_PAGE_HEIGHT ? `full page capped at ${MAX_FULL_PAGE_HEIGHT}px of ${Math.round(content.height)}px` : "full page";
	} else {
		clip = { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight, scale };
	}
	const perCssPixel = options.scale ?? Math.min(1, MAX_DEFAULT_WIDTH / Math.max(1, clip.width));
	clip.scale = (perCssPixel * pageScale) / dpr;

	const shot = await session.send(
		"Page.captureScreenshot",
		{ format, quality: format === "jpeg" ? clampInt(options.quality, 80, 1, 100) : undefined, clip, captureBeyondViewport, fromSurface: true },
		{ timeoutMs: 20_000 },
	);
	const buffer = Buffer.from(shot.data, "base64");
	const size = imageSize(buffer, format);
	return { data: shot.data, mimeType: format === "png" ? "image/png" : "image/jpeg", width: size.width, height: size.height, bytes: buffer.length, note };
}

export function imageSize(buffer: Buffer, format: "png" | "jpeg"): { width: number; height: number } {
	if (format === "png" && buffer.length >= 24) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
	if (format === "jpeg") {
		let offset = 2;
		while (offset + 9 < buffer.length) {
			if (buffer[offset] !== 0xff) break;
			const marker = buffer[offset + 1] as number;
			const length = buffer.readUInt16BE(offset + 2);
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
			}
			offset += 2 + length;
		}
	}
	return { width: 0, height: 0 };
}

export function artifactPath(baseDir: string, kind: string, extension: string, requested?: string, cwd?: string): string {
	if (requested) return isAbsolute(requested) ? requested : resolve(cwd ?? process.cwd(), requested);
	// Local time, so the name matches the file's modification time in Finder.
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
	return join(baseDir, kind, `${stamp}-${Math.random().toString(36).slice(2, 6)}.${extension}`);
}

export function registerScreenshotTool(pi: ExtensionAPI, services: ToolServices, artifactDir: string): void {
	registerChromeTool(pi, services, {
		name: "chrome_screenshot",
		label: "Chrome screenshot",
		description:
			"Screenshot the current tab: the viewport by default, fullPage for the whole document (capped at 8000px tall; briefly re-lays out the page), or one element via ref / selector / text (padding adds context). Output is at most 1024px wide unless scale is given (1 = one pixel per CSS px, 2 = Retina detail). Returned inline and saved to disk (path reported). Use it to verify visual state; use chrome_snapshot to read structure.",
		promptSnippet: "Capture the current Chrome tab (viewport, full page, or one element) as an image you can see",
		parameters: Type.Object({
			fullPage: Type.Optional(Type.Boolean()),
			ref: Type.Optional(Type.String({ description: "Element to capture: snapshot ref" })),
			selector: Type.Optional(Type.String({ description: "Element to capture: CSS selector" })),
			text: Type.Optional(Type.String({ description: "Element to capture: visible text" })),
			padding: Type.Optional(Type.Integer({ description: "CSS px of context around the element" })),
			format: Type.Optional(StringEnum(["png", "jpeg"] as const)),
			quality: Type.Optional(Type.Integer({ description: "JPEG quality 1-100 (default 80)" })),
			scale: Type.Optional(Type.Number({ description: "Output px per CSS px (default 1, capped to 1024 wide; 2 = Retina)" })),
			path: Type.Optional(Type.String({ description: "File path (default: artifact dir)" })),
			returnImage: Type.Optional(Type.Boolean({ description: "Return the image inline (default true)" })),
			focus: Type.Optional(Type.Boolean({ description: "Override focus mode" })),
		}),
		async execute(params, run) {
			const session = await services.connector.currentSession({ focus: params.focus, signal: run.signal });
			const format = params.format ?? "png";
			const shot = await captureScreenshot(session, { ...params, format });
			const path = artifactPath(artifactDir, "screenshots", format === "png" ? "png" : "jpg", params.path, run.ctx.cwd);
			await mkdir(join(path, ".."), { recursive: true });
			await writeFile(path, Buffer.from(shot.data, "base64"));
			const text = joinLines(
				`Screenshot ${shot.width}x${shot.height} ${format} (${Math.round(shot.bytes / 1024)}KB)${shot.note ? `, ${shot.note}` : ""} saved to ${path}`,
				`Page: ${pageLine(session)}`,
			);
			return { text, images: params.returnImage === false ? [] : [{ data: shot.data, mimeType: shot.mimeType }], details: { path, width: shot.width, height: shot.height } };
		},
	});
}
