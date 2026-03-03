/**
 * Docs/Sheets capability — create Google Docs and Spreadsheets.
 */

import { createDocWithContent, createSpreadsheet } from "../../google/docs.js";
import { logActivity } from "../../activity/log.js";
import { pushNotification } from "../../goals/notifications.js";
import { getInstanceName } from "../../instance.js";
import type { ActionBlockCapability, ActionContext, ActionExecutionResult } from "../types.js";

const actionLabel = (ctx: ActionContext) =>
  ctx.origin === "autonomous" ? "AUTONOMOUS" : "PROMPTED";

const reason = (ctx: ActionContext) => {
  switch (ctx.origin) {
    case "email": return `${getInstanceName()} email triggered doc create`;
    case "autonomous": return "planner created document";
    default: return "user requested via chat";
  }
};

export const docsCapability: ActionBlockCapability = {
  id: "docs",
  pattern: "action",
  tag: "DOC_ACTION",
  keywords: ["document", "doc", "spreadsheet", "sheet", "google doc", "google sheet"],

  getPromptInstructions(_ctx) {
    return [
      `## Google Docs & Sheets (create via [DOC_ACTION] blocks)`,
      `To create a Google Doc or Sheet, include a [DOC_ACTION] block in your response:`,
      `[DOC_ACTION]`,
      `{"action": "create_doc", "title": "Document Title", "content": "# Heading\\nParagraph text\\n## Subheading\\nMore text"}`,
      `[/DOC_ACTION]`,
      ``,
      `[DOC_ACTION]`,
      `{"action": "create_sheet", "title": "Sheet Title", "data": [["Header1", "Header2"], ["Row1Col1", "Row1Col2"]]}`,
      `[/DOC_ACTION]`,
      ``,
      `Content supports simple markdown headings (# ## ###). The URL will be returned to the user.`,
    ].join("\n");
  },

  async execute(payload, ctx): Promise<ActionExecutionResult> {
    const req = payload as Record<string, any>;
    const label = actionLabel(ctx);

    if (req.action === "create_doc" && req.title) {
      const result = await createDocWithContent(req.title, req.content ?? "");
      if (result.ok && result.url) {
        logActivity({ source: "google", summary: `Created Google Doc: ${req.title}`, detail: result.url, actionLabel: label, reason: reason(ctx) });
        pushNotification({ timestamp: new Date().toISOString(), source: "google", message: `Created Google Doc: [${req.title}](${result.url})` });
        return { capabilityId: "docs", ok: true, message: `Created doc: ${req.title} — ${result.url}` };
      }
      logActivity({ source: "google", summary: `Failed to create doc: ${result.message}`, actionLabel: label, reason: reason(ctx) });
      return { capabilityId: "docs", ok: false, message: result.message };
    }

    if (req.action === "create_sheet" && req.title) {
      const result = await createSpreadsheet(req.title, req.data);
      if (result.ok && result.data) {
        logActivity({ source: "google", summary: `Created Google Sheet: ${req.title}`, detail: result.data.spreadsheetUrl, actionLabel: label, reason: reason(ctx) });
        pushNotification({ timestamp: new Date().toISOString(), source: "google", message: `Created Google Sheet: [${req.title}](${result.data.spreadsheetUrl})` });
        return { capabilityId: "docs", ok: true, message: `Created sheet: ${req.title} — ${result.data.spreadsheetUrl}` };
      }
      logActivity({ source: "google", summary: `Failed to create sheet: ${result.message}`, actionLabel: label, reason: reason(ctx) });
      return { capabilityId: "docs", ok: false, message: result.message };
    }

    return { capabilityId: "docs", ok: false, message: "Unknown or incomplete doc action" };
  },
};
