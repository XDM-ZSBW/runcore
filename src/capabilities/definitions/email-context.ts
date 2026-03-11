/**
 * Email context provider — injects inbox summary or search results into the
 * LLM prompt when the user mentions email-related keywords.
 */

import type { ContextProviderCapability, ContextInjection, ActionContext } from "../types.js";

// Lazy-loaded byok-tier module
let _gmail: typeof import("../../google/gmail.js") | null = null;
async function getGmail() {
  if (!_gmail) { try { _gmail = await import("../../google/gmail.js"); } catch { _gmail = null; } }
  return _gmail;
}

export const emailContextProvider: ContextProviderCapability = {
  id: "email-context",
  pattern: "context",
  keywords: ["email", "inbox", "mail", "unread", "message", "gmail", "reply to"],

  getPromptInstructions(_ctx: ActionContext): string {
    return ""; // Context providers inject data, not prompt instructions
  },

  shouldInject(message: string): boolean {
    // Gmail module loaded lazily — if not yet loaded, check keyword match only.
    // Actual availability is verified in getContext().
    if (_gmail && !_gmail.isGmailAvailable()) return false;
    const keywords = /\b(email|inbox|mail|unread|messages?|gmail|from .+@|reply to)\b/i;
    return keywords.test(message);
  },

  async getContext(message: string): Promise<ContextInjection | null> {
    const gmail = await getGmail();
    if (!gmail || !gmail.isGmailAvailable()) return null;

    // Check if user is searching for a specific person/topic
    const fromMatch = message.match(/(?:email|mail|message)s?\s+from\s+(\w+)/i);

    if (fromMatch) {
      const searchResult = await gmail.searchMessages(`from:${fromMatch[1]}`, 5);
      if (!searchResult.ok || !searchResult.messages || searchResult.messages.length === 0) return null;

      return {
        label: `Email search: from ${fromMatch[1]}`,
        content: [
          `--- Email search results: from ${fromMatch[1]} ---`,
          gmail.formatMessagesForContext(searchResult.messages),
          `--- End email results ---`,
        ].join("\n"),
      };
    }

    // Generic inbox query — show recent unread
    const [unreadResult, recentResult] = await Promise.all([
      gmail.getUnreadCount(),
      gmail.getRecentMessages(24),
    ]);
    const unreadCount = unreadResult.ok ? unreadResult.count ?? 0 : 0;
    const recent = recentResult.ok ? recentResult.messages ?? [] : [];

    if (recent.length === 0 && unreadCount === 0) return null;

    return {
      label: "Inbox summary",
      content: [
        `--- Inbox summary (${unreadCount} unread) ---`,
        gmail.formatMessagesForContext(recent.slice(0, 10)),
        `--- End inbox summary ---`,
        `Use this to answer the user's question about their email or inbox.`,
      ].join("\n"),
    };
  },
};
