/**
 * Google OAuth2 token management.
 * Raw fetch — no SDK. Credentials from vault (process.env).
 * Follows src/twilio/call.ts pattern: never throws, returns { ok, message }.
 *
 * Stores refresh token in vault as GOOGLE_REFRESH_TOKEN.
 * Access tokens are cached in memory and auto-refreshed (they expire hourly).
 */

import { createLogger } from "../utils/logger.js";

const log = createLogger("google.auth");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** All scopes requested upfront to avoid re-consent. */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/tasks",
];

const REQUIRED_VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const;

// --- In-memory access token cache ---

let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0; // epoch ms

/**
 * Check if Google OAuth is configured (client ID + secret in vault).
 */
export function isGoogleConfigured(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
}

/**
 * Check if Google OAuth is authenticated (refresh token exists).
 */
export function isGoogleAuthenticated(): boolean {
  return isGoogleConfigured() && !!process.env.GOOGLE_REFRESH_TOKEN;
}

/**
 * Build the Google authorization URL for the consent screen.
 * Redirects to localhost callback after user approves.
 */
export function getAuthUrl(redirectUri: string): { ok: boolean; url?: string; message: string } {
  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    log.warn("OAuth config incomplete — missing vault keys", { missing });
    return {
      ok: false,
      message: `Missing vault keys: ${missing.join(", ")}. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in vault settings.`,
    };
  }

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // Force consent to always get refresh token
  });

  log.debug("Generated OAuth authorization URL", { redirectUri });
  return {
    ok: true,
    url: `${GOOGLE_AUTH_URL}?${params.toString()}`,
    message: "Authorization URL generated",
  };
}

/**
 * Exchange an authorization code for access + refresh tokens.
 * Returns the refresh token to be stored in vault.
 */
export async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<{ ok: boolean; refreshToken?: string; accessToken?: string; message: string }> {
  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    return { ok: false, message: `Missing vault keys: ${missing.join(", ")}` };
  }

  try {
    log.debug("Exchanging authorization code for tokens");
    const params = new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text();
      log.error("Token exchange HTTP error", { status: res.status, body });
      return { ok: false, message: `Google token error (${res.status}): ${body}` };
    }

    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!data.refresh_token) {
      log.warn("No refresh token in exchange response — user may need to re-consent");
      return { ok: false, message: "No refresh token returned — try revoking app access in Google settings and re-authorizing" };
    }

    // Cache access token
    cachedAccessToken = data.access_token ?? null;
    tokenExpiresAt = Date.now() + ((data.expires_in ?? 3600) - 60) * 1000; // 60s buffer

    log.info("OAuth tokens exchanged successfully", { expiresIn: data.expires_in });
    return {
      ok: true,
      refreshToken: data.refresh_token,
      accessToken: data.access_token,
      message: "Tokens exchanged successfully",
    };
  } catch (err: any) {
    log.error("Token exchange failed", { error: err.message });
    return { ok: false, message: `Token exchange failed: ${err.message}` };
  }
}

/**
 * Get a valid access token, auto-refreshing if expired.
 * Never throws — returns { ok, token?, message }.
 */
export async function getAccessToken(): Promise<{ ok: boolean; token?: string; message: string }> {
  // Return cached token if still valid
  if (cachedAccessToken && Date.now() < tokenExpiresAt) {
    log.debug("Using cached access token", { expiresIn: Math.round((tokenExpiresAt - Date.now()) / 1000) });
    return { ok: true, token: cachedAccessToken, message: "Cached token" };
  }

  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!refreshToken) {
    log.warn("No GOOGLE_REFRESH_TOKEN in vault — not authenticated");
    return { ok: false, message: "Not authenticated — no GOOGLE_REFRESH_TOKEN in vault" };
  }

  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    return { ok: false, message: `Missing vault keys: ${missing.join(", ")}` };
  }

  try {
    log.debug("Refreshing access token");
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text();
      // Clear cached token on auth failure
      cachedAccessToken = null;
      tokenExpiresAt = 0;
      log.error("Token refresh HTTP error — cache cleared", { status: res.status, body });
      return { ok: false, message: `Token refresh failed (${res.status}): ${body}` };
    }

    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!data.access_token) {
      log.error("No access token in refresh response");
      return { ok: false, message: "No access token in refresh response" };
    }

    cachedAccessToken = data.access_token;
    tokenExpiresAt = Date.now() + ((data.expires_in ?? 3600) - 60) * 1000;

    log.info("Access token refreshed successfully", { expiresIn: data.expires_in });
    return { ok: true, token: cachedAccessToken, message: "Token refreshed" };
  } catch (err: any) {
    log.error("Token refresh failed", { error: err.message });
    return { ok: false, message: `Token refresh failed: ${err.message}` };
  }
}

