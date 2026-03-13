/**
 * URL browse module for Core.
 * Fetches a URL, strips HTML to readable text, and returns it for context injection.
 * Zero external dependencies — uses native fetch and regex extraction.
 *
 * Never throws — returns null on any error.
 */

import { getInstanceName } from "../instance.js";

export interface BrowseResult {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  llmsTxt?: string | null;
}

/** Max chars of extracted text to keep (context budget). */
const MAX_TEXT_LENGTH = 8000;

/** Timeout for fetch requests in ms. */
const FETCH_TIMEOUT_MS = 15_000;

/** Content types we'll attempt to parse. */
const ALLOWED_CONTENT_TYPES = ["text/html", "text/plain", "application/xhtml"];

/**
 * Extract the <title> content from raw HTML.
 */
export function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1].trim()) : "";
}

/** Remove all content between opening and closing tags (indexOf-based, no regex). */
function stripTagBlocks(html: string, tagNames: string[]): string {
  let s = html;
  for (const tag of tagNames) {
    const openTag = `<${tag}`;
    const closeTag = `</${tag}`;
    let idx: number;
    while ((idx = s.toLowerCase().indexOf(openTag, 0)) !== -1) {
      // Ensure it's actually a tag boundary (followed by space, >, or /)
      const charAfter = s[idx + openTag.length];
      if (charAfter && charAfter !== '>' && charAfter !== ' ' && charAfter !== '/' && charAfter !== '\t' && charAfter !== '\n' && charAfter !== '\r') {
        // Not a real tag — skip past this occurrence
        s = s.slice(0, idx) + s.slice(idx + 1);
        continue;
      }
      const closeIdx = s.toLowerCase().indexOf(closeTag, idx + openTag.length);
      if (closeIdx === -1) {
        s = s.slice(0, idx);
        break;
      }
      const closeEnd = s.indexOf('>', closeIdx + closeTag.length);
      s = s.slice(0, idx) + s.slice(closeEnd === -1 ? s.length : closeEnd + 1);
    }
  }
  return s;
}

/**
 * Strip HTML to readable plain text.
 * Removes scripts, styles, tags, decodes entities, and collapses whitespace.
 */
export function stripHtml(html: string): string {
  let text = html;
  let prev;

  // Remove script, style, and noscript blocks entirely
  text = stripTagBlocks(text, ["script", "style", "noscript"]);

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Replace block-level tags with newlines for readability
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|blockquote|section|article|header|footer)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<(p|div|h[1-6]|li|tr|blockquote|section|article|header|footer)\b[^>]*>/gi, "\n");

  // Remove all remaining tags (loop for nested)
  do { prev = text; text = text.replace(/<[^>]+>/g, ""); } while (text !== prev);

  // Decode HTML entities
  text = decodeEntities(text);

  // Collapse whitespace: multiple spaces/tabs to single space, preserve newlines
  text = text.replace(/[^\S\n]+/g, " ");
  // Collapse multiple blank lines to at most two
  text = text.replace(/\n{3,}/g, "\n\n");
  // Trim each line
  text = text
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
  // Trim overall
  text = text.trim();

  return text;
}

/**
 * Decode common HTML entities.
 */
function decodeEntities(text: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
    "&mdash;": "—",
    "&ndash;": "–",
    "&hellip;": "…",
    "&laquo;": "«",
    "&raquo;": "»",
    "&copy;": "©",
    "&reg;": "®",
    "&trade;": "™",
  };

  let result = text;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.replaceAll(entity, char);
  }
  // Decode numeric entities (&#123; and &#x1a;)
  result = result.replace(/&#(\d+);/g, (_, num) =>
    String.fromCharCode(parseInt(num, 10)),
  );
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );

  return result;
}

/**
 * Fetch a plain-text URL and return its content (or null on failure).
 * Rejects HTML responses to avoid returning 404 pages.
 */
