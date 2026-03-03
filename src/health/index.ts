/**
 * Health check system for Core.
 *
 * Provides K8s-compatible /healthz (liveness) and /readyz (readiness) probes,
 * component health checks, dependency validation, and auto-recovery.
 *
 * Re-exports everything so `import { HealthChecker, memoryCheck } from "./health/index.js"`
 * is a drop-in replacement for the old `import { ... } from "./health.js"`.
 */

// Types
export type {
  HealthStatus,
  CheckResult,
  HealthCheckResult,
  HealthCheckFn,
  CheckRegistration,
  RegisterOptions,
  DependencyDescriptor,
  RecoveryAction,
  RecoveryState,
} from "./types.js";

// Core checker
export { HealthChecker } from "./checker.js";

// Built-in checks
export {
  memoryCheck,
  eventLoopCheck,
  availabilityCheck,
  cpuCheck,
  diskUsageCheck,
  diskCheck,
} from "./checks.js";

// Component checks
export {
  queueStoreCheck,
  agentCapacityCheck,
  agentHealthCheck,
  boardCheck,
  httpCheck,
} from "./components.js";

// OpenRouter credit check
export { openrouterCreditsCheck, creditsExtractor } from "./checks/openrouter.js";

// Recovery
export { RecoveryManager, sidecarRecovery } from "./recovery.js";

// Alerting
export { AlertManager } from "./alerting.js";
export { defaultThresholds, defaultAlertConfig } from "./alert-defaults.js";
export type {
  Alert,
  AlertConfig,
  AlertSeverity,
  AlertState,
  AlertSummary,
  AlertThreshold,
  ChannelPreference,
  MetricExtractor,
  NotificationChannel,
} from "./alert-types.js";
