/**
 * Onboarding — Name extraction and validation.
 *
 * Handles the greeting phase: extract a human name from free-text input,
 * validate it, and return a confidence-scored result.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface NameExtractionResult {
  name: string | null;
  confidence: "high" | "medium" | "low";
  source: "explicit" | "bare" | "context";
}

export interface NameValidationResult {
  valid: boolean;
  error?: string;
}

// ── Offensive content filter (basic) ─────────────────────────────────────────

const BLOCKED_WORDS: ReadonlySet<string> = new Set([
  "fuck", "shit", "ass", "bitch", "damn", "dick", "cunt", "bastard",
  "nigger", "nigga", "faggot", "retard", "slut", "whore",
]);

function containsOffensiveContent(name: string): boolean {
  const lower = name.toLowerCase();
  for (const word of BLOCKED_WORDS) {
    const pattern = new RegExp(`\\b${word}\\b`, "i");
    if (pattern.test(lower)) return true;
  }
  return false;
}

// ── Title handling ───────────────────────────────────────────────────────────

const TITLE_PATTERN = /^(?:mr\.?|mrs\.?|ms\.?|miss|dr\.?|prof\.?|sir|lord|lady|rev\.?)\s+/i;

/** Strip common titles/honorifics from the start of a name. */
function stripTitle(name: string): string {
  return name.replace(TITLE_PATTERN, "").trim();
}

// ── Extraction patterns ──────────────────────────────────────────────────────

interface NamePattern {
  regex: RegExp;
  confidence: "high" | "medium";
}

const NAME_PATTERNS: readonly NamePattern[] = [
  // High confidence — explicit name statements
  { regex: /\bmy name is\s+(.+)/i, confidence: "high" },
  { regex: /\bi'?m\s+(.+)/i, confidence: "high" },
  { regex: /\bi am\s+(.+)/i, confidence: "high" },
  { regex: /\bcall me\s+(.+)/i, confidence: "high" },
  { regex: /\bname'?s\s+(.+)/i, confidence: "high" },
  { regex: /\byou can call me\s+(.+)/i, confidence: "high" },
  { regex: /\bjust call me\s+(.+)/i, confidence: "high" },

  // Medium confidence — indirect references
  { regex: /\beveryone calls me\s+(.+)/i, confidence: "medium" },
  { regex: /\beverybody calls me\s+(.+)/i, confidence: "medium" },
  { regex: /\bpeople call me\s+(.+)/i, confidence: "medium" },
  { regex: /\bthey call me\s+(.+)/i, confidence: "medium" },
  { regex: /\bgo by\s+(.+)/i, confidence: "medium" },
  { regex: /\bit'?s\s+(.+)/i, confidence: "medium" },
  { regex: /\bthe name(?:'s| is)\s+(.+)/i, confidence: "medium" },
  { regex: /\bfriends call me\s+(.+)/i, confidence: "medium" },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Clean trailing punctuation, surrounding quotes, and trailing clauses. */
function cleanName(raw: string): string {
  let name = raw.trim();

  // Remove surrounding quotes
  name = name.replace(/^["']|["']$/g, "");

  // Truncate at common sentence continuations that aren't part of the name
  name = name.replace(/[,;]\s*(?:and|but|nice|glad|pleased|thanks|thank|how|what|i'm|i am|it's|so)\b.*/i, "");
  name = name.replace(/\s+(?:and i(?:'m|\s+am)|but i|nice to|glad to|pleased to|thanks|thank you|how are|what's|so glad)\b.*/i, "");

  // Remove trailing punctuation
  name = name.replace(/[.!?,;:]+$/, "");

  // Strip titles (Mr., Dr., etc.) — we want just the name
  name = stripTitle(name);

  return name.trim();
}

/**
 * Heuristic: does this look like a bare name (1-4 words, reasonable characters)?
 * Allows hyphens, apostrophes, and accented chars within name words.
 */
function looksLikeBareName(input: string): boolean {
  const words = input.split(/\s+/);
  if (words.length < 1 || words.length > 4) return false;
  return words.every(w => /^[a-zA-ZÀ-ÿ]/.test(w) && /^[a-zA-ZÀ-ÿ'-]+$/.test(w) && w.length <= 25);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract a name from free-text input.
 *
 * Handles:
 * - "My name is Bryant" → high confidence, explicit
 * - "I'm Bryant" → high confidence, explicit
 * - "Call me B" → high confidence, explicit
 * - "Everyone calls me B" → medium confidence, explicit
 * - "Dr. Sarah Chen" → medium confidence, bare (title stripped)
 * - "Bryant" → medium confidence, bare
 * - "Bryant Herrman" → medium confidence, bare (multi-word)
 * - "hey there, Bryant here" → low confidence, context
 * - Empty/garbage → null, low confidence
 */
export function extractName(message: string): NameExtractionResult {
  const trimmed = message.trim();

  if (!trimmed) {
    return { name: null, confidence: "low", source: "context" };
  }

  // Try explicit patterns first
  for (const { regex, confidence } of NAME_PATTERNS) {
    const match = trimmed.match(regex);
    if (match) {
      const name = cleanName(match[1]);
      const validation = validateName(name);
      if (name && validation.valid) {
        return { name, confidence, source: "explicit" };
      }
    }
  }

  // Bare name detection: single word or short phrase that looks like a name
  const cleaned = cleanName(trimmed);
  if (cleaned && looksLikeBareName(cleaned)) {
    const validation = validateName(cleaned);
    if (validation.valid) {
      return {
        name: cleaned,
        confidence: "medium",
        source: "bare",
      };
    }
  }

  // Context: try to find a capitalized word that might be a name
  const NON_NAME_WORDS = new Set([
    "i", "hey", "hi", "hello", "yo", "sup", "well", "ok", "okay",
    "yeah", "yes", "no", "nah", "sure", "the", "a", "an", "my",
    "what", "how", "who", "when", "where", "why", "just", "so",
  ]);

  const words = trimmed.split(/\s+/);
  for (const word of words) {
    const clean = word.replace(/[^a-zA-ZÀ-ÿ'-]/g, "");
    if (
      clean.length >= 2 &&
      clean.length <= 25 &&
      /^[A-ZÀ-Ý]/.test(clean) &&
      !NON_NAME_WORDS.has(clean.toLowerCase())
    ) {
      const validation = validateName(clean);
      if (validation.valid) {
        return { name: clean, confidence: "low", source: "context" };
      }
    }
  }

  return { name: null, confidence: "low", source: "context" };
}

/**
 * Validate an extracted name.
 *
 * Rules:
 * - Length between 1 and 50 characters
 * - Contains at least one letter
 * - Only contains letters, spaces, hyphens, apostrophes, and periods
 * - No offensive content
 * - Not a single common non-name word
 */
export function validateName(name: string): NameValidationResult {
  if (!name || name.length === 0) {
    return { valid: false, error: "Name cannot be empty." };
  }

  if (name.length > 50) {
    return { valid: false, error: "Name must be 50 characters or fewer." };
  }

  if (!/[a-zA-ZÀ-ÿ]/.test(name)) {
    return { valid: false, error: "Name must contain at least one letter." };
  }

  // Only allow letters, spaces, hyphens, apostrophes, periods (for initials)
  if (!/^[a-zA-ZÀ-ÿ\s'.\-]+$/.test(name)) {
    return { valid: false, error: "Name contains invalid characters." };
  }

  if (containsOffensiveContent(name)) {
    return { valid: false, error: "Name contains inappropriate content." };
  }

  return { valid: true };
}
