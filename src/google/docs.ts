/**
 * Google Docs & Sheets client.
 * Raw fetch via googlePost/googleGet — no SDK.
 * Follows same pattern as gmail.ts and calendar.ts.
 *
 * Uses drive.file scope — can only access files this app creates.
 */

import { googlePost, googleGet, isGoogleAuthenticated } from "./auth.js";
import { createLogger } from "../utils/logger.js";
import { getInstanceName } from "../instance.js";

const log = createLogger("google.docs");

const DOCS_API = "https://docs.googleapis.com/v1/documents";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

/**
 * Check if Docs/Sheets creation is available.
 */
export function isDocsAvailable(): boolean {
  return isGoogleAuthenticated();
}

interface DocCreateResult {
  documentId: string;
  title: string;
  documentUrl: string;
}

/**
 * Create a new Google Doc with the given title.
 * Returns the document ID and URL.
 */
export async function createDocument(
  title: string,
): Promise<{ ok: boolean; data?: DocCreateResult; message: string }> {
  log.debug("Creating Google Doc", { title });
  const res = await googlePost<{ documentId: string; title: string }>(
    DOCS_API,
    { title },
  );

  if (!res.ok || !res.data) {
    log.error("Failed to create Google Doc", { title, error: res.message });
    return { ok: false, message: res.message };
  }

  log.info("Google Doc created", { title, documentId: res.data.documentId });
  return {
    ok: true,
    data: {
      documentId: res.data.documentId,
      title: res.data.title,
      documentUrl: `https://docs.google.com/document/d/${res.data.documentId}/edit`,
    },
    message: "Document created",
  };
}

/**
 * Batch-update a document with structured content requests.
 * Uses the Google Docs batchUpdate API.
 * Requests are applied in order — insert from bottom-up to avoid index shifting.
 */
export async function batchUpdateDocument(
  documentId: string,
  requests: Record<string, any>[],
): Promise<{ ok: boolean; message: string }> {
  log.debug("Batch-updating document", { documentId, requestCount: requests.length });
  const res = await googlePost(
    `${DOCS_API}/${documentId}:batchUpdate`,
    { requests },
  );

  if (!res.ok) {
    log.error("Document batch update failed", { documentId, error: res.message });
    return { ok: false, message: res.message };
  }
  log.debug("Document batch update complete", { documentId });
  return { ok: true, message: "Document updated" };
}

/**
 * Insert plain text at a given index in the document.
 */
function insertTextRequest(text: string, index: number) {
  return {
    insertText: {
      text,
      location: { index },
    },
  };
}

/**
 * Apply paragraph style (heading, normal) to a range.
 */
function paragraphStyleRequest(
  startIndex: number,
  endIndex: number,
  namedStyleType: string,
) {
  return {
    updateParagraphStyle: {
      range: { startIndex, endIndex },
      paragraphStyle: { namedStyleType },
      fields: "namedStyleType",
    },
  };
}

/**
 * Apply bold/italic text style to a range.
 */
function textStyleRequest(
  startIndex: number,
  endIndex: number,
  style: { bold?: boolean; italic?: boolean },
) {
  const fields = Object.keys(style).join(",");
  return {
    updateTextStyle: {
      range: { startIndex, endIndex },
      textStyle: style,
      fields,
    },
  };
}

interface BacklogItem {
  identifier: string;
  title: string;
  description: string;
  state: string;
  priority: number;
  assignee: string | null;
  exchanges: Array<{ body: string }>;
}

const PRIORITY_LABELS: Record<number, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

/**
 * Create a Google Doc populated with a backlog review.
 * Returns the document URL.
 */
