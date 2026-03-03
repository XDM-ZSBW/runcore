/**
 * CLI commands for manual brain backup and restore operations.
 * Usage: npx tsx src/cli/backup.ts <command> [options]
 *
 * Commands:
 *   backup              Run a backup now
 *   restore <id>        Restore from a specific backup
 *   list                List available backups
 *   verify <id>         Verify a backup's integrity
 *   status              Show backup service status
 */

import { join } from "node:path";
import { getInstanceName } from "../instance.js";
import { runBackup, restoreBackup, verifyBackup, listBackups } from "../services/backup.js";
import { loadSettings } from "../settings.js";
import type { BackupConfig } from "../settings.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(0);
  }

  // Load settings to get backup config
  const settings = await loadSettings();
  const config = settings.backup;

  switch (command) {
    case "backup":
      await handleBackup(config, args);
      break;
    case "restore":
      await handleRestore(config, args);
      break;
    case "list":
      await handleList(config, args);
      break;
    case "verify":
      await handleVerify(config, args);
      break;
    case "status":
      await handleStatus(config);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage() {
  console.log(`
${getInstanceName()} Brain Backup CLI

Usage: npx tsx src/cli/backup.ts <command> [options]

Commands:
  backup [--provider <local|gdrive>]   Run a backup now
  restore <backup-id> [--provider <local|gdrive>]   Restore from a backup
  list [--provider <local|gdrive>]     List available backups
  verify <backup-id> [--provider <local|gdrive>]    Verify backup integrity
  status                               Show backup configuration

Options:
  --provider  Storage provider to use (default: from settings)
  --help      Show this help message
  `.trim());
}

function parseProvider(args: string[]): ("local" | "gdrive")[] | undefined {
  const idx = args.indexOf("--provider");
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const p = args[idx + 1];
  if (p === "local" || p === "gdrive") return [p];
  console.error(`Invalid provider: ${p}. Must be "local" or "gdrive".`);
  process.exit(1);
}

async function handleBackup(config: BackupConfig, args: string[]) {
  const providers = parseProvider(args) ?? config.providers;
  console.log(`Starting backup to: ${providers.join(", ")}...`);

  const result = await runBackup(providers);

  if (result.ok) {
    console.log(`Backup completed: ${result.message}`);
    if (result.manifest) {
      console.log(`  ID: ${result.manifest.id}`);
      console.log(`  Files: ${result.manifest.files.length}`);
      console.log(`  Size: ${formatBytes(result.manifest.totalBytes)}`);
      console.log(`  Encrypted files: ${result.manifest.files.filter((f) => f.encrypted).length}`);
    }
  } else {
    console.error(`Backup failed: ${result.message}`);
    process.exit(1);
  }
}

async function handleRestore(config: BackupConfig, args: string[]) {
  const backupId = args[1];
  if (!backupId || backupId.startsWith("--")) {
    console.error("Error: backup ID required. Usage: restore <backup-id> [--provider <local|gdrive>]");
    process.exit(1);
  }

  const providers = parseProvider(args) ?? config.providers;
  const provider = providers[0];

  console.log(`Restoring backup ${backupId} from ${provider}...`);
  console.log("WARNING: This will overwrite current brain/ files.");

  const result = await restoreBackup(provider, backupId);

  if (result.ok) {
    console.log(`Restore completed: ${result.message}`);
    console.log("IMPORTANT: Enter your safe word to decrypt episodic memory files.");
  } else {
    console.error(`Restore failed: ${result.message}`);
    process.exit(1);
  }
}

async function handleList(config: BackupConfig, args: string[]) {
  const providers = parseProvider(args);
  const provider = providers?.[0];

  console.log("Available backups:\n");
  const backups = await listBackups(provider);

  if (backups.length === 0) {
    console.log("  No backups found.");
    return;
  }

  for (const b of backups) {
    const encrypted = b.files.filter((f) => f.encrypted).length;
    console.log(`  ${b.id}`);
    console.log(`    Time:      ${b.timestamp}`);
    console.log(`    Provider:  ${b.provider}`);
    console.log(`    Files:     ${b.files.length} (${encrypted} encrypted)`);
    console.log(`    Size:      ${formatBytes(b.totalBytes)}`);
    console.log();
  }
}

async function handleVerify(config: BackupConfig, args: string[]) {
  const backupId = args[1];
  if (!backupId || backupId.startsWith("--")) {
    console.error("Error: backup ID required. Usage: verify <backup-id> [--provider <local|gdrive>]");
    process.exit(1);
  }

  const providers = parseProvider(args) ?? config.providers;
  const provider = providers[0];

  console.log(`Verifying backup ${backupId} on ${provider}...`);
  const result = await verifyBackup(provider, backupId);

  if (result.ok) {
    console.log(`Verification passed: ${result.message}`);
  } else {
    console.error(`Verification failed: ${result.message}`);
    if (result.mismatches.length > 0) {
      console.error("Mismatches:");
      for (const m of result.mismatches) {
        console.error(`  - ${m}`);
      }
    }
    process.exit(1);
  }
}

async function handleStatus(config: BackupConfig) {
  console.log("Backup Configuration:");
  console.log(`  Enabled:    ${config.enabled}`);
  console.log(`  Schedule:   ${config.schedule}`);
  console.log(`  Providers:  ${config.providers.join(", ")}`);
  console.log(`  Local dir:  ${config.localBackupDir}`);
  console.log(`  Max keep:   ${config.maxBackups}`);
  console.log(`  Hour:       ${config.backupHour}:00`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
