/**
 * Extension streaming client — fetches extension tarballs from runcore.sh.
 *
 * Protocol:
 *   GET https://runcore.sh/api/extensions/:name
 *   Authorization: Bearer <activation-jwt>
 *   X-Runcore-Version: 0.4.0
 *   X-Bond-Signature: <sign("ext-byok:0.4.0", bondPrivateKey)>
 *
 * Returns gzipped tarball with manifest + module files.
 * 403 if tier insufficient, 401 if token invalid.
 */

import { createVerify } from "node:crypto";
import { createLogger } from "../utils/logger.js";
import type { ExtensionManifest, ExtensionName } from "./manifest.js";
import { signMessage } from "../tier/bond.js";

const log = createLogger("ext-client");

const REGISTRY_BASE = "https://runcore.sh/api/extensions";

export interface StreamResult {
  manifest: ExtensionManifest;
  /** Map of module path → file content buffer */
  files: Map<string, Buffer>;
}

export interface StreamOptions {
  /** Activation JWT */
  jwt: string;
  /** Extension to download */
  name: ExtensionName;
  /** Core package version */
  version: string;
  /** Brain root directory (for bond key signing) */
  root: string;
  /** Custom registry URL (for testing) */
  registryUrl?: string;
  /** Request timeout in ms (default: 30s) */
  timeoutMs?: number;
}

/**
 * Stream an extension from runcore.sh.
 *
 * Downloads the extension tarball, extracts manifest + files.
 * Throws on auth failure, network error, or invalid response.
 */
export async function streamExtension(opts: StreamOptions): Promise<StreamResult> {
  const {
    jwt,
    name,
    version,
    root,
    registryUrl = REGISTRY_BASE,
    timeoutMs = 30_000,
  } = opts;

  const url = `${registryUrl}/${name}`;

  // Sign the request with bond key for mutual authentication
  const signPayload = `${name}:${version}`;
  const bondSignature = await signMessage(root, signPayload);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
    "X-Runcore-Version": version,
    Accept: "application/json",
  };

  if (bondSignature) {
    headers["X-Bond-Signature"] = bondSignature;
  }

  log.info(`Streaming ${name}@${version}...`);

  const res = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new ExtensionStreamError(
        `Authentication failed for ${name}. Run \`runcore activate <token>\` to re-authenticate.`,
        "AUTH_FAILED"
      );
    }
    if (res.status === 403) {
      throw new ExtensionStreamError(
        `Tier insufficient for ${name}. Run \`runcore register\` to upgrade.`,
        "TIER_INSUFFICIENT"
      );
    }
    if (res.status === 404) {
      throw new ExtensionStreamError(
        `Extension ${name}@${version} not found. Run \`runcore update\` for latest version.`,
        "NOT_FOUND"
      );
    }
    throw new ExtensionStreamError(
      `Failed to stream ${name}: ${res.status} ${body}`,
      "STREAM_FAILED"
    );
  }

  // Parse JSON response containing manifest + base64-encoded files
  const payload = (await res.json()) as {
    manifest: ExtensionManifest;
    files: Record<string, string>; // path → base64 content
  };

  if (!payload.manifest || !payload.files) {
    throw new ExtensionStreamError(
      `Invalid response for ${name} — missing manifest or files`,
      "INVALID_RESPONSE"
    );
  }

  // Decode files
  const files = new Map<string, Buffer>();
  for (const [path, b64] of Object.entries(payload.files)) {
    files.set(path, Buffer.from(b64, "base64"));
  }

  log.info(`Downloaded ${name}@${version} (${files.size} modules)`);

  return { manifest: payload.manifest, files };
}

/**
 * Check if a newer version of an extension is available.
 * Lightweight HEAD request — doesn't download anything.
 */
export async function checkForUpdate(
  name: ExtensionName,
  currentVersion: string,
  jwt: string
): Promise<{ available: boolean; latestVersion?: string }> {
  try {
    const res = await fetch(`${REGISTRY_BASE}/${name}/check`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "X-Runcore-Version": currentVersion,
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) return { available: false };

    const data = (await res.json()) as { latest: string; updateAvailable: boolean };
    return {
      available: data.updateAvailable,
      latestVersion: data.latest,
    };
  } catch {
    return { available: false };
  }
}

/** Verify an Ed25519 manifest signature */
export function verifyManifestSignature(
  manifest: ExtensionManifest,
  publicKeyPem: string
): boolean {
  const { signature, ...body } = manifest;
  if (!signature) return false;

  try {
    const data = JSON.stringify(body, Object.keys(body).sort());
    const verifier = createVerify("Ed25519");
    verifier.update(data);
    return verifier.verify(publicKeyPem, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/** Typed error for extension streaming failures */
export class ExtensionStreamError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "AUTH_FAILED"
      | "TIER_INSUFFICIENT"
      | "NOT_FOUND"
      | "STREAM_FAILED"
      | "INVALID_RESPONSE"
      | "INTEGRITY_FAILED"
  ) {
    super(message);
    this.name = "ExtensionStreamError";
  }
}
