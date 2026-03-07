/**
 * Posture middleware — gates routes by current UI surface level
 * and records interaction signals for intent accumulation.
 *
 * Routes return 404 (not 403) when posture is below threshold.
 * The surface doesn't exist yet — it's not forbidden, it's not assembled.
 */

import type { MiddlewareHandler } from "hono";
import { hasSurface, recordInteraction, getSurface } from "./engine.js";
import type { PostureSurface } from "./types.js";

/**
 * Middleware: record every API interaction as a signal.
 * Mounted early — runs for all /api/* routes.
 */
export function postureTracker(): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;

    // Classify the interaction
    let surface: keyof PostureSurface | "page-view" = "chat";
    let detail: string | undefined;

    if (path.startsWith("/api/nerve") || path.startsWith("/api/pulse")) {
      surface = "pulse";
    } else if (path.startsWith("/api/board")) {
      surface = "pages";
      detail = "board";
    } else if (path.startsWith("/api/ops")) {
      surface = "pages";
      detail = "ops";
    } else if (path.startsWith("/api/agents")) {
      surface = "agents";
    } else if (path.startsWith("/api/settings") || path.startsWith("/api/admin")) {
      surface = "settings";
    } else if (path.startsWith("/api/open-loops") || path.startsWith("/api/insights") || path.startsWith("/api/metrics")) {
      surface = "pages";
      detail = "observatory";
    } else if (path.startsWith("/api/chat")) {
      surface = "chat";
    } else if (path.startsWith("/api/browse") || path.startsWith("/api/search")) {
      surface = "pages";
      detail = "browser";
    }

    recordInteraction({
      timestamp: new Date().toISOString(),
      surface,
      detail,
    });

    await next();
  };
}

/**
 * Middleware: record page views (HTML page loads).
 * Mounted on page routes like /board, /ops, /observatory, etc.
 */
export function pageViewTracker(pageName: string): MiddlewareHandler {
  return async (c, next) => {
    recordInteraction({
      timestamp: new Date().toISOString(),
      surface: "page-view",
      detail: pageName,
    });
    await next();
  };
}

/**
 * Require a minimum posture level for a route group.
 * Returns 404 if the surface isn't assembled yet.
 */
export function requireSurface(surface: keyof PostureSurface): MiddlewareHandler {
  return async (c, next) => {
    if (!hasSurface(surface)) {
      return c.json({ error: "not_available", posture: "surface not assembled" }, 404);
    }
    await next();
  };
}

/**
 * Add posture info to API responses via header.
 * Clients use this to know what to render.
 */
export function postureHeader(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const surface = getSurface();
    c.header("X-Posture-Surface", JSON.stringify(surface));
  };
}
