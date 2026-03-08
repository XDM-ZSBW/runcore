/**
 * Session auth middleware — hard gate on all /api/* routes.
 * No valid session = 401. No exceptions except the allowlist.
 */

import type { MiddlewareHandler } from "hono";
import { validateSession } from "./identity.js";

// --- Public routes (no session required) ---

/** Exact paths that skip auth. */
const PUBLIC_EXACT = new Set([
  "/api/status",
  "/api/pair",
  "/api/auth",
  "/api/auth/validate",
  "/api/auth/active-session",
  "/api/auth/token",
  "/api/recover",
  "/api/tier",
  "/api/health",
  "/api/ui-version",
  "/api/local-model",
]);

/** Prefixes that skip auth (webhooks verified by their own mechanisms). */
const PUBLIC_PREFIXES = [
  "/api/github/webhooks",
  "/api/slack/",
  "/api/whatsapp/",
  "/api/twilio/",
  "/api/mobile/info/",   // voucher info (display only, no secrets)
  "/api/mobile/redeem",  // voucher redemption (auth via safe word)
];

function isPublic(path: string): boolean {
  if (PUBLIC_EXACT.has(path)) return true;
  for (const prefix of PUBLIC_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Hono middleware: requires a valid session for all /api/* routes
 * unless the route is in the public allowlist.
 *
 * Session ID is extracted from (in order of priority):
 *   1. x-session-id header
 *   2. ?sessionId= query parameter
 */
export function requireSession(): MiddlewareHandler {
  return async (c, next) => {
    if (isPublic(c.req.path)) {
      return next();
    }

    const sessionId =
      c.req.header("x-session-id") ||
      c.req.query("sessionId") ||
      "";

    if (!sessionId) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const session = validateSession(sessionId);
    if (!session) {
      return c.json({ error: "Invalid or expired session" }, 401);
    }

    // Store in context for downstream handlers
    c.set("session", session);
    c.set("sessionId", sessionId);
    await next();
  };
}
