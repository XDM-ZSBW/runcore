/**
 * Safe Word — creation, validation, and strength assessment.
 *
 * The safe word is the single authentication factor for the entire system.
 * No passwords, no OAuth, no accounts. Created during onboarding,
 * used for every nerve spawn and session thereafter.
 */

import { createHash, randomBytes } from "node:crypto";
import { SAFE_WORD_RULES, type SafeWordValidation } from "./types.js";

// ── Banned patterns ────────────────────────────────────────────────────────

/** Common weak safe words that should be rejected. */
const WEAK_PATTERNS = [
  "password", "12345", "abcde", "qwerty", "letmein",
  "admin", "test", "hello", "secret", "safe",
];

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate a safe word against the rules.
 * Returns { valid: true } or { valid: false, reason: "..." }.
 */
export function validateSafeWord(input: string): SafeWordValidation {
  const trimmed = input.trim();

  if (trimmed.length < SAFE_WORD_RULES.minLength) {
    return { valid: false, reason: `Too short — need at least ${SAFE_WORD_RULES.minLength} characters.` };
  }

  if (trimmed.length > SAFE_WORD_RULES.maxLength) {
    return { valid: false, reason: `Too long — keep it under ${SAFE_WORD_RULES.maxLength} characters.` };
  }

  const lower = trimmed.toLowerCase();
  for (const weak of WEAK_PATTERNS) {
    if (lower === weak) {
      return { valid: false, reason: "That's too common — pick something more personal." };
    }
  }

  return { valid: true };
}

/**
 * Check if two safe word entries match (for confirmation step).
 */
export function safeWordsMatch(first: string, second: string): boolean {
  return first.trim().toLowerCase() === second.trim().toLowerCase();
}

// ── Hashing ────────────────────────────────────────────────────────────────

/**
 * Hash a safe word for storage. Same algorithm as auth/identity.ts.
 * SHA-256 of lowercased, trimmed input.
 */
export function hashSafeWord(safeWord: string): string {
  return createHash("sha256")
    .update(safeWord.trim().toLowerCase())
    .digest("hex");
}

/**
 * Generate a PBKDF2 salt for session key derivation.
 * Returns 16 random bytes as hex string.
 */
export function generateSalt(): string {
  return randomBytes(16).toString("hex");
}

// ── Strength feedback ──────────────────────────────────────────────────────

export type SafeWordStrength = "weak" | "fair" | "strong";

/**
 * Assess safe word strength for user feedback (not a gate — just guidance).
 * Stronger safe words get a friendlier confirmation message.
 */
export function assessStrength(safeWord: string): SafeWordStrength {
  const trimmed = safeWord.trim();
  const words = trimmed.split(/\s+/).length;
  const length = trimmed.length;

  // Multi-word phrases are strong
  if (words >= 3 && length >= 12) return "strong";

  // Medium length or two words
  if (length >= 8 || words >= 2) return "fair";

  return "weak";
}

/**
 * Get a confirmation message based on strength.
 * Used during onboarding to acknowledge the safe word without repeating it.
 */
export function strengthMessage(strength: SafeWordStrength): string {
  switch (strength) {
    case "strong":
      return "That's a solid safe word. I'll remember it.";
    case "fair":
      return "Got it. That works — I'll keep it safe.";
    case "weak":
      return "Noted. Short and simple — just make sure you remember it.";
  }
}