export async function createBacklogReviewDoc(
  items: BacklogItem[],
): Promise<{ ok: boolean; url?: string; message: string }> {
  // 1. Create the document
  log.info("Creating backlog review document", { itemCount: items.length });
  const doc = await createDocument(`${getInstanceName()}'s Notes`);
  if (!doc.ok || !doc.data) return { ok: false, message: doc.message };

  // 2. Build document content as text + formatting requests
  // Google Docs starts with index 1 (the body content start)
  const requests: Record<string, any>[] = [];
  let idx = 1;

  // Helper: append text and track index
  function appendText(text: string) {
    requests.push(insertTextRequest(text, idx));
    const start = idx;
    idx += text.length;
    return { start, end: idx };
  }

  // Helper: append a heading
  function appendHeading(text: string, level: "HEADING_1" | "HEADING_2" | "HEADING_3") {
    const range = appendText(text + "\n");
    requests.push(paragraphStyleRequest(range.start, range.end, level));
    return range;
  }

  // Helper: append normal paragraph
  function appendParagraph(text: string) {
    const range = appendText(text + "\n");
    requests.push(paragraphStyleRequest(range.start, range.end, "NORMAL_TEXT"));
    return range;
  }

  // Helper: append bold text within a paragraph
  function appendBoldText(text: string) {
    const range = appendText(text);
    requests.push(textStyleRequest(range.start, range.end, { bold: true }));
    return range;
  }

  // --- Document content ---

  // Title is already set by createDocument, but we add an intro section
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  appendHeading("Backlog Review", "HEADING_1");
  appendParagraph(
    `Prepared by ${getInstanceName()} on ${today}. This document summarizes all active backlog items for review. Items are grouped by current state and sorted by priority.`,
  );
  appendText("\n");

  // Group items by state
  const groups: Record<string, BacklogItem[]> = {};
  for (const item of items) {
    const state = item.state;
    if (!groups[state]) groups[state] = [];
    groups[state].push(item);
  }

  // Sort each group by priority (1=urgent first)
  for (const g of Object.values(groups)) {
    g.sort((a, b) => a.priority - b.priority);
  }

  // Render order: in_progress, todo, backlog, done, cancelled
  const stateOrder = ["in_progress", "todo", "backlog", "done", "cancelled"];
  const stateLabels: Record<string, string> = {
    in_progress: "In Progress",
    todo: "To Do",
    backlog: "Backlog",
    done: "Completed",
    cancelled: "Cancelled",
  };

  for (const state of stateOrder) {
    const groupItems = groups[state];
    if (!groupItems || groupItems.length === 0) continue;

    appendHeading(`${stateLabels[state] ?? state} (${groupItems.length})`, "HEADING_2");

    for (const item of groupItems) {
      // Item title line
      appendHeading(`${item.identifier}: ${item.title}`, "HEADING_3");

      // Priority & assignee
      const priority = PRIORITY_LABELS[item.priority] ?? `P${item.priority}`;
      let meta = `Priority: ${priority}`;
      if (item.assignee) meta += ` | Assignee: ${item.assignee}`;
      appendParagraph(meta);

      // Description
      if (item.description) {
        appendParagraph(item.description);
      }

      // Notes from exchanges
      if (item.exchanges.length > 0) {
        appendBoldText("Notes: ");
        appendText(item.exchanges.map((e) => e.body).join("; ") + "\n");
      }

      appendText("\n");
    }
  }

  // Summary section
  appendHeading("Summary", "HEADING_1");
  const counts = stateOrder
    .filter((s) => groups[s]?.length)
    .map((s) => `${stateLabels[s]}: ${groups[s]!.length}`)
    .join(" | ");
  appendParagraph(counts);
  appendParagraph(`Total active items: ${items.length}`);

  // 3. Apply all requests
  const update = await batchUpdateDocument(doc.data.documentId, requests);
  if (!update.ok) {
    return {
      ok: false,
      message: `Document created but content failed: ${update.message}. Doc URL: ${doc.data.documentUrl}`,
    };
  }

  log.info("Backlog review document complete", { url: doc.data.documentUrl, itemCount: items.length });
  return { ok: true, url: doc.data.documentUrl, message: "Backlog review doc created" };
}

// --- Sheets ---

