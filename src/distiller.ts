/**
 * Distiller — convert live brain files into templates and back.
 *
 * Replaces identity-specific values (names, roles) with {{TOKEN}} placeholders,
 * producing reusable templates. Hydrate reverses the process for new instances.
 *
 * Token map is built from instances.yaml + vault.policy.yaml.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { createLogger } from "./utils/logger.js";

const log = createLogger("distiller");

const BRAIN_DIR = resolve(process.cwd(), "brain");

// ── Types ────────────────────────────────────────────────────────────────────

/** Map of TOKEN_NAME → value (e.g. { OWNER: "Bryant", CHIEF_OF_STAFF: "dash" }) */
export type TokenMap = Record<string, string>;

// ── Token map builder ────────────────────────────────────────────────────────

/**
 * Build a token map from brain files.
 *
 * Reads instances.yaml and vault.policy.yaml to extract:
 *   OWNER             — vault policy owner
 *   CHIEF_OF_STAFF    — instance with role chief-of-staff
 *   ADMIN             — instance with role administration
 *   BRAND             — instance with role brand
 *   COMMERCIAL        — instance with role commercial
 *   LOSS_PREVENTION   — instance with role loss-prevention
 */
export async function buildTokenMap(brainRoot?: string): Promise<TokenMap> {
  const root = brainRoot ?? BRAIN_DIR;
  const tokens: TokenMap = {};

  // Read vault.policy.yaml for owner
  try {
    const vaultRaw = await readFile(join(root, "vault.policy.yaml"), "utf-8");
    const ownerMatch = vaultRaw.match(/^owner\s*:\s*(.+)$/m);
    if (ownerMatch) {
      tokens.OWNER = ownerMatch[1].replace(/^["']|["']$/g, "").trim();
    }
  } catch {
    log.debug("Could not read vault.policy.yaml for token map");
  }

  // Read instances.yaml for role→name mapping
  try {
    const instancesRaw = await readFile(join(root, "identity", "instances.yaml"), "utf-8");

    // Simple parser: find instance blocks and extract name + role
    const roleMap: Record<string, string> = {
      "chief-of-staff": "CHIEF_OF_STAFF",
      "administration": "ADMIN",
      "brand": "BRAND",
      "commercial": "COMMERCIAL",
      "loss-prevention": "LOSS_PREVENTION",
    };

    // Parse instance names and their roles
    let currentInstance = "";
    for (const line of instancesRaw.split("\n")) {
      // Instance name (indent 2, key followed by colon)
      const instanceMatch = line.match(/^  (\w[\w-]*)\s*:\s*$/);
      if (instanceMatch) {
        currentInstance = instanceMatch[1];
        continue;
      }

      // Role line (indent 4)
      const roleMatch = line.match(/^\s{4}role\s*:\s*(.+)$/);
      if (roleMatch && currentInstance) {
        const role = roleMatch[1].replace(/^["']|["']$/g, "").trim();
        const tokenName = roleMap[role];
        if (tokenName) {
          tokens[tokenName] = currentInstance;
        }
      }
    }
  } catch {
    log.debug("Could not read instances.yaml for token map");
  }

  log.info("Token map built", { tokens: Object.keys(tokens) });
  return tokens;
}

// ── Core operations ──────────────────────────────────────────────────────────

/**
 * Distill content — replace identity values with {{TOKEN}} placeholders.
 * Replacements are applied longest-first to avoid partial matches.
 */
export function distill(content: string, tokenMap: TokenMap): string {
  // Sort by value length descending (longest first)
  const entries = Object.entries(tokenMap)
    .filter(([, value]) => value.length > 0)
    .sort((a, b) => b[1].length - a[1].length);

  let result = content;
  for (const [token, value] of entries) {
    // Replace all occurrences (case-sensitive)
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "g"), `{{${token}}}`);
  }

  return result;
}

/**
 * Hydrate a template — replace {{TOKEN}} placeholders with values.
 */
export function hydrate(template: string, tokenMap: TokenMap): string {
  let result = template;
  for (const [token, value] of Object.entries(tokenMap)) {
    result = result.replace(new RegExp(`\\{\\{${token}\\}\\}`, "g"), value);
  }
  return result;
}

/**
 * Distill a brain file into a template and write to brain/templates/.
 *
 * @param sourcePath   - Brain-relative path of the source file (e.g. "identity/instances.yaml")
 * @param templateName - Output filename in brain/templates/ (e.g. "instances.yaml")
 * @param tokenMap     - Token map for replacement
 */
export async function distillFile(
  sourcePath: string,
  templateName: string,
  tokenMap: TokenMap,
): Promise<string> {
  const fullSource = join(BRAIN_DIR, sourcePath);
  const content = await readFile(fullSource, "utf-8");
  const distilled = distill(content, tokenMap);

  const templateDir = join(BRAIN_DIR, "templates");
  const templatePath = join(templateDir, templateName);
  await mkdir(templateDir, { recursive: true });
  await writeFile(templatePath, distilled, "utf-8");

  log.info("File distilled to template", { source: sourcePath, template: templateName });
  return templatePath;
}

/**
 * Hydrate a template from brain/templates/ and write to a target path.
 *
 * @param templateName - Filename in brain/templates/ (e.g. "instances.yaml")
 * @param targetPath   - Brain-relative path for the output (e.g. "identity/instances.yaml")
 * @param tokenMap     - Token map for hydration
 */
export async function hydrateFile(
  templateName: string,
  targetPath: string,
  tokenMap: TokenMap,
): Promise<string> {
  const templatePath = join(BRAIN_DIR, "templates", templateName);
  const template = await readFile(templatePath, "utf-8");
  const hydrated = hydrate(template, tokenMap);

  const fullTarget = join(BRAIN_DIR, targetPath);
  await mkdir(dirname(fullTarget), { recursive: true });
  await writeFile(fullTarget, hydrated, "utf-8");

  log.info("Template hydrated to file", { template: templateName, target: targetPath });
  return fullTarget;
}
