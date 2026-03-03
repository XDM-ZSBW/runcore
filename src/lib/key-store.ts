/**
 * Shared encryption key store.
 * Holds the current session-derived encryption key for brain files at rest.
 * Set once after authentication; consumed by any module that does brain I/O.
 *
 * Also tracks the `encryptBrainFiles` toggle from settings:
 * - When true (default): new writes to allowlisted files are encrypted.
 * - When false: new writes are plaintext. Reads still decrypt existing data.
 */

let currentKey: Buffer | null = null;
let writeEnabled = true;

/** Set the encryption key (called after auth/pairing). */
export function setEncryptionKey(key: Buffer): void {
  currentKey = key;
}

/** Get the current encryption key, or null if not yet authenticated. */
export function getEncryptionKey(): Buffer | null {
  return currentKey;
}

/**
 * Get the encryption key for write operations.
 * Returns null if encryption is disabled via settings (encryptBrainFiles: false),
 * even when a key is available. Reads should use getEncryptionKey() directly.
 */
export function getWriteEncryptionKey(): Buffer | null {
  if (!writeEnabled) return null;
  return currentKey;
}

/** Set whether new writes should be encrypted (from settings.encryptBrainFiles). */
export function setWriteEncryptionEnabled(enabled: boolean): void {
  writeEnabled = enabled;
}

/** Clear the encryption key (e.g. on logout). */
export function clearEncryptionKey(): void {
  currentKey = null;
}
