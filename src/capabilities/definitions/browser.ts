/**
 * Browser capability — navigate, click, type, screenshot, extract, scroll
 * via Stagehand (AI-powered) + Playwright (deterministic).
 *
 * Pattern: action-block
 * Tag:     BROWSER_ACTION
 *
 * The LLM emits [BROWSER_ACTION]{...}[/BROWSER_ACTION] blocks.
 * Each block specifies an `action` plus action-specific fields.
 *
 * Session management: Playwright browser contexts are persisted per-domain
 * as encrypted storageState JSON in brain/browser/sessions/ with 7-day expiry.
 */

import { Stagehand } from "@browserbasehq/stagehand";
import { logActivity } from "../../activity/log.js";
import { pushNotification } from "../../goals/notifications.js";
import { createLogger } from "../../utils/logger.js";
import { saveSession, loadSession, purgeExpiredSessions } from "../../browser/sessions.js";
import type { ActionBlockCapability, ActionContext, ActionExecutionResult } from "../types.js";

const log = createLogger("browser");

// ── Stagehand lifecycle ──────────────────────────────────────────────────────

let _stagehand: Stagehand | null = null;

/**
 * Get or create the shared Stagehand instance.
 * Uses LOCAL env with headless Chromium — no Browserbase dependency.
 */
async function getStagehand(): Promise<Stagehand> {
  if (_stagehand) return _stagehand;

  _stagehand = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: { headless: true },
  });
  await _stagehand.init();
  log.info("Stagehand initialized (LOCAL, headless)");

  // Purge expired sessions on first launch
  purgeExpiredSessions().catch(() => {});

  return _stagehand;
}

