/**
 * Structured error types for Core.
 * Provides consistent error classification across the application.
 */

/** Base error for all Core subsystems. */
export class CoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly recoverable: boolean = false,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CoreError";
  }
}

/** Error during file I/O operations (brain files, settings, etc.). */
export class FileIOError extends CoreError {
  constructor(
    public readonly path: string,
    public readonly operation: "read" | "write" | "stat" | "access",
    cause: unknown,
  ) {
    const errMsg = cause instanceof Error ? cause.message : String(cause);
    const errCode = (cause as NodeJS.ErrnoException)?.code;
    super(
      errCode ? `FILE_${errCode}` : "FILE_IO_ERROR",
      `Failed to ${operation} ${path}: ${errMsg}`,
      errCode === "ENOENT" || errCode === "EPIPE",
      { path, operation, errno: errCode },
    );
    this.name = "FileIOError";
  }

  get isNotFound(): boolean { return this.code === "FILE_ENOENT"; }
  get isPermissionDenied(): boolean { return this.code === "FILE_EACCES" || this.code === "FILE_EPERM"; }
  get isDiskFull(): boolean { return this.code === "FILE_ENOSPC"; }
}

/** Error during configuration loading. */
export class ConfigError extends CoreError {
  constructor(
    public readonly configName: string,
    message: string,
    cause?: unknown,
  ) {
    super(
      "CONFIG_ERROR",
      `${configName}: ${message}`,
      true,
      { configName, cause: cause instanceof Error ? cause.message : cause },
    );
    this.name = "ConfigError";
  }
}

/** Error during agent process management. */
export class AgentProcessError extends CoreError {
  constructor(
    message: string,
    public readonly pid?: number,
    public readonly taskId?: string,
    cause?: unknown,
  ) {
    super(
      "AGENT_PROCESS_ERROR",
      message,
      false,
      { pid, taskId, cause: cause instanceof Error ? cause.message : cause },
    );
    this.name = "AgentProcessError";
  }
}

/** Extract a human-readable message from any caught error value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

/** Extract the errno code from an error, if present. */
export function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}
