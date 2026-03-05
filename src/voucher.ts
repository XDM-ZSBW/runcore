/**
 * Decoder Ring — brain-to-brain voucher system.
 * Short-lived tokens the human carries between brains as proof of intent.
 * Vouchers live in procedural memory (append-only JSONL).
 */

import { randomBytes } from "node:crypto";
import type { LongTermMemoryStore } from "./memory/long-term.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("voucher");

export interface VoucherResult {
  valid: boolean;
  scope?: string;
}

function generateToken(): string {
  return `vch_${randomBytes(4).toString("hex")}`;
}

/**
 * Issue a voucher: generate a token, store it in procedural memory.
 * @returns The token string for the human to carry.
 */
export async function issueVoucher(
  ltm: LongTermMemoryStore,
  scope?: string,
  ttlMinutes: number = 30,
): Promise<string> {
  const token = generateToken();
  const expires = new Date(Date.now() + ttlMinutes * 60_000).toISOString();

  await ltm.add({
    type: "procedural",
    content: `Voucher ${token} issued`,
    meta: {
      voucher: true,
      token,
      ...(scope ? { scope } : {}),
      status: "active",
      expires,
    },
  });

  return token;
}

/**
 * Check a voucher: scan procedural memory for the token.
 * Returns valid only if the token exists, is active, hasn't expired,
 * and no later entry has archived/revoked it.
 */
export async function checkVoucher(
  ltm: LongTermMemoryStore,
  token: string,
): Promise<VoucherResult> {
  // Get all entries for this token (both active and archived)
  const entries = await ltm.search({
    type: "procedural",
    meta: { voucher: true, token },
  });

  if (entries.length === 0) return { valid: false };

  // Sort newest-first — the latest status wins
  const sorted = entries.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const latest = sorted[0];
  const meta = latest.meta as Record<string, string | number | boolean> | undefined;

  if (!meta || meta.status !== "active") return { valid: false };

  // Check expiry
  if (meta.expires && new Date(meta.expires as string) < new Date()) {
    return { valid: false };
  }

  return {
    valid: true,
    scope: meta.scope as string | undefined,
  };
}

/**
 * Revoke a voucher: append an archived entry for the token.
 */
export async function revokeVoucher(
  ltm: LongTermMemoryStore,
  token: string,
): Promise<boolean> {
  const check = await checkVoucher(ltm, token);
  if (!check.valid) return false;

  await ltm.add({
    type: "procedural",
    content: `Voucher ${token} revoked`,
    meta: {
      voucher: true,
      token,
      status: "archived",
    },
  });

  return true;
}

// ── Alert callback for failed voucher checks ──────────────────────────────

type AlertFn = (subject: string, body: string) => Promise<unknown>;
let _alertFn: AlertFn | null = null;

/**
 * Register an alert function to be called on failed voucher checks.
 * Keeps voucher.ts decoupled from the alert system — caller wires the dependency.
 */
export function setVoucherAlertFn(fn: AlertFn): void {
  _alertFn = fn;
}

/**
 * Check a voucher with alerting on failure.
 * Wraps checkVoucher() — if the token is invalid/expired, fires an alert.
 * Use this at trust boundaries (MCP tools, mesh auth) instead of raw checkVoucher().
 */
export async function checkVoucherWithAlert(
  ltm: LongTermMemoryStore,
  token: string,
  context?: string,
): Promise<VoucherResult> {
  const result = await checkVoucher(ltm, token);

  if (!result.valid) {
    const masked = token.length > 8 ? token.slice(0, 8) + "..." : token;
    const where = context ? ` (${context})` : "";
    log.warn("Voucher check failed", { token: masked, context });

    if (_alertFn) {
      _alertFn(
        `Voucher check failed${where}`,
        `Someone tried token "${masked}"${where} at ${new Date().toISOString()}. The voucher was invalid or expired.`,
      ).catch((err) => {
        log.debug("Alert dispatch failed", { error: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  return result;
}
