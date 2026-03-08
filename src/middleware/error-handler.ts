import type { ErrorHandler, NotFoundHandler } from "hono";
import { createLogger } from "../utils/logger.js";

const log = createLogger("error-handler");

// ── ApiError ─────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code ?? statusToCode(status);
  }
}

function statusToCode(status: number): string {
  switch (status) {
    case 400: return "BAD_REQUEST";
    case 401: return "AUTH_REQUIRED";
    case 403: return "FORBIDDEN";
    case 404: return "NOT_FOUND";
    case 409: return "CONFLICT";
    case 422: return "UNPROCESSABLE";
    case 429: return "RATE_LIMITED";
    default:  return "INTERNAL_ERROR";
  }
}

// ── Error response shape ─────────────────────────────────────────────────────

interface ErrorResponseBody {
  error: string;
  code: string;
  status: number;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof ApiError) {
    log.warn(err.message, { status: err.status, code: err.code });

    const body: ErrorResponseBody = {
      error: err.message,
      code: err.code,
      status: err.status,
    };
    return c.json(body, err.status as any);
  }

  // Generic / unexpected error
  const isProduction = process.env.NODE_ENV === "production";
  const message = isProduction ? "Internal server error" : err.message;

  log.error(err.message, {
    stack: isProduction ? undefined : err.stack,
  });

  const body: ErrorResponseBody = {
    error: message,
    code: "INTERNAL_ERROR",
    status: 500,
  };
  return c.json(body, 500);
};

export const notFoundHandler: NotFoundHandler = (c) => {
  const body: ErrorResponseBody = {
    error: "Not found",
    code: "NOT_FOUND",
    status: 404,
  };
  return c.json(body, 404);
};

// ── Helper throwers ──────────────────────────────────────────────────────────

export function badRequest(message: string): never {
  throw new ApiError(400, message, "BAD_REQUEST");
}

export function unauthorized(message = "Authentication required"): never {
  throw new ApiError(401, message, "AUTH_REQUIRED");
}

export function forbidden(message = "Forbidden"): never {
  throw new ApiError(403, message, "FORBIDDEN");
}

export function notFound(message = "Not found"): never {
  throw new ApiError(404, message, "NOT_FOUND");
}
