// Snapshot geometry must be right whatever the display's device scale factor: a Retina panel (2x),
// a standard external monitor (1x), or a scaled one (fractional). Chrome renders under
// --force-device-scale-factor exactly as it would on such a display.

import assert from "node:assert/strict";
import { test } from "node:test";
import { startToolTestEnv } from "./setup.ts";

test("device emulation captures what the device shows, even when Chrome zooms a page out", async () => {
	const env = await startToolTestEnv("scale-emulated");
	try {
		const { pi, fixtures } = env;
		// form.html has no viewport meta, so mobile emulation lays it out at 980px and zooms out to fit.
		await pi.callTool("chrome_navigate", { url: `${fixtures.url}/form.html` });
		await pi.callTool("chrome_emulate", { device: "iPhone 15" });
		const zoomedOut = await pi.callTool("chrome_screenshot", { returnImage: false });
		const zoomed = zoomedOut.details as { width: number; height: number };
		assert.ok(Math.abs(zoomed.width - 393) <= 2, `a zoomed-out page is captured at device width, got ${zoomed.width}x${zoomed.height}`);
		assert.ok(zoomed.height <= 900, `and device height, got ${zoomed.height}`);

		// responsive.html declares a viewport, so there is no zoom-out; the capture is the same size.
		await pi.callTool("chrome_navigate", { url: `${fixtures.url}/responsive.html` });
		const responsive = (await pi.callTool("chrome_screenshot", { returnImage: false })).details as { width: number; height: number };
		assert.deepEqual([responsive.width, responsive.height], [393, 852]);
		// scale: 3 opts back into full device-pixel detail.
		const retina = (await pi.callTool("chrome_screenshot", { returnImage: false, scale: 3 })).details as { width: number };
		assert.equal(retina.width, 1179);
		await pi.callTool("chrome_emulate", { reset: true });
	} finally {
		await env.close();
	}
});

for (const scale of [1, 1.5, 2]) {
	test(`offscreen markers are correct at device scale factor ${scale}`, async () => {
		const env = await startToolTestEnv(`scale-${scale}`, {}, { extraArgs: [`--force-device-scale-factor=${scale}`] });
		try {
			const { pi, fixtures } = env;
			await pi.callTool("chrome_navigate", { url: `${fixtures.url}/form.html` });
			const dpr = (await pi.callTool("chrome_evaluate", { expression: "devicePixelRatio" })).text.split("\n")[0];
			assert.equal(Number(dpr), scale, "Chrome honored the forced scale factor");
			const snapshot = (await pi.callTool("chrome_snapshot", {})).text;
			assert.match(snapshot, /- editable "editable text" \[e\d+\]\n/, "control at y≈400 is not marked offscreen");
			assert.match(snapshot, /- button "Submit form" \[e\d+\]\n/, "control at y≈360 is not marked offscreen");
			assert.match(snapshot, /- button "Far button" \[e\d+\] \[offscreen\]/, "control at y≈2700 is marked offscreen");
			// The screenshot pipeline scales the other way (device -> CSS); check it agrees with the viewport.
			const shot = await pi.callTool("chrome_screenshot", { returnImage: false });
			const viewport = JSON.parse((await pi.callTool("chrome_evaluate", { expression: "({ w: innerWidth, h: innerHeight })" })).text.split("\nSince: ")[0] as string) as { w: number; h: number };
			const details = shot.details as { width: number; height: number };
			assert.equal(details.width, viewport.w);
			assert.equal(details.height, viewport.h);
		} finally {
			await env.close();
		}
	});
}
