/**
 * Bond handshake — establishes trust after activation.
 *
 * Registration = identity ("I know who you are").
 * Bonding = trust ("I can verify it's you").
 *
 * Flow:
 * 1. `runcore activate <token>` saves the JWT locally
 * 2. Immediately calls `bond()` — generates an Ed25519 keypair,
 *    POSTs the public key + token JTI to the registry
 * 3. Registry stores the public key alongside the approval record
 * 4. Admin (Dash) sees "bonded" status on next poll
 * 5. All future signed messages between instance and registry
 *    use this keypair — freeze acks, heartbeat signatures, etc.
 *
 * The token is a one-time introducer. The keypair is the ongoing relationship.
 */

import { generateKeyPairSync, createSign, createVerify } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("bond");
const REGISTRY_URL = "https://runcore.sh/api/registry";

interface BondKeys {
  publicKey: string;
  privateKey: string;
  fingerprint: string;
  bondedAt: string;
}

const KEYS_DIR = ".core";
const KEYS_FILE = "bond-keys.json";

function keysPath(root: string): string {
  return join(root, "brain", KEYS_DIR, KEYS_FILE);
}

/** Generate a new Ed25519 keypair for this instance. */
function generateBondKeys(): BondKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  // Fingerprint = first 16 chars of base64-encoded public key body
  const pubBody = publicKey
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "");
  const fingerprint = pubBody.slice(0, 16);

  return {
    publicKey,
    privateKey,
    fingerprint,
    bondedAt: new Date().toISOString(),
  };
}

/** Load existing bond keys, or null if not yet bonded. */
export async function loadBondKeys(root: string): Promise<BondKeys | null> {
  const path = keysPath(root);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Save bond keys to disk. */
async function saveBondKeys(root: string, keys: BondKeys): Promise<void> {
  const dir = join(root, "brain", KEYS_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(keysPath(root), JSON.stringify(keys, null, 2), "utf-8");
}

/** Check if this instance has completed bonding. */
export async function isBonded(root: string): Promise<boolean> {
  const keys = await loadBondKeys(root);
  return keys !== null;
}

/**
 * Execute the bond handshake.
 * Called immediately after `runcore activate <token>`.
 *
 * 1. Generate keypair (or load existing)
 * 2. POST public key + JTI to registry
 * 3. Save keys locally on success
 */
export async function bond(
  root: string,
  jwt: string,
  jti: string
): Promise<{ fingerprint: string; bonded: boolean }> {
  // Check for existing bond
  let keys = await loadBondKeys(root);
  if (keys) {
    log.info(`Already bonded (fingerprint: ${keys.fingerprint})`);
    // Re-announce to registry in case it missed us
    await announceToRegistry(jwt, keys);
    return { fingerprint: keys.fingerprint, bonded: true };
  }

  // Generate new keypair
  log.info("Generating bond keypair...");
  keys = generateBondKeys();

  // Announce to registry
  const success = await announceToRegistry(jwt, keys);
  if (!success) {
    log.warn("Bond handshake failed — will retry on next heartbeat");
    // Save keys locally anyway — we'll retry the announcement
    await saveBondKeys(root, keys);
    return { fingerprint: keys.fingerprint, bonded: false };
  }

  // Save keys
  await saveBondKeys(root, keys);
  log.info(`Bonded successfully (fingerprint: ${keys.fingerprint})`);
  return { fingerprint: keys.fingerprint, bonded: true };
}

/** POST public key to the registry bond endpoint. */
async function announceToRegistry(
  jwt: string,
  keys: BondKeys
): Promise<boolean> {
  try {
    const res = await fetch(`${REGISTRY_URL}/bond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        publicKey: keys.publicKey,
        fingerprint: keys.fingerprint,
        bondedAt: keys.bondedAt,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Sign a message with this instance's bond private key.
 * Used for authenticated communication after bonding.
 */
export async function signMessage(
  root: string,
  message: string
): Promise<string | null> {
  const keys = await loadBondKeys(root);
  if (!keys) return null;

  const signer = createSign("Ed25519");
  signer.update(message);
  return signer.sign(keys.privateKey, "base64url");
}

/**
 * Verify a message signed by another instance's bond key.
 * Used by the registry to verify instance identity.
 */
export function verifyMessage(
  message: string,
  signature: string,
  publicKeyPem: string
): boolean {
  try {
    const verifier = createVerify("Ed25519");
    verifier.update(message);
    return verifier.verify(publicKeyPem, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}
