/**
 * Privacy Membrane Demo — Playwright screenshot capture
 *
 * Captures a clean user journey in a fresh thread:
 *   1. BEFORE: Empty chat, ready to type
 *   2. DURING: PII sent, blurred in chat, Data tab shows redaction
 *   3. AFTER: Response with rehydrated values, history stays sealed
 *
 * Usage:
 *   node demo/capture-membrane.mjs http://localhost:64619 [password]
 */

import { chromium } from "playwright";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.argv[2] || "http://localhost:3577";
const PASSWORD = process.argv[3] || "";
const OUT_DIR = join(process.cwd(), "demo", "screenshots");

// Clean previous screenshots
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

let shotNum = 0;
async function shot(page, name, clip) {
  shotNum++;
  const filename = `${String(shotNum).padStart(2, "0")}-${name}.png`;
  const path = join(OUT_DIR, filename);
  const opts = { path, fullPage: false };
  if (clip) opts.clip = clip;
  await page.screenshot(opts);
  console.log(`    -> ${filename}`);
  return path;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForReady(page) {
  await page.waitForFunction(
    () => {
      const els = ["chat-input", "auth-safeword", "pair-code"];
      return els.some((id) => {
        const el = document.getElementById(id);
        if (!el) return false;
        return el.offsetParent !== null;
      });
    },
    { timeout: 30000 }
  );
}

async function authenticate(page) {
  const chatInput = page.locator("#chat-input");
  if (await chatInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log("  Cached session — skipping auth.");
    return;
  }
  const authInput = page.locator("#auth-safeword");
  if (await authInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    if (!PASSWORD) { console.error("Password required."); process.exit(1); }
    await authInput.fill(PASSWORD);
    await page.click("#auth-btn");
    await page.waitForSelector("#chat-input", { timeout: 10000 });
    await sleep(1000);
    return;
  }
  console.error("Unexpected screen state. Pair manually first.");
  process.exit(1);
}

async function startNewThread(page) {
  const btn = page.locator("#thread-new-btn");
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await btn.click();
    await sleep(1000);
    console.log("  Fresh thread started.");
  } else {
    // Try opening sidebar first
    const toggle = page.locator("#thread-toggle-btn");
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click();
      await sleep(500);
      await btn.click();
      await sleep(1000);
      console.log("  Fresh thread started.");
    }
  }
}

async function sendAndWait(page, text) {
  const input = page.locator("#chat-input");
  await input.fill(text);
  await page.keyboard.press("Enter");
  // Wait for streaming to finish
  await page.waitForFunction(
    () => {
      const msgs = document.querySelectorAll(".message.assistant .content");
      if (msgs.length === 0) return false;
      const last = msgs[msgs.length - 1];
      return !last.classList.contains("streaming-cursor") && last.textContent.length > 5;
    },
    { timeout: 90000 }
  );
  await sleep(1000);
}

async function getMessageAreaClip(page) {
  const box = await page.locator("#messages, .messages").first().boundingBox();
  if (!box) return undefined;
  return {
    x: Math.max(0, box.x),
    y: Math.max(0, box.y),
    width: Math.min(box.width, 1440),
    height: Math.min(box.height, 900),
  };
}

// ── Main flow ────────────────────────────────────────────────────────────

async function main() {
  console.log("\n  Privacy Membrane — Demo Capture");
  console.log("  " + "=".repeat(38));
  console.log(`  Server: ${BASE_URL}`);
  console.log(`  Output: ${OUT_DIR}\n`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  try {
    // ── 1. OPEN & AUTH ──────────────────────────────────────────────
    console.log("[1] Opening...");
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    await waitForReady(page);
    await authenticate(page);
    await sleep(500);

    // ── 2. START FRESH THREAD ───────────────────────────────────────
    console.log("[2] Starting fresh thread...");
    await startNewThread(page);

    // ── 3. BEFORE — clean empty chat ────────────────────────────────
    console.log("[3] BEFORE — clean chat...");
    await shot(page, "before-clean-chat");

    // ── 4. TYPE PII — user sends sensitive info ─────────────────────
    console.log("[4] Sending message with PII...");
    await sendAndWait(page,
      "Hi! My phone number is 213-555-0147 and my email is jane.doe@example.com. Save these for emergencies."
    );

    // ── 5. DURING — blurred seals in chat ───────────────────────────
    console.log("[5] DURING — privacy seals (blurred)...");
    await shot(page, "during-pii-blurred", await getMessageAreaClip(page));

    // ── 6. HOVER — reveal one sealed value ──────────────────────────
    console.log("[6] Hover to reveal...");
    const seal = page.locator(".pii-redact").first();
    if (await seal.isVisible().catch(() => false)) {
      await seal.hover();
      await sleep(400);
      await shot(page, "during-hover-reveal", await getMessageAreaClip(page));
      await page.mouse.move(0, 0);
      await sleep(300);
    } else {
      console.log("    (no .pii-redact found — skipping hover shot)");
    }

    // ── 7. DATA TAB — what the LLM actually saw ────────────────────
    console.log("[7] Data tab — LLM view...");
    const expandBtn = page.locator(".stream-expand-btn");
    if (await expandBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expandBtn.click();
      await sleep(400);
    }
    const dataTab = page.locator("text=Data").first();
    if (await dataTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await dataTab.click();
      await sleep(600);
    }
    await shot(page, "during-data-tab-llm-view");

    // ── 8. SECOND MESSAGE — more PII types ──────────────────────────
    console.log("[8] Sending SSN + address...");
    await sendAndWait(page,
      "Also my SSN is 123-45-6789 and I live at 742 Evergreen Terrace, Springfield IL 62704."
    );
    await shot(page, "during-multi-pii-blurred");

    // ── 9. AFTER — full chat with seals + data tab visible ──────────
    console.log("[9] AFTER — full experience...");
    // Hover one seal for the money shot: blur + reveal + data tab all visible
    const anySeal = page.locator(".pii-redact").nth(1);
    if (await anySeal.isVisible().catch(() => false)) {
      await anySeal.hover();
      await sleep(400);
    }
    await shot(page, "after-full-experience");

    // ── 10. FINAL — all blurred, no hover ───────────────────────────
    console.log("[10] Final — everything sealed...");
    await page.mouse.move(0, 0);
    await sleep(300);
    await shot(page, "after-all-sealed");

    console.log(`\n  Done! ${shotNum} screenshots in ${OUT_DIR}\n`);

  } catch (err) {
    console.error("Error:", err.message);
    await shot(page, "error-state").catch(() => {});
  } finally {
    await sleep(3000);
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
