/**
 * DPAPI wrapper — encrypts/decrypts data using Windows Data Protection API.
 * Keys are tied to the current Windows user account.
 * Falls back to plaintext on non-Windows or if DPAPI is unavailable.
 */

import { execSync } from "node:child_process";
import { readFile, writeFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";

const IS_WINDOWS = process.platform === "win32";

/** Encode a PowerShell script as base64 UTF-16LE for -EncodedCommand. */
function encodePS(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Run a PowerShell script reliably via -EncodedCommand. */
function runPS(script: string): string {
  const encoded = encodePS(script);
  return execSync(
    `powershell -NoProfile -EncodedCommand ${encoded}`,
    { encoding: "utf-8", windowsHide: true },
  ).trim();
}

/** DPAPI-protect a Buffer, returns base64-encoded ciphertext. */
function dpapiProtect(data: Buffer): string {
  const b64Input = data.toString("base64");
  return runPS(`
    Add-Type -AssemblyName System.Security
    $bytes = [Convert]::FromBase64String("${b64Input}")
    $enc = [System.Security.Cryptography.ProtectedData]::Protect(
      $bytes, [byte[]]@(),
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [Convert]::ToBase64String($enc)
  `);
}

/** DPAPI-unprotect a base64-encoded ciphertext, returns Buffer. */
function dpapiUnprotect(b64Ciphertext: string): Buffer {
  const result = runPS(`
    Add-Type -AssemblyName System.Security
    $enc = [Convert]::FromBase64String("${b64Ciphertext}")
    $dec = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $enc, [byte[]]@(),
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [Convert]::ToBase64String($dec)
  `);
  return Buffer.from(result, "base64");
}

/**
 * Read a session key file. Tries DPAPI-protected format first (.dpapi),
 * falls back to plaintext hex. If plaintext found, migrates to DPAPI.
 * Returns the raw key as a Buffer, or null if not found.
 */
export async function readSessionKey(keyPath: string): Promise<Buffer | null> {
  // Resolve symlinks so .dpapi file lands next to the real key
  let resolvedPath = keyPath;
  try {
    resolvedPath = await realpath(keyPath);
  } catch {
    // realpath fails if file doesn't exist — use original
  }
  const dpapiPath = resolvedPath + ".dpapi";

  // Try DPAPI-protected version first
  if (IS_WINDOWS && existsSync(dpapiPath)) {
    try {
      const b64 = (await readFile(dpapiPath, "utf-8")).trim();
      if (b64.length > 0) return dpapiUnprotect(b64);
    } catch {
      // DPAPI decrypt failed — fall through to plaintext
    }
  }

  // Try plaintext hex file
  if (!existsSync(resolvedPath)) return null;
  const hex = (await readFile(resolvedPath, "utf-8")).trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const key = Buffer.from(hex, "hex");

  // Migrate: protect with DPAPI and save
  if (IS_WINDOWS) {
    try {
      const protected64 = dpapiProtect(key);
      await writeFile(dpapiPath, protected64, "utf-8");
      // Don't delete the plaintext yet — Dash may still need it
      // until Dash also uses this reader
    } catch {
      // DPAPI not available — keep using plaintext
    }
  }

  return key;
}

/** Check if DPAPI is available on this system. */
export function isDpapiAvailable(): boolean {
  if (!IS_WINDOWS) return false;
  try {
    dpapiProtect(Buffer.from("test"));
    return true;
  } catch {
    return false;
  }
}
