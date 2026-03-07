/**
 * Activation token — Ed25519 signed JWT, offline-verifiable.
 *
 * Private key lives in the registry backend (Dash's dead drop / Cloudflare Worker).
 * Public key ships in this package. Tokens validate without network.
 * Revocation is checked periodically (24h) via registry heartbeat.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createVerify, createSign } from "node:crypto";
import { type ActivationToken, type TierName } from "./types.js";

// Ed25519 public key — embedded in package, used for offline token verification.
// Replace with real key after generating the keypair.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAPLACENTER_REAL_KEY_HERE_AFTER_KEYGEN=
-----END PUBLIC KEY-----`;

const TOKEN_DIR = ".core";
const TOKEN_FILE = "activation.json";

function tokenPath(root: string): string {
  return join(root, "brain", TOKEN_DIR, TOKEN_FILE);
}

/** Decode a compact JWT (header.payload.signature) without verification */
function decodePayload(jwt: string): ActivationToken {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Invalid token format");
  const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
  return JSON.parse(payload);
}

/** Verify Ed25519 signature on a JWT */
function verifySignature(jwt: string, publicKey: string): boolean {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  const data = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2], "base64url");
  const verifier = createVerify("Ed25519");
  verifier.update(data);
  try {
    return verifier.verify(publicKey, signature);
  } catch {
    return false;
  }
}

/** Sign a JWT with Ed25519 private key (used by Dash / registry backend) */
export function signToken(
  payload: ActivationToken,
  privateKeyPem: string
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: "JWT" })
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `${header}.${body}`;
  const signer = createSign("Ed25519");
  signer.update(data);
  const signature = signer.sign(privateKeyPem, "base64url");
  return `${data}.${signature}`;
}

/** Load and validate the local activation token. Returns null if none or invalid. */
export async function loadActivationToken(
  root: string
): Promise<{ token: ActivationToken; raw: string } | null> {
  try {
    const raw = (await readFile(tokenPath(root), "utf-8")).trim();
    if (!raw) return null;

    if (!verifySignature(raw, PUBLIC_KEY_PEM)) {
      console.warn("  Activation token has invalid signature — ignoring.");
      return null;
    }

    const token = decodePayload(raw);

    if (new Date(token.expires) < new Date()) {
      console.warn("  Activation token expired — running as Local tier.");
      return null;
    }

    return { token, raw };
  } catch {
    return null;
  }
}

/** Store an activation token to disk */
export async function saveActivationToken(
  root: string,
  jwt: string
): Promise<ActivationToken> {
  if (!verifySignature(jwt, PUBLIC_KEY_PEM)) {
    throw new Error("Token signature verification failed. Token not saved.");
  }

  const token = decodePayload(jwt);
  const dir = join(root, "brain", TOKEN_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(tokenPath(root), jwt, "utf-8");
  return token;
}

/** Get the current tier from the stored token, defaulting to "local" */
export async function currentTier(root: string): Promise<TierName> {
  const result = await loadActivationToken(root);
  return result?.token.tier ?? "local";
}

/** Set a custom public key (for testing or key rotation) */
export function setPublicKey(pem: string): void {
  // Only used in test — production uses the embedded key
  (globalThis as any).__CORE_TIER_PUBKEY = pem;
}

function getPublicKey(): string {
  return (globalThis as any).__CORE_TIER_PUBKEY ?? PUBLIC_KEY_PEM;
}
