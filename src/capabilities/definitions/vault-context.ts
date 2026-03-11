/**
 * Vault context provider — injects retrieval API instructions into the LLM
 * prompt when form-filling keywords are detected.
 *
 * SECURITY: This provider NEVER injects actual vault values into the prompt.
 * It only tells the LLM what fields are available and how to request them
 * via the VAULT_ACTION block. Actual values are retrieved at execution time
 * and passed directly to the form-fill target, bypassing the LLM context.
 */

import type {
  ContextProviderCapability,
  ContextInjection,
  ActionContext,
} from "../types.js";

// Lazy-loaded byok-tier module
let _vault: typeof import("../../vault/personal.js") | null = null;
async function getVault() {
  if (!_vault) { try { _vault = await import("../../vault/personal.js"); } catch { _vault = null; } }
  return _vault;
}

const KEYWORDS =
  /\b(form|fill|auto.?fill|personal|address|name|tax|ssn|credit.?card|checkout|sign.?up|register|application)\b/i;

export const vaultContextProvider: ContextProviderCapability = {
  id: "vault-context",
  pattern: "context",
  keywords: [
    "form",
    "fill",
    "autofill",
    "personal",
    "address",
    "name",
    "tax",
    "ssn",
    "checkout",
    "signup",
    "register",
    "application",
  ],

  getPromptInstructions(_ctx: ActionContext): string {
    return ""; // Context providers inject data, not prompt instructions
  },

  shouldInject(message: string): boolean {
    return KEYWORDS.test(message);
  },

  async getContext(_message: string): Promise<ContextInjection | null> {
    const vault = await getVault();
    if (!vault) return null;
    const fields = await vault.listPersonalFields();
    if (fields.length === 0) return null;

    // Group by category for a clean summary
    const byCategory = new Map<string, string[]>();
    for (const f of fields) {
      const list = byCategory.get(f.category) ?? [];
      list.push(f.field);
      byCategory.set(f.category, list);
    }

    const lines: string[] = [
      "--- Personal vault (field names only — values are encrypted) ---",
    ];
    for (const [cat, fieldNames] of byCategory) {
      lines.push(`${cat}: ${fieldNames.join(", ")}`);
    }
    lines.push("--- End vault summary ---");
    lines.push(
      "To retrieve values for form filling, use the vault retrieval API. " +
        "NEVER ask the user to re-enter data that is already stored in the vault. " +
        "NEVER log, display, or repeat vault values in conversation.",
    );

    return {
      label: "Personal vault fields",
      content: lines.join("\n"),
    };
  },
};