/** Shut down the browser (called on server teardown). */
export async function closeBrowser(): Promise<void> {
  if (_stagehand) {
    await _stagehand.close();
    _stagehand = null;
    log.info("Stagehand closed");
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

const actionLabel = (ctx: ActionContext) =>
  ctx.origin === "autonomous" ? "AUTONOMOUS" : "PROMPTED";

// ── Action handlers ──────────────────────────────────────────────────────────

async function handleNavigate(
  req: Record<string, any>,
  ctx: ActionContext,
): Promise<ActionExecutionResult> {
  const url: string = req.url;
  if (!url) return { capabilityId: "browser", ok: false, message: "Missing required field: url" };

  const stagehand = await getStagehand();
  const domain = domainFromUrl(url);

  // Restore session if available
  const stored = await loadSession(domain);
  if (stored) {
    try {
      await stagehand.context.addCookies((stored as any).cookies ?? []);
      log.info(`Restored session for ${domain}`);
    } catch (err) {
      log.warn(`Failed to restore session for ${domain}`, { error: String(err) });
    }
  }

  const page = stagehand.context.pages()[0];
  await page.goto(url, { waitUntil: "domcontentloaded", timeoutMs: 30_000 });

  logActivity({ source: "browse", summary: `Navigated to ${url}`, actionLabel: actionLabel(ctx), reason: `browser navigate` });
  return { capabilityId: "browser", ok: true, message: `Navigated to ${url}` };
}

async function handleClick(
  req: Record<string, any>,
  ctx: ActionContext,
): Promise<ActionExecutionResult> {
  const instruction: string = req.instruction ?? req.selector;
  if (!instruction) return { capabilityId: "browser", ok: false, message: "Missing required field: instruction or selector" };

  const stagehand = await getStagehand();
  const result = await stagehand.act(`click ${instruction}`);

  logActivity({ source: "browse", summary: `Clicked: ${instruction}`, actionLabel: actionLabel(ctx), reason: `browser click` });
  return { capabilityId: "browser", ok: result.success, message: result.message ?? `Clicked: ${instruction}` };
}

async function handleType(
  req: Record<string, any>,
  ctx: ActionContext,
): Promise<ActionExecutionResult> {
  const instruction: string | undefined = req.instruction;
  const text: string | undefined = req.text;
  const selector: string | undefined = req.selector;

  if (!text) return { capabilityId: "browser", ok: false, message: "Missing required field: text" };

  const stagehand = await getStagehand();
  const actInstruction = instruction
    ?? (selector ? `type "${text}" into ${selector}` : `type "${text}" into the focused field`);

  const result = await stagehand.act(actInstruction);

  logActivity({ source: "browse", summary: `Typed into field`, actionLabel: actionLabel(ctx), reason: `browser type` });
  return { capabilityId: "browser", ok: result.success, message: result.message ?? `Typed text` };
}

async function handleScreenshot(
  _req: Record<string, any>,
  ctx: ActionContext,
): Promise<ActionExecutionResult> {
  const stagehand = await getStagehand();
  const page = stagehand.context.pages()[0];
  const buffer = await page.screenshot({ type: "png", fullPage: false });
  const base64 = buffer.toString("base64");

  logActivity({ source: "browse", summary: `Took screenshot`, actionLabel: actionLabel(ctx), reason: `browser screenshot` });
  return {
    capabilityId: "browser",
    ok: true,
    message: "Screenshot captured",
    data: { base64, mimeType: "image/png" },
  };
}

async function handleExtract(
  req: Record<string, any>,
  ctx: ActionContext,
): Promise<ActionExecutionResult> {
  const instruction: string | undefined = req.instruction;

  const stagehand = await getStagehand();

  let extracted: unknown;
  if (instruction) {
    extracted = await stagehand.extract(instruction);
  } else {
    extracted = await stagehand.extract();
  }

  logActivity({ source: "browse", summary: `Extracted content from page`, actionLabel: actionLabel(ctx), reason: `browser extract` });
  return {
    capabilityId: "browser",
    ok: true,
    message: "Content extracted",
    data: extracted,
  };
}

async function handleScroll(
  req: Record<string, any>,
  ctx: ActionContext,
): Promise<ActionExecutionResult> {
  const direction: string = req.direction ?? "down";

  const stagehand = await getStagehand();
  const result = await stagehand.act(`scroll ${direction}`);

  logActivity({ source: "browse", summary: `Scrolled ${direction}`, actionLabel: actionLabel(ctx), reason: `browser scroll` });
  return { capabilityId: "browser", ok: result.success, message: result.message ?? `Scrolled ${direction}` };
}

// ── Capability definition ────────────────────────────────────────────────────

export const browserCapability: ActionBlockCapability = {
  id: "browser",
  pattern: "action",
  tag: "BROWSER_ACTION",
  keywords: ["browse", "browser", "website", "webpage", "click", "screenshot", "scrape", "navigate", "open page", "web page"],

  getPromptInstructions(ctx) {
    const name = ctx.name ?? "the user";
    return [
      `## Browser (via [BROWSER_ACTION] blocks)`,
      `To interact with web pages, include a [BROWSER_ACTION] block in your response.`,
      ``,
      `Navigate to a URL:`,
      `[BROWSER_ACTION]`,
      `{"action": "navigate", "url": "https://example.com"}`,
      `[/BROWSER_ACTION]`,
      ``,
      `Click an element (natural language):`,
      `[BROWSER_ACTION]`,
      `{"action": "click", "instruction": "the Sign In button"}`,
      `[/BROWSER_ACTION]`,
      ``,
      `Type text into a field:`,
      `[BROWSER_ACTION]`,
      `{"action": "type", "text": "hello world", "instruction": "the search input"}`,
      `[/BROWSER_ACTION]`,
      ``,
      `Take a screenshot of the current page:`,
      `[BROWSER_ACTION]`,
      `{"action": "screenshot"}`,
      `[/BROWSER_ACTION]`,
      ``,
      `Extract content from the page:`,
      `[BROWSER_ACTION]`,
      `{"action": "extract", "instruction": "the main article text and author"}`,
      `[/BROWSER_ACTION]`,
      ``,
      `Scroll the page:`,
      `[BROWSER_ACTION]`,
      `{"action": "scroll", "direction": "down"}`,
      `[/BROWSER_ACTION]`,
      ``,
      `Actions: navigate, click, type, screenshot, extract, scroll.`,
      `Sessions are persisted per domain — cookies and login state carry across requests.`,
      `Navigate, extract, screenshot, and scroll without confirmation — just do it and mention what you did. Confirm with ${name} before submitting forms (click on submit buttons, form POSTs).`,
    ].join("\n");
  },

  getPromptOverride(origin) {
    if (origin === "autonomous") {
      return [
        `## Browser (via [BROWSER_ACTION] blocks)`,
        `Navigate: {"action": "navigate", "url": "https://..."}`,
        `Click:    {"action": "click", "instruction": "the button text"}`,
        `Type:     {"action": "type", "text": "value", "instruction": "the input field"}`,
        `Screenshot: {"action": "screenshot"}`,
        `Extract:  {"action": "extract", "instruction": "what to extract"}`,
        `Scroll:   {"action": "scroll", "direction": "down|up"}`,
        `Wrap each in [BROWSER_ACTION]...[/BROWSER_ACTION].`,
      ].join("\n");
    }
    return null;
  },

  async execute(payload, ctx): Promise<ActionExecutionResult> {
    const req = payload as Record<string, any>;
    const action = req.action as string | undefined;

    try {
      switch (action) {
        case "navigate": return await handleNavigate(req, ctx);
        case "click": return await handleClick(req, ctx);
        case "type": return await handleType(req, ctx);
        case "screenshot": return await handleScreenshot(req, ctx);
        case "extract": return await handleExtract(req, ctx);
        case "scroll": return await handleScroll(req, ctx);
        default:
          return { capabilityId: "browser", ok: false, message: `Unknown browser action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Browser action "${action}" failed`, { error: msg });
      pushNotification({ timestamp: new Date().toISOString(), source: "browse", message: `Browser action failed: ${msg}` });
      return { capabilityId: "browser", ok: false, message: msg };
    } finally {
      // Persist session after navigate (cookies may have changed)
      try {
        const stagehand = _stagehand;
        if (stagehand && action === "navigate") {
          const url = req.url as string;
          if (url) {
            const domain = domainFromUrl(url);
            const cookies = await stagehand.context.cookies();
            await saveSession(domain, { cookies });
          }
        }
      } catch {
        // Non-critical — session save failure shouldn't break the action
      }
    }
  },
};
