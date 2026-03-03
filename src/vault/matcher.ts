/**
 * Fuzzy field matcher — maps form field labels to personal vault entries.
 *
 * Normalizes incoming labels (lowercased, stripped of punctuation/whitespace),
 * checks exact matches first, then alias mappings, then substring/token overlap.
 * Returns a confidence score (0–1) so callers can threshold auto-fill decisions.
 */

import { listPersonalFields, type VaultCategory } from "./personal.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface FieldMatch {
  /** The vault field name that matched. */
  field: string;
  /** The vault category. */
  category: VaultCategory;
  /** Confidence score: 1.0 = exact/alias, 0.7 = token overlap, 0.5 = substring. */
  confidence: number;
}

// ── Alias map ────────────────────────────────────────────────────────────────

/**
 * Maps common form label variants to canonical vault field names.
 * Keys are normalized (lowercase, no punctuation). Values are vault field names.
 */
const ALIASES: Record<string, string> = {
  // Identity
  "first name": "name.first",
  "firstname": "name.first",
  "fname": "name.first",
  "given name": "name.first",
  "last name": "name.last",
  "lastname": "name.last",
  "lname": "name.last",
  "surname": "name.last",
  "family name": "name.last",
  "full name": "name.full",
  "fullname": "name.full",
  "name": "name.full",
  "middle name": "name.middle",
  "middlename": "name.middle",
  "date of birth": "dob",
  "birthday": "dob",
  "birthdate": "dob",
  "dob": "dob",
  "ssn": "ssn",
  "social security": "ssn",
  "social security number": "ssn",

  // Contact
  "email": "email",
  "email address": "email",
  "e-mail": "email",
  "phone": "phone",
  "phone number": "phone",
  "telephone": "phone",
  "mobile": "phone.mobile",
  "mobile phone": "phone.mobile",
  "cell": "phone.mobile",
  "cell phone": "phone.mobile",
  "home phone": "phone.home",
  "work phone": "phone.work",
  "address": "address.street",
  "street address": "address.street",
  "address line 1": "address.line1",
  "address line1": "address.line1",
  "address1": "address.line1",
  "street": "address.line1",
  "address line 2": "address.line2",
  "address line2": "address.line2",
  "address2": "address.line2",
  "apt": "address.line2",
  "apartment": "address.line2",
  "suite": "address.line2",
  "unit": "address.line2",
  "city": "address.city",
  "state": "address.state",
  "province": "address.state",
  "zip": "address.zip",
  "zip code": "address.zip",
  "zipcode": "address.zip",
  "postal code": "address.zip",
  "postcode": "address.zip",
  "country": "address.country",

  // Financial
  "card number": "card.number",
  "credit card": "card.number",
  "credit card number": "card.number",
  "cc number": "card.number",
  "card holder": "card.holder",
  "cardholder": "card.holder",
  "cardholder name": "card.holder",
  "name on card": "card.holder",
  "expiration": "card.expiry",
  "expiration date": "card.expiry",
  "exp date": "card.expiry",
  "expiry": "card.expiry",
  "cvv": "card.cvv",
  "cvc": "card.cvv",
  "security code": "card.cvv",
  "routing number": "bank.routing",
  "routing": "bank.routing",
  "account number": "bank.account",
  "bank account": "bank.account",

  // Credentials
  "username": "username",
  "user name": "username",
  "login": "username",
  "password": "password",
  "pass": "password",
};

// ── Normalization ────────────────────────────────────────────────────────────

/** Normalize a label for matching: lowercase, strip non-alphanumeric (keep spaces). */
function normalize(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokenize a normalized string into words. */
function tokenize(s: string): string[] {
  return s.split(/[\s.]+/).filter(Boolean);
}

// ── Matching ─────────────────────────────────────────────────────────────────

/**
 * Match a form field label to a vault entry.
 *
 * Strategy (in order):
 * 1. Exact match on normalized vault field name → confidence 1.0
 * 2. Alias lookup → confidence 1.0
 * 3. Token overlap (Jaccard-like) → confidence 0.5–0.8
 *
 * Returns null if no match found above threshold (0.5).
 */
export async function matchField(label: string): Promise<FieldMatch | null> {
  const norm = normalize(label);
  if (!norm) return null;

  const fields = await listPersonalFields();
  const fieldMap = new Map(fields.map((f) => [f.field, f]));

  // 1. Exact match on vault field name
  for (const entry of fields) {
    if (normalize(entry.field) === norm) {
      return { field: entry.field, category: entry.category, confidence: 1.0 };
    }
  }

  // 2. Alias lookup
  const aliasTarget = ALIASES[norm];
  if (aliasTarget) {
    const entry = fieldMap.get(aliasTarget);
    if (entry) {
      return { field: entry.field, category: entry.category, confidence: 1.0 };
    }
    // Alias matched but no vault entry exists yet — still return the canonical field
    return null;
  }

  // 3. Token overlap scoring
  const labelTokens = new Set(tokenize(norm));
  if (labelTokens.size === 0) return null;

  let bestMatch: FieldMatch | null = null;
  let bestScore = 0;

  for (const entry of fields) {
    const fieldTokens = new Set(tokenize(normalize(entry.field)));
    if (fieldTokens.size === 0) continue;

    // Count shared tokens
    let shared = 0;
    for (const t of labelTokens) {
      if (fieldTokens.has(t)) shared++;
    }

    // Jaccard-like: shared / union
    const union = new Set([...labelTokens, ...fieldTokens]).size;
    const score = shared / union;

    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      bestMatch = {
        field: entry.field,
        category: entry.category,
        confidence: Math.min(0.8, 0.5 + score * 0.3),
      };
    }
  }

  return bestMatch;
}

/**
 * Match multiple form field labels at once.
 * Returns matches for each label (null entries for unmatched labels are omitted).
 */
export async function matchFields(
  labels: string[],
): Promise<FieldMatch[]> {
  const results: FieldMatch[] = [];
  for (const label of labels) {
    const match = await matchField(label);
    if (match) results.push(match);
  }
  return results;
}

/**
 * Get the canonical vault field name for a form label via alias lookup.
 * Returns the canonical name or the normalized label if no alias exists.
 * Does NOT check if the field exists in the vault.
 */
export function resolveFieldName(label: string): string {
  const norm = normalize(label);
  return ALIASES[norm] ?? norm;
}