interface SheetCreateResult {
  spreadsheetId: string;
  title: string;
  spreadsheetUrl: string;
}

/**
 * Create a new Google Sheet with optional data.
 * Data is an array of rows, each row an array of cell values.
 */
export async function createSpreadsheet(
  title: string,
  data?: string[][],
  sheetName?: string,
): Promise<{ ok: boolean; data?: SheetCreateResult; message: string }> {
  const body: Record<string, any> = {
    properties: { title },
  };
  if (sheetName) {
    body.sheets = [{ properties: { title: sheetName } }];
  }

  log.debug("Creating spreadsheet", { title, sheetName });
  const res = await googlePost<{
    spreadsheetId: string;
    spreadsheetUrl?: string;
    properties?: { title?: string };
  }>(SHEETS_API, body);

  if (!res.ok || !res.data?.spreadsheetId) {
    log.error("Failed to create spreadsheet", { title, error: res.message });
    return { ok: false, message: res.message };
  }

  const sheetId = res.data.spreadsheetId;
  const url = res.data.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;

  // Write data if provided
  if (data && data.length > 0) {
    const range = `${sheetName ?? "Sheet1"}!A1`;
    const writeResult = await googlePost(
      `${SHEETS_API}/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { values: data },
    );
    if (!writeResult.ok) {
      return {
        ok: true,
        data: { spreadsheetId: sheetId, title, spreadsheetUrl: url },
        message: `Sheet created but data write failed: ${writeResult.message}`,
      };
    }
  }

  log.info("Spreadsheet created", { title, spreadsheetId: sheetId });
  return {
    ok: true,
    data: { spreadsheetId: sheetId, title, spreadsheetUrl: url },
    message: "Spreadsheet created",
  };
}

/**
 * Read data from a Google Sheet.
 */
export async function readSpreadsheet(
  spreadsheetId: string,
  range?: string,
): Promise<{ ok: boolean; data?: string[][]; message: string }> {
  const r = range ?? "Sheet1";
  log.debug("Reading spreadsheet", { spreadsheetId, range: r });
  const res = await googleGet<{ values?: string[][] }>(
    `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(r)}`,
  );
  if (!res.ok) {
    log.error("Failed to read spreadsheet", { spreadsheetId, error: res.message });
    return { ok: false, message: res.message };
  }

  const rows = res.data?.values ?? [];
  log.debug("Spreadsheet read complete", { spreadsheetId, rowCount: rows.length });
  return {
    ok: true,
    data: rows,
    message: `${rows.length} rows`,
  };
}

/**
 * Create a Google Doc with markdown-ish content in one call.
 * Convenience wrapper: creates doc + inserts formatted content.
 */
export async function createDocWithContent(
  title: string,
  content: string,
): Promise<{ ok: boolean; url?: string; message: string }> {
  log.debug("Creating doc with content", { title });
  const doc = await createDocument(title);
  if (!doc.ok || !doc.data) return { ok: false, message: doc.message };

  if (content.trim()) {
    const requests: Record<string, any>[] = [];
    const lines = content.trim().split("\n");
    let idx = 1;

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
      const text = (headingMatch ? headingMatch[2] : line) + "\n";

      requests.push(insertTextRequest(text, idx));

      if (headingMatch) {
        const level = headingMatch[1].length;
        const style = level === 1 ? "HEADING_1" : level === 2 ? "HEADING_2" : "HEADING_3";
        requests.push(paragraphStyleRequest(idx, idx + text.length, style));
      }

      idx += text.length;
    }

    const update = await batchUpdateDocument(doc.data.documentId, requests);
    if (!update.ok) {
      return {
        ok: true,
        url: doc.data.documentUrl,
        message: `Doc created but content failed: ${update.message}`,
      };
    }
  }

  log.info("Doc with content created", { title, url: doc.data.documentUrl });
  return { ok: true, url: doc.data.documentUrl, message: `Created: ${title}` };
}