/**
 * Make an authenticated GET request to a Google API.
 * Auto-refreshes token. Returns parsed JSON or error.
 */
export async function googleGet<T = any>(
  url: string,
  params?: Record<string, string | string[]>,
): Promise<{ ok: boolean; data?: T; message: string }> {
  const auth = await getAccessToken();
  if (!auth.ok) return { ok: false, message: auth.message };

  try {
    let fullUrl = url;
    if (params) {
      const qs = new URLSearchParams();
      for (const [key, val] of Object.entries(params)) {
        if (Array.isArray(val)) {
          for (const v of val) qs.append(key, v);
        } else {
          qs.append(key, val);
        }
      }
      fullUrl = `${url}?${qs.toString()}`;
    }

    const res = await fetch(fullUrl, {
      headers: { Authorization: `Bearer ${auth.token}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 401) {
      // Token might have been revoked — clear cache and retry once
      log.warn("GET received 401 — clearing token cache and retrying", { url });
      cachedAccessToken = null;
      tokenExpiresAt = 0;
      const retry = await getAccessToken();
      if (!retry.ok) return { ok: false, message: `Auth failed: ${retry.message}` };

      const retryRes = await fetch(fullUrl, {
        headers: { Authorization: `Bearer ${retry.token}` },
        signal: AbortSignal.timeout(15_000),
      });

      if (!retryRes.ok) {
        const body = await retryRes.text();
        log.error("GET retry failed", { url, status: retryRes.status });
        return { ok: false, message: `Google API error (${retryRes.status}): ${body}` };
      }

      log.debug("GET succeeded on retry", { url });
      return { ok: true, data: (await retryRes.json()) as T, message: "OK (retry)" };
    }

    if (!res.ok) {
      const body = await res.text();
      log.error("GET failed", { url, status: res.status });
      return { ok: false, message: `Google API error (${res.status}): ${body}` };
    }

    return { ok: true, data: (await res.json()) as T, message: "OK" };
  } catch (err: any) {
    log.error("GET request exception", { url, error: err.message });
    return { ok: false, message: `Google API request failed: ${err.message}` };
  }
}

/**
 * Make an authenticated POST request to a Google API.
 * Auto-refreshes token. Returns parsed JSON or error.
 */
export async function googlePost<T = any>(
  url: string,
  body: Record<string, any>,
): Promise<{ ok: boolean; data?: T; message: string }> {
  const auth = await getAccessToken();
  if (!auth.ok) return { ok: false, message: auth.message };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text();
      log.error("POST failed", { url, status: res.status });
      return { ok: false, message: `Google API error (${res.status}): ${text}` };
    }

    return { ok: true, data: (await res.json()) as T, message: "OK" };
  } catch (err: any) {
    log.error("POST request exception", { url, error: err.message });
    return { ok: false, message: `Google API request failed: ${err.message}` };
  }
}

/**
 * Make an authenticated PATCH request to a Google API.
 */
export async function googlePatch<T = any>(
  url: string,
  body: Record<string, any>,
): Promise<{ ok: boolean; data?: T; message: string }> {
  const auth = await getAccessToken();
  if (!auth.ok) return { ok: false, message: auth.message };

  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text();
      log.error("PATCH failed", { url, status: res.status });
      return { ok: false, message: `Google API error (${res.status}): ${text}` };
    }

    return { ok: true, data: (await res.json()) as T, message: "OK" };
  } catch (err: any) {
    log.error("PATCH request exception", { url, error: err.message });
    return { ok: false, message: `Google API request failed: ${err.message}` };
  }
}

/**
 * Make an authenticated DELETE request to a Google API.
 */
export async function googleDelete(
  url: string,
): Promise<{ ok: boolean; message: string }> {
  const auth = await getAccessToken();
  if (!auth.ok) return { ok: false, message: auth.message };

  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${auth.token}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text();
      log.error("DELETE failed", { url, status: res.status });
      return { ok: false, message: `Google API error (${res.status}): ${text}` };
    }

    return { ok: true, message: "Deleted" };
  } catch (err: any) {
    log.error("DELETE request exception", { url, error: err.message });
    return { ok: false, message: `Google API request failed: ${err.message}` };
  }
}

/**
 * Clear the cached access token (e.g., when vault keys change).
 */
export function clearTokenCache(): void {
  cachedAccessToken = null;
  tokenExpiresAt = 0;
}
