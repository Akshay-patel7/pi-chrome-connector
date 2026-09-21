import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { registerChromeTool, type ToolServices } from "./shared.ts";

export function registerDialogTool(pi: ExtensionAPI, services: ToolServices): void {
	registerChromeTool(pi, services, {
		name: "chrome_dialog",
		label: "Chrome dialog",
		description:
			"Handle JavaScript dialogs (alert, confirm, prompt, beforeunload) in the current tab. While one is open, page tools fail fast and tell you. Actions: status; accept (optional promptText for prompt()); dismiss; policy accept|dismiss|manual to auto-handle future dialogs for this tab (manual is the default and reports them to you).",
		promptSnippet: "Accept or dismiss a JavaScript dialog, or set an auto-handling policy",
		parameters: Type.Object({
			action: StringEnum(["status", "accept", "dismiss", "policy"] as const),
			promptText: Type.Optional(Type.String({ description: "Text to enter for prompt() when accepting" })),
			policy: Type.Optional(StringEnum(["accept", "dismiss", "manual"] as const)),
		}),
		async execute(params, run) {
			const session = await services.connector.currentSession({ focus: false, signal: run.signal });
			const dialog = session.dialog;
			switch (params.action) {
				case "status":
					return { text: dialog ? `Open ${dialog.type} dialog: "${dialog.message}"${dialog.defaultPrompt ? ` (default: "${dialog.defaultPrompt}")` : ""} from ${dialog.url}. Policy: ${session.dialogPolicy}.` : `No dialog open. Policy: ${session.dialogPolicy}.` };
				case "accept":
				case "dismiss": {
					if (!dialog) return { text: "No dialog is open." };
					const accept = params.action === "accept";
					await session.send("Page.handleJavaScriptDialog", { accept, promptText: accept ? params.promptText : undefined });
					await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
					return { text: `${accept ? "Accepted" : "Dismissed"} the ${dialog.type} dialog "${dialog.message.slice(0, 120)}"${accept && params.promptText !== undefined ? ` with "${params.promptText}"` : ""}.` };
				}
				case "policy": {
					if (!params.policy) throw new Error("policy needs accept, dismiss, or manual.");
					session.dialogPolicy = params.policy;
					if (dialog && params.policy !== "manual") await session.send("Page.handleJavaScriptDialog", { accept: params.policy === "accept" }).catch(() => {});
					return { text: `Dialog policy for this tab: ${params.policy}.` };
				}
				default:
					throw new Error(`unknown action ${String(params.action)}`);
			}
		},
	});
}