async function fetchPlainText(textUrl: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(textUrl, {
      signal: controller.signal,
      headers: { "User-Agent": `${getInstanceName()}/1.0 (personal AI agent)` },
      redirect: "follow",
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/")) return null;

    const text = (await response.text()).trim();
    // Sanity check: if it's HTML (404 page), reject it
    if (text.startsWith("<!") || text.startsWith("<html")) return null;
    if (text.length < 5) return null;

    return text;
  } catch {
    return null;
  }
}

/**
 * Extract llms.txt link hrefs from raw HTML.
 * Looks for <a> tags whose href ends in /llms.txt or whose text mentions llms.txt.
 */
export function extractLlmsTxtLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const parsed = new URL(baseUrl);
  // Match <a> tags with href containing llms.txt
  const hrefPattern = /<a\s[^>]*href=["']([^"']*llms\.txt[^"']*)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefPattern.exec(html)) !== null) {
    const href = match[1];
    try {
      // Resolve relative URLs
      const resolved = new URL(href, `${parsed.protocol}//${parsed.host}`).href;
      if (!links.includes(resolved)) links.push(resolved);
    } catch {
      // skip malformed URLs
    }
  }
  return links;
}

/**
 * Fetch llms.txt from a site — tries root /llms.txt first, then follows
 * any llms.txt links found in the page HTML as fallback.
 * Convention: sites publish /llms.txt with AI-friendly content about the site.
 * Returns the text content or null if not found.
 */
export async function fetchLlmsTxt(
  url: string,
  html?: string,
): Promise<string | null> {
  const parsed = new URL(url);
  const rootUrl = `${parsed.protocol}//${parsed.host}/llms.txt`;

  // Try the root /llms.txt first (standard location)
  const rootResult = await fetchPlainText(rootUrl);
  if (rootResult) return rootResult;

  // Fallback: scan page HTML for llms.txt links and try each
  if (html) {
    const links = extractLlmsTxtLinks(html, url);
    for (const link of links) {
      // Skip if same as root (already tried)
      if (link === rootUrl) continue;
      const result = await fetchPlainText(link);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Fetch a URL and extract readable text.
 * Returns null on any error (timeout, network, non-HTML content, etc.).
 */
export async function browseUrl(url: string): Promise<BrowseResult | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": `${getInstanceName()}/1.0 (personal AI agent)`,
        Accept: "text/html, text/plain;q=0.9, */*;q=0.1",
      },
      redirect: "follow",
    });

    clearTimeout(timer);

    if (!response.ok) {
      return null;
    }

    // Check content type — reject non-text responses
    const contentType = response.headers.get("content-type") ?? "";
    const isAllowed = ALLOWED_CONTENT_TYPES.some((t) =>
      contentType.toLowerCase().includes(t),
    );
    if (!isAllowed) {
      return null;
    }

    const html = await response.text();
    const title = extractTitle(html);

    // For plain text, skip HTML stripping
    const isPlainText = contentType.toLowerCase().includes("text/plain");
    let text = isPlainText ? html.trim() : stripHtml(html);

    // Truncate to context budget
    let truncated = false;
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH);
      // Try to break at a word/sentence boundary
      const lastBreak = Math.max(
        text.lastIndexOf("\n"),
        text.lastIndexOf(". "),
        text.lastIndexOf("? "),
        text.lastIndexOf("! "),
      );
      if (lastBreak > MAX_TEXT_LENGTH * 0.8) {
        text = text.slice(0, lastBreak + 1);
      }
      text += "\n\n[Content truncated]";
      truncated = true;
    }

    // Fetch llms.txt — tries root /llms.txt, then any links found in page HTML
    const llmsTxt = await fetchLlmsTxt(url, html);

    return { url, title, text, truncated, llmsTxt };
  } catch {
    return null;
  }
}

/**
 * Detect the first URL in a message string.
 */
export function detectUrl(message: string): string | null {
  const match = message.match(/https?:\/\/\S+/);
  return match ? match[0].replace(/[.,;:!?)]+$/, "") : null;
}
