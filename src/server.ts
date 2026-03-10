/**
 * Core local chat server.
 * Hono app: serves static UI, handles pairing/auth, streams chat via Ollama (local) or OpenRouter (cloud).
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { acquireLock, releaseLock } from "./runtime-lock.js";

// Package root — works whether run from CWD or npx
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = __dirname.endsWith("dist") ? join(__dirname, "..") : __dirname;

// UI directory — resolved at startup. Prefers CDN-synced, falls back to bundled.
let UI_DIR = getUiPublicDir(PKG_ROOT);
import { writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { initInstanceName, getInstanceName, setInstanceName, getInstanceNameLower, resolveEnv, getAlertEmailFrom } from "./instance.js";
import { syncUi, getUiPublicDir } from "./ui-sync.js";

import { readBrainFile, writeBrainFile, appendBrainLine } from "./lib/brain-io.js";
import { runWithAuditContext } from "./lib/audit.js";
import { Brain } from "./brain.js";
import { FileSystemLongTermMemory } from "./memory/file-backed.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("server");
const agentLog = createLogger("agent");
import type { ContextMessage } from "./types.js";
import {
  ensurePairingCode,
  getStatus,
  pair,
  authenticate,
  getRecoveryQuestion,
  recover,
  validateSession,
  readHuman,
  restoreSession,
  cacheSessionKey,
  createSession,
} from "./auth/identity.js";
import { requireSession } from "./auth/middleware.js";
import { streamChat } from "./llm/openrouter.js";
import { streamChatLocal } from "./llm/ollama.js";
import { getProvider } from "./llm/providers/index.js";
import type { StreamOptions } from "./llm/providers/types.js";
import { withStreamRetry } from "./llm/retry.js";
import { LLMError } from "./llm/errors.js";
import { PrivateModeError, isPrivateMode, checkOllamaHealth } from "./llm/guard.js";
import { installFetchGuard } from "./llm/fetch-guard.js";
import { SensitiveRegistry } from "./llm/sensitive-registry.js";
import { PrivacyMembrane } from "./llm/membrane.js";
import { setActiveMembrane, getActiveMembrane, rehydrateResponse } from "./llm/redact.js";
import { logLlmCall } from "./llm/call-log.js";
import { VolumeManager } from "./volumes/index.js";
import {
  loadSettings,
  getSettings,
  updateSettings,
  resolveProvider,
  resolveChatModel,
  resolveUtilityModel,
  getPulseSettings,
  getMeshConfig,
} from "./settings.js";
import { startMdns, stopMdns } from "./mdns.js";
import { ingestDirectory } from "./files/ingest.js";
import { processIngestFolder } from "./files/ingest-folder.js";
import { saveSession, loadSession } from "./sessions/store.js";
import { extractAndLearn } from "./learning/extractor.js";
import { startSidecar, stopSidecar, isSidecarAvailable } from "./search/sidecar.js";
import { classifySearchNeed } from "./search/classify.js";
import { findBrainDocument, setBrainRAG } from "./search/brain-docs.js";
import { BrainRAG } from "./search/brain-rag.js";
import { watchBrain } from "./search/file-watcher.js";

let stopFileWatcher: () => void = () => {};
import { isSearchAvailable, search } from "./search/client.js";
import { browseUrl, detectUrl } from "./search/browse.js";
import { startTtsSidecar, stopTtsSidecar } from "./tts/sidecar.js";
import { isTtsAvailable, synthesize } from "./tts/client.js";
import { startSttSidecar, stopSttSidecar } from "./stt/sidecar.js";
import { isSttAvailable, transcribe } from "./stt/client.js";
import { startAvatarSidecar, stopAvatarSidecar, isAvatarAvailable } from "./avatar/sidecar.js";
import { preparePhoto, generateVideo, getCachedVideo, cacheVideo, clearVideoCache } from "./avatar/client.js";
import { getTtsConfig, getSttConfig, getAvatarConfig } from "./settings.js";
import { loadVault, listVaultKeys, setVaultKey, deleteVaultKey, getDashReadableVault, getVaultEntries, hydrateEnv as rehydrateVaultEnv } from "./vault/store.js";
import { exportVault, importVault, verifyExport } from "./vault/transfer.js";
import { getIntegrationStatus, isIntegrationEnabled } from "./integrations/gate.js";
import { makeCall } from "./twilio/call.js";
import {
  isGoogleConfigured,
  isGoogleAuthenticated,
  getAuthUrl,
  exchangeCode,
  clearTokenCache,
} from "./google/auth.js";
import { isCalendarAvailable, getTodaySchedule, getUpcomingEvents, listEvents, searchEvents, getFreeBusy, createEvent, updateEvent, deleteEvent, formatEventsForContext } from "./google/calendar.js";
import { validateCalendarEntry, getDayOfWeek, getDayOfWeekIndex } from "./google/temporal.js";
import { startCalendarTimer, stopCalendarTimer } from "./google/calendar-timer.js";
import { isGmailAvailable, getRecentMessages, searchMessages, getUnreadCount, formatMessagesForContext, categorizeMessages, prioritizeInbox, getInboxSummary, markAsRead, markAsUnread, batchMarkAsRead, batchMarkAsUnread } from "./google/gmail.js";
import { startGmailTimer, stopGmailTimer, onDashEmail } from "./google/gmail-timer.js";
import { startTasksTimer, stopTasksTimer } from "./google/tasks-timer.js";
import { sendEmail, attachmentFromFile } from "./google/gmail-send.js";
import { isDocsAvailable, createDocWithContent, createSpreadsheet, createBacklogReviewDoc } from "./google/docs.js";
import {
  isTasksAvailable,
  listTaskLists,
  createTaskList,
  updateTaskList,
  deleteTaskList,
  listTasks,
  getTask as getGoogleTask,
  createTask,
  updateTask,
  completeTask,
  uncompleteTask,
  deleteTask,
  createRecurringWeeklyTasks,
  formatTasksForContext,
} from "./google/tasks.js";
import { runGoalCheck } from "./goals/loop.js";
import { startGoalTimer, stopGoalTimer } from "./goals/timer.js";
import { drainNotifications, pushNotification, initNotifications } from "./goals/notifications.js";
import { logActivity, getActivities, getActivitiesByIds, generateTraceId } from "./activity/log.js";
import { compactHistory } from "./context/compaction.js";
import { rateLimit } from "./rate-limit.js";
import { initAgents, recoverAndStartMonitor, shutdownAgents, submitTask, getTask, listTasks as listAgentTasks, cancelTask, getTaskOutput, setOnBatchComplete, setAgentPool } from "./agents/index.js";
import { rememberTaskCompletion } from "./agents/memory.js";
import { acquireLocks, releaseLocks, releaseFileLock, forceReleaseLock, listLocks, checkLocks, pruneAllStaleLocks } from "./agents/locks.js";
import { continueAfterBatch, startAutonomousTimer, stopAutonomousTimer, resetContinuation, getAutonomousStatus, triggerPulse } from "./agents/autonomous.js";
import { initPressureIntegrator, getPressureIntegrator } from "./pulse/pressure.js";
import { startBacklogReviewTimer, stopBacklogReviewTimer, triggerBacklogReview, getLastBacklogReview, isBacklogReviewRunning } from "./services/backlogReview.js";
import { startBriefingTimer, stopBriefingTimer, triggerBriefing, getLastBriefing, getLastDeliveryResult, updateBriefingConfig } from "./services/morningBriefing.js";
import type { BriefingConfig } from "./services/morningBriefing.js";
import { initTraining, getTrainingProgress } from "./services/training.js";
import { startInsightsTimer, stopInsightsTimer, getInsights, getLastInsightRun, triggerInsightAnalysis } from "./services/traceInsights.js";
import { startCreditMonitor, stopCreditMonitor, getCreditStatus, triggerCreditCheck } from "./services/credit-monitor.js";
import {
  loadLoops,
  loadLoopsByState,
  loadTriads,
  transitionLoop,
  startOpenLoopScanner,
  stopOpenLoopScanner,
  getResonances,
  getLastScanRun,
  triggerOpenLoopScan,
  triggerResolutionScan,
  getResolutions,
  getLastResolutionScanRun,
  foldBack,
} from "./openloop/index.js";
import { createRuntime, getRuntime, shutdownRuntime } from "./agents/runtime/index.js";
import { AgentInstanceManager } from "./agents/instance-manager.js";
import { AgentPool } from "./agents/runtime.js";
import { WorkflowEngine } from "./agents/workflow.js";
import { getBoardProvider, setBoardProvider, isBoardAvailable } from "./board/provider.js";
import { QueueBoardProvider } from "./queue/provider.js";
import { QUEUE_STATES } from "./queue/types.js";
import type { BoardIssue } from "./board/types.js";
import { Tracer } from "./tracing/tracer.js";
import { initTracing, shutdownTracing } from "./tracing/init.js";
import { tracingMiddleware } from "./tracing/middleware.js";
import { attachOTelToBus } from "./tracing/bridge.js";
import {
  HealthChecker,
  memoryCheck,
  eventLoopCheck,
  availabilityCheck,
  cpuCheck,
  diskUsageCheck,
  diskCheck,
  queueStoreCheck,
  agentCapacityCheck,
  agentHealthCheck,
  boardCheck,
  RecoveryManager,
  sidecarRecovery,
  AlertManager,
  defaultAlertConfig,
} from "./health/index.js";
import { NotificationDispatcher, EmailChannel, PhoneChannel } from "./notifications/index.js";
import { skillRegistry as _skillRegistry, type SkillEntry } from "./skills/index.js";
import { createModuleRegistry, getModuleRegistry } from "./modules/index.js";
import { createCapabilityRegistry, getCapabilityRegistry, calendarCapability, emailCapability, docsCapability, boardCapability, browserCapability, closeBrowser, taskDoneCapability, calendarContextProvider, emailContextProvider, createWebSearchContextProvider, vaultContextProvider } from "./capabilities/index.js";
import {
  MetricsStore,
  startCollector,
  stopCollector,
  recordAgentSpawn,
  recordAgentCompletion,
  recordError,
  registerDefaultThresholds,
  evaluateAlerts,
  buildDashboard,
  metricsMiddleware,
  collectPrometheus,
  generatePeriodStats,
  generateComparisonReport,
} from "./metrics/index.js";
import { startGroomingTimer, stopGroomingTimer } from "./queue/grooming.js";
import { createSchedulingStore, getSchedulingStore } from "./scheduling/store.js";
import { startSchedulingTimer, stopSchedulingTimer } from "./scheduling/timer.js";
import type { BlockType, BlockStatus } from "./scheduling/types.js";
import { createContactStore, getContactStore } from "./contacts/store.js";
import type { EntityType, EdgeType } from "./contacts/types.js";
import { createCredentialStore, getCredentialStore, maskValue } from "./credentials/store.js";
import type { CredentialType } from "./credentials/store.js";
import { verifyWebhookSignature, githubProvider } from "./github/webhooks.js";
import {
  initGitHub,
  shutdownGitHub,
  getGitHubStatus,
  isGitHubAvailable,
  reviewPullRequest,
  reviewAndCommentPR,
  triageGitHubIssue,
  triageAndLabelIssue,
  batchTriageIssues,
  analyzeGitHubCommit,
  analyzeRecentGitHubCommits,
  getGitHubRepoHealth,
  processWebhook as processGitHubWebhook,
  formatHealthReport,
} from "./integrations/github.js";
import {
  isSlackConfigured,
  isSlackAuthenticated,
  getOAuthUrl as getSlackOAuthUrl,
  exchangeOAuthCode as exchangeSlackCode,
  getClient as getSlackClient,
} from "./slack/client.js";
import { slackEventsProvider, slackCommandsProvider, slackInteractionsProvider } from "./slack/webhooks.js";
import { listChannels, getChannelInfo, joinChannel, postMessage as slackPostMessage, getChannelHistory } from "./slack/channels.js";
// Slack types no longer needed — providers handle their own type mapping
import { getClient as getWhatsAppClient, isWhatsAppConfigured } from "./channels/whatsapp.js";
import { parseFormBody, processIncomingMessage, emptyTwimlResponse, replyTwiml, twilioProvider } from "./webhooks/twilio.js";
import { resendProvider } from "./resend/webhooks.js";
import type { TwilioWhatsAppPayload } from "./webhooks/twilio.js";
import { handleWhatsAppMessage } from "./services/whatsapp.js";
import { initLLMCache, shutdownLLMCache, getCacheDiagnostics } from "./cache/llm-cache.js";
import { mountWebhookAdmin, createWebhookRoute, verifyWebhookRequest } from "./webhooks/mount.js";
import { setProviderConfigs } from "./webhooks/config.js";
import { registerProviders } from "./webhooks/registry.js";
import { verifyRelaySignature } from "./webhooks/relay.js";
import { setEncryptionKey } from "./lib/key-store.js";
import { FileManager } from "./files/manager.js";
import { createLibraryStore } from "./library/store.js";
import { libraryRoutes } from "./library/routes.js";
import { brainShadowRoutes, initBrainShadow } from "./library/brain-shadow.js";
import { createCalendarStore } from "./calendar/store.js";
import { calendarRoutes } from "./calendar/routes.js";
import { getGoogleCalendarAdapter } from "./calendar/google-adapter.js";
import { saveVisualMemory, hydrateVisualMemories, isVisualMemory, searchVisualMemories } from "./memory/visual.js";
import type { ContentBlock } from "./types.js";

// --- LLM provider selection (via settings) ---

function pickStreamFn(): (options: StreamOptions) => Promise<void> {
  const providerName = resolveProvider();
  const provider = getProvider(providerName);
  return withStreamRetry(
    (options: StreamOptions) => provider.streamChat(options),
    { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
  );
}

// --- Config ---

import { getLastPort } from "./runtime-lock.js";
const _envPort = parseInt(process.env.CORE_PORT ?? resolveEnv("PORT") ?? "0", 10);
// Sticky port: if no explicit port set, reuse the last known port from runtime lock
const PORT = _envPort === 0 ? getLastPort() : _envPort;
let actualPort = PORT;
const SIDECAR_PORT = resolveEnv("SEARCH_PORT") ?? "3578";
import { BRAIN_DIR } from "./lib/paths.js";
const SKILLS_DIR = join(process.cwd(), "skills");
const MEMORY_DIR = join(BRAIN_DIR, "memory");
const PERSONALITY_PATH = join(BRAIN_DIR, "identity", "personality.md");
const INGEST_DIR = join(process.cwd(), "ingest");
const INGESTED_DIR = join(process.cwd(), "ingested");

// --- Health checker & recovery ---

const health = new HealthChecker();
health.register("memory", memoryCheck());
health.register("event_loop", eventLoopCheck());
health.register("cpu", cpuCheck());
health.register("disk", diskCheck(BRAIN_DIR));
health.register("disk_usage", diskUsageCheck(BRAIN_DIR));
const recovery = new RecoveryManager(health);

// --- Alerting ---

const alertDispatcher = new NotificationDispatcher();
const alertManager = new AlertManager(health, defaultAlertConfig(), alertDispatcher);

// --- Metrics ---

const metricsStore = new MetricsStore(BRAIN_DIR);
registerDefaultThresholds();

// --- Volume manager ---

const volumeManager = new VolumeManager(BRAIN_DIR);
volumeManager.init().catch((err) =>
  log.warn("Volume manager init failed — single-volume mode", { error: String(err) })
);

// --- Session state ---

interface ChatSession {
  history: ContextMessage[];
  historySummary: string;
  brain: Brain;
  fileContext: string;
  learnedPaths: string[];
  ingestedContext: string;
  turnCount: number;
  lastExtractionTurn: number;
  foldedBack: boolean;
  /** Currently active thread ID, or null for main chat. */
  activeThreadId: string | null;
  /** Preserved main chat history when a thread is active. */
  mainHistory: ContextMessage[];
  mainHistorySummary: string;
}

const chatSessions = new Map<string, ChatSession>();
const sessionKeys = new Map<string, Buffer>();
let goalTimerStarted = false;

// --- Thread management ---

interface ChatThread {
  id: string;
  title: string;
  history: ContextMessage[];
  historySummary: string;
  createdAt: string;
  updatedAt: string;
}

/** Threads per session. Key = sessionId, value = Map<threadId, ChatThread>. */
const sessionThreads = new Map<string, Map<string, ChatThread>>();

function getThreadsForSession(sessionId: string): Map<string, ChatThread> {
  let threads = sessionThreads.get(sessionId);
  if (!threads) {
    threads = new Map();
    sessionThreads.set(sessionId, threads);
  }
  return threads;
}

function generateThreadId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Switch cs to point at the given thread's history (or back to main).
 * Saves/restores main history transparently.
 */
function switchSessionThread(cs: ChatSession, threadId: string | null, sessionId: string): void {
  const currentThread = cs.activeThreadId;
  if (currentThread === threadId) return; // already there

  // Save current history back to wherever it belongs
  if (currentThread) {
    // Currently on a thread — save back to that thread
    const threads = getThreadsForSession(sessionId);
    const t = threads.get(currentThread);
    if (t) {
      t.history = cs.history;
      t.historySummary = cs.historySummary;
    }
    // Restore main
    cs.history = cs.mainHistory;
    cs.historySummary = cs.mainHistorySummary;
  }

  if (threadId) {
    // Switching to a thread — save main, load thread
    const threads = getThreadsForSession(sessionId);
    const t = threads.get(threadId);
    if (t) {
      cs.mainHistory = cs.history;
      cs.mainHistorySummary = cs.historySummary;
      cs.history = t.history;
      cs.historySummary = t.historySummary;
      t.updatedAt = new Date().toISOString();
    }
  }

  cs.activeThreadId = threadId;
}

/** One-time startup token for zero-friction local auth. */
let startupToken: string | null = null;

export function getStartupToken(): string | null {
  return startupToken;
}

/** Autonomous timer started flag. */
let autonomousStarted = false;
const tracer = new Tracer();
let instanceManager: AgentInstanceManager | null = null;
let agentPool: AgentPool | null = null;
let workflowEngine: WorkflowEngine | null = null;
let activeSensitiveRegistry: SensitiveRegistry | null = null;

/** Get the current instance manager (or null if not initialized). */
function getInstanceManager(): AgentInstanceManager | null {
  return instanceManager;
}

/** Get the current agent pool (or null if not initialized). */
function getAgentPool(): AgentPool | null {
  return agentPool;
}

/** Get the current workflow engine (or null if not initialized). */
function getWorkflowEngine(): WorkflowEngine | null {
  return workflowEngine;
}

async function getOrCreateChatSession(sessionId: string, name: string): Promise<ChatSession> {
  let cs = chatSessions.get(sessionId);
  if (cs) return cs;

  // Single-user system: reuse existing chat session from any prior session ID.
  // This ensures all tabs/devices see the same conversation history.
  if (chatSessions.size > 0) {
    const [existingId, existingCs] = chatSessions.entries().next().value!;
    chatSessions.set(sessionId, existingCs);
    return existingCs;
  }

  // Read custom personality instructions (empty string if file doesn't exist)
  let personality = "";
  try {
    personality = (await runWithAuditContext({ caller: "http:init:personality", channel: "http" }, () => readBrainFile(PERSONALITY_PATH))).trim();
  } catch {}

  // Fetch current projects for system prompt injection
  let projectListStr = "";
  try {
    const projectStore = (getBoardProvider() as any)?.getProjectStore?.();
    if (projectStore) {
      const projects = await projectStore.list();
      projectListStr = projects.map((p: any) => `- **${p.prefix}** → id: "${p.id}" — ${p.name}${p.description ? ` (${p.description})` : ""}`).join("\n");
    }
  } catch {}

  const encryptionKey = sessionKeys.get(sessionId) ?? null;
  const ltm = new FileSystemLongTermMemory(MEMORY_DIR, encryptionKey ?? undefined);
  await ltm.init();
  const brain = new Brain(
    {
      systemPrompt: [
        `IDENTITY:`,
        `- Your name is ${getInstanceName()}.`,
        `- The human you are talking to is named ${name}. When they say "my name" they mean "${name}".`,
        `- You are ${name}'s personal AI agent, running locally on their machine. This conversation is private.`,
        `- Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}. Current tier: ${activeTier}.`,
        ``,
        // Tier-aware capability boundaries
        ...(() => {
          const caps = TIER_CAPS[activeTier];
          const can: string[] = [];
          const cannot: string[] = [];

          // Always available
          can.push("chat and answer questions");
          can.push("remember things and learn from conversations");
          if (caps.ollama) can.push("use local AI models via Ollama");

          // Gated capabilities — be explicit about what's off
          if (caps.integrations) {
            can.push("connect to external services (Google, Slack, etc.)");
          } else {
            cannot.push("connect to external services (Google, Slack, email)");
          }
          if (caps.vault) {
            can.push("manage API keys and credentials");
          } else {
            cannot.push("manage API keys or a credential vault");
          }
          if (caps.spawning) {
            can.push("spawn sub-agents to edit code and run tasks");
          } else {
            cannot.push("spawn agents, edit code, or run shell commands");
          }
          if (caps.voice) {
            can.push("speak and listen (voice I/O)");
          } else {
            cannot.push("use voice input or output");
          }
          if (caps.mesh) {
            can.push("communicate with other instances on the network");
          } else {
            cannot.push("reach other instances or the network");
          }
          if (caps.alerting) {
            can.push("send alerts via SMS, email, or webhooks");
          } else {
            cannot.push("send SMS, email, or webhook alerts");
          }

          const lines = [`CAPABILITIES (tier: ${activeTier}):`];
          lines.push(`You CAN: ${can.join("; ")}.`);
          if (cannot.length > 0) {
            lines.push(`You CANNOT: ${cannot.join("; ")}.`);
            lines.push(`Do NOT offer, suggest, or pretend to do things you cannot. If ${name} asks for something outside your capabilities, explain what tier unlocks it and how to upgrade (Settings → API Keys, or run \`runcore register\`).`);
          }
          return lines;
        })(),
        ``,
        `RULES:`,
        `- Be warm, honest, and direct. Have personality. Don't be a corporate assistant.`,
        `- If you don't know something, say so. Never invent information.`,
        `- Only reference data that appears in the context below. If nothing is provided, you know nothing yet.`,
        `- NEVER reference board items, tasks, or project work unless they appear verbatim below.`,
        `- NEVER claim you searched the web unless search results appear in your context.`,
        ...(personality ? [``, `--- Custom personality ---`, personality, `--- End custom personality ---`] : []),
        isSearchAvailable()
          ? `You have web search capability. When search results appear in your context, use them to answer. You don't control when searches happen — the system handles that automatically.`
          : `You do NOT have web search capability. If ${name} asks you to search or asks about current events, be honest that you can't look things up right now.`,
        ``,
        // Google Workspace status (gated on auth, instructions come from registry)
        ...(isGoogleAuthenticated()
          ? [
              `You have Google Workspace integration. Your available actions are listed below.`,
              `If Google data appears in your context, use it. It is real, live data from ${name}'s account.`,
              `You do NOT need to build or implement Google integration — it is already working.`,
              ``,
            ]
          : isGoogleConfigured()
            ? [`Google Workspace credentials are configured but not yet authorized. Tell ${name} to click "Connect Google" in settings to complete the setup.`, ``]
            : [`Google Workspace is not connected. ${name} can add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in vault settings to enable Calendar, Gmail, and Drive access.`, ``]),
        // Non-Google capability instructions (always injected)
        ...(getCapabilityRegistry()?.getPromptInstructions({ origin: "chat", name, exclude: ["calendar", "email", "docs"] }) ?? "").split("\n"),
        // Google capability instructions (only when authenticated)
        ...(isGoogleAuthenticated()
          ? (getCapabilityRegistry()?.getPromptInstructions({ origin: "chat", name, filter: ["calendar", "email", "docs"] }) ?? "").split("\n")
          : []),
        ``,
        // Capability summary — self-knowledge of full toolset
        ...(getCapabilityRegistry()?.getSummary() ?? "").split("\n"),
        ...(projectListStr ? [``, `Current projects:`, projectListStr] : []),
        ``,
        // Dynamic module prompt injection (replaces hardcoded per-module paragraphs)
        ...(() => {
          const mr = getModuleRegistry();
          if (!mr) return [];
          const fragments: string[] = [];
          for (const fragment of mr.getPromptFragments({ name })) {
            fragments.push(fragment, ``);
          }
          return fragments;
        })(),
        ...(TIER_CAPS[activeTier].spawning ? [
        `## Agent spawning (CRITICAL — follow exactly)`,
        `When a task requires code editing, file operations, or shell commands, you MUST spawn a Claude Code agent.`,
        `Do NOT describe what you would do — actually spawn the agent by including the block below.`,
        `The block content MUST be valid JSON with "label" and "prompt" keys. No markdown, no backticks, no explanation inside the block.`,
        ``,
        `### Agent prompt quality rules (MANDATORY)`,
        `Agents are Claude Code sessions that edit files. They need CONCRETE instructions or they will fail.`,
        `NEVER spawn an agent for a task that lacks a clear spec, requirement, or file to work on. If a board item is vague (e.g. "Rules Engine", "Skills Library"), do NOT spawn an agent — instead tell ${name} the item needs a spec first.`,
        `Every agent prompt MUST include:`,
        `- Real file paths from this project (e.g. "Edit src/queue/store.ts to add...")`,
        `- What specifically to build, change, or fix`,
        `- How it connects to existing code`,
        `WRONG prompt: "Build a comprehensive rules engine with prioritization, conflict resolution, versioning..."`,
        `RIGHT prompt: "In src/agents/spawn.ts, add a timeout retry: when an agent exits with code 1, re-spawn it once with the same prompt. Update the exit handler at line 77."`,
        `If you cannot write a prompt with real file paths and concrete changes, the task is not ready to spawn. Tell ${name} what's missing and either propose a spec or ask what they want. Never go silent — if you can't act, communicate.`,
        ``,
        `Format (place at the END of your response, OUTSIDE any code blocks):`,
        `[AGENT_REQUEST]`,
        `{"label": "short task name", "prompt": "Detailed instructions for the agent including file paths and what to do", "taskId": "internal-id-from-board"}`,
        `[/AGENT_REQUEST]`,
        `Include "taskId" when spawning for a specific board item (use the internal id, not the DASH-N identifier). This locks the task so other agents don't pick it up concurrently.`,
        ``,
        `You can include multiple [AGENT_REQUEST] blocks to run tasks in parallel.`,
        `WRONG: Describing the agent request in prose. WRONG: Wrapping the block in \`\`\`markdown. WRONG: Putting non-JSON text inside the block.`,
        `RIGHT: Plain [AGENT_REQUEST] tag, one line of JSON, [/AGENT_REQUEST] tag. Nothing else inside.`,
        `Agent failures are normal (auth issues, timeouts, environment mismatches). Never stop spawning agents because of past failures.`,
        `IMPORTANT: Do NOT announce agent spawns in your visible response text. No "Agent spawned to...", no "I'll spawn an agent...", no "Let me run an agent...". The UI shows agent status automatically. Just include the [AGENT_REQUEST] block silently at the end. Your visible text should answer the user's question or continue the conversation naturally.`,
        ] : []),  // end spawning gate
        // Inject instance-readable vault values (CORE_*/DASH_* prefixed only — never secrets)
        ...(() => {
          const readable = getDashReadableVault();
          if (readable.length === 0) return [];
          const lines = readable.map((r) => `- ${r.name}: ${r.value}`);
          return [
            ``,
            `## Your vault (things you need to remember)`,
            ...lines,
            `These are values ${name} stored for you. Reference them when relevant.`,
          ];
        })(),
        ``,
        ...(TIER_CAPS[activeTier].spawning ? [
        `## Autonomous work (already running)`,
        `You have a background timer that checks the backlog every 15 minutes.`,
        `When agents are idle and actionable items exist, a planner LLM picks tasks and spawns agents automatically.`,
        `${name} does not need to be in chat for this to work — work continues in the background.`,
        `Key facts:`,
        `- Fires 60s after boot, then every 15 min`,
        `- Only picks items in backlog/todo state, unassigned, not on cooldown`,
        `- Max 5 agents per round, up to 5 continuation rounds per session`,
        `- Failed tasks get escalating cooldowns (30min → 1hr → 2hr → 4hr) so they won't retry immediately`,
        `- All activity logged to brain/ops/activity.jsonl`,
        `- Circuit breaker pauses work for 30min if API credits run out`,
        `When asked about autonomous work, explain this system accurately. You CAN work while ${name} is away.`,
        `The user can type "auto" in chat to see the current autonomous status.`,
        ] : []),  // end autonomous gate
        ``,
        `## Security: encrypted memories`,
        `Some of your memories (experiences, decisions, failures) are encrypted at rest. They are only available when ${name} has authenticated with their password.`,
        `You do NOT know the password. NEVER guess, reveal, or claim to know it. If ${name} asks about it, tell them the password is verified at the system level, not by you.`,
        `If encrypted memories are unavailable (not loaded in your context), tell ${name} they may need to authenticate first.`,
      ].join("\n"),
      maxRetrieved: 5,
    },
    ltm
  );

  // Process ingest folder (move new files, read archive)
  let ingestedContext = "";
  try {
    const ingestResult = await processIngestFolder(INGEST_DIR, INGESTED_DIR);
    ingestedContext = ingestResult.content;
    if (ingestResult.newFiles.length > 0) {
      logActivity({
        source: "ingest",
        summary: `Ingested ${ingestResult.newFiles.length} new file(s): ${ingestResult.newFiles.join(", ")}`,
      });
    }
  } catch {}

  // Try restoring from encrypted disk
  const key = sessionKeys.get(sessionId);
  if (key) {
    const restored = await loadSession(sessionId, key);
    if (restored) {
      cs = { history: restored.history, historySummary: restored.historySummary ?? "", brain, fileContext: restored.fileContext, learnedPaths: restored.learnedPaths, ingestedContext, turnCount: 0, lastExtractionTurn: 0, foldedBack: false, activeThreadId: null, mainHistory: [], mainHistorySummary: "" };
      chatSessions.set(sessionId, cs);
      // Restore threads
      if (restored.threads && restored.threads.length > 0) {
        const threads = getThreadsForSession(sessionId);
        for (const t of restored.threads) {
          threads.set(t.id, {
            id: t.id,
            title: t.title,
            history: t.history || [],
            historySummary: t.historySummary || "",
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
          });
        }
      }
      return cs;
    }
  }

  cs = { history: [], historySummary: "", brain, fileContext: "", learnedPaths: [], ingestedContext, turnCount: 0, lastExtractionTurn: 0, foldedBack: false, activeThreadId: null, mainHistory: [], mainHistorySummary: "" };
  chatSessions.set(sessionId, cs);
  return cs;
}

// --- App ---

import { TIER_CAPS } from "./tier/types.js";
import type { TierName } from "./tier/types.js";
let activeTier: TierName = "local";

const app = new Hono();

// Global error handler — structured JSON errors
import { errorHandler, notFoundHandler, ApiError } from "./middleware/error-handler.js";
app.onError((err, c) => {
  // Use structured handler for ApiErrors; preserve original behavior for others
  if (err instanceof ApiError) return errorHandler(err, c);
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  log.error("Unhandled route error", { error: msg, stack, path: c.req.path, method: c.req.method });
  return c.json({ error: msg, code: "INTERNAL_ERROR", status: 500 }, 500);
});

// Serve static files from UI directory (CDN-synced or bundled fallback)
app.use("/public/*", serveStatic({ root: join(UI_DIR, ".."), rewriteRequestPath: (p) => p }));

// --- HTML template cache (replaces {{INSTANCE_NAME}} with configured name) ---
const htmlCache = new Map<string, { content: string; mtime: number }>();
async function serveHtmlTemplate(filePath: string): Promise<string> {
  const { stat } = await import("node:fs/promises");
  const stats = await stat(filePath);
  const cached = htmlCache.get(filePath);
  if (cached && cached.mtime === stats.mtimeMs) return cached.content;
  const raw = await readFile(filePath, "utf-8");
  const content = raw.replaceAll("{{INSTANCE_NAME}}", getInstanceName());
  htmlCache.set(filePath, { content, mtime: stats.mtimeMs });
  return content;
}

// --- Auth middleware: hard gate on all /api/* routes ---
app.use("/api/*", requireSession());

// Serve index.html at root
app.get("/", async (c) => {
  const html = await serveHtmlTemplate(join(UI_DIR,"index.html"));
  return c.html(html);
});

// --- PWA assets (must be served from root for scope) ---
app.get("/manifest.json", async (c) => {
  const data = await readFile(join(UI_DIR, "manifest.json"), "utf-8");
  return c.json(JSON.parse(data));
});
app.get("/sw.js", async (c) => {
  const data = await readFile(join(UI_DIR, "sw.js"), "utf-8");
  return c.newResponse(data, 200, { "Content-Type": "application/javascript", "Service-Worker-Allowed": "/" });
});

// --- Nerve endpoint (PWA) ---
app.get("/nerve", async (c) => {
  const html = await serveHtmlTemplate(join(UI_DIR,"nerve", "index.html"));
  return c.html(html);
});

// --- Audit context middleware ---
// Tags all brain file reads within HTTP handlers with the route info.
app.use("/api/*", async (c, next) => {
  const caller = `http:${c.req.method} ${c.req.path}`;
  return runWithAuditContext({ caller, channel: "http" }, () => next());
});

// --- Tracing middleware ---

app.use("/api/*", tracingMiddleware());

// --- Metrics middleware ---

app.use("/api/*", metricsMiddleware());

// --- Rate limiting ---

// Tight limit on auth endpoints to prevent brute-force attacks.
app.use("/api/pair", rateLimit({ windowMs: 15 * 60_000, max: 10 }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60_000, max: 10 }));
app.use("/api/recover", rateLimit({ windowMs: 15 * 60_000, max: 5 }));
app.use("/api/mobile/redeem", rateLimit({ windowMs: 15 * 60_000, max: 5 }));

// Dashboard endpoints get a separate, more generous limit — they poll frequently.
app.use("/api/ops/*", rateLimit({ windowMs: 60_000, max: 300 }));

// General API rate limit — skip paths that already have their own limiter.
// Multiple tabs (board 5s + observatory 30s + ops 15s + activity 5s + agent 3s)
// can easily generate 60-80 req/min from polling alone; 600 gives plenty of headroom.
const generalLimiter = rateLimit({ windowMs: 60_000, max: 600 });
app.use("/api/*", async (c, next) => {
  const path = c.req.path;
  if (path.startsWith("/api/ops/") || path.startsWith("/api/pair") || path.startsWith("/api/auth") || path.startsWith("/api/recover")) {
    return next();
  }
  return generalLimiter(c, next);
});

// --- Posture middleware (intent accumulation + surface gating) ---

// Track all API interactions for posture engine
app.use("/api/*", postureTracker());

// Attach posture surface header to all responses
app.use("/api/*", postureHeader());

// --- Webhook initialization (batch registration + config + admin routes) ---

const webhookInitStart = performance.now();

// Phase 1: Batch-register all webhook providers (deferred from module imports to avoid
// 5 individual logActivity calls during startup — now a single batch call).
const registerStart = performance.now();
registerProviders([githubProvider, slackEventsProvider, slackCommandsProvider, slackInteractionsProvider, twilioProvider, resendProvider]);
const registerMs = performance.now() - registerStart;

// Phase 2: Configure webhook providers (secrets resolved from env vars)
const configStart = performance.now();
setProviderConfigs([
  { name: "slack-events", secret: "SLACK_SIGNING_SECRET", signatureHeader: "x-slack-signature", algorithm: "slack-v0", path: "/api/slack/events" },
  { name: "slack-commands", secret: "SLACK_SIGNING_SECRET", signatureHeader: "x-slack-signature", algorithm: "slack-v0", path: "/api/slack/commands" },
  { name: "slack-interactions", secret: "SLACK_SIGNING_SECRET", signatureHeader: "x-slack-signature", algorithm: "slack-v0", path: "/api/slack/interactions" },
  { name: "twilio", secret: "TWILIO_AUTH_TOKEN", signatureHeader: "x-twilio-signature", algorithm: "twilio", path: "/api/twilio/whatsapp" },
  { name: "github", secret: "GITHUB_WEBHOOK_SECRET", signatureHeader: "x-hub-signature-256", algorithm: "hmac-sha256-hex", path: "/api/github/webhooks" },
  { name: "resend", secret: "RESEND_WEBHOOK_SECRET", signatureHeader: "svix-signature", algorithm: "custom" as const, path: "/api/resend/webhooks" },
]);
const configMs = performance.now() - configStart;

// Phase 3: Mount admin routes
const mountStart = performance.now();
mountWebhookAdmin(app);
const mountMs = performance.now() - mountStart;

const webhookInitMs = performance.now() - webhookInitStart;
log.debug(
  `Webhook init complete: ${webhookInitMs.toFixed(1)}ms — register:${registerMs.toFixed(1)}ms, config:${configMs.toFixed(1)}ms, mount:${mountMs.toFixed(1)}ms`,
  { durationMs: Math.round(webhookInitMs), registerMs: Math.round(registerMs), configMs: Math.round(configMs), mountMs: Math.round(mountMs) },
);
if (webhookInitMs > 100) {
  logActivity({
    source: "system",
    summary: `[perf] Webhook init slow: ${webhookInitMs.toFixed(1)}ms — register:${registerMs.toFixed(1)}ms, config:${configMs.toFixed(1)}ms, mount:${mountMs.toFixed(1)}ms`,
  });
}

// --- API routes ---

// UI version check (stub — UI polls this to detect hot-reload)
app.get("/api/ui-version", (c) => c.json({ version: "0.4.0" }));

// Return current seal values so client can blur on page load
app.get("/api/sensitive/seals", (c) => {
  const membrane = getActiveMembrane();
  return c.json({ values: membrane ? membrane.knownValues.map(v => v.value) : [] });
});

// Pending questions (stub — proactive question chips)
app.get("/api/pending-questions", (c) => c.json({ questions: [] }));

// Status: what screen should the UI show?
app.get("/api/status", async (c) => {
  const status = await getStatus();
  const settings = getSettings();
  return c.json({
    ...status,
    provider: resolveProvider(),
    airplaneMode: settings.airplaneMode,
    privateMode: settings.privateMode,
    authMode: settings.safeWordMode,
    search: isSearchAvailable(),
    tts: isTtsAvailable(),
    stt: isSttAvailable(),
    avatar: isAvatarAvailable(),
    agentName: getInstanceName(),
  });
});

// Tier: current tier + capability matrix for UI gating
app.get("/api/tier", async (c) => {
  const { TIER_CAPS } = await import("./tier/types.js");
  const tier = activeTier;
  return c.json({
    tier,
    capabilities: TIER_CAPS[tier] ?? TIER_CAPS.local,
    model: resolveChatModel() ?? "auto",
    provider: resolveProvider(),
  });
});

// Pairing ceremony
app.post("/api/pair", async (c) => {
  const body = await c.req.json();
  let { code, name, password, safeWord, recoveryQuestion, recoveryAnswer, agentName } = body;
  // Backward compat: accept "safeWord" from old clients
  const pw = password || safeWord;

  if (!code || !name || !pw) {
    return c.json({ error: "Name and password required" }, 400);
  }

  // Auto-token bypass: startup token already proved the user is local.
  const skipCodeCheck = code === "__auto_token__";

  const result = await pair({ code, name, password: pw, recoveryQuestion, recoveryAnswer, skipCodeCheck });
  if ("error" in result) {
    return c.json({ error: result.error }, 400);
  }

  sessionKeys.set(result.session.id, result.sessionKey);
  setEncryptionKey(result.sessionKey);
  cacheSessionKey(result.sessionKey);
  await loadVault(result.sessionKey);

  // Save agent name to settings + update in-memory name
  if (agentName) {
    setInstanceName(agentName);
    try {
      const settingsPath = join(BRAIN_DIR, "settings.json");
      const raw = await readFile(settingsPath, "utf-8");
      const settings = JSON.parse(raw);
      settings.instanceName = agentName.trim();
      settings.agentName = agentName.trim();
      await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    } catch {}
  }

  return c.json({ sessionId: result.session.id, name: result.session.name, agentName: agentName || "Core" });
});

// Auth: return visit
app.post("/api/auth", async (c) => {
  const body = await c.req.json();
  const { password, safeWord } = body;
  // Backward compat: accept "safeWord" from old clients
  const pw = password || safeWord;

  if (!pw) {
    return c.json({ error: "Password required" }, 400);
  }

  const result = await authenticate(pw);
  if ("error" in result) {
    return c.json({ error: result.error }, 401);
  }

  sessionKeys.set(result.session.id, result.sessionKey);
  setEncryptionKey(result.sessionKey);
  cacheSessionKey(result.sessionKey);
  await loadVault(result.sessionKey);
  return c.json({ sessionId: result.session.id, name: result.name });
});

// Validate an existing session (for "restart" auth mode)
app.get("/api/auth/validate", async (c) => {
  const sid = c.req.query("sessionId");
  if (!sid) return c.json({ valid: false });
  const session = validateSession(sid);
  if (session && sessionKeys.has(sid)) {
    return c.json({ valid: true, name: session.name });
  }
  return c.json({ valid: false });
});

// Check if server has an active session (for "restart" mode when sessionStorage is empty)
app.get("/api/auth/active-session", async (c) => {
  // Return the first active session if one exists (single-user system)
  for (const [sid] of sessionKeys) {
    const session = validateSession(sid);
    if (session) {
      return c.json({ valid: true, sessionId: sid, name: session.name });
    }
  }
  return c.json({ valid: false });
});

// Auto-token auth: zero-friction local first-run bypass
app.get("/api/auth/token", async (c) => {
  const token = c.req.query("t");
  if (!token || !startupToken || token !== startupToken) {
    return c.json({ valid: false, error: "Invalid or expired token" }, 401);
  }
  startupToken = null;
  const status = await getStatus();
  return c.json({ valid: true, needsPairing: !status.paired, codeBypass: true });
});

// Recovery question (GET)
app.get("/api/recover", async (c) => {
  const question = await getRecoveryQuestion();
  if (!question) {
    return c.json({ error: "Not paired yet" }, 400);
  }
  return c.json({ question });
});

// Recovery: reset password
app.post("/api/recover", async (c) => {
  const body = await c.req.json();
  const { answer, newPassword, newSafeWord } = body;
  // Backward compat: accept "newSafeWord" from old clients
  const newPw = newPassword || newSafeWord;

  if (!answer || !newPw) {
    return c.json({ error: "Answer and new password required" }, 400);
  }

  const result = await recover(answer, newPw);
  if ("error" in result) {
    return c.json({ error: result.error }, 401);
  }

  sessionKeys.set(result.session.id, result.sessionKey);
  setEncryptionKey(result.sessionKey);
  cacheSessionKey(result.sessionKey);
  await loadVault(result.sessionKey);
  return c.json({ sessionId: result.session.id, name: result.name });
});

// --- Mobile pairing (device voucher + QR) ---

/** In-memory store for device vouchers (short-lived, cleared on restart). */
interface DeviceVoucher {
  token: string;
  instanceHash: string;
  instanceName: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}
const deviceVouchers = new Map<string, DeviceVoucher>();

/** In-memory store for paired devices. */
interface PairedDevice {
  deviceToken: string;
  sessionId?: string;
  humanName?: string;
  label: string;
  pairedAt: string;
  lastSeen: string;
}
const pairedDevices = new Map<string, PairedDevice>();

// Load paired devices from brain on startup (called later in init)
async function loadPairedDevices(): Promise<void> {
  try {
    const raw = await readFile(join(BRAIN_DIR, "identity", "devices.json"), "utf-8");
    const devices = JSON.parse(raw) as PairedDevice[];
    for (const d of devices) {
      pairedDevices.set(d.deviceToken, d);
      // Re-create session so phone doesn't need to re-pair after Core restart
      if (d.sessionId) {
        createSession(d.humanName || d.label, d.sessionId);
        log.debug("Restored session for paired device", { label: d.label, humanName: d.humanName });
      }
    }
  } catch { /* no devices yet */ }
}
async function savePairedDevices(): Promise<void> {
  try {
    await mkdir(join(BRAIN_DIR, "identity"), { recursive: true });
    await writeFile(
      join(BRAIN_DIR, "identity", "devices.json"),
      JSON.stringify([...pairedDevices.values()], null, 2),
      "utf-8",
    );
  } catch { /* best effort */ }
}

// Issue a device voucher (requires active session — you're on the PC)
app.post("/api/mobile/voucher", async (c) => {
  const sessionId = c.req.query("sessionId") || c.req.header("x-session-id");
  if (!sessionId || !validateSession(sessionId)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { randomBytes: rng } = await import("node:crypto");
  const { createHash } = await import("node:crypto");
  const token = `dv_${rng(8).toString("hex")}`;
  const instanceHash = createHash("sha256")
    .update(getInstanceName() + BRAIN_DIR)
    .digest("hex")
    .slice(0, 16);

  const voucher: DeviceVoucher = {
    token,
    instanceHash,
    instanceName: getInstanceName(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    consumed: false,
  };
  deviceVouchers.set(token, voucher);

  // Clean expired vouchers
  for (const [k, v] of deviceVouchers) {
    if (v.expiresAt < Date.now()) deviceVouchers.delete(k);
  }

  // The QR payload — a URL the phone opens directly
  const voucherPayload = encodeURIComponent(JSON.stringify({
    relay: "https://runcore.sh",
    token,
    instance: instanceHash,
    name: voucher.instanceName,
  }));
  const qrUrl = `https://runcore.sh/pair#${voucherPayload}`;

  // Generate QR code as data URL (server-side, proven library)
  let qrDataUrl = "";
  try {
    const QRCode = (await import("qrcode")).default;
    qrDataUrl = await QRCode.toDataURL(qrUrl, {
      width: 250,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
      errorCorrectionLevel: "L",
    });
  } catch (err) {
    log.warn("QR generation failed", { error: err instanceof Error ? err.message : String(err) });
  }

  return c.json({
    token,
    expiresIn: 600,
    qrData: qrUrl,
    qrImage: qrDataUrl,
    instanceName: voucher.instanceName,
  });
});

// Get voucher info (phone hits this to personalize before asking for safe word)
// Public — returns only display info, nothing secret
app.get("/api/mobile/info/:token", async (c) => {
  const token = c.req.param("token");
  const voucher = deviceVouchers.get(token);

  if (!voucher || voucher.consumed || voucher.expiresAt < Date.now()) {
    return c.json({ error: "Invalid or expired voucher" }, 404);
  }

  return c.json({
    instanceName: voucher.instanceName,
    expiresIn: Math.max(0, Math.round((voucher.expiresAt - Date.now()) / 1000)),
  });
});

// Redeem voucher with safe word → device token
app.post("/api/mobile/redeem", async (c) => {
  const body = await c.req.json();
  const { token, password } = body;

  if (!token || !password) {
    return c.json({ error: "Voucher token and password required" }, 400);
  }

  const voucher = deviceVouchers.get(token);
  if (!voucher || voucher.consumed || voucher.expiresAt < Date.now()) {
    return c.json({ error: "Invalid or expired voucher" }, 404);
  }

  // Validate safe word via existing auth
  const authResult = await authenticate(password);
  if ("error" in authResult) {
    return c.json({ error: "Invalid safe word" }, 401);
  }

  // Consume voucher
  voucher.consumed = true;

  // Issue device token
  const { randomBytes: rng } = await import("node:crypto");
  const deviceToken = `dt_${rng(16).toString("hex")}`;
  const label = body.label || "Phone";

  const device: PairedDevice = {
    deviceToken,
    sessionId: authResult.session.id,
    humanName: authResult.name,
    label,
    pairedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };
  pairedDevices.set(deviceToken, device);
  await savePairedDevices();

  // Return session + device token
  sessionKeys.set(authResult.session.id, authResult.sessionKey);
  setEncryptionKey(authResult.sessionKey);

  return c.json({
    deviceToken,
    sessionId: authResult.session.id,
    instanceName: getInstanceName(),
  });
});

// List paired devices (requires session)
app.get("/api/mobile/devices", async (c) => {
  const sessionId = c.req.query("sessionId") || c.req.header("x-session-id");
  if (!sessionId || !validateSession(sessionId)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return c.json({
    devices: [...pairedDevices.values()].map((d) => ({
      label: d.label,
      pairedAt: d.pairedAt,
      lastSeen: d.lastSeen,
    })),
  });
});

// Revoke a device (requires session)
app.delete("/api/mobile/devices/:label", async (c) => {
  const sessionId = c.req.query("sessionId") || c.req.header("x-session-id");
  if (!sessionId || !validateSession(sessionId)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const label = c.req.param("label");
  for (const [token, d] of pairedDevices) {
    if (d.label === label) {
      pairedDevices.delete(token);
      await savePairedDevices();
      return c.json({ ok: true });
    }
  }
  return c.json({ error: "Device not found" }, 404);
});

// --- Relay polling (receive messages from paired phones) ---

let relayPollInterval: ReturnType<typeof setInterval> | null = null;

function startRelayPoll(instanceHash: string): void {
  if (relayPollInterval) return;

  const POLL_MS = 1_500; // 1.5 seconds

  relayPollInterval = setInterval(async () => {
    // Check for chat envelopes
    try {
      const res = await fetch(
        `https://runcore.sh/api/relay/envelope?recipient=${encodeURIComponent(instanceHash)}`,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (res.ok) {
        const data = await res.json() as { envelopes: Array<{ id: string; from: string; deviceToken?: string; payload: string; timestamp: string }> };
        if (data.envelopes && data.envelopes.length > 0) {
          for (const env of data.envelopes) {
            try {
              const decoded = JSON.parse(Buffer.from(env.payload, "base64").toString("utf-8"));
              if (decoded.type === "chat" && decoded.sessionId && decoded.message) {
                log.info("Relay message received", { from: env.from, messageLen: decoded.message.length });
                await handleRelayChat(decoded.sessionId, decoded.message, env.from, instanceHash);
              } else if (decoded.type === "sync" && decoded.sessionId) {
                log.info("Relay sync request", { from: env.from });
                await handleRelaySync(decoded.sessionId, env.from, instanceHash);
              }
            } catch (err) {
              log.debug("Failed to process relay envelope", { error: err instanceof Error ? err.message : String(err) });
            }
          }
        }
      }
    } catch {
      // Network error — will retry on next poll
    }

    // Check for pending pair requests (independent of envelope check)
    try {
      const pairRes = await fetch(
        `https://runcore.sh/api/relay/pair?instance=${encodeURIComponent(instanceHash)}`,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (pairRes.ok) {
        const pairData = await pairRes.json() as { requests: Array<{ token: string; password: string; label: string }> };
        if (pairData.requests && pairData.requests.length > 0) {
          log.info("Relay pair requests received", { count: pairData.requests.length });
          for (const req of pairData.requests) {
            await handleRelayPair(req.token, req.password, req.label, instanceHash);
          }
        }
      }
    } catch {
      // Pair poll failed — will retry on next cycle
    }
  }, POLL_MS);
}

/**
 * Handle a chat message received via relay from a paired phone.
 * Processes through the same LLM pipeline as a local chat, sends response back through relay.
 */
/**
 * Handle a sync request from a paired phone — send chat history back through relay.
 */
async function handleRelaySync(sid: string, senderHash: string, instanceHash: string): Promise<void> {
  try {
    // Find chat session — check this sessionId or grab the single existing one
    let history: Array<{ role: string; content: string }> = [];
    const cs = chatSessions.get(sid) || (chatSessions.size > 0 ? chatSessions.values().next().value : null);
    if (cs) {
      // Send last 50 messages to keep payload reasonable
      history = cs.history.slice(-50).map((m: any) => ({ role: m.role, content: m.content }));
    }

    await fetch("https://runcore.sh/api/relay/envelope", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipientHash: senderHash,
        senderHash: instanceHash,
        payload: Buffer.from(JSON.stringify({
          type: "history",
          messages: history,
          timestamp: new Date().toISOString(),
        })).toString("base64"),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    log.info("Sent chat history to phone", { messageCount: history.length });
  } catch (err) {
    log.warn("Relay sync failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleRelayChat(sid: string, message: string, senderHash: string, instanceHash: string): Promise<void> {
  log.info("handleRelayChat start", { sid: sid.slice(0, 8), senderHash, messageLen: message.length });

  // Get the user name — check session first, then paired device, then fallback
  const session = validateSession(sid);
  let userName = session?.name || "User";
  // Look up paired device for real name
  for (const d of pairedDevices.values()) {
    if (d.sessionId === sid && d.humanName) { userName = d.humanName; break; }
  }
  log.info("handleRelayChat session", { userName, sessionValid: !!session });

  const cs = await getOrCreateChatSession(sid, userName);
  log.info("handleRelayChat chatSession ready", { turnCount: cs.turnCount, historyLen: cs.history.length });

  // Add user message to history (tagged with source device)
  cs.history.push({ role: "user", content: message, source: "phone" } as any);

  try {
    const provider = resolveProvider();
    const model = resolveChatModel() ?? undefined;
    log.info("handleRelayChat calling LLM", { provider, model });
    const llmProvider = getProvider(provider);

    const response = await llmProvider.completeChat(cs.history, model);
    log.info("handleRelayChat LLM responded", { responseLen: response.length });

    // Add response to history
    cs.history.push({ role: "assistant", content: response });
    cs.turnCount++;

    // Send response back through relay to the phone
    await fetch("https://runcore.sh/api/relay/envelope", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipientHash: senderHash,
        senderHash: instanceHash,
        payload: Buffer.from(JSON.stringify({
          type: "chat_response",
          message: response,
          timestamp: new Date().toISOString(),
        })).toString("base64"),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log.warn("Relay chat failed", { error: err instanceof Error ? err.message : String(err) });

    // Send error back to phone
    await fetch("https://runcore.sh/api/relay/envelope", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipientHash: senderHash,
        senderHash: instanceHash,
        payload: Buffer.from(JSON.stringify({
          type: "status",
          message: "Error: " + (err instanceof Error ? err.message : String(err)),
          timestamp: new Date().toISOString(),
        })).toString("base64"),
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }
}

/**
 * Handle a pairing request received via relay.
 * Validates the safe word, issues device token, sends result back through relay.
 */
async function handleRelayPair(token: string, password: string, label: string, instanceHash: string): Promise<void> {
  let result: { ok: boolean; deviceToken?: string; sessionId?: string; instanceName?: string; error?: string };

  try {
    const voucher = deviceVouchers.get(token);
    if (!voucher || voucher.consumed || voucher.expiresAt < Date.now()) {
      result = { ok: false, error: "Invalid or expired voucher" };
    } else {
      const authResult = await authenticate(password);
      if ("error" in authResult) {
        result = { ok: false, error: "Invalid safe word" };
      } else {
        // Consume voucher
        voucher.consumed = true;

        // Issue device token
        const { randomBytes: rng } = await import("node:crypto");
        const deviceToken = `dt_${rng(16).toString("hex")}`;

        const device: PairedDevice = {
          deviceToken,
          sessionId: authResult.session.id,
          humanName: authResult.name,
          label,
          pairedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        };
        pairedDevices.set(deviceToken, device);
        await savePairedDevices();

        sessionKeys.set(authResult.session.id, authResult.sessionKey);
        setEncryptionKey(authResult.sessionKey);

        log.info("Device paired via relay", { label, token: token.slice(0, 8) + "..." });
        result = { ok: true, deviceToken, sessionId: authResult.session.id, instanceName: getInstanceName() };
      }
    }
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : "Pairing failed" };
  }

  // Send result back through relay
  try {
    await fetch("https://runcore.sh/api/relay/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "result", token, result }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    log.warn("Failed to send pair result to relay", { token: token.slice(0, 8) + "..." });
  }
}

// --- Vault routes ---

// List vault keys (names + labels only, no values)
app.get("/api/vault", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  return c.json({ keys: listVaultKeys() });
});

// Add or update a vault key
app.put("/api/vault/:name", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const key = sessionKeys.get(sessionId);
  if (!key) return c.json({ error: "Session key not found" }, 401);

  const name = c.req.param("name");
  const body = await c.req.json();
  const { value, label } = body;
  if (!value) return c.json({ error: "value required" }, 400);

  await setVaultKey(name, value, key, label);
  return c.json({ ok: true });
});

// Delete a vault key
app.delete("/api/vault/:name", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const key = sessionKeys.get(sessionId);
  if (!key) return c.json({ error: "Session key not found" }, 401);

  const name = c.req.param("name");
  await deleteVaultKey(name, key);
  return c.json({ ok: true });
});

// Export vault to portable passphrase-encrypted file
app.post("/api/vault/export", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const body = await c.req.json<{ passphrase?: string }>();
  if (!body.passphrase || body.passphrase.length < 8) {
    return c.json({ error: "Passphrase required (min 8 characters)" }, 400);
  }

  try {
    const result = await exportVault(body.passphrase);
    return c.json({ ok: true, filePath: result.filePath, stats: result.stats });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Import vault from portable passphrase-encrypted file
app.post("/api/vault/import", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const key = sessionKeys.get(sessionId);
  if (!key) return c.json({ error: "Session key not found" }, 401);

  const body = await c.req.json<{ filePath?: string; passphrase?: string; strategy?: string }>();
  if (!body.filePath || !body.passphrase) {
    return c.json({ error: "filePath and passphrase required" }, 400);
  }

  const strategy = (body.strategy as "overwrite" | "skip" | "rename") ?? "skip";
  try {
    const result = await importVault(body.filePath, body.passphrase, strategy, key);
    return c.json({ ok: true, stats: result.stats });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// Verify a vault export file without importing
app.post("/api/vault/verify-export", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const body = await c.req.json<{ filePath?: string; passphrase?: string }>();
  if (!body.filePath || !body.passphrase) {
    return c.json({ error: "filePath and passphrase required" }, 400);
  }

  try {
    const result = await verifyExport(body.filePath, body.passphrase);
    return c.json({ ok: true, message: result.message, stats: result.stats });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// --- Google OAuth2 routes ---

// Initiate Google OAuth flow — redirects to Google consent screen
// No session required: this just redirects to Google, no sensitive data returned
app.get("/api/google/auth", async (c) => {
  const redirectUri = `http://localhost:${PORT}/api/google/callback`;
  const result = getAuthUrl(redirectUri);
  if (!result.ok) {
    return c.html(`<html><body><h2>Google OAuth not configured</h2><p>${result.message}</p></body></html>`);
  }

  return c.redirect(result.url!);
});

// Handle Google OAuth callback — exchange code for tokens, store in vault
app.get("/api/google/callback", async (c) => {
  const code = c.req.query("code");
  const error = c.req.query("error");

  if (error) {
    return c.html(`<html><body><h2>Google auth denied</h2><p>${error}</p><p>You can close this tab.</p></body></html>`);
  }

  if (!code) {
    return c.html(`<html><body><h2>Missing authorization code</h2><p>No code received from Google.</p></body></html>`);
  }

  const redirectUri = `http://localhost:${PORT}/api/google/callback`;
  const result = await exchangeCode(code, redirectUri);
  if (!result.ok) {
    return c.html(`<html><body><h2>Token exchange failed</h2><p>${result.message}</p></body></html>`);
  }

  // Store refresh token in vault
  if (!result.refreshToken) {
    return c.html(`<html><body><h2>Token exchange incomplete</h2><p>No refresh token received. Try revoking app access in Google settings and reconnecting.</p></body></html>`);
  }

  // Get a session key — try in-memory first, fall back to disk cache
  let vaultKey = [...sessionKeys.values()][0] ?? null;
  if (!vaultKey) {
    const restored = await restoreSession();
    if (restored) {
      vaultKey = restored.sessionKey;
      sessionKeys.set(restored.session.id, restored.sessionKey);
      setEncryptionKey(restored.sessionKey);
      await loadVault(restored.sessionKey);
    }
  }

  if (!vaultKey) {
    return c.html(`<html><body><h2>Session not found</h2><p>Could not find a session key to store credentials. Please log in first, then try connecting Google again.</p></body></html>`);
  }

  await setVaultKey("GOOGLE_REFRESH_TOKEN", result.refreshToken, vaultKey, "Google OAuth refresh token");
  logActivity({ source: "google", summary: "Google OAuth connected — refresh token stored in vault", actionLabel: "PROMPTED", reason: "user connected Google OAuth" });

  // Start Google polling timers now that Google is connected
  startCalendarTimer();
  startGmailTimer();
  startTasksTimer();

  return c.html(`<html><body><h2>Google connected!</h2><p>${getInstanceName()} now has access to Calendar, Gmail, and Drive.</p><p>This tab will close automatically.</p><script>if(window.opener){window.opener.postMessage("google-connected","*")}setTimeout(()=>window.close(),1500)</script></body></html>`);
});

// Check Google auth state (public — only returns booleans, no sensitive data)
app.get("/api/google/status", async (c) => {
  return c.json({
    configured: isGoogleConfigured(),
    authenticated: isGoogleAuthenticated(),
    scopes: isGoogleAuthenticated() ? ["gmail.modify", "calendar.events", "drive.file", "tasks"] : [],
  });
});

// Send email via Gmail
app.post("/api/google/send-email", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  if (!isGoogleAuthenticated()) {
    return c.json({ error: "Google not authenticated" }, 400);
  }

  const body = await c.req.json<{
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject: string;
    body: string;
    htmlBody?: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
  }>();

  if (!body.to || !body.subject || !body.body) {
    return c.json({ error: "to, subject, and body are required" }, 400);
  }

  const result = await sendEmail(body);
  if (!result.ok) return c.json({ error: result.message }, 500);

  logActivity({ source: "gmail", summary: `Email sent to ${Array.isArray(body.to) ? body.to.join(", ") : body.to}: "${body.subject}"`, actionLabel: "PROMPTED", reason: "user sent email" });
  return c.json(result);
});

// --- Gmail triage routes ---

// Inbox summary: unread count, categorized messages, high-priority items
app.get("/api/google/gmail/inbox-summary", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);
  if (!isGmailAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const hours = parseInt(c.req.query("hours") ?? "24", 10);
  const result = await getInboxSummary(hours);
  if (!result.ok) return c.json({ error: result.message }, 500);
  return c.json(result);
});

// Categorize recent messages by sender type
app.get("/api/google/gmail/categorize", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);
  if (!isGmailAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const hours = parseInt(c.req.query("hours") ?? "24", 10);
  const result = await categorizeMessages(hours);
  if (!result.ok) return c.json({ error: result.message }, 500);
  return c.json(result);
});

// Prioritize inbox: messages sorted by importance score
app.get("/api/google/gmail/prioritize", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);
  if (!isGmailAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const hours = parseInt(c.req.query("hours") ?? "24", 10);
  const result = await prioritizeInbox(hours);
  if (!result.ok) return c.json({ error: result.message }, 500);
  return c.json(result);
});

// Mark message as read
app.post("/api/google/gmail/mark-read", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);
  if (!isGmailAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const body = await c.req.json<{ messageId?: string; messageIds?: string[] }>();

  if (body.messageIds && body.messageIds.length > 0) {
    const result = await batchMarkAsRead(body.messageIds);
    if (!result.ok) return c.json({ error: result.message }, 500);
    return c.json(result);
  }

  if (!body.messageId) return c.json({ error: "messageId or messageIds required" }, 400);
  const result = await markAsRead(body.messageId);
  if (!result.ok) return c.json({ error: result.message }, 500);
  return c.json(result);
});

// Mark message as unread
app.post("/api/google/gmail/mark-unread", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);
  if (!isGmailAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const body = await c.req.json<{ messageId?: string; messageIds?: string[] }>();

  if (body.messageIds && body.messageIds.length > 0) {
    const result = await batchMarkAsUnread(body.messageIds);
    if (!result.ok) return c.json({ error: result.message }, 500);
    return c.json(result);
  }

  if (!body.messageId) return c.json({ error: "messageId or messageIds required" }, 400);
  const result = await markAsUnread(body.messageId);
  if (!result.ok) return c.json({ error: result.message }, 500);
  return c.json(result);
});

// --- Google Calendar routes ---

// Get today's schedule
app.get("/api/google/calendar/today", async (c) => {
  if (!isCalendarAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const result = await getTodaySchedule();
  if (!result.ok) return c.json({ error: result.message }, 500);
  return c.json(result);
});

// Get upcoming events
app.get("/api/google/calendar/upcoming", async (c) => {
  if (!isCalendarAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const hours = parseInt(c.req.query("hours") ?? "4", 10);
  const result = await getUpcomingEvents(hours);
  if (!result.ok) return c.json({ error: result.message }, 500);
  return c.json(result);
});

// Get free/busy
app.post("/api/google/calendar/freebusy", async (c) => {
  if (!isCalendarAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const body = await c.req.json<{ start: string; end: string }>();
  if (!body.start || !body.end) return c.json({ error: "start and end are required" }, 400);

  const result = await getFreeBusy(body.start, body.end);
  if (!result.ok) return c.json({ error: result.message }, 500);
  return c.json(result);
});

// Create calendar event
app.post("/api/google/calendar/events", async (c) => {
  if (!isCalendarAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const body = await c.req.json<{
    title: string;
    start: string;
    end: string;
    description?: string;
    location?: string;
    attendees?: string[];
    recurrence?: string[];
    timeZone?: string;
    expectedDayOfWeek?: string;
  }>();
  if (!body.title || !body.start || !body.end) {
    return c.json({ error: "title, start, and end are required" }, 400);
  }

  // Temporal validation: catch day-of-week mismatches before creating events (ts_temporal_mismatch_01)
  const temporalCheck = validateCalendarEntry(body.start, body.expectedDayOfWeek);
  if (!temporalCheck.ok) {
    return c.json({
      error: temporalCheck.message,
      suggestion: temporalCheck.suggestion,
      actualDayOfWeek: getDayOfWeek(body.start),
    }, 400);
  }

  const result = await createEvent(body.title, body.start, body.end, {
    description: body.description,
    location: body.location,
    attendees: body.attendees,
    recurrence: body.recurrence,
    timeZone: body.timeZone,
  });
  if (!result.ok) return c.json({ error: result.message }, 500);

  logActivity({ source: "calendar", summary: `Event created: ${body.title}`, actionLabel: "PROMPTED", reason: "user created calendar event" });
  return c.json({ ...result, actualDayOfWeek: getDayOfWeek(body.start) });
});

// List events with flexible filtering
app.get("/api/google/calendar/events", async (c) => {
  if (!isCalendarAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const result = await listEvents({
    timeMin: c.req.query("timeMin"),
    timeMax: c.req.query("timeMax"),
    query: c.req.query("q"),
    maxResults: c.req.query("maxResults") ? parseInt(c.req.query("maxResults")!, 10) : undefined,
    showDeleted: c.req.query("showDeleted") === "true",
  });
  if (!result.ok) return c.json({ error: result.message }, 500);
  return c.json(result);
});

// Update calendar event
app.patch("/api/google/calendar/events/:eventId", async (c) => {
  if (!isCalendarAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const eventId = c.req.param("eventId");
  const body = await c.req.json<{
    title?: string;
    start?: string;
    end?: string;
    description?: string;
    location?: string;
    attendees?: string[];
    recurrence?: string[];
    timeZone?: string;
    expectedDayOfWeek?: string;
  }>();

  // Temporal validation on updated start date (ts_temporal_mismatch_01)
  if (body.start) {
    const temporalCheck = validateCalendarEntry(body.start, body.expectedDayOfWeek);
    if (!temporalCheck.ok) {
      return c.json({
        error: temporalCheck.message,
        suggestion: temporalCheck.suggestion,
        actualDayOfWeek: getDayOfWeek(body.start),
      }, 400);
    }
  }

  const result = await updateEvent(eventId, body);
  if (!result.ok) return c.json({ error: result.message }, 500);

  logActivity({ source: "calendar", summary: `Event updated: ${eventId}`, actionLabel: "PROMPTED", reason: "user updated calendar event" });
  return c.json(body.start ? { ...result, actualDayOfWeek: getDayOfWeek(body.start) } : result);
});

// Delete calendar event
app.delete("/api/google/calendar/events/:eventId", async (c) => {
  if (!isCalendarAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const eventId = c.req.param("eventId");
  const sendUpdates = c.req.query("sendUpdates") as "all" | "externalOnly" | "none" | undefined;

  const result = await deleteEvent(eventId, { sendUpdates });
  if (!result.ok) return c.json({ error: result.message }, 500);

  logActivity({ source: "calendar", summary: `Event deleted: ${eventId}`, actionLabel: "PROMPTED", reason: "user deleted calendar event" });
  return c.json(result);
});

// Search calendar events by text
app.get("/api/google/calendar/search", async (c) => {
  if (!isCalendarAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const query = c.req.query("q");
  if (!query) return c.json({ error: "q (search query) is required" }, 400);

  const result = await searchEvents(query, {
    timeMin: c.req.query("timeMin"),
    timeMax: c.req.query("timeMax"),
    maxResults: c.req.query("maxResults") ? parseInt(c.req.query("maxResults")!, 10) : undefined,
  });
  if (!result.ok) return c.json({ error: result.message }, 500);
  return c.json(result);
});

// --- Google Tasks routes ---

// List task lists
app.get("/api/google/tasks/lists", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);
  if (!isTasksAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const result = await listTaskLists();
  if (!result.ok) return c.json({ error: result.message }, 500);
  return c.json(result);
});

// Create task list
app.post("/api/google/tasks/lists", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);
  if (!isTasksAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const body = await c.req.json<{ title: string }>();
  if (!body.title) return c.json({ error: "title is required" }, 400);

  const result = await createTaskList(body.title);
  if (!result.ok) return c.json({ error: result.message }, 500);

  logActivity({ source: "tasks", summary: `Task list created: ${body.title}`, actionLabel: "PROMPTED", reason: "user created task list" });
  return c.json(result);
});

// Update task list
app.patch("/api/google/tasks/lists/:listId", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);
  if (!isTasksAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const listId = c.req.param("listId");
  const body = await c.req.json<{ title: string }>();
  if (!body.title) return c.json({ error: "title is required" }, 400);

  const result = await updateTaskList(listId, body.title);
  if (!result.ok) return c.json({ error: result.message }, 500);
  return c.json(result);
});

// Delete task list
app.delete("/api/google/tasks/lists/:listId", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);
  if (!isTasksAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const listId = c.req.param("listId");
  const result = await deleteTaskList(listId);
  if (!result.ok) return c.json({ error: result.message }, 500);

  logActivity({ source: "tasks", summary: `Task list deleted: ${listId}`, actionLabel: "PROMPTED", reason: "user deleted task list" });
  return c.json(result);
});

// Create recurring weekly tasks (must be before :listId param routes)
app.post("/api/google/tasks/recurring", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);
  if (!isTasksAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const body = await c.req.json<{
    title: string;
    notes?: string;
    taskListId?: string;
    dayOfWeek: number;
    hour: number;
    minute?: number;
    weeksAhead?: number;
    expectedDayName?: string;
  }>();

  if (!body.title) return c.json({ error: "title is required" }, 400);
  if (body.dayOfWeek === undefined) return c.json({ error: "dayOfWeek is required (0=Sun, 6=Sat)" }, 400);
  if (body.hour === undefined) return c.json({ error: "hour is required (0-23)" }, 400);

  // Temporal validation: cross-check dayOfWeek number against expectedDayName (ts_temporal_mismatch_01)
  if (body.expectedDayName) {
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const actualName = dayNames[body.dayOfWeek];
    const expected = body.expectedDayName.toLowerCase().trim();
    const normalizedExpected = dayNames.find((d) => d === expected || d.startsWith(expected));
    if (normalizedExpected && actualName !== normalizedExpected) {
      const correctIndex = dayNames.indexOf(normalizedExpected);
      return c.json({
        error: `Temporal mismatch: dayOfWeek ${body.dayOfWeek} is ${actualName}, not ${normalizedExpected}`,
        suggestion: `Use dayOfWeek: ${correctIndex} for ${normalizedExpected}`,
        actualDayName: actualName,
      }, 400);
    }
  }

  const result = await createRecurringWeeklyTasks(body);
  if (!result.ok) return c.json({ error: result.message }, 500);

  logActivity({ source: "tasks", summary: result.message, actionLabel: "PROMPTED", reason: "user created recurring tasks" });
  return c.json(result);
});

// List tasks in a list
app.get("/api/google/tasks/:listId", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);
  if (!isTasksAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const listId = c.req.param("listId");
  const showCompleted = c.req.query("showCompleted") === "true";
  const dueMin = c.req.query("dueMin");
  const dueMax = c.req.query("dueMax");

  const result = await listTasks(listId, {
    showCompleted,
    dueMin: dueMin || undefined,
    dueMax: dueMax || undefined,
  });
  if (!result.ok) return c.json({ error: result.message }, 500);
  return c.json(result);
});

// Get single task
app.get("/api/google/tasks/:listId/:taskId", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);
  if (!isTasksAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const listId = c.req.param("listId");
  const taskId = c.req.param("taskId");
  const result = await getGoogleTask(listId, taskId);
  if (!result.ok) return c.json({ error: result.message }, 500);
  return c.json(result);
});

// Create task
app.post("/api/google/tasks/:listId", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);
  if (!isTasksAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const listId = c.req.param("listId");
  const body = await c.req.json<{
    title: string;
    notes?: string;
    due?: string;
    parent?: string;
  }>();
  if (!body.title) return c.json({ error: "title is required" }, 400);

  const result = await createTask(listId, body);
  if (!result.ok) return c.json({ error: result.message }, 500);

  logActivity({ source: "tasks", summary: `Task created: ${body.title}`, actionLabel: "PROMPTED", reason: "user created task" });
  return c.json(result);
});

// Update task
app.patch("/api/google/tasks/:listId/:taskId", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);
  if (!isTasksAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const listId = c.req.param("listId");
  const taskId = c.req.param("taskId");
  const body = await c.req.json<{
    title?: string;
    notes?: string;
    due?: string;
    status?: "needsAction" | "completed";
  }>();

  const result = await updateTask(listId, taskId, body);
  if (!result.ok) return c.json({ error: result.message }, 500);

  logActivity({ source: "tasks", summary: `Task updated: ${taskId}`, actionLabel: "PROMPTED", reason: "user updated task" });
  return c.json(result);
});

// Complete task
app.post("/api/google/tasks/:listId/:taskId/complete", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);
  if (!isTasksAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const listId = c.req.param("listId");
  const taskId = c.req.param("taskId");
  const result = await completeTask(listId, taskId);
  if (!result.ok) return c.json({ error: result.message }, 500);

  logActivity({ source: "tasks", summary: `Task completed: ${taskId}`, actionLabel: "PROMPTED", reason: "user completed task" });
  return c.json(result);
});

// Uncomplete task (reopen)
app.post("/api/google/tasks/:listId/:taskId/uncomplete", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);
  if (!isTasksAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const listId = c.req.param("listId");
  const taskId = c.req.param("taskId");
  const result = await uncompleteTask(listId, taskId);
  if (!result.ok) return c.json({ error: result.message }, 500);
  return c.json(result);
});

// Delete task
app.delete("/api/google/tasks/:listId/:taskId", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);
  if (!isTasksAvailable()) return c.json({ error: "Google not authenticated" }, 400);

  const listId = c.req.param("listId");
  const taskId = c.req.param("taskId");
  const result = await deleteTask(listId, taskId);
  if (!result.ok) return c.json({ error: result.message }, 500);

  logActivity({ source: "tasks", summary: `Task deleted: ${taskId}`, actionLabel: "PROMPTED", reason: "user deleted task" });
  return c.json(result);
});

// --- Prompt (personality) routes ---

// Read personality prompt
app.get("/api/prompt", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  let prompt = "";
  try {
    prompt = await readBrainFile(PERSONALITY_PATH);
  } catch {}
  return c.json({ prompt });
});

// Write personality prompt
app.put("/api/prompt", async (c) => {
  const body = await c.req.json();
  const { sessionId, prompt } = body;
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  await mkdir(join(BRAIN_DIR, "identity"), { recursive: true });
  await writeBrainFile(PERSONALITY_PATH, prompt ?? "");
  return c.json({ ok: true });
});

// --- Model discovery ---

app.get("/api/models", async (c) => {
  const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return c.json({ models: [], error: "Ollama not responding" });
    const data = await res.json() as { models?: Array<{ name: string; size: number; modified_at: string }> };
    const models = (data.models ?? []).map((m) => ({
      name: m.name,
      size: m.size,
      modified: m.modified_at,
    }));
    return c.json({ models });
  } catch {
    return c.json({ models: [], error: "Ollama not reachable" });
  }
});

// --- Sensitivity trainer ---

app.post("/api/sensitive/flag", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.value || typeof body.value !== "string") {
    return c.json({ error: "value required" }, 400);
  }
  const category = (body.category || "FLAGGED").toUpperCase();
  const value = body.value.trim();
  if (value.length < 2) {
    return c.json({ error: "value too short" }, 400);
  }

  if (!activeSensitiveRegistry) {
    return c.json({ error: "registry not initialized" }, 503);
  }

  const isNew = await activeSensitiveRegistry.addTerm(value, category);

  // Append-only exposure log: who saw this, when, which model, which turn
  const exposure: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    category,
    valueLength: value.length,
    model: body.model || null,
    threadId: body.threadId || null,
    turnIndex: body.turnIndex ?? null,
    provider: body.provider || null,
    action: "flag",
    isNew,
  };

  try {
    const logPath = join(BRAIN_DIR, "memory", "sensitivity-flags.jsonl");
    await appendFile(logPath, JSON.stringify(exposure) + "\n", "utf-8");
  } catch {
    // best-effort logging
  }

  return c.json({ ok: true, isNew, category });
});

// --- Settings routes ---

app.get("/api/settings", async (c) => {
  const settings = getSettings();
  return c.json({
    ...settings,
    resolved: {
      provider: resolveProvider(),
      chatModel: resolveChatModel() ?? "(provider default)",
      utilityModel: resolveUtilityModel() ?? "(provider default)",
    },
  });
});

app.put("/api/settings", async (c) => {
  const body = await c.req.json();

  // Handle human name change — updates identity file, session, and paired devices
  if (typeof body.humanName === "string" && body.humanName.trim()) {
    const newName = body.humanName.trim();
    const sid = c.req.query("sessionId") || c.req.header("x-session-id") || "";
    // Update identity file
    try {
      const { updateHumanName } = await import("./auth/identity.js");
      await updateHumanName(newName);
    } catch (err) {
      log.warn("Failed to update human name in identity file");
    }
    // Update current session
    const session = validateSession(sid);
    if (session) (session as any).name = newName;
    // Update all paired devices
    for (const d of pairedDevices.values()) {
      d.humanName = newName;
    }
    await savePairedDevices();
    return c.json({ ok: true, humanName: newName });
  }

  const updated = await updateSettings(body);
  return c.json({
    ...updated,
    resolved: {
      provider: resolveProvider(),
      chatModel: resolveChatModel() ?? "(provider default)",
      utilityModel: resolveUtilityModel() ?? "(provider default)",
    },
  });
});

// --- Integration admin routes ---

app.get("/api/admin/integrations", async (c) => {
  const settings = getSettings();
  const integrations = settings.integrations ?? { enabled: true };
  const status = getIntegrationStatus();
  return c.json({
    enabled: integrations.enabled ?? true,
    services: status,
  });
});

app.post("/api/admin/integrations", async (c) => {
  const body = await c.req.json();
  const patch: { integrations: { enabled?: boolean; services?: Record<string, boolean> } } = {
    integrations: {},
  };
  if (typeof body.enabled === "boolean") {
    patch.integrations.enabled = body.enabled;
  }
  if (body.services && typeof body.services === "object") {
    patch.integrations.services = body.services;
  }
  const updated = await updateSettings(patch as any);

  // Re-hydrate env with new gates — clear integration vars first, then re-hydrate
  const status = getIntegrationStatus();
  rehydrateVaultEnv();
  const credStore = getCredentialStore();
  if (credStore) await credStore.hydrate();

  return c.json({
    enabled: updated.integrations?.enabled ?? true,
    services: status.map((s) => ({
      ...s,
      // Re-check after settings update
      enabled: isIntegrationEnabled(s.service),
    })),
  });
});

// --- Voice routes ---

// Voice status: which voice features are available?
app.get("/api/voice-status", async (c) => {
  return c.json({ tts: isTtsAvailable(), stt: isSttAvailable() });
});

// TTS: synthesize text to WAV audio via Piper
app.get("/api/tts", async (c) => {
  const text = c.req.query("text");
  if (!text) return c.json({ error: "text query param required" }, 400);
  if (!isTtsAvailable()) return c.json({ error: "TTS not available" }, 503);

  const wav = await synthesize(text);
  if (!wav) return c.json({ error: "Synthesis failed" }, 502);

  return new Response(wav, {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(wav.length),
    },
  });
});

// STT: transcribe audio via whisper-server
app.post("/api/stt", async (c) => {
  if (!isSttAvailable()) return c.json({ error: "STT not available" }, 503);

  const body = await c.req.arrayBuffer();
  if (!body || body.byteLength === 0) return c.json({ error: "Audio body required" }, 400);

  const text = await transcribe(Buffer.from(body));
  if (!text) return c.json({ error: "Transcription failed" }, 502);

  return c.json({ text });
});

// --- Avatar routes ---

let latestAvatarVideo: { url: string; timestamp: number } | null = null;

function pushPendingVideo(filename: string): void {
  latestAvatarVideo = {
    url: `/api/avatar/video/${filename}`,
    timestamp: Date.now(),
  };
}

// Avatar status: is MuseTalk sidecar running?
app.get("/api/avatar/status", async (c) => {
  return c.json({ available: isAvatarAvailable() });
});

// Poll for new avatar videos since a given timestamp
app.get("/api/avatar/latest", async (c) => {
  const after = parseInt(c.req.query("after") ?? "0", 10) || 0;
  if (latestAvatarVideo && latestAvatarVideo.timestamp > after) {
    const video = latestAvatarVideo;
    latestAvatarVideo = null; // Clear after serving — play once only
    return c.json({ videos: [video] });
  }
  return c.json({ videos: [] });
});

// Serve cached MP4 video files
app.get("/api/avatar/video/:hash", async (c) => {
  const hash = c.req.param("hash");
  // Sanitize: only allow alphanumeric + .mp4
  if (!/^[a-f0-9]+\.mp4$/.test(hash)) {
    return c.json({ error: "Invalid hash" }, 400);
  }

  const filePath = join(UI_DIR,"avatar", "cache", hash);
  try {
    const mp4 = await readFile(filePath);
    return new Response(mp4, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(mp4.length),
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
});

// Upload a new reference photo, re-prepare, clear cache
app.post("/api/avatar/photo", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  if (!isAvatarAvailable()) return c.json({ error: "Avatar not available" }, 503);

  const body = await c.req.arrayBuffer();
  if (!body || body.byteLength === 0) return c.json({ error: "Photo body required" }, 400);

  const avatarConfig = getAvatarConfig();
  const photoPath = join(process.cwd(), avatarConfig.photoPath);
  await mkdir(join(UI_DIR,"avatar"), { recursive: true });
  await writeFile(photoPath, Buffer.from(body));

  const ok = await preparePhoto(photoPath);
  if (ok) {
    await clearVideoCache();
    latestAvatarVideo = null;
  }

  return c.json({ ok });
});

// History: return stored conversation for UI to render
// Extract text from uploaded files (PDF, DOCX, etc.)
app.post("/api/extract", async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return c.json({ error: "No file provided" }, 400);

    const buffer = Buffer.from(await file.arrayBuffer());
    const name = file.name.toLowerCase();
    let text = "";

    if (name.endsWith(".pdf")) {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      const result = await parser.getText();
      text = result.text;
    } else if (name.endsWith(".docx")) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else {
      // Try as plain text
      text = buffer.toString("utf-8");
    }

    // Truncate to ~50k chars to stay within token limits
    if (text.length > 50000) text = text.slice(0, 50000) + "\n...[truncated]";

    return c.json({ text, filename: file.name });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Extraction failed: ${msg}` }, 500);
  }
});

app.get("/api/history", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);

  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const cs = await getOrCreateChatSession(sessionId, session.name);
  // Always return main history (not active thread's)
  const historySource = cs.activeThreadId ? cs.mainHistory : cs.history;
  const messages = historySource
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));

  return c.json({ messages });
});

// Persist intro message so it appears in all tabs/devices
app.post("/api/history/intro", async (c) => {
  const body = await c.req.json();
  const { sessionId, message } = body;
  if (!sessionId || !message) return c.json({ error: "sessionId and message required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid session" }, 401);
  const cs = await getOrCreateChatSession(sessionId, session.name);
  // Only add if history is empty (first run)
  if (cs.history.length === 0) {
    cs.history.push({ role: "assistant", content: message });
  }
  return c.json({ ok: true });
});

// --- Thread routes ---

app.get("/api/threads", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid session" }, 401);

  const threads = getThreadsForSession(sessionId);
  const list = [...threads.values()]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map(t => ({ id: t.id, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt }));
  return c.json({ threads: list });
});

app.post("/api/threads", async (c) => {
  const body = await c.req.json<{ sessionId?: string; title?: string }>();
  const sessionId = body.sessionId;
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid session" }, 401);

  const threads = getThreadsForSession(sessionId);
  const now = new Date().toISOString();
  const thread: ChatThread = {
    id: generateThreadId(),
    title: body.title || "New chat",
    history: [],
    historySummary: "",
    createdAt: now,
    updatedAt: now,
  };
  threads.set(thread.id, thread);

  // New thread starts blank. Main chat keeps its history.
  // If currently on a thread, save it back first.
  const cs = chatSessions.get(sessionId);
  if (cs && cs.activeThreadId) {
    const prevThread = threads.get(cs.activeThreadId);
    if (prevThread) {
      prevThread.history = cs.history;
      prevThread.historySummary = cs.historySummary;
    }
    cs.history = cs.mainHistory;
    cs.historySummary = cs.mainHistorySummary;
    cs.activeThreadId = null;
  }

  return c.json({ thread: { id: thread.id, title: thread.title, createdAt: thread.createdAt, updatedAt: thread.updatedAt } });
});

app.get("/api/threads/:id/history", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid session" }, 401);

  const threadId = c.req.param("id");
  const threads = getThreadsForSession(sessionId);
  const thread = threads.get(threadId);
  if (!thread) return c.json({ error: "Thread not found" }, 404);

  // If this thread is currently active on cs, its live history is in cs.history
  const cs = chatSessions.get(sessionId);
  const historySource = (cs && cs.activeThreadId === threadId) ? cs.history : thread.history;
  const messages = historySource
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));
  return c.json({ messages });
});

app.patch("/api/threads/:id", async (c) => {
  const body = await c.req.json<{ sessionId?: string; title?: string }>();
  const sessionId = body.sessionId;
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid session" }, 401);

  const threads = getThreadsForSession(sessionId);
  const thread = threads.get(c.req.param("id"));
  if (!thread) return c.json({ error: "Thread not found" }, 404);

  if (body.title) thread.title = body.title;
  thread.updatedAt = new Date().toISOString();
  return c.json({ ok: true });
});

app.delete("/api/threads/:id", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid session" }, 401);

  const threadId = c.req.param("id");
  const threads = getThreadsForSession(sessionId);
  // If deleting the active thread, switch back to main first
  const cs = chatSessions.get(sessionId);
  if (cs && cs.activeThreadId === threadId) {
    switchSessionThread(cs, null, sessionId);
  }
  threads.delete(threadId);
  return c.json({ ok: true });
});

// Activity log: poll for background actions
// SSE stream — real-time activity push
app.get("/api/activity/stream", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const { onActivity } = await import("./activity/log.js");

  return streamSSE(c, async (stream) => {
    // Send heartbeat immediately
    await stream.writeSSE({ data: JSON.stringify({ type: "heartbeat" }) });

    const unsub = onActivity((entry) => {
      stream.writeSSE({
        data: JSON.stringify({ type: "action", action: entry }),
      }).catch(() => {});
    });

    // Heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => {
      stream.writeSSE({ data: JSON.stringify({ type: "heartbeat" }) }).catch(() => {});
    }, 30_000);

    stream.onAbort(() => {
      unsub();
      clearInterval(heartbeat);
    });

    // Keep stream open
    await new Promise(() => {});
  });
});

app.get("/api/activity", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const since = parseInt(c.req.query("since") ?? "0", 10) || 0;
  return c.json({ activities: await getActivities(since) });
});

// Branch: scoped conversation from selected activity entries
app.post("/api/branch", async (c) => {
  const body = await c.req.json();
  const { sessionId, entryIds, question } = body as {
    sessionId?: string;
    entryIds?: number[];
    question?: string;
  };

  if (!sessionId || !entryIds?.length || !question) {
    return c.json({ error: "sessionId, entryIds, and question required" }, 400);
  }

  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const selected = await getActivitiesByIds(entryIds);
  if (selected.length === 0) {
    return c.json({ error: "No matching activity entries" }, 404);
  }

  // Generate a trace for this branch, backreffing the first selected entry
  const branchTraceId = generateTraceId();
  const primaryBackref = selected[0].traceId;

  const contextBlock = selected
    .map((e) => `[${e.timestamp}] [${e.source}] (${e.traceId}) ${e.summary}${e.detail ? " — " + e.detail : ""}`)
    .join("\n");

  // Log the branch as its own activity entry with lineage
  logActivity({
    source: "system",
    summary: `Branch opened: "${question.slice(0, 60)}" (${selected.length} entries)`,
    traceId: branchTraceId,
    backref: primaryBackref,
    actionLabel: "PROMPTED",
    reason: "user opened conversation branch",
  });

  const messages: ContextMessage[] = [
    {
      role: "system",
      content: [
        `You are ${getInstanceName()}, a personal AI agent. ${session.name} selected some entries from your activity stream and wants to discuss them.`,
        `Be concise and insightful. Reference the specific entries when relevant.`,
        ``,
        `--- Selected activity entries ---`,
        contextBlock,
        `--- End entries ---`,
      ].join("\n"),
    },
    { role: "user", content: question },
  ];

  const activeProvider = resolveProvider();
  const activeChatModel = resolveChatModel();
  let stream_fn: ReturnType<typeof pickStreamFn>;
  try {
    stream_fn = pickStreamFn();
  } catch (err) {
    if (err instanceof PrivateModeError) {
      return c.json({ error: err.message }, 503);
    }
    throw err;
  }
  const reqSignal = c.req.raw.signal;

  // Apply membrane to branch messages before they reach the LLM
  const branchMembrane = getActiveMembrane();
  const redactedBranchMessages = messages.map((msg: any) => {
    if (!branchMembrane) return msg;
    const copy = { ...msg };
    if (typeof copy.content === "string") {
      copy.content = branchMembrane.apply(copy.content);
    }
    return copy;
  });

  return streamSSE(c, async (stream) => {
    // Send branch trace metadata so the UI can track lineage
    await stream.writeSSE({
      data: JSON.stringify({
        meta: {
          provider: activeProvider,
          model: activeChatModel ?? (activeProvider === "ollama" ? "llama3.2:3b" : "claude-sonnet-4"),
          traceId: branchTraceId,
          backref: primaryBackref,
        },
      }),
    });

    await new Promise<void>((resolve) => {
      if (reqSignal?.aborted) { resolve(); return; }
      const onAbort = () => resolve();
      reqSignal?.addEventListener("abort", onAbort, { once: true });

      // Token buffer for split-placeholder rehydration
      let tokenBuf = "";
      let totalOutputChars = 0;
      const streamStartMs = performance.now();
      const flushBuf = () => {
        if (!tokenBuf) return;
        const rehydrated = rehydrateResponse(tokenBuf);
        totalOutputChars += rehydrated.length;
        tokenBuf = "";
        stream.writeSSE({ data: JSON.stringify({ token: rehydrated }) }).catch(() => {});
      };

      const streamModel = activeChatModel ?? (activeProvider === "ollama" ? "llama3.2:3b" : "claude-sonnet-4");

      stream_fn({
        messages: redactedBranchMessages,
        model: activeChatModel,
        signal: reqSignal,
        onToken: (token) => {
          tokenBuf += token;
          // Hold if buffer ends with partial placeholder: << ... (no closing >>)
          const lastOpen = tokenBuf.lastIndexOf("<<");
          if (lastOpen !== -1 && tokenBuf.indexOf(">>", lastOpen) === -1) return;
          flushBuf();
        },
        onDone: () => {
          flushBuf(); // flush remainder
          reqSignal?.removeEventListener("abort", onAbort);
          stream.writeSSE({ data: JSON.stringify({ done: true }) }).catch(() => {});
          const durationMs = Math.round(performance.now() - streamStartMs);
          logLlmCall({
            ts: new Date().toISOString(), mode: "stream",
            provider: activeProvider, model: streamModel,
            durationMs, outputTokens: Math.ceil(totalOutputChars / 4), ok: true,
          });
          resolve();
        },
        onError: async (err) => {
          flushBuf();
          reqSignal?.removeEventListener("abort", onAbort);
          let errorMsg = err instanceof LLMError ? err.userMessage : (err.message || "Stream error");
          if (isPrivateMode() && /ECONNREFUSED|fetch failed|network|socket/i.test(errorMsg)) {
            const health = await checkOllamaHealth();
            if (!health.ok) errorMsg += " — Check that Ollama is running. " + health.message;
          }
          const durationMs = Math.round(performance.now() - streamStartMs);
          logLlmCall({
            ts: new Date().toISOString(), mode: "stream",
            provider: activeProvider, model: streamModel,
            durationMs, ok: false, error: errorMsg,
          });
          stream.writeSSE({ data: JSON.stringify({ error: errorMsg }) }).catch(() => {});
          resolve();
        },
      });
    });
  });
});

// --- Agent task REST routes ---

app.post("/api/agents/tasks", async (c) => {
  const body = await c.req.json();
  const { label, prompt, cwd, origin, sessionId: sid, timeoutMs } = body;
  if (!prompt) return c.json({ error: "prompt required" }, 400);
  try {
    const task = await submitTask({
      label: label || prompt.slice(0, 60),
      prompt,
      cwd,
      origin: origin || "user",
      sessionId: sid,
      timeoutMs,
    });
    return c.json(task, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.get("/api/agents/tasks", async (c) => {
  const tasks = await listAgentTasks();
  return c.json({ tasks });
});

app.get("/api/agents/tasks/:id", async (c) => {
  const task = await getTask(c.req.param("id"));
  if (!task) return c.json({ error: "Not found" }, 404);
  return c.json(task);
});

app.get("/api/agents/tasks/:id/output", async (c) => {
  const output = await getTaskOutput(c.req.param("id"));
  return c.json({ output });
});

app.post("/api/agents/tasks/:id/cancel", async (c) => {
  const ok = await cancelTask(c.req.param("id"));
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// --- File lock routes ---

app.get("/api/agents/locks", async (c) => {
  const locks = await listLocks();
  return c.json({ locks });
});

app.post("/api/agents/locks/acquire", async (c) => {
  const body = await c.req.json();
  const { agentId, agentLabel, filePaths, timeoutMs } = body;
  if (!agentId || !filePaths || !Array.isArray(filePaths)) {
    return c.json({ error: "agentId and filePaths[] required" }, 400);
  }
  const result = await acquireLocks(agentId, agentLabel || agentId, filePaths, timeoutMs);
  return c.json(result, result.acquired ? 200 : 409);
});

app.post("/api/agents/locks/release", async (c) => {
  const body = await c.req.json();
  const { agentId, filePath } = body;
  if (!agentId) return c.json({ error: "agentId required" }, 400);

  if (filePath) {
    const ok = await releaseFileLock(agentId, filePath);
    return c.json({ released: ok ? 1 : 0 });
  }
  const count = await releaseLocks(agentId);
  return c.json({ released: count });
});

app.post("/api/agents/locks/force-release", async (c) => {
  const body = await c.req.json();
  const { filePath } = body;
  if (!filePath) return c.json({ error: "filePath required" }, 400);
  const ok = await forceReleaseLock(filePath);
  return c.json({ released: ok });
});

app.post("/api/agents/locks/check", async (c) => {
  const body = await c.req.json();
  const { filePaths } = body;
  if (!filePaths || !Array.isArray(filePaths)) {
    return c.json({ error: "filePaths[] required" }, 400);
  }
  const conflicts = await checkLocks(filePaths);
  return c.json({ locked: conflicts.length > 0, conflicts });
});

app.post("/api/agents/locks/prune", async (_c) => {
  const pruned = await pruneAllStaleLocks();
  return _c.json({ pruned });
});

// --- Self-reported issues (autonomous agent findings) ---

app.get("/api/agents/issues", async (c) => {
  const { listIssues } = await import("./agents/issues.js");
  const issues = await listIssues();
  return c.json({ issues });
});

// --- Agent runtime routes ---

app.get("/api/runtime/status", async (c) => {
  const rt = getRuntime();
  if (!rt) return c.json({ available: false });
  return c.json({
    available: true,
    resources: rt.getResourceSnapshot(),
    states: rt.getStateCounts(),
  });
});

app.get("/api/runtime/instances", async (c) => {
  const rt = getRuntime();
  if (!rt) return c.json({ instances: [] });
  const states = c.req.query("states")?.split(",");
  return c.json({ instances: rt.listInstances(states ? { states } : undefined) });
});

app.get("/api/runtime/instances/:id", async (c) => {
  const rt = getRuntime();
  if (!rt) return c.json({ error: "Runtime not initialized" }, 503);
  const inst = rt.getInstance(c.req.param("id"));
  if (!inst) return c.json({ error: "Not found" }, 404);
  return c.json(inst);
});

app.post("/api/runtime/spawn", async (c) => {
  const rt = getRuntime();
  if (!rt) return c.json({ error: "Runtime not initialized" }, 503);
  const body = await c.req.json();
  const { taskId, label, prompt, cwd, origin, parentId, tags, config, resources } = body;
  if (!prompt) return c.json({ error: "prompt required" }, 400);

  try {
    // Create the underlying AgentTask first
    const { createTask } = await import("./agents/store.js");
    const task = await createTask({
      label: label || prompt.slice(0, 60),
      prompt,
      cwd,
      origin: origin || "user",
    });

    const instance = await rt.spawn({
      taskId: taskId || task.id,
      label: label || prompt.slice(0, 60),
      prompt,
      cwd,
      origin: origin || "user",
      parentId,
      tags,
      config,
      resources,
    });

    // Start a trace span for this agent
    tracer.startSpan({
      operationName: "agent:spawn",
      agentId: instance.id,
      taskId: instance.taskId,
      parentAgentId: parentId,
      attributes: {
        "agent.label": instance.metadata.label,
        "agent.origin": instance.metadata.origin,
      },
    });

    return c.json(instance, 201);
  } catch (err: any) {
    return c.json({ error: err.message, code: err.code }, err.code === "RESOURCE_EXHAUSTED" ? 429 : 500);
  }
});

app.post("/api/runtime/instances/:id/pause", async (c) => {
  const rt = getRuntime();
  if (!rt) return c.json({ error: "Runtime not initialized" }, 503);
  try {
    const inst = await rt.pause(c.req.param("id"), c.req.query("reason"));
    return c.json(inst);
  } catch (err: any) {
    return c.json({ error: err.message, code: err.code }, 400);
  }
});

app.post("/api/runtime/instances/:id/resume", async (c) => {
  const rt = getRuntime();
  if (!rt) return c.json({ error: "Runtime not initialized" }, 503);
  try {
    const inst = await rt.resume(c.req.param("id"));
    return c.json(inst);
  } catch (err: any) {
    return c.json({ error: err.message, code: err.code }, 400);
  }
});

app.post("/api/runtime/instances/:id/terminate", async (c) => {
  const rt = getRuntime();
  if (!rt) return c.json({ error: "Runtime not initialized" }, 503);
  try {
    const inst = await rt.terminate(c.req.param("id"), c.req.query("reason") ?? undefined);
    return c.json(inst);
  } catch (err: any) {
    return c.json({ error: err.message, code: err.code }, 400);
  }
});

app.post("/api/runtime/instances/:id/message", async (c) => {
  const rt = getRuntime();
  if (!rt) return c.json({ error: "Runtime not initialized" }, 503);
  const body = await c.req.json();
  const { to, type, payload } = body;
  if (!to || !type) return c.json({ error: "to and type required" }, 400);
  const msg = rt.sendMessage(c.req.param("id"), to, type, payload);
  return c.json(msg);
});

// --- Instance manager routes ---

app.get("/api/instances/health", async (c) => {
  const im = getInstanceManager();
  if (!im) return c.json({ error: "Instance manager not initialized" }, 503);
  return c.json(im.getHealthSummary());
});

app.get("/api/instances/:id/health", async (c) => {
  const im = getInstanceManager();
  if (!im) return c.json({ error: "Instance manager not initialized" }, 503);
  return c.json(im.assessHealth(c.req.param("id")));
});

app.get("/api/instances/:id/history", async (c) => {
  const im = getInstanceManager();
  if (!im) return c.json({ error: "Instance manager not initialized" }, 503);
  return c.json({ history: im.getHistory(c.req.param("id")) });
});

app.post("/api/instances/:id/restart", async (c) => {
  const im = getInstanceManager();
  if (!im) return c.json({ error: "Instance manager not initialized" }, 503);
  try {
    const inst = await im.restart(c.req.param("id"), c.req.query("reason") ?? undefined);
    return c.json(inst, 201);
  } catch (err: any) {
    return c.json({ error: err.message, code: err.code }, 400);
  }
});

app.post("/api/instances/batch/pause", async (c) => {
  const im = getInstanceManager();
  if (!im) return c.json({ error: "Instance manager not initialized" }, 503);
  const body = await c.req.json();
  const count = await im.pauseMatching(body.filter ?? {}, body.reason);
  return c.json({ paused: count });
});

app.post("/api/instances/batch/terminate", async (c) => {
  const im = getInstanceManager();
  if (!im) return c.json({ error: "Instance manager not initialized" }, 503);
  const body = await c.req.json();
  const count = await im.terminateMatching(body.filter ?? {}, body.reason);
  return c.json({ terminated: count });
});

// --- Agent pool monitoring routes ---

app.get("/api/pool/monitoring", async (c) => {
  const pool = getAgentPool();
  if (!pool) return c.json({ error: "Agent pool not initialized" }, 503);
  return c.json(pool.getMonitoringSnapshot());
});

app.get("/api/pool/resources", async (c) => {
  const pool = getAgentPool();
  if (!pool) return c.json({ error: "Agent pool not initialized" }, 503);
  return c.json(pool.resourceManager.getUtilization());
});

app.get("/api/pool/errors", async (c) => {
  const pool = getAgentPool();
  if (!pool) return c.json({ error: "Agent pool not initialized" }, 503);
  return c.json(pool.errorRecovery.snapshot());
});

app.post("/api/pool/circuits/:name/reset", async (c) => {
  const pool = getAgentPool();
  if (!pool) return c.json({ error: "Agent pool not initialized" }, 503);
  const name = c.req.param("name");
  pool.errorRecovery.resetCircuit(name);
  return c.json({ reset: true, circuit: name });
});

// --- Workflow routes ---

app.get("/api/workflows", async (c) => {
  const engine = getWorkflowEngine();
  if (!engine) return c.json({ error: "Workflow engine not initialized" }, 503);
  const report = engine.getOrchestrator().getReport();
  const definitions = engine.listDefinitions();
  return c.json({ ...report, definitions });
});

app.get("/api/workflows/:id", async (c) => {
  const engine = getWorkflowEngine();
  if (!engine) return c.json({ error: "Workflow engine not initialized" }, 503);
  const wf = engine.getOrchestrator().getWorkflow(c.req.param("id"));
  if (!wf) return c.json({ error: "Workflow not found" }, 404);

  // Serialize Map<string, WorkflowTask> to plain object
  const tasks: Record<string, unknown> = {};
  for (const [key, task] of wf.tasks) {
    tasks[key] = task;
  }
  return c.json({ ...wf, tasks });
});

app.get("/api/workflows/:id/results", async (c) => {
  const engine = getWorkflowEngine();
  if (!engine) return c.json({ error: "Workflow engine not initialized" }, 503);
  try {
    const result = engine.getOrchestrator().getResult(c.req.param("id"));
    return c.json(result);
  } catch {
    return c.json({ error: "Workflow not found" }, 404);
  }
});

// --- Tracing routes ---

app.get("/api/traces", async (c) => {
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const status = c.req.query("status") as "ok" | "error" | "running" | undefined;
  return c.json({ traces: tracer.listTraces({ limit, status }) });
});

app.get("/api/traces/:traceId", async (c) => {
  const detail = tracer.getTraceDetail(c.req.param("traceId"));
  if (!detail) return c.json({ error: "Trace not found" }, 404);
  return c.json(detail);
});

app.get("/api/traces/agent/:agentId", async (c) => {
  const traceId = tracer.getAgentTraceId(c.req.param("agentId"));
  if (!traceId) return c.json({ error: "No trace for agent" }, 404);
  const detail = tracer.getTraceDetail(traceId);
  if (!detail) return c.json({ error: "Trace not found" }, 404);
  return c.json(detail);
});


// --- GitHub routes ---

// GitHub webhooks: receive webhook events from GitHub
// GitHub needs the event type from X-GitHub-Event header, so we use a custom route.
app.post("/api/github/webhooks", async (c) => {
  const eventType = c.req.header("x-github-event") ?? "unknown";
  const signature = c.req.header("x-hub-signature-256") ?? "";
  const rawBody = await c.req.text();
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (secret && signature) {
    if (!verifyWebhookSignature(rawBody, signature, secret)) {
      return c.json({ error: "Invalid signature" }, 401);
    }
  }

  let payload: unknown;
  try { payload = JSON.parse(rawBody); } catch { return c.json({ error: "Invalid JSON" }, 400); }

  const result = await processGitHubWebhook(eventType, payload);
  return c.json(result);
});

// GitHub status
app.get("/api/github/status", async (c) => {
  const status = await getGitHubStatus();
  return c.json(status);
});

// GitHub PR review
app.post("/api/github/pr/review", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const body = await c.req.json();
  const { prNumber, repo, postComment } = body;
  if (!prNumber) return c.json({ error: "prNumber required" }, 400);

  const result = postComment
    ? await reviewAndCommentPR(prNumber, repo)
    : await reviewPullRequest(prNumber, repo);
  if (!result) return c.json({ error: "Failed to review PR" }, 502);
  return c.json(result);
});

// GitHub issue triage
app.post("/api/github/issues/triage", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const body = await c.req.json();
  const { issueNumber, repo, apply } = body;
  if (!issueNumber) return c.json({ error: "issueNumber required" }, 400);

  const result = apply
    ? await triageAndLabelIssue(issueNumber, repo)
    : await triageGitHubIssue(issueNumber, repo);
  if (!result) return c.json({ error: "Failed to triage issue" }, 502);
  return c.json(result);
});

// GitHub batch issue triage
app.post("/api/github/issues/triage/batch", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const body = await c.req.json();
  const { repo, apply } = body;
  const results = await batchTriageIssues(repo, { apply });
  return c.json({ count: results.length, results });
});

// GitHub commit analysis
app.post("/api/github/commits/analyze", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const body = await c.req.json();
  const { sha, repo, count, since } = body;

  if (sha) {
    const result = await analyzeGitHubCommit(sha, repo);
    if (!result) return c.json({ error: "Failed to analyze commit" }, 502);
    return c.json(result);
  }

  const results = await analyzeRecentGitHubCommits(repo, { count, since });
  return c.json({ count: results.length, results });
});

// GitHub repo health
app.get("/api/github/health/:owner/:repo", async (c) => {
  const { owner, repo } = c.req.param();
  const report = await getGitHubRepoHealth(`${owner}/${repo}`);
  if (!report) return c.json({ error: "Failed to generate health report" }, 502);
  return c.json(report);
});

app.get("/api/github/health/:owner/:repo/markdown", async (c) => {
  const { owner, repo } = c.req.param();
  const report = await getGitHubRepoHealth(`${owner}/${repo}`);
  if (!report) return c.json({ error: "Failed to generate health report" }, 502);
  return c.text(formatHealthReport(report));
});

// --- Slack routes ---

// Slack OAuth: initiate "Add to Slack" flow
app.get("/api/slack/auth", async (c) => {
  const redirectUri = `http://localhost:${PORT}/api/slack/callback`;
  const result = getSlackOAuthUrl(redirectUri);
  if (!result.ok) {
    return c.html(`<html><body><h2>Slack not configured</h2><p>${result.message}</p></body></html>`);
  }
  return c.redirect(result.url!);
});

// Slack OAuth callback: exchange code for bot token, store in vault
app.get("/api/slack/callback", async (c) => {
  const code = c.req.query("code");
  const error = c.req.query("error");

  if (error) {
    return c.html(`<html><body><h2>Slack auth denied</h2><p>${error}</p></body></html>`);
  }
  if (!code) {
    return c.html(`<html><body><h2>Missing authorization code</h2></body></html>`);
  }

  const redirectUri = `http://localhost:${PORT}/api/slack/callback`;
  const result = await exchangeSlackCode(code, redirectUri);
  if (!result.ok) {
    return c.html(`<html><body><h2>Token exchange failed</h2><p>${result.message}</p></body></html>`);
  }

  // Get a session key for vault storage
  let vaultKey = [...sessionKeys.values()][0] ?? null;
  if (!vaultKey) {
    const restored = await restoreSession();
    if (restored) {
      vaultKey = restored.sessionKey;
      sessionKeys.set(restored.session.id, restored.sessionKey);
      setEncryptionKey(restored.sessionKey);
      await loadVault(restored.sessionKey);
    }
  }
  if (!vaultKey) {
    return c.html(`<html><body><h2>Session not found</h2><p>Log in first, then try connecting Slack again.</p></body></html>`);
  }

  await setVaultKey("SLACK_BOT_TOKEN", result.botToken!, vaultKey, "Slack Bot Token");
  if (result.teamId) {
    await setVaultKey("SLACK_TEAM_ID", result.teamId, vaultKey, "Slack Team ID");
  }
  logActivity({ source: "slack", summary: `Slack OAuth connected — team: ${result.teamName ?? result.teamId}`, actionLabel: "PROMPTED", reason: "user connected Slack OAuth" });

  return c.html(`<html><body><h2>Slack connected!</h2><p>Team: ${result.teamName ?? "connected"}</p><p>This tab will close automatically.</p><script>if(window.opener){window.opener.postMessage("slack-connected","*")}setTimeout(()=>window.close(),1500)</script></body></html>`);
});

// Slack status: check connection state
app.get("/api/slack/status", async (c) => {
  const client = getSlackClient();
  if (!client) {
    return c.json({
      configured: isSlackConfigured(),
      authenticated: false,
      message: "SLACK_BOT_TOKEN not set",
    });
  }

  const auth = await client.testAuth();
  return c.json({
    configured: isSlackConfigured(),
    authenticated: auth.ok,
    userId: auth.userId,
    teamId: auth.teamId,
    team: auth.team,
    error: auth.ok ? undefined : auth.message,
  });
});

// Slack send: post a message to a channel (requires sessionId)
app.post("/api/slack/send", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const client = getSlackClient();
  if (!client) return c.json({ error: "Slack not available" }, 503);

  const body = await c.req.json<{ channel: string; text: string; thread_ts?: string; blocks?: any[] }>();
  if (!body.channel || !body.text) return c.json({ error: "channel and text required" }, 400);

  const result = await client.sendMessage(body.channel, body.text, {
    thread_ts: body.thread_ts,
    blocks: body.blocks,
  });
  if (!result.ok) return c.json({ error: result.error }, 500);

  logActivity({ source: "slack", summary: `Message sent to ${body.channel}`, actionLabel: "PROMPTED", reason: "user sent Slack message" });
  return c.json(result);
});

// Slack DM: send a direct message to a user (requires sessionId)
app.post("/api/slack/dm", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const client = getSlackClient();
  if (!client) return c.json({ error: "Slack not available" }, 503);

  const body = await c.req.json<{ user: string; text: string; blocks?: any[] }>();
  if (!body.user || !body.text) return c.json({ error: "user and text required" }, 400);

  const result = await client.sendDm(body.user, body.text, { blocks: body.blocks });
  if (!result.ok) return c.json({ error: result.error }, 500);

  logActivity({ source: "slack", summary: `DM sent to ${body.user}`, actionLabel: "PROMPTED", reason: "user sent Slack DM" });
  return c.json(result);
});

// Slack channels: list channels
app.get("/api/slack/channels", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const types = c.req.query("types") || undefined;
  const result = await listChannels({ types });
  if (!result.ok) return c.json({ error: result.message }, 502);
  return c.json({ channels: result.channels });
});

// Slack channel info
app.get("/api/slack/channels/:id", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const result = await getChannelInfo(c.req.param("id"));
  if (!result.ok) return c.json({ error: result.message }, 502);
  return c.json(result.channel);
});

// Slack channel join
app.post("/api/slack/channels/:id/join", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const result = await joinChannel(c.req.param("id"));
  if (!result.ok) return c.json({ error: result.message }, 502);
  return c.json({ ok: true, message: result.message });
});

// Slack channel history
app.get("/api/slack/channels/:id/history", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;
  const result = await getChannelHistory(c.req.param("id"), { limit });
  if (!result.ok) return c.json({ error: result.message }, 502);
  return c.json({ messages: result.messages });
});

// Slack user lookup
app.get("/api/slack/users/:id", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const client = getSlackClient();
  if (!client) return c.json({ error: "Slack not available" }, 503);

  const result = await client.getUser(c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, 502);
  return c.json(result.user);
});

// Slack events: receive Events API webhooks from Slack
// Routed through the generic webhook system with challenge response handling.
app.post("/api/slack/events", createWebhookRoute({
  provider: "slack-events",
  transformResponse: (result, c) => {
    // Slack URL verification: return challenge for initial handshake
    if (result.data?.challenge) {
      return c.json({ challenge: result.data.challenge });
    }
    return null; // default JSON response
  },
}));

// Slack slash commands: routed through the generic webhook system.
// The slack-commands provider handles URL-encoded form → SlackSlashCommand mapping.
app.post("/api/slack/commands", createWebhookRoute({ provider: "slack-commands" }));

// Slack interactions: routed through the generic webhook system.
// The slack-interactions provider handles extracting JSON from the form "payload" field.
app.post("/api/slack/interactions", createWebhookRoute({ provider: "slack-interactions" }));

// --- Resend inbound email ---

// Resend webhook: receive inbound emails via Svix-signed webhooks (direct path).
// Uses generic webhook route with Svix signature verification.
app.post("/api/resend/webhooks", createWebhookRoute({ provider: "resend" }));

// Resend inbox: manually trigger inbox check (pulls from Worker KV).
app.post("/api/resend/check-inbox", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const { forceCheckResendInbox } = await import("./resend/inbox.js");
  const count = await forceCheckResendInbox();
  return c.json({ ok: true, processed: count });
});

// --- WhatsApp routes (Twilio-backed) ---

// WhatsApp status: check if configured
app.get("/api/whatsapp/status", (c) => {
  return c.json({ available: isWhatsAppConfigured() });
});

// WhatsApp webhook: receive incoming messages from Twilio
// Uses centralized verification via verifyWebhookRequest from the webhook registry.
// Custom TwiML response handling prevents use of generic createWebhookRoute.
app.post("/api/twilio/whatsapp", async (c) => {
  const rawBody = await c.req.text();
  const params = parseFormBody(rawBody);

  // Verify via centralized webhook system (handles secret resolution from config)
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const proto = headers["x-forwarded-proto"] ?? "https";
  const host = headers["host"] ?? "localhost";
  const url = `${proto}://${host}/api/twilio/whatsapp`;

  const verification = verifyWebhookRequest("twilio", rawBody, headers, { url, params });
  if (!verification.valid) {
    return c.text(verification.error ?? "Invalid signature", 401);
  }

  const payload = params as unknown as TwilioWhatsAppPayload;

  // Store the inbound message in history + update contacts
  await processIncomingMessage(payload);

  // Extract sender info
  const from = payload.From?.replace(/^whatsapp:/, "") ?? "";
  const body = payload.Body?.trim() ?? "";

  if (!body) {
    c.header("Content-Type", "text/xml");
    return c.body(emptyTwimlResponse());
  }

  // Process through chat pipeline (async — Twilio allows up to 15s for response).
  // The service sends the reply via Twilio API, so we return empty TwiML to avoid
  // duplicate messages. If chat processing fails, we reply inline via TwiML as fallback.
  const result = await handleWhatsAppMessage(from, body, payload.ProfileName);

  c.header("Content-Type", "text/xml");
  if (!result.ok && !result.reply) {
    // Chat failed and no reply was sent — respond inline so user isn't left hanging
    return c.body(replyTwiml("Sorry, I couldn't process that right now. Please try again."));
  }
  return c.body(emptyTwimlResponse());
});

// WhatsApp relay: receive pre-verified messages from the Cloudflare Worker.
// The Worker has already verified Twilio's signature — this endpoint verifies
// the relay's own HMAC-SHA256 signature (RELAY_SECRET).
app.post("/api/relay/whatsapp", async (c) => {
  const rawBody = await c.req.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const relaySecret = process.env.RELAY_SECRET ?? "";
  const verification = verifyRelaySignature(rawBody, headers, relaySecret);
  if (!verification.valid) {
    return c.json({ error: verification.error ?? "Invalid relay signature" }, 401);
  }

  const params = parseFormBody(rawBody);
  const payload = params as unknown as TwilioWhatsAppPayload;

  // Store inbound message + update contacts (same as direct webhook path)
  await processIncomingMessage(payload);

  const from = payload.From?.replace(/^whatsapp:/, "") ?? "";
  const body = payload.Body?.trim() ?? "";

  if (!body) {
    return c.json({ ok: true, message: "Empty message, skipped" });
  }

  // Process through chat pipeline — reply sent via Twilio API
  const result = await handleWhatsAppMessage(from, body, payload.ProfileName);
  return c.json({ ok: result.ok, reply: result.reply, error: result.error });
});

// Resend relay: receive pre-verified inbound emails from the Cloudflare Worker.
// The Worker has already verified Resend's Svix signature and fetched the full
// email body — this endpoint verifies the relay's own HMAC-SHA256 signature.
app.post("/api/relay/resend", async (c) => {
  const rawBody = await c.req.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const relaySecret = process.env.RELAY_SECRET ?? "";
  const verification = verifyRelaySignature(rawBody, headers, relaySecret);
  if (!verification.valid) {
    return c.json({ error: verification.error ?? "Invalid relay signature" }, 401);
  }

  let payload: {
    type: string;
    email_id: string;
    from: string;
    to: string[];
    subject: string;
    message_id: string;
    created_at: string;
    body: string;
    html: string;
  };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  if (payload.type !== "email.received" || !payload.body?.trim()) {
    return c.json({ ok: true, message: "No actionable content" });
  }

  logActivity({
    source: "resend",
    summary: `Inbound email relayed from ${payload.from}: "${payload.subject}"`,
  });

  // Import processInboundEmail dynamically to avoid circular deps at module level
  const { processInboundEmail, sendResendReply } = await import("./resend/webhooks.js");

  const reply = await processInboundEmail({
    from: payload.from,
    subject: payload.subject,
    body: payload.body,
    date: payload.created_at || new Date().toISOString(),
  });

  if (!reply) {
    return c.json({ ok: true, message: "No reply generated" });
  }

  const sent = await sendResendReply({
    to: payload.from,
    subject: payload.subject,
    body: reply,
    inReplyTo: payload.message_id,
  });

  logActivity({
    source: "resend",
    summary: sent
      ? `Replied to ${payload.from}: "${payload.subject}" (${reply.length} chars)`
      : `Failed to reply to ${payload.from}: "${payload.subject}"`,
  });

  return c.json({ ok: true, sent, replyLength: reply.length });
});

// WhatsApp send: send a message (requires sessionId)
app.post("/api/whatsapp/send", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const client = getWhatsAppClient();
  if (!client) return c.json({ error: "WhatsApp not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER to vault." }, 503);

  const body = await c.req.json() as { to: string; message: string };
  if (!body.to || !body.message) return c.json({ error: "to and message required" }, 400);

  const result = await client.sendMessage(body.to, body.message);
  if (!result.ok) return c.json({ error: result.message }, 502);
  return c.json(result);
});

// WhatsApp contacts: list known contacts
app.get("/api/whatsapp/contacts", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const client = getWhatsAppClient();
  if (!client) return c.json({ error: "WhatsApp not configured" }, 503);

  const contacts = await client.listContacts();
  return c.json({ contacts });
});

// WhatsApp history: get message history
app.get("/api/whatsapp/history", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const client = getWhatsAppClient();
  if (!client) return c.json({ error: "WhatsApp not configured" }, 503);

  const phone = c.req.query("phone") || undefined;
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const history = await client.getHistory({ phone, limit });
  return c.json({ messages: history });
});

// --- Board routes (generic — backed by local queue, GitHub Issues, etc.) ---

/** Map BoardIssue[] to card payload with stateType enrichment. */
function issuesToCardPayload(issues: BoardIssue[]) {
  return issues.map((issue) => {
    // Derive stateType from QUEUE_STATES by matching display name
    const qs = QUEUE_STATES.find(
      (s) => s.name.toLowerCase() === issue.state.toLowerCase(),
    );
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state,
      stateType: qs?.type ?? "unstarted",
      priority: issue.priority,
      assignee: issue.assignee,
      project: issue.project,
    };
  });
}

// Board API — gated to board posture
app.use("/api/board/*", requireSurface("pages"));
app.use("/api/ops/*", requireSurface("pages"));
app.use("/api/agents/*", requireSurface("agents"));

// Board status: is a provider configured, and who is the user?
app.get("/api/board/status", async (c) => {
  const board = getBoardProvider();
  if (!board || !board.isAvailable()) return c.json({ available: false });
  const user = await board.getMe();
  return c.json({
    available: true,
    provider: board.name,
    user: user ? { name: user.name, email: user.email } : undefined,
  });
});

// Board teams
app.get("/api/board/teams", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const board = getBoardProvider();
  if (!board || !board.isAvailable()) return c.json({ teams: [] });
  const teams = await board.getTeams();
  return c.json({ teams: teams ?? [] });
});

// List issues (GET with optional filters)
app.get("/api/board/issues", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const board = getBoardProvider();
  if (!board || !board.isAvailable()) return c.json({ issues: [] });
  const teamId = c.req.query("team") || undefined;
  const stateType = c.req.query("state") || undefined;
  const issues = await board.listIssues({ teamId, stateType });
  return c.json({ issues: issues ?? [] });
});

// Create issue
app.post("/api/board/issues", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const board = getBoardProvider();
  if (!board || !board.isAvailable()) return c.json({ error: "No board provider configured" }, 503);
  const body = await c.req.json();
  const { title, description, teamId, priority } = body;
  if (!title) return c.json({ error: "title required" }, 400);

  const issue = await board.createIssue(title, { description, teamId, priority });
  if (!issue) return c.json({ error: "Failed to create issue" }, 502);
  return c.json(issue, 201);
});

// Update issue
app.patch("/api/board/issues/:id", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const board = getBoardProvider();
  if (!board || !board.isAvailable()) return c.json({ error: "No board provider configured" }, 503);
  const id = c.req.param("id");
  const body = await c.req.json();
  const { title, stateId, assigneeId, priority } = body;

  const issue = await board.updateIssue(id, { title, stateId, assigneeId, priority });
  if (!issue) return c.json({ error: "Failed to update issue" }, 502);
  return c.json(issue);
});

// Add comment to issue
app.post("/api/board/issues/:id/comments", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const board = getBoardProvider();
  if (!board || !board.isAvailable()) return c.json({ error: "No board provider configured" }, 503);
  const id = c.req.param("id");
  const body = await c.req.json();
  const { body: commentBody } = body;
  if (!commentBody) return c.json({ error: "body required" }, 400);

  const ok = await board.addComment(id, commentBody);
  return ok ? c.json({ ok: true }) : c.json({ error: "Failed to add comment" }, 502);
});

// --- Exchange routes (queue-specific) ---

app.get("/api/board/issues/:id/exchanges", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const board = getBoardProvider();
  const store = (board as any)?.getStore?.();
  if (!store) return c.json({ error: "Exchange tracking not available" }, 503);
  const id = c.req.param("id");
  const exchanges = await store.getExchanges(id);
  return c.json({ exchanges });
});

app.post("/api/board/issues/:id/exchanges", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  const session = validateSession(sessionId);
  if (!session) return c.json({ error: "Invalid or expired session" }, 401);

  const board = getBoardProvider();
  const store = (board as any)?.getStore?.();
  if (!store) return c.json({ error: "Exchange tracking not available" }, 503);
  const id = c.req.param("id");
  const body = await c.req.json();
  const { author, body: exBody, source } = body;
  if (!author || !exBody) return c.json({ error: "author and body required" }, 400);

  const exchange = await store.addExchange(id, {
    author,
    body: exBody,
    source: source ?? "manual",
  });
  if (exchange) {
    logActivity({ source: "board", summary: `Exchange on issue ${id} from ${author}`, actionLabel: "PROMPTED", reason: "user added board exchange" });
    return c.json({ exchange });
  }
  return c.json({ error: "Task not found or archived" }, 404);
});

// --- Weekly backlog review endpoints (DASH-59) ---

// Get the last backlog review report.
app.get("/api/board/review", (c) => {
  const report = getLastBacklogReview();
  if (!report) return c.json({ available: false, message: "No backlog review generated yet" });
  return c.json({ available: true, running: isBacklogReviewRunning(), report });
});

// Trigger an immediate backlog review (ignores Friday schedule).
app.post("/api/board/review/trigger", async (c) => {
  const report = await triggerBacklogReview();
  if (!report) return c.json({ ok: false, message: "Backlog review timer not started" }, 503);
  return c.json({ ok: true, report });
});

// ---------------------------------------------------------------------------
// Skills routes
// ---------------------------------------------------------------------------

// List all registered skills (metadata only)
app.get("/api/skills", async (c) => {
  const typeFilter = c.req.query("type") as "reference" | "task" | undefined;
  const skills = await _skillRegistry.list();
  const filtered = typeFilter ? skills.filter((s) => s.type === typeFilter) : skills;

  return c.json(filtered.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    description: s.description,
    triggers: s.triggers,
    loads: s.loads,
  })));
});

// Get a single skill (metadata + full content)
app.get("/api/skills/:name", async (c) => {
  const name = c.req.param("name");
  const skill = await _skillRegistry.get(name);
  if (!skill) return c.json({ error: "Skill not found" }, 404);

  const content = await _skillRegistry.getContent(name);

  return c.json({
    ...skill,
    content,
  });
});

// Resolve trigger → matching skill
app.post("/api/skills/resolve", async (c) => {
  const { trigger } = await c.req.json<{ trigger: string }>();
  if (!trigger) return c.json({ error: "trigger is required" }, 400);

  const skill = await _skillRegistry.findByTrigger(trigger);
  if (!skill) return c.json({ error: "No matching skill" }, 404);

  return c.json({
    id: skill.id,
    name: skill.name,
    type: skill.type,
    description: skill.description,
    triggers: skill.triggers,
  });
});

// --- Plugin status routes ---

import { getPluginStatusSummary } from "./plugins/status.js";
import { initPlugins, shutdownPlugins } from "./plugins/index.js";

// --- File management routes ---

import { fileRegistry, computeChecksum } from "./files/registry.js";
import { validateUpload } from "./files/validate.js";
import { slugify } from "./files/validate.js";

app.get("/api/plugins", (c) => {
  return c.json(getPluginStatusSummary());
});

// --- File management routes ---

// Upload file — persist to brain/files/data/, register in JSONL
app.post("/api/files/upload", async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return c.json({ error: "No file provided" }, 400);

    const source = (formData.get("source") as string) || "user-upload";
    const tagsRaw = formData.get("tags") as string;
    const tags = tagsRaw ? tagsRaw.split(",").map(t => t.trim()).filter(Boolean) : [];

    // Folder path from directory upload — preserved as virtual folder tag
    const folder = formData.get("folder") as string | null;
    if (folder) tags.push("folder:" + folder);

    const buffer = Buffer.from(await file.arrayBuffer());
    const maxUploadBytes = 50 * 1024 * 1024; // 50 MB

    // Validate: extension allowlist, magic bytes, size, content scan
    const validation = await validateUpload(buffer, file.name, file.type, maxUploadBytes);
    if (!validation.valid) {
      return c.json({ error: validation.rejected }, 400);
    }

    // Generate storage path: brain/files/data/YYYY-MM-DD/slug_id.ext
    const dateDir = new Date().toISOString().slice(0, 10);
    const slug = slugify(file.name.replace(/\.[^.]+$/, ""));
    const checksum = computeChecksum(buffer);

    // Check for duplicate by checksum
    const existing = await fileRegistry.list({});
    const dup = existing.find(r => r.checksum === checksum && r.status === "active");
    if (dup) {
      return c.json({ file: dup, duplicate: true });
    }

    const storageDir = join(BRAIN_DIR, "files", "data", dateDir);
    await mkdir(storageDir, { recursive: true });

    const storedName = `${slug}_${Date.now()}${validation.detectedExt}`;
    const storagePath = join("files", "data", dateDir, storedName);
    const fullPath = join(BRAIN_DIR, storagePath);

    await writeFile(fullPath, buffer);

    // Extract text preview for searchability
    let textPreview: string | undefined;
    const textExts = new Set([".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".xml", ".log"]);
    if (textExts.has(validation.detectedExt)) {
      textPreview = buffer.toString("utf-8").slice(0, 500);
    } else if (validation.detectedExt === ".pdf") {
      try {
        const { extractPdfText } = await import("./files/extract.js");
        textPreview = (await extractPdfText(buffer)).slice(0, 500);
      } catch { /* PDF extraction optional */ }
    }

    // Register in file registry
    const record = await fileRegistry.register({
      filename: validation.sanitizedName,
      storagePath,
      mimeType: validation.detectedMime || file.type,
      sizeBytes: buffer.length,
      checksum,
      tags,
      source,
      status: "active",
    });

    // Trigger volume replication (on-write event)
    volumeManager.handleEvent({ type: "write", fileId: record.id, volume: "primary" }).catch((err) =>
      log.warn("Volume on-write event failed", { error: String(err) })
    );

    return c.json({ file: record, duplicate: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("File upload failed", { error: msg });
    return c.json({ error: `Upload failed: ${msg}` }, 500);
  }
});

// Download / serve a stored file
app.get("/api/files/:id/download", async (c) => {
  const record = await fileRegistry.get(c.req.param("id"));
  if (!record) return c.json({ error: "File not found" }, 404);

  const fullPath = join(BRAIN_DIR, record.storagePath);
  try {
    const data = await readFile(fullPath);
    return c.newResponse(data, 200, {
      "Content-Type": record.mimeType,
      "Content-Disposition": `inline; filename="${record.filename}"`,
      "Content-Length": String(data.length),
    });
  } catch {
    return c.json({ error: "File data not found on disk" }, 404);
  }
});

// List virtual folders (must be before :id route)
app.get("/api/files/folders", async (c) => {
  const folders = await fileRegistry.getFolders();
  return c.json({ folders });
});

app.get("/api/files", async (c) => {
  const status = c.req.query("status");
  const source = c.req.query("source");
  const q = c.req.query("q");

  if (q) {
    const results = await fileRegistry.search(q);
    return c.json({ files: results, total: results.length });
  }

  const results = await fileRegistry.list({ status, source });
  return c.json({ files: results, total: results.length });
});

app.get("/api/files/:id", async (c) => {
  const record = await fileRegistry.get(c.req.param("id"));
  if (!record) return c.json({ error: "File not found", code: "NOT_FOUND", status: 404 }, 404);
  return c.json(record);
});

app.post("/api/files/:id/archive", async (c) => {
  const result = await fileRegistry.archive(c.req.param("id"));
  if (!result) return c.json({ error: "File not found", code: "NOT_FOUND", status: 404 }, 404);
  return c.json(result);
});

// Update file tags / move to virtual folder
app.put("/api/files/:id", async (c) => {
  const body = await c.req.json();
  const { tags, source, folder } = body as { tags?: string[]; source?: string; folder?: string };
  const id = c.req.param("id");

  const record = await fileRegistry.get(id);
  if (!record) return c.json({ error: "File not found" }, 404);

  // Handle virtual folder: stored as tag "folder:Name"
  let updatedTags = tags ?? [...(record.tags ?? [])];
  if (folder !== undefined) {
    // Remove existing folder tags, add new one
    updatedTags = updatedTags.filter(t => !t.startsWith("folder:"));
    if (folder) updatedTags.push("folder:" + folder);
  }

  const result = await fileRegistry.update(id, { tags: updatedTags, ...(source ? { source } : {}) });
  return c.json(result);
});


// --- Volume management routes ---

app.get("/api/volumes", async (c) => {
  const states = volumeManager.getStates();
  const configs = volumeManager.getConfigs();
  return c.json({
    volumes: configs.map((cfg) => {
      const state = states.find((s) => s.name === cfg.name);
      return { ...cfg, ...state };
    }),
    pendingReplications: volumeManager.getPendingCount(),
  });
});

app.post("/api/volumes/probe", async (c) => {
  const states = await volumeManager.probeAll();
  return c.json({ volumes: states });
});

app.post("/api/volumes/event", async (c) => {
  const event = await c.req.json();
  if (!event?.type) return c.json({ error: "Missing event type" }, 400);
  await volumeManager.handleEvent(event);
  return c.json({ ok: true });
});

// --- Module discovery routes ---

app.get("/api/modules", (c) => {
  const registry = getModuleRegistry();
  if (!registry) return c.json({ modules: [] });
  return c.json({ modules: registry.list().map((m) => m.manifest) });
});

// --- Health probe routes (no auth — K8s compatible) ---

// Liveness probe: is the process alive and responsive?
// Only critical checks (memory, event loop, disk) can make this fail.
app.get("/healthz", async (c) => {
  const result = await health.liveness();
  return c.json(result, result.status === "unhealthy" ? 503 : 200);
});

// Readiness probe: is the server ready to accept traffic?
// All checks must pass — degraded or unhealthy returns 503.
app.get("/readyz", async (c) => {
  const result = await health.check();
  const httpStatus = result.status === "healthy" ? 200 : 503;
  return c.json(result, httpStatus);
});

// Startup probe: has initial bootstrapping completed?
// K8s calls this during startup; once it passes, switches to liveness.
app.get("/startupz", async (c) => {
  const result = await health.check();
  // Accept healthy or degraded during startup (some sidecars may still be loading)
  const httpStatus = result.status === "unhealthy" ? 503 : 200;
  return c.json(result, httpStatus);
});

// Detailed health: full check results with recovery, alert state (for dashboards).
app.get("/api/health", async (c) => {
  const result = await health.check();
  return c.json({
    ...result,
    checks_registered: health.list(),
    recovery: recovery.getState(),
    alerts: alertManager.getSummary(),
  });
});

// --- Alert management routes ---

// Dashboard summary: active alerts, counts by severity, recent history.
app.get("/api/alerts/summary", (c) => {
  return c.json(alertManager.getSummary());
});

// List active alerts (firing + acknowledged).
app.get("/api/alerts", (c) => {
  return c.json({ alerts: alertManager.getActive() });
});

// Get alert history (resolved alerts).
app.get("/api/alerts/history", (c) => {
  return c.json({ alerts: alertManager.getHistory() });
});

// Get a single alert by ID.
app.get("/api/alerts/:id", (c) => {
  const alert = alertManager.getAlert(c.req.param("id"));
  if (!alert) return c.json({ error: "alert not found" }, 404);
  return c.json(alert);
});

// Acknowledge a firing alert.
app.post("/api/alerts/:id/acknowledge", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const by = (body as Record<string, unknown>).by as string | undefined;
  const ok = alertManager.acknowledge(c.req.param("id"), by);
  if (!ok) return c.json({ error: "alert not found or not in firing state" }, 404);
  return c.json({ acknowledged: true });
});

// Manually resolve an alert.
app.post("/api/alerts/:id/resolve", (c) => {
  const ok = alertManager.resolve(c.req.param("id"));
  if (!ok) return c.json({ error: "alert not found" }, 404);
  return c.json({ resolved: true });
});

// Trigger manual evaluation of alert thresholds.
app.post("/api/alerts/evaluate", async (c) => {
  const result = await alertManager.evaluate();
  return c.json(result);
});

// Get current alert configuration.
app.get("/api/alerts/config", (c) => {
  return c.json(alertManager.getConfig());
});

// Update alert thresholds.
app.put("/api/alerts/config/thresholds", async (c) => {
  const body = await c.req.json();
  alertManager.updateThresholds(body.thresholds);
  return c.json({ updated: true });
});

// Update notification preferences.
app.put("/api/alerts/config/notifications", async (c) => {
  const body = await c.req.json();
  alertManager.updateNotifications(body.notifications);
  return c.json({ updated: true });
});

// Enable or disable the alerting system.
app.post("/api/alerts/config/enabled", async (c) => {
  const body = await c.req.json();
  alertManager.setEnabled(body.enabled);
  return c.json({ enabled: body.enabled });
});

// --- Credit monitoring endpoints ---

// Get current credit status.
app.get("/api/credits/status", (c) => {
  const status = getCreditStatus();
  if (!status) return c.json({ available: false, message: "No credit check has run yet" });
  return c.json({ available: true, ...status });
});

// Trigger an immediate credit check.
app.post("/api/credits/check", async (c) => {
  const status = await triggerCreditCheck();
  if (!status) return c.json({ ok: false, message: "Credit monitor not initialized" }, 503);
  return c.json({ ok: true, ...status });
});

// --- Morning briefing endpoints (DASH-44) ---

// Get the last generated morning briefing.
app.get("/api/briefing", (c) => {
  const briefing = getLastBriefing();
  const delivery = getLastDeliveryResult();
  if (!briefing) return c.json({ available: false, message: "No briefing generated yet" });
  return c.json({ available: true, briefing, delivery });
});

// Trigger an immediate briefing (ignores schedule).
app.post("/api/briefing/trigger", async (c) => {
  const result = await triggerBriefing();
  if (!result) return c.json({ ok: false, message: "Briefing timer not started" }, 503);
  return c.json({ ok: true, ...result });
});

// Update briefing configuration at runtime.
app.put("/api/briefing/config", async (c) => {
  const body = await c.req.json() as Partial<BriefingConfig>;
  updateBriefingConfig(body);
  return c.json({ updated: true });
});

// --- Scheduling endpoints ---

// List scheduling blocks with optional filters.
app.get("/api/scheduling/blocks", async (c) => {
  const store = getSchedulingStore();
  if (!store) return c.json({ error: "Scheduling not initialized" }, 503);
  const date = c.req.query("date") || undefined;
  const status = (c.req.query("status") || undefined) as BlockStatus | undefined;
  const type = (c.req.query("type") || undefined) as BlockType | undefined;
  const blocks = await store.list({ date, status, type });
  return c.json({ blocks, count: blocks.length });
});

// Create a scheduling block.
app.post("/api/scheduling/blocks", async (c) => {
  const store = getSchedulingStore();
  if (!store) return c.json({ error: "Scheduling not initialized" }, 503);
  const body = await c.req.json();
  if (!body.type || !body.title) {
    return c.json({ error: "type and title required" }, 400);
  }
  const block = await store.create(body);
  return c.json(block, 201);
});

// Update/transition a scheduling block.
app.patch("/api/scheduling/blocks/:id", async (c) => {
  const store = getSchedulingStore();
  if (!store) return c.json({ error: "Scheduling not initialized" }, 503);
  const id = c.req.param("id");
  const body = await c.req.json();
  const updated = await store.update(id, body);
  if (!updated) return c.json({ error: "Block not found" }, 404);
  return c.json(updated);
});

// Get today's schedule.
app.get("/api/scheduling/today", async (c) => {
  const store = getSchedulingStore();
  if (!store) return c.json({ error: "Scheduling not initialized" }, 503);
  const schedule = await store.getToday();
  return c.json(schedule);
});

// --- Contacts endpoints ---

// List entities with optional type filter.
app.get("/api/contacts/entities", async (c) => {
  const store = getContactStore();
  if (!store) return c.json({ error: "Contacts not initialized" }, 503);
  const type = (c.req.query("type") || undefined) as EntityType | undefined;
  const entities = await store.listEntities(type ? { type } : undefined);
  return c.json({ entities, count: entities.length });
});

// Create an entity.
app.post("/api/contacts/entities", async (c) => {
  const store = getContactStore();
  if (!store) return c.json({ error: "Contacts not initialized" }, 503);
  const body = await c.req.json();
  if (!body.type || !body.name) {
    return c.json({ error: "type and name required" }, 400);
  }
  const entity = await store.createEntity(body);
  return c.json(entity, 201);
});

// Update an entity.
app.patch("/api/contacts/entities/:id", async (c) => {
  const store = getContactStore();
  if (!store) return c.json({ error: "Contacts not initialized" }, 503);
  const id = c.req.param("id");
  const body = await c.req.json();
  const updated = await store.updateEntity(id, body);
  if (!updated) return c.json({ error: "Entity not found" }, 404);
  return c.json(updated);
});

// Get an entity's relationships (all edges where entity is from or to).
app.get("/api/contacts/entities/:id/relationships", async (c) => {
  const store = getContactStore();
  if (!store) return c.json({ error: "Contacts not initialized" }, 503);
  const id = c.req.param("id");
  const edges = await store.getRelationships(id);
  return c.json({ edges, count: edges.length });
});

// Create an edge between entities.
app.post("/api/contacts/edges", async (c) => {
  const store = getContactStore();
  if (!store) return c.json({ error: "Contacts not initialized" }, 503);
  const body = await c.req.json();
  if (!body.from || !body.to || !body.type) {
    return c.json({ error: "from, to, and type required" }, 400);
  }
  const edge = await store.createEdge(body);
  return c.json(edge, 201);
});

// Get subgraph from an entity (BFS traversal).
app.get("/api/contacts/graph/:id", async (c) => {
  const store = getContactStore();
  if (!store) return c.json({ error: "Contacts not initialized" }, 503);
  const id = c.req.param("id");
  const depth = parseInt(c.req.query("depth") ?? "1", 10);
  const graph = await store.getGraph(id, depth);
  return c.json(graph);
});

// --- Credentials endpoints ---

// List credentials (values masked).
app.get("/api/credentials", async (c) => {
  const store = getCredentialStore();
  if (!store) return c.json({ error: "Credentials not initialized" }, 503);
  const type = (c.req.query("type") || undefined) as CredentialType | undefined;
  const search = c.req.query("search") || undefined;
  const creds = await store.list({ type, search });
  const masked = creds.map((cr) => ({ ...cr, value: maskValue(cr.value) }));
  return c.json({ credentials: masked, count: masked.length });
});

// Get single credential (full value for reveal/copy).
app.get("/api/credentials/:id", async (c) => {
  const store = getCredentialStore();
  if (!store) return c.json({ error: "Credentials not initialized" }, 503);
  const cred = await store.get(c.req.param("id"));
  if (!cred) return c.json({ error: "Credential not found" }, 404);
  return c.json(cred);
});

// Create credential.
app.post("/api/credentials", async (c) => {
  const store = getCredentialStore();
  if (!store) return c.json({ error: "Credentials not initialized" }, 503);
  const body = await c.req.json();
  if (!body.name || !body.service || !body.type || !body.value) {
    return c.json({ error: "name, service, type, and value required" }, 400);
  }
  const cred = await store.create(body);
  // Hydrate immediately if envVar set
  if (cred.envVar && cred.value) {
    process.env[cred.envVar] = cred.value;
  }
  return c.json(cred, 201);
});

// Update credential.
app.patch("/api/credentials/:id", async (c) => {
  const store = getCredentialStore();
  if (!store) return c.json({ error: "Credentials not initialized" }, 503);
  const id = c.req.param("id");
  const body = await c.req.json();
  const updated = await store.update(id, body);
  if (!updated) return c.json({ error: "Credential not found" }, 404);
  // Re-hydrate if envVar changed
  if (updated.envVar && updated.value && updated.status === "active") {
    process.env[updated.envVar] = updated.value;
  }
  return c.json(updated);
});

// Archive credential (soft-delete).
app.delete("/api/credentials/:id", async (c) => {
  const store = getCredentialStore();
  if (!store) return c.json({ error: "Credentials not initialized" }, 503);
  const id = c.req.param("id");
  const archived = await store.archive(id);
  if (!archived) return c.json({ error: "Credential not found" }, 404);
  // Remove from process.env
  if (archived.envVar) {
    delete process.env[archived.envVar];
  }
  return c.json(archived);
});

// Migrate vault keys → credential store.
app.post("/api/credentials/migrate-vault", async (c) => {
  const store = getCredentialStore();
  if (!store) return c.json({ error: "Credentials not initialized" }, 503);

  const vaultEntries = getVaultEntries();
  if (vaultEntries.length === 0) {
    return c.json({ migrated: 0, message: "No vault keys to migrate" });
  }

  // Check existing credentials to avoid duplicates (match on envVar)
  const existing = await store.list();
  const existingEnvVars = new Set(existing.map((c) => c.envVar).filter(Boolean));

  let migrated = 0;
  const skipped: string[] = [];

  for (const entry of vaultEntries) {
    if (existingEnvVars.has(entry.name)) {
      skipped.push(entry.name);
      continue;
    }

    // Infer service name from key name (e.g. OPENROUTER_API_KEY → openrouter)
    const service = inferService(entry.name);
    const type = inferType(entry.name);

    await store.create({
      name: entry.label || entry.name,
      service,
      type,
      value: entry.value,
      envVar: entry.name,
      notes: entry.label ? `Migrated from vault (${entry.name})` : "Migrated from vault",
      tags: ["migrated"],
    });
    migrated++;
  }

  return c.json({ migrated, skipped, total: vaultEntries.length });
});

function inferService(keyName: string): string {
  // Strip common suffixes to get service name
  const cleaned = keyName
    .replace(/_API_KEY$/i, "")
    .replace(/_SECRET$/i, "")
    .replace(/_TOKEN$/i, "")
    .replace(/_KEY$/i, "")
    .replace(/_SID$/i, "")
    .replace(/_ID$/i, "")
    .toLowerCase()
    .replace(/_/g, "-");
  return cleaned || keyName.toLowerCase();
}

function inferType(keyName: string): "api_key" | "token" | "oauth" | "password" | "secret" {
  const upper = keyName.toUpperCase();
  if (upper.includes("API_KEY")) return "api_key";
  if (upper.includes("TOKEN")) return "token";
  if (upper.includes("OAUTH") || upper.includes("REFRESH")) return "oauth";
  if (upper.includes("PASSWORD") || upper.includes("PASS")) return "password";
  return "secret";
}

// --- Training endpoints ---

// Get training progress (skill trees, signal, nudge status).
app.get("/api/training/progress", (c) => {
  return c.json(getTrainingProgress());
});

// --- Trace Insights endpoints ---

// Get discovered trace insights and last run summary.
app.get("/api/insights", (c) => {
  return c.json({ insights: getInsights(), lastRun: getLastInsightRun() });
});

// Trigger an immediate insight analysis run.
app.post("/api/insights/trigger", async (c) => {
  const result = await triggerInsightAnalysis();
  if (!result) return c.json({ ok: false, message: "Timer not started" }, 503);
  return c.json({ ok: true, ...result });
});

// --- Open Loop Protocol endpoints ---

// List open loops (optional ?state= filter).
app.get("/api/open-loops", async (c) => {
  const state = c.req.query("state");
  const loops = state
    ? await loadLoopsByState(state as any)
    : await loadLoops();
  return c.json({ loops, count: loops.length });
});

// List all triads.
app.get("/api/open-loops/triads", async (c) => {
  const triads = await loadTriads();
  return c.json({ triads, count: triads.length });
});

// Recent resonance matches + last scan summary.
app.get("/api/open-loops/resonances", (c) => {
  return c.json({ resonances: getResonances(), lastRun: getLastScanRun() });
});

// Trigger an immediate scan.
app.post("/api/open-loops/scan", async (c) => {
  const result = await triggerOpenLoopScan();
  if (!result) return c.json({ ok: false, message: "Scan returned no result" }, 503);
  return c.json({ ok: true, ...result });
});

// Recent resolution matches + last resolution scan summary.
app.get("/api/open-loops/resolutions", (c) => {
  return c.json({ resolutions: getResolutions(), lastRun: getLastResolutionScanRun() });
});

// Trigger an immediate resolution scan.
app.post("/api/open-loops/resolution-scan", async (c) => {
  const result = await triggerResolutionScan();
  if (!result) return c.json({ ok: false, message: "Resolution scan returned no result" }, 503);
  return c.json({ ok: true, ...result });
});

// Manually resolve a loop.
app.put("/api/open-loops/:id/resolve", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as { resolvedBy?: string };
  const updated = await transitionLoop(id, "resonant", body.resolvedBy);
  if (!updated) return c.json({ error: "Loop not found" }, 404);
  return c.json({ ok: true, loop: updated });
});

// Trigger fold-back for a session.
app.post("/api/open-loops/foldback", async (c) => {
  const body = await c.req.json() as { sessionId?: string };
  if (!body.sessionId) return c.json({ error: "sessionId required" }, 400);

  const cs = chatSessions.get(body.sessionId);
  if (!cs) return c.json({ error: "Session not found" }, 404);

  const result = await foldBack({
    history: cs.history,
    historySummary: cs.historySummary || undefined,
    sourceTraceId: generateTraceId(),
    sessionId: body.sessionId,
  });

  if (!result) return c.json({ ok: false, message: "Conversation too trivial for fold-back" });
  return c.json({ ok: true, triad: result.triad, openLoops: result.openLoops });
});

// --- Prometheus metrics endpoint (no auth — local-only scraping) ---

// Prometheus text exposition format at /metrics.
app.get("/metrics", (c) => {
  const body = collectPrometheus();
  return c.text(body, 200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
});

// --- Metrics routes (no auth — local-only diagnostics) ---

// Dashboard snapshot: aggregated system, HTTP, agent, and alert data.
app.get("/api/metrics/dashboard", async (c) => {
  const dashboard = await buildDashboard(metricsStore);
  return c.json(dashboard);
});

// Query raw metric points by name and time range.
app.get("/api/metrics", async (c) => {
  const name = c.req.query("name") || undefined;
  const since = c.req.query("since") || undefined;
  const until = c.req.query("until") || undefined;
  const limit = parseInt(c.req.query("limit") ?? "0", 10) || undefined;
  const points = await metricsStore.query({ name, since, until, limit });
  return c.json({ points, count: points.length });
});

// Summarize a named metric over a window.
app.get("/api/metrics/summary", async (c) => {
  const name = c.req.query("name");
  if (!name) return c.json({ error: "name parameter required" }, 400);
  const windowMs = parseInt(c.req.query("window") ?? "60000", 10);
  const summary = await metricsStore.summarize(name, { windowMs });
  return c.json({ summary });
});

// List distinct metric names in the store.
app.get("/api/metrics/names", async (c) => {
  const names = await metricsStore.metricNames();
  return c.json({ names });
});

// Time-series bucketed data for a named metric.
app.get("/api/metrics/series", async (c) => {
  const name = c.req.query("name");
  if (!name) return c.json({ error: "name parameter required" }, 400);
  const now = Date.now();
  const since = c.req.query("since") ?? new Date(now - 60 * 60 * 1000).toISOString();
  const until = c.req.query("until") ?? new Date(now).toISOString();
  const bucketCount = parseInt(c.req.query("buckets") ?? "60", 10);
  const points = await metricsStore.query({ name, since, until });
  const sinceMs = new Date(since).getTime();
  const untilMs = new Date(until).getTime();
  const intervalMs = (untilMs - sinceMs) / bucketCount;
  const buckets: { time: string; count: number; avg: number; min: number; max: number }[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const bucketStart = sinceMs + i * intervalMs;
    const bucketEnd = bucketStart + intervalMs;
    const bucketStartISO = new Date(bucketStart).toISOString();
    const bucketEndISO = new Date(bucketEnd).toISOString();
    const inBucket = points.filter((p) => {
      const t = p.timestamp;
      return t >= bucketStartISO && (i === bucketCount - 1 ? t <= bucketEndISO : t < bucketEndISO);
    });
    if (inBucket.length === 0) {
      buckets.push({ time: bucketStartISO, count: 0, avg: 0, min: 0, max: 0 });
    } else {
      const values = inBucket.map((p) => p.value);
      const sum = values.reduce((a, v) => a + v, 0);
      buckets.push({
        time: bucketStartISO,
        count: inBucket.length,
        avg: sum / inBucket.length,
        min: Math.min(...values),
        max: Math.max(...values),
      });
    }
  }
  return c.json({ name, since, until, buckets, interval: intervalMs });
});

// Export raw metric points as JSON or CSV.
app.get("/api/metrics/export", async (c) => {
  const now = Date.now();
  const since = c.req.query("since") ?? new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const until = c.req.query("until") ?? new Date(now).toISOString();
  const name = c.req.query("name") || undefined;
  const format = c.req.query("format") ?? "json";
  const points = await metricsStore.query({ name, since, until });
  if (format === "csv") {
    const header = "timestamp,name,value,unit,tags";
    const rows = points.map((p) => {
      const tags = p.tags ? JSON.stringify(p.tags).replace(/"/g, '""') : "";
      return `${p.timestamp},${p.name},${p.value},${p.unit ?? ""},\"${tags}\"`;
    });
    const csv = [header, ...rows].join("\n");
    c.header("Content-Type", "text/csv");
    c.header("Content-Disposition", 'attachment; filename="metrics-export.csv"');
    return c.body(csv);
  }
  return c.json({ points, count: points.length });
});

// Evaluate alert thresholds and return any fired alerts.
app.post("/api/metrics/alerts/evaluate", async (c) => {
  const alerts = await evaluateAlerts(metricsStore);
  return c.json({ alerts, count: alerts.length });
});

// Force metrics rotation (drop old data).
app.post("/api/metrics/rotate", async (c) => {
  const result = await metricsStore.rotate();
  return c.json(result);
});

// Firewall period stats: autonomous actions, dedup blocks, filter efficiency.
app.get("/api/metrics/firewall", async (c) => {
  const since = c.req.query("since") ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const until = c.req.query("until") ?? undefined;
  const stats = await generatePeriodStats(metricsStore, since, until);
  return c.json(stats);
});

// Firewall before/after comparison report (markdown).
app.get("/api/metrics/firewall/compare", async (c) => {
  const beforeSince = c.req.query("before_since");
  const beforeUntil = c.req.query("before_until");
  const afterSince = c.req.query("after_since");
  const afterUntil = c.req.query("after_until");
  if (!beforeSince || !beforeUntil || !afterSince) {
    return c.json({ error: "Required: before_since, before_until, after_since" }, 400);
  }
  const report = await generateComparisonReport(
    metricsStore,
    { since: beforeSince, until: beforeUntil },
    { since: afterSince, until: afterUntil ?? new Date().toISOString() },
  );
  return c.text(report);
});

// LLM cache diagnostics.
app.get("/api/cache", (c) => {
  return c.json(getCacheDiagnostics());
});

// --- Help page routes (no auth — knowledge exchange for other AIs/humans) ---

app.get("/help", async (c) => {
  const html = await serveHtmlTemplate(join(UI_DIR,"help.html"));
  return c.html(html);
});

app.get("/api/help/context", async (c) => {
  const result = await health.check();
  const activities = await getActivities();
  const last20 = activities.slice(-20).reverse();

  let changelog = "";
  try {
    changelog = await readBrainFile(join(BRAIN_DIR, "operations", "changelog.md"));
  } catch {
    // changelog file missing — skip
  }

  return c.json({
    health: { status: result.status, uptime: result.uptime },
    provider: resolveProvider(),
    model: resolveChatModel() ?? "auto",
    sidecars: {
      search: isSearchAvailable(),
      tts: isTtsAvailable(),
      stt: isSttAvailable(),
      avatar: isAvatarAvailable(),
    },
    integrations: {
      google: isGoogleAuthenticated(),
      slack: isSlackConfigured(),
      whatsapp: isWhatsAppConfigured(),
    },
    recentActivity: last20.map((e) => ({
      timestamp: e.timestamp,
      source: e.source,
      summary: e.summary,
      traceId: e.traceId,
      backref: e.backref ?? null,
    })),
    insights: getInsights().slice(-10),
    changelog,
  });
});

// --- Ops dashboard routes (posture-gated: board level) ---

// Board-level pages — only assembled when user has shown intent for full visibility
app.get("/observatory", requireSurface("pages"), async (c) => {
  const html = await serveHtmlTemplate(join(UI_DIR,"observatory.html"));
  return c.html(html);
});

app.get("/ops", requireSurface("pages"), async (c) => {
  const html = await serveHtmlTemplate(join(UI_DIR,"ops.html"));
  return c.html(html);
});

app.get("/board", requireSurface("pages"), async (c) => {
  const html = await serveHtmlTemplate(join(UI_DIR,"board.html"));
  return c.html(html);
});

app.get("/library", requireSurface("pages"), async (c) => {
  const html = await serveHtmlTemplate(join(UI_DIR,"library.html"));
  return c.html(html);
});

app.get("/browser", requireSurface("pages"), async (c) => {
  const html = await serveHtmlTemplate(join(UI_DIR,"browser.html"));
  return c.html(html);
});

// Registry is always available — it's the entry point
app.get("/registry", async (c) => {
  const html = await serveHtmlTemplate(join(UI_DIR,"registry.html"));
  return c.html(html);
});

// Serve roadmap.html (strategic roadmap & rearview)
app.get("/roadmap", async (c) => {
  const html = await serveHtmlTemplate(join(UI_DIR,"roadmap.html"));
  return c.html(html);
});

// Roadmap API — parse brain/operations/roadmap.yaml and return as JSON
app.get("/api/roadmap", async (c) => {
  try {
    const raw = await readBrainFile(join(BRAIN_DIR, "operations", "roadmap.yaml"));
    const parsed = parseRoadmapYaml(raw);
    return c.json(parsed);
  } catch (err) {
    return c.json({ error: "Failed to load roadmap.yaml" }, 500);
  }
});

// Roadmap rearview API — recent git commits grouped by hour
// Git is an optional signal source — returns empty when unavailable.
app.get("/api/roadmap/recent", async (c) => {
  const hours = parseInt(c.req.query("hours") || "24", 10);
  if (isNaN(hours) || hours < 1 || hours > 168) {
    return c.json({ error: "hours must be between 1 and 168" }, 400);
  }

  try {
    const { gitAvailable } = await import("./utils/git.js");
    if (!gitAvailable()) {
      return c.json({ commits: [], groups: [], hours, total: 0 });
    }
    const { execSync } = await import("child_process");
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const raw = execSync(
      `git log --after="${since}" --format="%H||%an||%ai||%s" --no-merges`,
      { cwd: process.cwd(), encoding: "utf-8", timeout: 10000 }
    ).trim();

    if (!raw) return c.json({ commits: [], groups: [], hours, total: 0 });

    const commits = raw.split("\n").map((line) => {
      const [hash, author, date, ...msgParts] = line.split("||");
      const message = msgParts.join("||");
      const isAuto = /^\[(?:dash|agent)\]/i.test(message);
      return {
        hash: hash.slice(0, 8),
        fullHash: hash,
        author,
        date,
        message,
        autonomous: isAuto,
        tag: isAuto ? "dash" : "human",
      };
    });

    // Group by hour bucket
    const groups: Record<string, typeof commits> = {};
    for (const commit of commits) {
      const d = new Date(commit.date);
      const hourKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:00`;
      if (!groups[hourKey]) groups[hourKey] = [];
      groups[hourKey].push(commit);
    }

    const grouped = Object.entries(groups)
      .map(([hour, items]) => ({ hour, commits: items, count: items.length }))
      .sort((a, b) => b.hour.localeCompare(a.hour));

    return c.json({ commits, groups: grouped, hours, total: commits.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "Failed to read git log: " + msg }, 500);
  }
});

// Serve personal.html (placeholder — instances populate this)
app.get("/personal", async (c) => {
  try {
    const html = await serveHtmlTemplate(join(UI_DIR,"personal.html"));
    return c.html(html);
  } catch {
    return c.text("Personal page not configured for this instance.", 404);
  }
});

// Serve life.html (placeholder — instances populate this)
app.get("/life", async (c) => {
  try {
    const html = await serveHtmlTemplate(join(UI_DIR,"life.html"));
    return c.html(html);
  } catch {
    return c.text("Life page not configured for this instance.", 404);
  }
});

// Browse API — fetch a URL and return what the agent sees (stripped text)
app.get("/api/browse", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "url parameter required" }, 400);

  try {
    new URL(url);
  } catch {
    return c.json({ error: "Invalid URL" }, 400);
  }

  const result = await browseUrl(url);
  if (!result) {
    return c.json({ error: "Failed to fetch URL — timeout, non-HTML content, or network error" }, 502);
  }
  return c.json(result);
});

// Share Core — send install invite via email
app.post("/api/share", async (c) => {
  const { email, note } = await c.req.json<{ email: string; note?: string }>();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "Valid email address required" }, 400);
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return c.json({ error: "Email not configured. Set up Resend API key in Settings > Vault." }, 500);
  }

  const { randomBytes } = await import("node:crypto");
  const shareId = `share_${Date.now()}_${randomBytes(4).toString("hex")}`;

  const emailHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; color: #e4e4e7; background: #0e0e10;">
      <h1 style="font-size: 20px; font-weight: 600; margin: 0 0 16px;">You've been invited to try Core</h1>
      <p style="color: #8b8b94; font-size: 14px; line-height: 1.6; margin: 0 0 20px;">
        Core is a file-based personal operating system for an AI agent — your own local brain that learns, remembers, and works for you.
      </p>
      ${note ? `<div style="background: #18181b; border: 1px solid #2e2e33; border-radius: 8px; padding: 14px 16px; margin: 0 0 20px; font-size: 13px; color: #e4e4e7;"><strong>Note from sender:</strong> ${note.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>` : ""}
      <h2 style="font-size: 14px; font-weight: 600; margin: 0 0 10px;">Install</h2>
      <pre style="background: #18181b; border: 1px solid #2e2e33; border-radius: 8px; padding: 14px 16px; font-size: 13px; color: #a78bfa; overflow-x: auto; margin: 0 0 20px;">
# Clone the repo
git clone https://github.com/yourusername/core.git
cd core && npm install && npm run build
npm run chat</pre>
      <h2 style="font-size: 14px; font-weight: 600; margin: 0 0 10px;">Your Connection Key</h2>
      <p style="color: #8b8b94; font-size: 13px; line-height: 1.5; margin: 0 0 8px;">
        Paste this key during first-run setup to connect with the person who invited you:
      </p>
      <pre style="background: #18181b; border: 1px solid #2e2e33; border-radius: 8px; padding: 14px 16px; font-size: 14px; color: #22c55e; letter-spacing: 0.5px; margin: 0 0 20px;">${shareId}</pre>
      <p style="color: #8b8b94; font-size: 12px; margin: 0;">
        This creates a connection record — it does <strong>not</strong> enable mesh/hive-mind until you explicitly approve it in network settings.
      </p>
    </div>
  `.trim();

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${getInstanceName()} <${getAlertEmailFrom()}>`,
        to: [email],
        subject: "You've been invited to try Core",
        html: emailHtml,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      log.error("Share email failed", { status: res.status, body: err });
      return c.json({ error: "Failed to send email" }, 500);
    }

    // Append to shares JSONL
    const record = {
      id: shareId,
      email,
      note: note || undefined,
      sharedAt: new Date().toISOString(),
      status: "sent",
    };
    const sharesPath = join(BRAIN_DIR, "ops", "shares.jsonl");
    await appendBrainLine(sharesPath, JSON.stringify(record));

    log.info("Share invite sent", { email, shareId });
    return c.json({ ok: true, shareId });
  } catch (err) {
    log.error("Share email error", { error: err instanceof Error ? err.message : String(err) });
    return c.json({ error: "Failed to send email" }, 500);
  }
});

// Mount brain shadow API routes (more specific prefix, before /api/library)
app.route("/api/library/brain", brainShadowRoutes);

// Mount library API routes
app.route("/api/library", libraryRoutes);
app.route("/api/calendar", calendarRoutes);

// Health: aggregate system health snapshot
app.get("/api/ops/health", async (c) => {
  const settings = getSettings();
  const uptime = process.uptime();
  const mem = process.memoryUsage();
  const board = getBoardProvider();
  const agents = await listAgentTasks();
  const activities = await getActivities();

  const running = agents.filter((t) => t.status === "running").length;
  const failed = agents.filter((t) => t.status === "failed").length;

  return c.json({
    uptime: Math.round(uptime),
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
    provider: resolveProvider(),
    airplaneMode: settings.airplaneMode,
    privateMode: settings.privateMode,
    models: settings.models,
    sidecars: {
      search: isSidecarAvailable(),
      tts: isTtsAvailable(),
      stt: isSttAvailable(),
      avatar: isAvatarAvailable(),
    },
    agents: {
      total: agents.length,
      running,
      failed,
      completed: agents.filter((t) => t.status === "completed").length,
    },
    board: board ? { name: board.name, available: true } : { name: "none", available: false },
    activityCount: activities.length,
    lastActivity: activities.length > 0 ? activities[activities.length - 1] : null,
  });
});

// Sidecars: detailed sidecar status with config
app.get("/api/ops/sidecars", async (c) => {
  const settings = getSettings();
  return c.json({
    search: {
      available: isSidecarAvailable(),
      perplexity: !!process.env.PERPLEXITY_API_KEY,
      port: parseInt(resolveEnv("SEARCH_PORT") ?? "3578", 10),
    },
    tts: {
      available: isTtsAvailable(),
      enabled: settings.tts.enabled,
      port: settings.tts.port,
      voice: settings.tts.voice,
      autoPlay: settings.tts.autoPlay,
    },
    stt: {
      available: isSttAvailable(),
      enabled: settings.stt.enabled,
      port: settings.stt.port,
      model: settings.stt.model,
    },
    avatar: {
      available: isAvatarAvailable(),
      enabled: settings.avatar.enabled,
      port: settings.avatar.port,
    },
  });
});

// Restart a sidecar by name
app.post("/api/ops/sidecars/:name/restart", async (c) => {
  const name = c.req.param("name");
  let ok = false;
  switch (name) {
    case "search":
      stopSidecar();
      ok = await startSidecar();
      break;
    case "tts":
      stopTtsSidecar();
      ok = await startTtsSidecar();
      break;
    case "stt":
      stopSttSidecar();
      ok = await startSttSidecar();
      break;
    case "avatar":
      stopAvatarSidecar();
      ok = await startAvatarSidecar();
      break;
    default:
      return c.json({ error: `Unknown sidecar: ${name}` }, 400);
  }
  logActivity({ source: "system", summary: `Restarted sidecar: ${name} (${ok ? "up" : "failed"})` });
  return c.json({ name, available: ok });
});

// Agent tasks summary for ops view
app.get("/api/ops/agents", async (c) => {
  const tasks = await listAgentTasks();
  return c.json({
    tasks: tasks.map((t) => ({
      id: t.id,
      label: t.label,
      status: t.status,
      origin: t.origin,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      exitCode: t.exitCode,
      error: t.error,
      pid: t.pid,
    })),
  });
});

// Settings overview (read-only ops view)
app.get("/api/ops/settings", async (c) => {
  const settings = getSettings();
  return c.json(settings);
});

// Activity log (no auth for ops — full stream)
app.get("/api/ops/activity", async (c) => {
  const since = parseInt(c.req.query("since") ?? "0", 10) || 0;
  const limit = parseInt(c.req.query("limit") ?? "100", 10);
  const all = await getActivities(since);
  return c.json({ activities: all.slice(-limit), total: all.length });
});

// Health checks: detailed per-check results + recovery state (for ops dashboard)
app.get("/api/ops/health-checks", async (c) => {
  const result = await health.check();
  return c.json({
    status: result.status,
    uptime: result.uptime,
    timestamp: result.timestamp,
    checks: result.checks,
    registered: health.list(),
    recovery: recovery.getState(),
  });
});

// Agent runtime: instance health, resource utilization, state counts
app.get("/api/ops/runtime", async (c) => {
  const mgr = getInstanceManager();
  if (!mgr) {
    return c.json({ initialized: false, summary: null, stateCounts: {} });
  }
  const summary = mgr.getHealthSummary();
  const stateCounts = mgr.getStateCounts();
  return c.json({ initialized: true, summary, stateCounts });
});

// --- Escalation: projectless task notification ---
// Missing project is housekeeping, not an emergency — notification + email only.
// Phone calls are reserved for P0 emergencies with imminent deadlines.
async function escalateProjectlessTask(identifier: string, title: string): Promise<void> {
  const msg = `New board item ${identifier} needs project assignment — "${title}"`;
  pushNotification({ timestamp: new Date().toISOString(), source: "board", message: msg });
  logActivity({ source: "board", summary: msg, actionLabel: "AUTONOMOUS", reason: "task created without project" });
}

// --- Queue endpoints for board page (no auth — local-only dashboard) ---

// List all queue tasks (raw QueueTask objects), optionally filtered by project
app.get("/api/ops/queue", async (c) => {
  const board = getBoardProvider() as any;
  const store = board?.getStore?.();
  if (!store) return c.json({ tasks: [] });
  let tasks = await store.list();
  const projectFilter = c.req.query("project");
  if (projectFilter) {
    tasks = tasks.filter((t: any) => t.project === projectFilter);
  }
  return c.json({ tasks });
});

// Update a queue task's state (drag-drop from board page)
app.patch("/api/ops/queue/:id", async (c) => {
  const board = getBoardProvider() as any;
  const store = board?.getStore?.();
  if (!store) return c.json({ error: "No queue store available" }, 503);

  const id = c.req.param("id");
  const body = await c.req.json();
  const updated = await store.update(id, body);
  if (!updated) return c.json({ error: "Task not found" }, 404);
  return c.json(updated);
});

// --- Project endpoints ---

app.get("/api/ops/projects", async (c) => {
  const board = getBoardProvider() as any;
  const projectStore = board?.getProjectStore?.();
  if (!projectStore) return c.json({ projects: [] });
  const projects = await projectStore.list();
  return c.json({ projects });
});

app.post("/api/ops/projects", async (c) => {
  const board = getBoardProvider() as any;
  const projectStore = board?.getProjectStore?.();
  if (!projectStore) return c.json({ error: "No project store available" }, 503);
  const body = await c.req.json();
  const { name, prefix, description } = body;
  if (!name || !prefix) return c.json({ error: "name and prefix required" }, 400);
  try {
    const project = await projectStore.create({ name, prefix, description });
    return c.json(project, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 409);
  }
});

app.patch("/api/ops/projects/:id", async (c) => {
  const board = getBoardProvider() as any;
  const projectStore = board?.getProjectStore?.();
  if (!projectStore) return c.json({ error: "No project store available" }, 503);
  const id = c.req.param("id");
  const body = await c.req.json();
  const updated = await projectStore.update(id, body);
  if (!updated) return c.json({ error: "Project not found" }, 404);
  return c.json(updated);
});

app.delete("/api/ops/projects/:id", async (c) => {
  const board = getBoardProvider() as any;
  const projectStore = board?.getProjectStore?.();
  const store = board?.getStore?.();
  if (!projectStore) return c.json({ error: "No project store available" }, 503);
  const id = c.req.param("id");
  // Reject if active tasks exist in this project
  if (store) {
    const tasks = await store.list();
    const active = tasks.filter((t: any) => t.project === id && t.state !== "done" && t.state !== "cancelled");
    if (active.length > 0) {
      return c.json({ error: `Cannot delete: ${active.length} active task(s) in project` }, 409);
    }
  }
  const ok = await projectStore.delete(id);
  if (!ok) return c.json({ error: "Project not found" }, 404);
  return c.json({ ok: true });
});

// --- Posture API (UI surface assembly) ---

app.get("/api/posture", (c) => {
  return c.json({
    posture: getPosture(),
    surface: getSurface(),
    state: getPostureState(),
  });
});

app.put("/api/posture", async (c) => {
  const body = await c.req.json() as { posture?: PostureName; pinned?: boolean };
  if (body.posture && ["silent", "pulse", "board"].includes(body.posture)) {
    if (body.pinned !== false) {
      pinPosture(body.posture);
    } else {
      pinPosture(body.posture);
      unpinPosture();
    }
  } else if (body.pinned === false) {
    unpinPosture();
  }
  return c.json({ posture: getPosture(), surface: getSurface(), state: getPostureState() });
});

// --- Pulse (nervous system) endpoint ---

app.get("/api/pulse/status", (c) => {
  const integrator = getPressureIntegrator();
  if (!integrator) {
    return c.json({ error: "Pulse system not initialized" }, 503);
  }
  return c.json(integrator.getStatus());
});

app.get("/api/pulse/history", (c) => {
  const integrator = getPressureIntegrator();
  if (!integrator) {
    return c.json({ error: "Pulse system not initialized" }, 503);
  }
  return c.json(integrator.getVoltageHistory());
});

// --- Nerve API (three-dot goo) ---

import { getNerveState } from "./nerve/state.js";
import { initPush, getVapidPublicKey, addSubscription, checkAndNotify, startPushMonitor, stopPushMonitor } from "./nerve/push.js";
import {
  loadPosture, startDecayTimer, stopDecayTimer,
  getPosture, getPostureState, getSurface, pinPosture, unpinPosture,
} from "./posture/engine.js";
import { postureTracker, requireSurface, postureHeader } from "./posture/middleware.js";
import type { PostureName } from "./posture/types.js";

// State endpoint — three dots
app.get("/api/nerve/state", async (c) => {
  const state = await getNerveState();
  return c.json(state);
});

// VAPID public key for push subscription
app.get("/api/nerve/vapid-key", (c) => {
  try {
    return c.json({ key: getVapidPublicKey() });
  } catch {
    return c.json({ error: "Push not initialized" }, 503);
  }
});

// Store push subscription from a nerve endpoint
app.post("/api/nerve/subscribe", async (c) => {
  const body = await c.req.json();
  const { subscription, label } = body as {
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
    label?: string;
  };
  if (!subscription?.endpoint || !subscription?.keys) {
    return c.json({ error: "Invalid subscription" }, 400);
  }
  const id = await addSubscription(subscription, label);
  return c.json({ id });
});

// SSE stream — real-time nerve state updates
app.get("/api/nerve/stream", async (c) => {
  return streamSSE(c, async (stream) => {
    // Send initial state
    const initial = await getNerveState();
    await stream.writeSSE({ event: "state", data: JSON.stringify(initial) });

    // Poll every 5 seconds and send updates
    let lastJson = JSON.stringify(initial);
    const interval = setInterval(async () => {
      try {
        const state = await getNerveState();
        const json = JSON.stringify(state);
        if (json !== lastJson) {
          lastJson = json;
          await stream.writeSSE({ event: "state", data: json });
          // Check if push notifications should fire
          await checkAndNotify(state).catch(() => {});
        }
      } catch { /* stream may be closed */ }
    }, 5000);

    // Keep alive
    const keepAlive = setInterval(async () => {
      try { await stream.writeSSE({ event: "ping", data: "" }); } catch { /* ok */ }
    }, 30000);

    stream.onAbort(() => {
      clearInterval(interval);
      clearInterval(keepAlive);
    });

    // Hold the stream open
    await new Promise(() => {});
  });
});

// Update: accept a pending major update
app.post("/api/nerve/accept-update", async (c) => {
  try {
    const { acceptMajorUpdate } = await import("./updater.js");
    const { clearPendingUpdate } = await import("./nerve/state.js");
    clearPendingUpdate();
    // This will restart the process after updating
    await acceptMajorUpdate();
    return c.json({ ok: true, message: "Updating and restarting..." });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Poll for new chat messages (phone → PC live feed)
app.get("/api/chat/poll", async (c) => {
  const sessionId = c.req.query("sessionId") || c.req.header("x-session-id");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);

  const since = parseInt(c.req.query("since") || "0", 10);
  const cs = chatSessions.get(sessionId) || (chatSessions.size > 0 ? chatSessions.values().next().value : null);
  if (!cs) return c.json({ messages: [], total: 0 });

  const total = cs.history.length;
  if (since >= total) return c.json({ messages: [], total });

  const newMsgs = cs.history.slice(since).map((m: any, i: number) => ({
    index: since + i,
    role: m.role,
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    source: m.source || "pc",
  }));

  return c.json({ messages: newMsgs, total });
});

// Chat: streamed response (or learn command)
app.post("/api/chat", async (c) => {
  const body = await c.req.json();
  const { sessionId, message, images } = body as {
    sessionId?: string;
    message?: string;
    images?: { data: string; mimeType: string }[];
    threadId?: string;
  };

  if (!sessionId || !message) {
    return c.json({ error: "sessionId and message required" }, 400);
  }

  const session = validateSession(sessionId);
  if (!session) {
    return c.json({ error: "Invalid or expired session" }, 401);
  }

  const cs = await getOrCreateChatSession(sessionId, session.name);

  // Route to thread history if threadId is provided
  const requestThreadId = (body as any).threadId as string | undefined;
  switchSessionThread(cs, requestThreadId || null, sessionId);

  // Reset continuation rounds when user sends a real message
  resetContinuation(sessionId);

  // Inject user-chat tension into the nervous system
  getPressureIntegrator()?.addUserChatTension();

  // Start goal timer on first chat call
  if (!goalTimerStarted) {
    goalTimerStarted = true;
    startGoalTimer({ brain: cs.brain, humanName: session.name });

    // Start Google polling timers if already authenticated
    if (isCalendarAvailable()) {
      startCalendarTimer();
    }
    if (isGmailAvailable()) {
      startGmailTimer();
    }
    if (isTasksAvailable()) {
      startTasksTimer();
    }
  }

  // Helper: persist session to disk (fire-and-forget)
  const persistSession = () => {
    const key = sessionKeys.get(sessionId);
    if (key) {
      // Collect threads for persistence
      const threads = getThreadsForSession(sessionId);
      const threadList = [...threads.values()].map((t) => ({
        id: t.id,
        title: t.title,
        // If this thread is active, its live history is in cs.history
        history: (cs.activeThreadId === t.id) ? cs.history : t.history,
        historySummary: (cs.activeThreadId === t.id) ? cs.historySummary : t.historySummary,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }));
      // Persist main history (from mainHistory if a thread is active, else cs.history)
      const mainHistory = cs.activeThreadId ? cs.mainHistory : cs.history;
      const mainSummary = cs.activeThreadId ? cs.mainHistorySummary : cs.historySummary;
      saveSession(sessionId, {
        history: mainHistory,
        fileContext: cs.fileContext,
        learnedPaths: cs.learnedPaths,
        historySummary: mainSummary,
        threads: threadList.length > 0 ? threadList : undefined,
      }, key).catch(() => {});
    }

    // Auto fold-back: fire once per session when user messages reach threshold
    const userMsgCount = cs.history.filter((m) => m.role === "user").length;
    if (!cs.foldedBack && userMsgCount >= 6) {
      cs.foldedBack = true;
      foldBack({
        history: cs.history,
        historySummary: cs.historySummary || undefined,
        sourceTraceId: generateTraceId(),
        sessionId,
      }).catch(() => {});
    }
  };

  // --- Handle "learn <path>" command ---
  const learnMatch = message.match(/^learn\s+(.+)$/i);
  if (learnMatch) {
    const dirPath = learnMatch[1].trim();
    try {
      const result = await ingestDirectory(dirPath);
      cs.fileContext = result.content;
      cs.learnedPaths.push(dirPath);

      const summary = result.files.length > 10
        ? result.files.slice(0, 10).join(", ") + `, ... and ${result.files.length - 10} more`
        : result.files.join(", ");

      const msg = `Learned ${result.files.length} file${result.files.length === 1 ? "" : "s"} from ${dirPath}: ${summary}${result.truncated ? " (some files truncated to fit context budget)" : ""}`;

      persistSession();
      return c.json({ system: true, content: msg });
    } catch (err: any) {
      return c.json({ system: true, content: `Failed to learn from ${dirPath}: ${err.message}` });
    }
  }

  // --- Handle "call me" / "call <number>" command ---
  const callMatch = message.match(/^call\s+(?:me|(\+\d{10,15}))\s*(?:and\s+say\s+(.+))?$/i);
  if (callMatch) {
    const to = callMatch[1] || undefined;
    const msg = callMatch[2]?.trim() || undefined;
    const result = await makeCall({ to, message: msg });
    return c.json({ system: true, content: result.message });
  }

  // --- Handle "email <address> subject: <subject> body: <body>" command ---
  const emailMatch = message.match(/^(?:email|send email|mail)\s+(\S+@\S+)\s+subject:\s*(.+?)\s+body:\s*([\s\S]+)$/i);
  if (emailMatch) {
    const [, to, subject, body] = emailMatch;
    const result = await sendEmail({ to: to.trim(), subject: subject.trim(), body: body.trim() });
    logActivity({ source: "gmail", summary: `Email sent to ${to.trim()}: "${subject.trim()}"`, actionLabel: "PROMPTED", reason: "user sent email via chat" });
    return c.json({ system: true, content: result.message });
  }

  // --- Handle "goals" / "goal check" command ---
  const goalMatch = message.match(/^(?:goals|goal check|what should i do|check goals)\s*$/i);
  if (goalMatch) {
    const result = await runGoalCheck({ brain: cs.brain, provider: resolveProvider(), model: resolveUtilityModel(), humanName: session.name });
    logActivity({ source: "goal-loop", summary: `Manual check: ${result.action}`, detail: result.reasoning, actionLabel: "PROMPTED", reason: "user requested goal check" });
    const lines = [`**Goal check** — action: \`${result.action}\``];
    if (result.reasoning) lines.push(`Reasoning: ${result.reasoning}`);
    if (result.outcome) lines.push(`Outcome: ${result.outcome}`);
    if (result.error) lines.push(`Error: ${result.error}`);
    return c.json({ system: true, content: lines.join("\n") });
  }

  // --- Handle "run <prompt>" command ---
  const runMatch = message.match(/^run\s+(.+)$/is);
  if (runMatch) {
    const prompt = runMatch[1].trim();
    const label = prompt.slice(0, 60);
    try {
      const task = await submitTask({ label, prompt, origin: "user", sessionId });
      return c.json({ system: true, content: `Agent spawned: **${label}**\nTask ID: \`${task.id}\`\nPID: ${task.pid}\nUse \`tasks\` to check status.` });
    } catch (err: any) {
      return c.json({ system: true, content: `Failed to spawn agent: ${err.message}` });
    }
  }

  // --- Handle "tasks" command ---
  const tasksMatch = message.match(/^tasks\s*$/i);
  if (tasksMatch) {
    const allTasks = await listAgentTasks();
    if (allTasks.length === 0) {
      return c.json({ system: true, content: "No agent tasks." });
    }
    const lines = allTasks.slice(0, 20).map((t) => {
      const status = t.status === "running" ? "running" : t.status === "completed" ? "completed" : t.status === "failed" ? "failed" : t.status;
      return `- **${t.label}** [\`${status}\`] — \`${t.id}\`${t.pid ? ` (PID ${t.pid})` : ""}`;
    });
    return c.json({ system: true, content: `**Agent tasks** (${allTasks.length} total):\n${lines.join("\n")}` });
  }

  // --- Handle "task <id>" command ---
  const taskMatch = message.match(/^task\s+(agent_\S+)\s*$/i);
  if (taskMatch) {
    const task = await getTask(taskMatch[1]);
    if (!task) return c.json({ system: true, content: `Task not found: ${taskMatch[1]}` });
    const output = await getTaskOutput(task.id);
    const tail = output ? output.slice(-2000) : "(no output yet)";
    const lines = [
      `**${task.label}** [\`${task.status}\`]`,
      `ID: \`${task.id}\``,
      task.pid ? `PID: ${task.pid}` : null,
      `Created: ${task.createdAt}`,
      task.startedAt ? `Started: ${task.startedAt}` : null,
      task.finishedAt ? `Finished: ${task.finishedAt}` : null,
      task.exitCode != null ? `Exit code: ${task.exitCode}` : null,
      task.error ? `Error: ${task.error}` : null,
      `\n---\n**Output** (last 2000 chars):\n\`\`\`\n${tail}\n\`\`\``,
    ].filter(Boolean);
    return c.json({ system: true, content: lines.join("\n") });
  }

  // --- Handle "cancel <id>" command ---
  const cancelMatch = message.match(/^cancel\s+(agent_\S+)\s*$/i);
  if (cancelMatch) {
    const ok = await cancelTask(cancelMatch[1]);
    return c.json({ system: true, content: ok ? `Cancelled task \`${cancelMatch[1]}\`` : `Task not found: ${cancelMatch[1]}` });
  }

  // --- Handle "auto" / "autonomous" command ---
  const autoMatch = message.match(/^(?:auto|autonomous)\s*$/i);
  if (autoMatch) {
    const status = getAutonomousStatus();
    const lines: string[] = [
      `**Autonomous Work Loop**`,
      ``,
      `- Timer: ${status.timerRunning ? "running" : "stopped"} (every ${status.intervalMs / 60_000}min)`,
      `- Planning in progress: ${status.planningInProgress ? "yes" : "no"}`,
      `- Active sessions: ${status.activeSessions.length > 0 ? status.activeSessions.join(", ") : "none"}`,
    ];
    if (status.creditCircuitBreakerActive) {
      lines.push(`- **Credit circuit breaker: ACTIVE** (${status.creditCircuitBreakerRemainingMin}min remaining)`);
    }
    if (status.cooldowns.length > 0) {
      lines.push(``, `**Tasks on cooldown:**`);
      for (const cd of status.cooldowns) {
        lines.push(`- ${cd.label ?? cd.taskId}: failed ${cd.failureCount}x, ${cd.remainingMin}min remaining`);
      }
    } else {
      lines.push(`- Cooldowns: none`);
    }
    if (status.pulse) {
      const p = status.pulse;
      const ageStr = p.lastPulseAge < 0 ? "never" : `${Math.round(p.lastPulseAge / 60_000)}m ago`;
      lines.push(``, `**Nervous System (Pulse)**`);
      lines.push(`- Voltage: ${p.voltage}/${p.effectiveThreshold}mV (${p.state})`);
      lines.push(`- Pulses fired: ${p.pulseCount} (last: ${ageStr})`);
      lines.push(`- Decay: ${p.decayRate}mV/hr`);
      if (p.refractoryRemaining > 0) {
        lines.push(`- Refractory: ${Math.ceil(p.refractoryRemaining / 1000)}s remaining`);
      }
    }
    return c.json({ system: true, content: lines.join("\n") });
  }

  // --- Handle "issues" / "board" command ---
  const issuesMatch = message.match(/^(?:issues|board)\s*$/i);
  if (issuesMatch) {
    const board = getBoardProvider();
    if (!board || !board.isAvailable()) {
      return c.json({ system: true, content: "No task board connected." });
    }
    const allIssues = await board.listIssues({}) ?? [];
    // Default "issues" command shows active items (not done/cancelled)
    const issues = allIssues
      .filter((i: any) => !["Done", "Cancelled"].includes(i.state))
      .slice(0, 50);
    if (!issues || issues.length === 0) {
      return c.json({ system: true, content: "**Board** — No active issues found." });
    }
    return c.json({ system: true, boardItems: { issues: issuesToCardPayload(issues) } });
  }

  // --- Handle "todo <title>" command ---
  const todoMatch = message.match(/^todo\s+(.+)$/i);
  if (todoMatch) {
    const board = getBoardProvider();
    if (!board || !board.isAvailable()) {
      return c.json({ system: true, content: "No task board connected." });
    }
    const title = todoMatch[1].trim();
    const issue = await board.createIssue(title);
    if (!issue) {
      return c.json({ system: true, content: `Failed to create issue: "${title}"` });
    }
    return c.json({ system: true, content: `Created **${issue.identifier}**: ${issue.title}\n${issue.url}` });
  }

  // --- Handle "done <identifier>" command ---
  const doneMatch = message.match(/^done\s+([A-Z]+-\d+)\s*$/i);
  if (doneMatch) {
    const board = getBoardProvider();
    if (!board || !board.isAvailable()) {
      return c.json({ system: true, content: "No task board connected." });
    }
    const identifier = doneMatch[1].toUpperCase();
    const issue = await board.findByIdentifier(identifier);
    if (!issue) {
      return c.json({ system: true, content: `Issue not found: ${identifier}` });
    }
    // Find the team from the identifier prefix to get its "Done" state
    const teamPrefix = identifier.split("-")[0];
    const teams = await board.getTeams();
    const team = teams?.find((t) => t.key === teamPrefix);
    if (!team) {
      return c.json({ system: true, content: `Team not found for prefix: ${teamPrefix}` });
    }
    const doneStateId = await board.getDoneStateId(team.id);
    if (!doneStateId) {
      return c.json({ system: true, content: `No "Done" state found for team ${team.name}` });
    }
    const updated = await board.updateIssue(issue.id, { stateId: doneStateId });
    if (!updated) {
      return c.json({ system: true, content: `Failed to update ${identifier}` });
    }
    return c.json({ system: true, content: `Marked **${identifier}** as Done: ${updated.title}` });
  }

  // --- Handle "browse <url>" command ---
  // Rewrite bare browse commands into a natural message so it flows through
  // the normal chat path (URL auto-detect fetches the content, LLM synthesizes).
  const browseMatch = message.match(/^(?:browse|read|fetch|open)\s+(https?:\/\/\S+)\s*$/i);
  const chatMessage = browseMatch
    ? `Read and summarize this page: ${browseMatch[1]}`
    : message;

  // --- Normal chat flow ---

  // Build multimodal content if images are attached
  const hasImages = images && images.length > 0;
  // When user sends an image without text, provide a default prompt so the LLM
  // has clear instructions instead of an empty text block.
  const imageText = hasImages && !chatMessage.trim()
    ? "Describe what you see in this image. What is it, and what's notable?"
    : chatMessage;
  const userContent = hasImages
    ? [
        { type: "text" as const, text: imageText },
        ...images.map((img) => ({
          type: "image_url" as const,
          image_url: { url: `data:${img.mimeType};base64,${img.data}` },
        })),
      ]
    : chatMessage;

  // Add user message to history and persist immediately
  // (so it survives a server restart before onDone fires)
  cs.history.push({ role: "user", content: userContent });
  persistSession();

  // Fire-and-forget: persist images to visual memory
  if (hasImages && getSettings().visualMemory?.enabled !== false) {
    const vmConfig = getSettings().visualMemory;
    if (vmConfig?.autoSave !== false) {
      for (const img of images!) {
        saveVisualMemory({
          imageData: img.data,
          mimeType: img.mimeType,
          userContext: chatMessage,
          provider: resolveProvider(),
          model: vmConfig?.descriptionModel === "chat"
            ? resolveChatModel() : resolveUtilityModel(),
          maxImageBytes: vmConfig?.maxImageBytes,
        }).catch(() => {}); // fire-and-forget, same pattern as extractAndLearn
      }
    }
  }

  // Compact older history if conversation is long (reduces token usage)
  const compaction = await compactHistory(
    cs.history.slice(0, -1), // everything before the just-added message
    cs.historySummary,
    resolveProvider(),
    resolveUtilityModel(),
  );
  if (compaction.compacted) {
    cs.historySummary = compaction.summary;
    cs.history = [...compaction.trimmedHistory, cs.history.at(-1)!];
    logActivity({ source: "system", summary: "Compacted conversation history" });
  }

  // Get context from Brain (retrieves from LTM, assembles system prompt + memories)
  const ctx = await cs.brain.getContextForTurn({
    userInput: chatMessage,
    conversationHistory: cs.history.slice(0, -1), // history before this message
  });

  // Hydrate visual memories — re-inject saved images into LLM context
  if (getSettings().visualMemory?.enabled !== false) {
    const vmConfig = getSettings().visualMemory;
    const maxImages = vmConfig?.maxImagesPerTurn ?? 2;

    // First: check if generic retrieval surfaced any visual memories
    let visualEntries = ctx.workingMemory.retrieved.filter(isVisualMemory);

    // Fallback: targeted search when visual memories got crowded out by other episodic entries
    if (visualEntries.length === 0) {
      visualEntries = await searchVisualMemories(chatMessage, maxImages);
    }

    if (visualEntries.length > 0) {
      const hydrated = await hydrateVisualMemories(visualEntries, maxImages);
      if (hydrated.length > 0) {
        const blocks: ContentBlock[] = [];
        for (const h of hydrated) {
          blocks.push({ type: "text", text: `[Visual memory from ${h.entry.createdAt}]: ${h.description}` });
          blocks.push({ type: "image_url", image_url: { url: h.dataUri } });
        }
        ctx.messages.splice(1, 0, { role: "user" as const, content: blocks });
      }
    }
  }

  // Inject resolved skill content (reference skills auto-load by trigger match)
  try {
    const matched = await _skillRegistry.findByTrigger(chatMessage);
    if (matched) {
      const body = await _skillRegistry.getContent(matched.id);
      if (body) {
        // Load files referenced by the skill (brain/ paths)
        const refPaths = body.match(/(?:brain|docs)\/[\w\-\/]+\.\w+/g) ?? [];
        const refContents: string[] = [];
        for (const refPath of refPaths) {
          try {
            const content = await readBrainFile(join(process.cwd(), refPath));
            refContents.push(`--- ${refPath} ---\n${content}\n--- end ${refPath} ---`);
          } catch { /* skip missing files */ }
        }

        const skillSection = [
          `--- Skill: ${matched.name} (${matched.type}) ---`,
          body,
          ...refContents,
          `--- end skill ---`,
        ].join("\n");

        ctx.messages.splice(1, 0, { role: "system" as const, content: skillSection });
        logActivity({ source: "system", summary: `Loaded skill: ${matched.name} (${matched.type})` });
      }
    }
  } catch (err) {
    // Skills are non-blocking — log and continue
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Skill resolution error: ${msg}`);
  }

  // Inject file context after system message, before conversation history
  if (cs.fileContext) {
    const fileMsg = {
      role: "system" as const,
      content: `--- Files loaded from ${cs.learnedPaths.join(", ")} ---\n${cs.fileContext}`,
    };
    ctx.messages.splice(1, 0, fileMsg);
  }

  // Inject ingested folder context (persistent background knowledge)
  if (cs.ingestedContext) {
    const ingestMsg = {
      role: "system" as const,
      content: `--- Background knowledge (ingested documents) ---\n${cs.ingestedContext}\n--- End background knowledge ---`,
    };
    ctx.messages.splice(1, 0, ingestMsg);
  }

  // Inject conversation history summary (from compaction)
  if (cs.historySummary) {
    ctx.messages.splice(1, 0, {
      role: "system" as const,
      content: `--- Earlier conversation summary ---\n${cs.historySummary}\n--- End summary ---`,
    });
  }

  // --- URL browse injection ---
  const detectedUrl = detectUrl(chatMessage);
  if (detectedUrl) {
    logActivity({ source: "browse", summary: `Auto-browsing URL in message: ${detectedUrl}`, actionLabel: "PROMPTED", reason: "user message contained URL" });
    const browseResult = await browseUrl(detectedUrl);
    if (browseResult) {
      const browseMsg = {
        role: "system" as const,
        content: [
          `--- Content from ${browseResult.url}${browseResult.title ? ` (${browseResult.title})` : ""} ---`,
          browseResult.text,
          `--- End fetched content ---`,
          `Use the content above to inform your response. The user shared this link in their message.`,
        ].join("\n"),
      };
      ctx.messages.splice(1, 0, browseMsg);
    }
  }

  // --- Brain document injection ---
  // When user references a paper/draft/note by description, find and inject it
  let brainDocFound = false;
  try {
    const doc = await findBrainDocument(chatMessage);
    if (doc) {
      brainDocFound = true;
      const siblingNote = doc.siblings && doc.siblings.length > 0
        ? `\nAlso in the same directory: ${doc.siblings.join(", ")}\nYou can ask to see any of these files.`
        : "";
      const docMsg = {
        role: "system" as const,
        content: [
          `--- Brain document: ${doc.filename} ---`,
          doc.content,
          `--- End ${doc.filename} ---`,
          `This document was found in your brain files. Use it to answer the user's question.${siblingNote}`,
        ].join("\n"),
      };
      ctx.messages.splice(1, 0, docMsg);
      logActivity({ source: "system", summary: `Auto-loaded brain document: ${doc.filename}`, actionLabel: "PROMPTED", reason: "user message referenced a brain document" });
    }
  } catch (err) {
    // Non-critical — fall through to web search
    console.error("[brain-docs] findBrainDocument error:", err instanceof Error ? err.message : String(err));
  }

  // --- Context provider injection (web search, calendar, email) ---
  {
    const capReg = getCapabilityRegistry();
    if (capReg) {
      const injections = await capReg.getContextInjections(chatMessage, {
        origin: "chat",
        name: session.name,
        hints: { detectedUrl: !!detectedUrl, brainDocFound },
      });
      for (const inj of injections) {
        ctx.messages.splice(1, 0, {
          role: "system" as const,
          content: inj.content,
        });
      }
    }
  }

  // --- Board context injection ---
  // Two triggers: (1) board keywords like "todo", "backlog", "board" inject a filtered list,
  // (2) PREFIX-N references (DASH-1, CORE-3, TRI-2) inject those specific items with full descriptions.
  // Always inject current project list so the agent uses correct project ids.
  const boardKeywords = /\b(issues?|board|tasks?|backlog|todo|close|done|groom|project)\b/i;
  const dashRefs = chatMessage.match(/\b[A-Z]+-\d+\b/gi);

  if (isBoardAvailable() && (boardKeywords.test(chatMessage) || dashRefs)) {
    const board = getBoardProvider()!;
    const queueStore = (board as any).getStore?.();

    // Inject current project list so the agent always knows exact project ids
    try {
      const projectStore = (board as any).getProjectStore?.();
      if (projectStore) {
        const projects = await projectStore.list();
        if (projects.length > 0) {
          const projectLines = projects.map((p: any) =>
            `- **${p.prefix}** → project id: "${p.id}" — ${p.name}${p.description ? ` (${p.description})` : ""}`
          );
          ctx.messages.splice(1, 0, {
            role: "system" as const,
            content: [
              `--- Available projects (use exact "id" values in BOARD_ACTION) ---`,
              ...projectLines,
              `--- End projects ---`,
            ].join("\n"),
          });
        }
      }
    } catch { /* non-fatal */ }

    // If the user referenced specific PREFIX-N identifiers, inject those with full descriptions
    if (dashRefs && dashRefs.length > 0 && queueStore) {
      const refLines: string[] = [];
      const seen = new Set<string>();
      for (const ref of dashRefs) {
        const upper = ref.toUpperCase();
        if (seen.has(upper)) continue;
        seen.add(upper);
        const task = await queueStore.getByIdentifier(upper);
        if (task) {
          let line = `### ${task.identifier}: ${task.title} [${task.state}]`;
          if (task.project) line += ` (project: ${task.project})`;
          if (task.assignee) line += ` (assigned: ${task.assignee})`;
          if (task.description) line += `\n${task.description}`;
          const exchanges = await queueStore.getExchanges(task.id);
          if (exchanges.length > 0) {
            line += `\n\n**Exchanges:**`;
            for (const ex of exchanges.slice(-5)) {
              const date = new Date(ex.timestamp).toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
              line += `\n- [${date}] ${ex.author} (${ex.source}): "${ex.body}"`;
            }
          }
          refLines.push(line);
        }
      }
      if (refLines.length > 0) {
        ctx.messages.splice(1, 0, {
          role: "system" as const,
          content: [
            `--- Referenced board items (full details) ---`,
            ...refLines,
            `--- End referenced items ---`,
            `Use these real identifiers in any [BOARD_ACTION] blocks. Do not invent identifiers.`,
          ].join("\n"),
        });
      }
    }

    // Also inject filtered list for keyword-based queries (e.g. "show todos", "board")
    if (boardKeywords.test(chatMessage)) {
      // Determine which state filter to apply based on user intent.
      // "board" is not a competing state — it's a noun (the board itself).
      let stateType: string | undefined;
      let contextLabel = "Current board issues";
      const msgLower = chatMessage.toLowerCase();
      if (/\btodos?\b/.test(msgLower) && !/\b(done|backlog|all|groom)\b/.test(msgLower)) {
        stateType = "unstarted";
        contextLabel = "Todo items";
      } else if (/\bbacklog\b/.test(msgLower) && !/\b(done|todo|all|groom)\b/.test(msgLower)) {
        stateType = "backlog";
        contextLabel = "Backlog items";
      } else if (/\bdone\b/.test(msgLower) && !/\b(todo|backlog|all|groom)\b/.test(msgLower)) {
        stateType = "completed";
        contextLabel = "Completed items";
      } else if (/\bin.progress\b/.test(msgLower)) {
        stateType = "started";
        contextLabel = "In-progress items";
      } else if (/\bicebox\b/.test(msgLower)) {
        stateType = "icebox";
        contextLabel = "Icebox items";
      }

      // Default: show active items (exclude done/cancelled) unless user asked for a specific state
      let boardIssues = (await board.listIssues({ stateType })) ?? [];
      if (!stateType) {
        boardIssues = boardIssues.filter((i: any) =>
          !["Done", "Cancelled", "Icebox"].includes(i.state)
        );
        contextLabel = "Active board issues";
      }
      boardIssues = boardIssues.slice(0, 50);
      if (boardIssues && boardIssues.length > 0) {
        const issueLines: string[] = [];
        for (const i of boardIssues) {
          let line = `- ${i.identifier}: ${i.title} [${i.state || "unknown"}]${i.project ? ` {${i.project}}` : ""}${i.assignee ? ` (${i.assignee})` : ""}`;
          if (queueStore) {
            const exchanges = await queueStore.getExchanges(i.id);
            if (exchanges.length > 0) {
              const last = exchanges[exchanges.length - 1];
              const date = new Date(last.timestamp).toLocaleDateString("en-US", { month: "numeric", day: "numeric" });
              line += `\n    Last exchange: [${date}] ${last.author} (${last.source}): "${last.body}"`;
            }
          }
          issueLines.push(line);
        }
        ctx.messages.splice(1, 0, {
          role: "system" as const,
          content: [
            `--- ${contextLabel} (${board.name}, ${boardIssues.length} items) ---`,
            ...issueLines,
            `--- End board issues ---`,
            `Use these real identifiers in any [BOARD_ACTION] blocks. Do not invent identifiers.`,
          ].join("\n"),
        });
      } else {
        ctx.messages.splice(1, 0, {
          role: "system" as const,
          content: `--- ${contextLabel} (${board.name}, 0 items) ---\nNo items found.\n--- End board issues ---`,
        });
      }
    }
  }


  // --- Changelog injection ---
  const changelogKeywords = /\b(what'?s new|changelog|recent changes|what changed|updates?|release notes|new features?|capabilities)\b/i;
  if (changelogKeywords.test(chatMessage)) {
    try {
      const changelogPath = join(BRAIN_DIR, "operations", "changelog.md");
      const changelogContent = await readBrainFile(changelogPath);
      const changelogMsg = {
        role: "system" as const,
        content: [
          `--- ${getInstanceName()} changelog ---`,
          changelogContent,
          `--- End changelog ---`,
          `Use the changelog above to answer the user's question about what's new or what has changed.`,
        ].join("\n"),
      };
      ctx.messages.splice(1, 0, changelogMsg);
    } catch (err) {
      log.debug(`Changelog unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Module context injection (keyword-triggered) ---
  const moduleRegistry = getModuleRegistry();
  if (moduleRegistry) {
    const DEDICATED_MODULES = new Set(["board", "calendar", "gmail"]);
    for (const hit of moduleRegistry.resolve(chatMessage)) {
      if (DEDICATED_MODULES.has(hit.module.manifest.name)) continue;
      if (!hit.module.instructionFile) continue;
      try {
        const content = await readBrainFile(hit.module.instructionFile);
        ctx.messages.splice(1, 0, {
          role: "system" as const,
          content: `--- Module: ${hit.module.manifest.name} ---\n${content}\n--- end ---`,
        });
      } catch { /* skip */ }
    }
  }

  // --- Open loop context injection ---
  try {
    const [activeLoops, resonantLoops, resonances] = await Promise.all([
      loadLoopsByState("active"),
      loadLoopsByState("resonant"),
      Promise.resolve(getResonances()),
    ]);

    const cappedActive = activeLoops.slice(0, 5);
    const cappedResonant = resonantLoops.slice(0, 3);
    const cappedResonances = resonances.slice(0, 3);

    if (cappedActive.length > 0 || cappedResonant.length > 0) {
      const lines: string[] = [
        `--- Open loops (unresolved tensions from past conversations) ---`,
      ];

      if (cappedActive.length > 0) {
        lines.push("[Active]");
        for (const loop of cappedActive) {
          const expires = new Date(loop.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
          lines.push(`- [${loop.anchor}] ${loop.dissonance} (expires ${expires})`);
          if (loop.searchHeuristic.length > 0) {
            lines.push(`  Heuristics: ${loop.searchHeuristic.join(", ")}`);
          }
        }
      }

      if (cappedResonant.length > 0) {
        lines.push("[Resonant — new match!]");
        for (const loop of cappedResonant) {
          lines.push(`- [${loop.anchor}] ${loop.dissonance}`);
          // Find matching resonance for this loop
          const match = cappedResonances.find((r) => r.loopId === loop.id);
          if (match) {
            lines.push(`  Matched: "${match.matchedSummary}" (${Math.round(match.similarity * 100)}% similarity)`);
            lines.push(`  → ${match.explanation}`);
          }
        }
      }

      lines.push(`--- End open loops ---`);
      lines.push(`If the user's message relates to any open loop, surface the connection naturally.`);
      lines.push(`Resonant loops are especially important — they represent a potential "aha moment."`);

      const loopMsg = {
        role: "system" as const,
        content: lines.join("\n"),
      };
      ctx.messages.splice(1, 0, loopMsg);
    }
  } catch (err) {
    log.warn(`Open loop context injection failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Goal notification injection ---
  const pendingNotifications = await drainNotifications();
  if (pendingNotifications.length > 0) {
    const notifText = pendingNotifications
      .map((n) => `- [${n.source}] ${n.message}`)
      .join("\n");
    const notifMsg = {
      role: "system" as const,
      content: [
        `--- Background updates from ${getInstanceName()} ---`,
        notifText,
        `--- End background updates ---`,
        `Weave these updates naturally into your response where relevant. Don't dump them as a raw list.`,
      ].join("\n"),
    };
    ctx.messages.splice(1, 0, notifMsg);
  }

  // Ensure the current turn's images reach the LLM.
  // getContextForTurn() builds the final user message from text-only primaryContent,
  // so multimodal content (images) from the current turn gets dropped. Patch it back in.
  if (hasImages) {
    const lastIdx = ctx.messages.length - 1;
    if (lastIdx >= 0 && ctx.messages[lastIdx]?.role === "user") {
      ctx.messages[lastIdx] = { role: "user", content: userContent };
    }
  }

  let stream_fn: ReturnType<typeof pickStreamFn>;
  try {
    stream_fn = pickStreamFn();
  } catch (err) {
    if (err instanceof PrivateModeError) {
      return c.json({ error: err.message }, 503);
    }
    throw err;
  }

  const activeProvider = resolveProvider();
  const activeChatModel = resolveChatModel();

  const reqSignal = c.req.raw.signal;

  return streamSSE(c, async (stream) => {
    // Send metadata first so UI can show which model is responding
    await stream.writeSSE({ data: JSON.stringify({ meta: { provider: activeProvider, model: activeChatModel ?? (activeProvider === "ollama" ? "llama3.2:3b" : "claude-sonnet-4") } }) });

    // --- Apply membrane: redact messages BEFORE they reach the LLM ---
    const membrane = getActiveMembrane();
    const redactedMessages = ctx.messages.map((msg: any) => {
      if (!membrane) return msg;
      const copy = { ...msg };
      if (typeof copy.content === "string") {
        copy.content = membrane.apply(copy.content);
      } else if (Array.isArray(copy.content)) {
        copy.content = copy.content.map((block: any) => {
          if (block.type === "text" && typeof block.text === "string") {
            return { ...block, text: membrane.apply(block.text) };
          }
          return block;
        });
      }
      return copy;
    });

    // --- Membrane view: emit what the LLM will see (redacted) ---
    try {
      const membraneView: { role: string; preview: string; redactions: number }[] = [];
      for (const msg of redactedMessages) {
        const raw = typeof msg.content === "string" ? msg.content
          : Array.isArray(msg.content) ? msg.content.map((b: any) => b.text || b.type || "").join(" ") : "";
        if (!raw) continue;
        // Count redactions by counting placeholders (already redacted)
        const placeholders = raw.match(/<<[A-Z_]+_\d+>>|\[REDACTED:[^\]]+\]/g);
        membraneView.push({
          role: msg.role,
          preview: raw.slice(0, 300) + (raw.length > 300 ? "..." : ""),
          redactions: placeholders ? placeholders.length : 0,
        });
      }
      const totalRedactions = membraneView.reduce((sum, m) => sum + m.redactions, 0);
      await stream.writeSSE({ data: JSON.stringify({
        membrane: {
          messageCount: redactedMessages.length,
          totalRedactions,
          messages: membraneView,
          sealValues: membrane ? membrane.knownValues.map(v => v.value) : [],
        },
      }) });
    } catch (memErr) {
      log.warn("membrane view error", { error: String(memErr) });
    }

    let fullResponse = "";

    const savePartial = () => {
      if (fullResponse) {
        cs.history.push({ role: "assistant", content: fullResponse });
        persistSession();
      }
    };

    await new Promise<void>((resolve, reject) => {
      // If client already disconnected before we start streaming, save and bail
      if (reqSignal?.aborted) {
        savePartial();
        resolve();
        return;
      }

      // Listen for client disconnect to abort the LLM stream
      const onAbort = () => {
        savePartial();
        resolve();
      };
      reqSignal?.addEventListener("abort", onAbort, { once: true });

      // Token buffer for split-placeholder rehydration
      let tokenBuf2 = "";
      const streamStartMs2 = performance.now();
      const streamModel2 = activeChatModel ?? (activeProvider === "ollama" ? "llama3.2:3b" : "claude-sonnet-4");
      const flushBuf2 = () => {
        if (!tokenBuf2) return;
        // Debug: trace rehydration
        const rehydrated = rehydrateResponse(tokenBuf2);
        fullResponse += rehydrated;
        tokenBuf2 = "";
        stream.writeSSE({ data: JSON.stringify({ token: rehydrated }) }).catch(() => {});
      };

      stream_fn({
        messages: redactedMessages,
        model: activeChatModel,
        signal: reqSignal,
        onToken: (token) => {
          tokenBuf2 += token;
          // Hold if buffer ends with partial placeholder
          const lastOpen = tokenBuf2.lastIndexOf("<<");
          if (lastOpen !== -1 && tokenBuf2.indexOf(">>", lastOpen) === -1) return;
          flushBuf2();
        },
        onDone: async () => {
          flushBuf2(); // flush remainder
          reqSignal?.removeEventListener("abort", onAbort);
          logLlmCall({
            ts: new Date().toISOString(), mode: "stream",
            provider: activeProvider, model: streamModel2,
            durationMs: Math.round(performance.now() - streamStartMs2),
            outputTokens: Math.ceil(fullResponse.length / 4), ok: true,
          });

          // Process action blocks BEFORE sending done — ensures SSE events reach client before stream closes.
          // ALWAYS strip [AGENT_REQUEST] blocks from response, even if they can't be parsed.
          // Capture raw block content first for logging/parsing.
          const rawAgentBlocks = [...fullResponse.matchAll(/\[AGENT_REQUEST\]\s*([\s\S]*?)\s*\[\/AGENT_REQUEST\]/g)];
          if (rawAgentBlocks.length > 0) {
            fullResponse = fullResponse.replace(/\s*\[AGENT_REQUEST\][\s\S]*?\[\/AGENT_REQUEST\]\s*/g, "").trim();
            agentLog.info(` Found ${rawAgentBlocks.length} AGENT_REQUEST block(s)`);
            let spawnCount = 0;
            for (const block of rawAgentBlocks) {
              const rawContent = block[1].trim();
              agentLog.info(` Block content: ${rawContent.slice(0, 300)}`);

              // Try to extract JSON from the block — may be wrapped in backticks, code fences, or prose
              let jsonStr = rawContent;
              // Strip code fence wrappers: ```json ... ``` or ``` ... ```
              jsonStr = jsonStr.replace(/^`{3,}(?:json)?\s*/i, "").replace(/\s*`{3,}$/i, "");
              // Strip inline backticks
              jsonStr = jsonStr.replace(/^`+|`+$/g, "");
              // Try to find a JSON object in the content
              const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
              if (!jsonMatch) {
                agentLog.error(` No JSON object found in block. Raw content: ${rawContent.slice(0, 300)}`);
                logActivity({ source: "agent", summary: `AGENT_REQUEST has no JSON`, detail: rawContent.slice(0, 300) });
                continue;
              }

              try {
                const req = JSON.parse(jsonMatch[0]);
                if (req.prompt) {
                  let finalPrompt = req.prompt as string;
                  const label = req.label || finalPrompt.slice(0, 60);

                  // Guard: detect vague prompts and prepend grounding instructions
                  const hasFilePath = /(?:src\/|brain\/|public\/|\.ts|\.js|\.md|\.json|\.yaml|\.yml)/.test(finalPrompt);
                  const isVague = /\b(?:comprehensive|robust|production-ready|enterprise|scalable|world-class)\b/i.test(finalPrompt)
                    && !hasFilePath;
                  const isWishList = (finalPrompt.match(/^\d+\.\s/gm) || []).length >= 5 && !hasFilePath;

                  if (isVague || isWishList) {
                    agentLog.warn(` Vague prompt detected, adding grounding preamble: ${label}`);
                    finalPrompt = [
                      `IMPORTANT: The original request below is vague. Do NOT try to build everything listed.`,
                      `Instead: 1) Read the existing codebase (start with src/ and package.json) to understand what exists.`,
                      `2) Pick ONE small, concrete piece you can actually implement that connects to existing code.`,
                      `3) Build that one thing well, with tests if a test framework exists.`,
                      `4) If nothing concrete can be built without more requirements, just create a brief spec document at brain/knowledge/notes/ describing what decisions are needed and exit.`,
                      ``,
                      `Original request:`,
                      finalPrompt,
                    ].join("\n");
                  }

                  spawnCount++;
                  agentLog.info(` Spawning: ${label}${(isVague || isWishList) ? " (grounded)" : ""}`);
                  // Await task submission so we can send the real task ID to the client
                  try {
                    const task = await submitTask({
                      label,
                      prompt: finalPrompt,
                      origin: "ai",
                      sessionId,
                      boardTaskId: req.taskId,
                    });
                    stream.writeSSE({ data: JSON.stringify({ agentSpawned: { label, taskId: task.id } }) }).catch(() => {});
                    logActivity({ source: "agent", summary: `AI-triggered agent: ${task.label}`, detail: `Task ${task.id}, PID ${task.pid}`, actionLabel: "PROMPTED", reason: "user chat triggered agent" });
                  } catch (err: any) {
                    agentLog.error(`Spawn failed for "${label}": ${err.message}`);
                    logActivity({ source: "agent", summary: `AI agent spawn failed: ${err.message}`, actionLabel: "PROMPTED", reason: "user chat triggered agent spawn failed" });
                    stream.writeSSE({ data: JSON.stringify({ agentError: { label, error: err.message } }) }).catch(() => {});
                  }
                } else {
                  agentLog.warn(`Parsed JSON but missing "prompt" field: ${jsonMatch[0].slice(0, 200)}`);
                }
              } catch (err) {
                const snippet = jsonMatch[0].slice(0, 300).replace(/\n/g, " ");
                agentLog.error(` JSON parse failed: ${snippet}`);
                logActivity({ source: "agent", summary: `AGENT_REQUEST parse error`, detail: snippet });
              }
            }
            if (spawnCount === 0) {
              agentLog.warn(` ${rawAgentBlocks.length} block(s) found but 0 spawned — check server logs for block content`);
            }
          }

          // Check if AI requested board VIEW (read-only card rendering)
          // Parsed here (not by registry) because BOARD_VIEW uses a different tag than BOARD_ACTION,
          // but execution is routed through the board capability's "view" action.
          const boardViewRe = /\[BOARD_VIEW\]\s*(\{[\s\S]*?\})\s*(?:\[\/BOARD_VIEW\])?/g;
          const boardViewBlocks = [...fullResponse.matchAll(boardViewRe)];
          const boardViewPromises: Promise<void>[] = [];
          const boardViewResults: { query: string; issues: BoardIssue[] }[] = [];
          if (boardViewBlocks.length > 0) {
            // Strip blocks from visible response
            fullResponse = fullResponse.replace(/\s*\[BOARD_VIEW\][\s\S]*?\[\/BOARD_VIEW\]\s*/g, "").trim();
            fullResponse = fullResponse.replace(/\s*\[BOARD_VIEW\]\s*\{[\s\S]*?\}\s*/g, "").trim();

            for (const block of boardViewBlocks) {
              try {
                const req = JSON.parse(block[1]);
                boardViewPromises.push((async () => {
                  try {
                    const result = await boardCapability.execute(
                      { action: "view", ...req },
                      { origin: "chat" },
                    );
                    const issues = result.data as BoardIssue[] | undefined;
                    const viewLabel = req.stateType || req.filter || "board";
                    if (result.ok && issues && issues.length > 0) {
                      boardViewResults.push({ query: viewLabel, issues });
                      stream.writeSSE({
                        data: JSON.stringify({ boardItems: { issues: issuesToCardPayload(issues) } }),
                      }).catch(() => {});
                    } else if (result.ok) {
                      boardViewResults.push({ query: viewLabel, issues: [] });
                      // Empty result — send a system message so the agent/user know
                      stream.writeSSE({
                        data: JSON.stringify({ boardItems: { issues: [], empty: true } }),
                      }).catch(() => {});
                    }
                  } catch {
                    log.warn("BOARD_VIEW fetch error");
                  }
                })());
              } catch {
                log.warn("BOARD_VIEW parse error");
              }
            }
          }

          // Process capability action blocks (board, calendar, email, docs) via registry
          {
            const capReg = getCapabilityRegistry();
            if (capReg) {
              const blocks = capReg.parseActionBlocks(fullResponse);
              if (blocks.length > 0) {
                fullResponse = capReg.stripActionBlocks(fullResponse);
                // Fire-and-forget: execute action blocks
                (async () => {
                  for (const block of blocks) {
                    if (!block.payload) continue;
                    const def = capReg.get(block.capabilityId);
                    if (!def || def.pattern !== "action") continue;
                    try { await def.execute(block.payload, { origin: "chat" }); } catch {}
                  }
                })();
              }
            }
          }

          // Save assistant response to history (with AGENT_REQUEST + BOARD_ACTION + action blocks stripped)
          cs.history.push({ role: "assistant", content: fullResponse });
          persistSession();

          // Fire-and-forget: extract learnable facts from conversation
          cs.turnCount++;
          const recentMessages = cs.history.slice(-4);
          extractAndLearn({
            brain: cs.brain,
            recentMessages,
            userMessage: message,
            provider: resolveProvider(),
            model: resolveUtilityModel(),
            lastExtractionTurn: cs.lastExtractionTurn,
            currentTurn: cs.turnCount,
          }).then((result) => {
            if (result.extracted > 0) {
              logActivity({ source: "learn", summary: `Extracted ${result.extracted} fact(s)`, actionLabel: "PROMPTED", reason: "user conversation triggered learning" });
              cs.lastExtractionTurn = cs.turnCount;
            }
            if (result.error) {
              logActivity({ source: "learn", summary: `Extraction error: ${result.error}` });
            }
          }).catch(() => {});

          // Fire-and-forget: generate avatar video (TTS → MuseTalk → MP4)
          if (isAvatarAvailable() && isTtsAvailable() && fullResponse) {
            const trimmedText = fullResponse.slice(0, 2000);
            synthesize(trimmedText).then(async (wavBuffer) => {
              if (!wavBuffer) return;
              const cached = await getCachedVideo(wavBuffer);
              if (cached) { pushPendingVideo(cached); return; }
              const mp4 = await generateVideo(wavBuffer);
              if (!mp4) return;
              const filename = await cacheVideo(mp4, wavBuffer);
              pushPendingVideo(filename);
              logActivity({ source: "avatar", summary: "Generated avatar video", actionLabel: "PROMPTED", reason: "user conversation triggered avatar" });
            }).catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              logActivity({ source: "avatar", summary: `Avatar generation failed: ${msg}` });
            });
          }

          // Wait for board view fetches so boardItems SSE events reach the client
          // BEFORE resolve() closes the stream. Previously resolve() fired immediately,
          // racing with the async boardViewPromises — cards never reached the client.
          if (boardViewPromises.length > 0) {
            Promise.all(boardViewPromises).finally(() => {
              // Store board view results in history so next turn has context
              if (boardViewResults.length > 0) {
                const lines = boardViewResults.map((r) => {
                  if (r.issues.length === 0) {
                    return `Displayed 0 ${r.query} items to user.`;
                  }
                  const itemLines = r.issues.map((i) => `- ${i.identifier}: ${i.title} [${i.state || "unknown"}]`);
                  return `Displayed ${r.issues.length} ${r.query} item(s) to user:\n${itemLines.join("\n")}`;
                });
                cs.history.push({
                  role: "system",
                  content: `[BOARD_VIEW_RESULT]\n${lines.join("\n")}`,
                });
                persistSession();
              }
              stream.writeSSE({ data: JSON.stringify({ done: true }) }).catch(() => {});
              resolve();
            });
          } else {
            stream.writeSSE({ data: JSON.stringify({ done: true }) }).catch(() => {});
            resolve();
          }
        },
        onError: async (err) => {
          flushBuf2();
          reqSignal?.removeEventListener("abort", onAbort);
          // If this error is from an abort, save partial and exit quietly
          if (reqSignal?.aborted) {
            savePartial();
            logLlmCall({
              ts: new Date().toISOString(), mode: "stream",
              provider: activeProvider, model: streamModel2,
              durationMs: Math.round(performance.now() - streamStartMs2),
              outputTokens: Math.ceil(fullResponse.length / 4), ok: true, error: "client_abort",
            });
          } else {
            let errorMsg = err instanceof LLMError ? err.userMessage : (err.message || "Stream error");
            // Include raw detail for health drilldown — client shows this, not the friendly version
            const rawDetail = err instanceof LLMError
              ? `${err.provider} ${err.statusCode || ""}: ${err.message}`.trim()
              : (err.message || "Stream error");
            if (isPrivateMode() && /ECONNREFUSED|fetch failed|network|socket/i.test(errorMsg)) {
              const health = await checkOllamaHealth();
              if (!health.ok) errorMsg += " — Check that Ollama is running. " + health.message;
            }
            logLlmCall({
              ts: new Date().toISOString(), mode: "stream",
              provider: activeProvider, model: streamModel2,
              durationMs: Math.round(performance.now() - streamStartMs2),
              ok: false, error: errorMsg,
            });
            stream.writeSSE({ data: JSON.stringify({ error: errorMsg, errorDetail: rawDetail }) }).catch(() => {});
          }
          resolve(); // Still resolve so stream closes
        },
      });
    });
  });
});

// --- Freeze endpoint (operator clicks freeze link) ---

app.post("/api/freeze", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.signal) return c.json({ error: "Missing freeze signal" }, 400);

  const { freeze, isFrozen } = await import("./tier/freeze.js");
  if (isFrozen()) return c.json({ error: "Already frozen" }, 409);

  await freeze(body.signal, process.cwd());
  return c.json({ status: "frozen", message: "All agents dormant." });
});

app.post("/api/thaw", async (c) => {
  const { thaw } = await import("./tier/freeze.js");
  await thaw(process.cwd());
  return c.json({ status: "thawed", message: "Operations resuming." });
});

app.get("/api/freeze/status", async (c) => {
  const { isFrozen, getFreezeSignal } = await import("./tier/freeze.js");
  return c.json({ frozen: isFrozen(), signal: getFreezeSignal() });
});

// --- Brain import API ---

app.post("/api/import/folder", async (c) => {
  const body = await c.req.json() as { paths: string[]; dryRun?: boolean };
  if (!body.paths || !Array.isArray(body.paths) || body.paths.length === 0) {
    return c.json({ error: "paths[] required" }, 400);
  }

  const { resolve } = await import("node:path");
  const { importToBrain } = await import("./files/import.js");
  const result = await importToBrain({
    sources: body.paths.map(p => resolve(p)),
    brainRoot: process.cwd(),
    dryRun: body.dryRun ?? false,
  });

  // After import: fast pass → deep pass (both background, chained)
  if (!body.dryRun && result.imported > 0) {
    import("./files/index-local.js").then(({ indexImportedFiles }) => {
      indexImportedFiles({ localOnly: true })
        .then(() => import("./files/deep-index.js"))
        .then(({ runDeepIndex }) => runDeepIndex())
        .catch(() => {});
    });
  }

  return c.json(result);
});

app.post("/api/import/index", async (c) => {
  const { indexImportedFiles } = await import("./files/index-local.js");
  const result = await indexImportedFiles({ localOnly: true });

  // After fast pass, kick off deep index in background
  import("./files/deep-index.js").then(({ runDeepIndex }) => {
    runDeepIndex().catch(() => {});
  });

  return c.json(result);
});

app.post("/api/import/deep-index", async (c) => {
  const { runDeepIndex } = await import("./files/deep-index.js");
  const result = await runDeepIndex();
  return c.json(result);
});

app.get("/api/import/deep-index/progress", async (c) => {
  const { getDeepIndexProgress } = await import("./files/deep-index.js");
  return c.json(getDeepIndexProgress());
});

app.get("/api/import/deep-index/results", async (c) => {
  const { readFile: rf } = await import("node:fs/promises");
  const { join: jp } = await import("node:path");
  try {
    const raw = await rf(jp(BRAIN_DIR, ".core", "deep-index.json"), "utf-8");
    return c.json(JSON.parse(raw));
  } catch {
    return c.json({ entities: [], themes: [], crossRefs: [], flags: [], deepIndexed: [] });
  }
});

app.post("/api/import/files", async (c) => {
  const formData = await c.req.formData();
  const files = formData.getAll("files") as File[];
  if (files.length === 0) return c.json({ error: "No files provided" }, 400);

  const { mkdir: mkdirFs, writeFile: writeFs } = await import("node:fs/promises");
  const { join: joinPath } = await import("node:path");
  const ingestDir = joinPath(process.cwd(), "ingest");
  await mkdirFs(ingestDir, { recursive: true });

  const saved: string[] = [];
  for (const file of files) {
    if (!file.name) continue;
    const buffer = Buffer.from(await file.arrayBuffer());
    const dest = joinPath(ingestDir, file.name);
    await writeFs(dest, buffer);
    saved.push(file.name);
  }

  // Process the ingest folder immediately
  const { processIngestFolder } = await import("./files/ingest-folder.js");
  const ingestedDir = joinPath(process.cwd(), "ingested");
  const result = await processIngestFolder(ingestDir, ingestedDir);

  return c.json({
    saved: saved.length,
    files: saved,
    ingested: result.newFiles,
  });
});

// --- Startup ---

async function start(opts?: { tier?: import("./tier/types.js").TierName }) {
  const tier = opts?.tier ?? "byok";
  activeTier = tier;
  const tierGate = await import("./tier/gate.js");
  // Initialize instance name before anything else
  initInstanceName();

  // Initialize OpenTelemetry tracing (must be early, before instrumented code)
  initTracing({
    serviceName: `${getInstanceNameLower()}-brain`,
    serviceVersion: "0.1.0",
    consoleExport: process.env.OTEL_CONSOLE === "1",
  });

  // Load settings (airplane mode, model selection)
  const settings = await loadSettings();

  // Initialize posture system (UI surface assembly)
  await loadPosture();
  startDecayTimer();

  // Install fetch guard before any routes or outbound calls
  installFetchGuard();

  // Initialize PrivacyMembrane for reversible redaction
  activeSensitiveRegistry = new SensitiveRegistry();
  await activeSensitiveRegistry.load(BRAIN_DIR);
  const membrane = new PrivacyMembrane(activeSensitiveRegistry);
  setActiveMembrane(membrane);

  // Run independent initialization in parallel: LLM cache, auth, and sidecars
  const [, pairingCode, sidecarResults] = await Promise.all([
    // LLM response cache (file-backed in .core/cache/, 1-hour TTL)
    initLLMCache({ projectRoot: process.cwd(), metrics: metricsStore }),
    // Pairing + session restoration (sequential within, parallel with others)
    (async () => {
      const code = await ensurePairingCode();
      const restored = await restoreSession();
      if (restored) {
        sessionKeys.set(restored.session.id, restored.sessionKey);
        setEncryptionKey(restored.sessionKey);
        await loadVault(restored.sessionKey);
        log.info("Session restored (no re-auth needed)");
      }
      return code;
    })(),
    // Start all sidecars in parallel
    Promise.all([startSidecar(), startTtsSidecar(), startSttSidecar()]),
  ]);
  const code = pairingCode;
  const [searchAvailable, ttsAvailable, sttAvailable] = sidecarResults;

  // Load paired mobile devices
  await loadPairedDevices();

  // Register with runcore.sh relay (fire-and-forget, non-blocking)
  (async () => {
    try {
      const { createHash } = await import("node:crypto");
      const instanceHash = createHash("sha256")
        .update(getInstanceName() + BRAIN_DIR)
        .digest("hex")
        .slice(0, 16);
      await fetch("https://runcore.sh/api/relay/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instanceHash,
          displayName: getInstanceName(),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      log.info("Registered with runcore.sh relay", { instanceHash });

      // Start polling relay for incoming phone messages
      startRelayPoll(instanceHash);
    } catch {
      log.debug("Relay registration skipped (offline or unreachable)");
    }
  })();

  // Pre-warm notification queue from disk (encryption key is set by now)
  const notifCount = await initNotifications();
  if (notifCount > 0) log.info(`Loaded ${notifCount} pending notification(s) from disk`);

  // Register sidecar health checks (optional — degraded, not unhealthy)
  health.register("search", availabilityCheck(isSidecarAvailable, "search"), { critical: false });
  health.register("tts", availabilityCheck(isTtsAvailable, "tts"), { critical: false });
  health.register("stt", availabilityCheck(isSttAvailable, "stt"), { critical: false });

  // Google Workspace health checks (optional — degraded if not connected)
  health.register("google_calendar", availabilityCheck(isCalendarAvailable, "Google Calendar"), { critical: false });

  // Initialize FileManager (file registry + storage for uploads, visual memory, etc.)
  await FileManager.init(BRAIN_DIR, join(BRAIN_DIR, "files", "storage"));

  // Initialize Library store (virtual folders over file registry)
  createLibraryStore(BRAIN_DIR);
  initBrainShadow(BRAIN_DIR);

  // Initialize Brain RAG (semantic file search)
  const rag = new BrainRAG();
  await rag.load();
  setBrainRAG(rag);
  stopFileWatcher = watchBrain(rag);
  // Background index — never block startup
  rag.indexAll().then((r) => {
    log.info(`Brain RAG index: ${r.indexed} indexed, ${r.skipped} skipped, ${r.errors} errors`);
  }).catch((err) => {
    log.error("Brain RAG indexAll failed", { error: err instanceof Error ? err.message : String(err) });
  });

  // Register board provider (local queue, always available)
  const queueProvider = new QueueBoardProvider(BRAIN_DIR);
  queueProvider.setOnProjectlessTask((identifier, title) => {
    escalateProjectlessTask(identifier, title);
  });
  setBoardProvider(queueProvider);
  queueProvider.getStore().setOnStateTransition(async (task, from, to) => {
    if (to === "done" || to === "cancelled") {
      try {
        await rememberTaskCompletion(task, from);
      } catch (err) {
        log.warn("Failed to record task completion memory", {
          identifier: task.identifier,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });
  startGroomingTimer(queueProvider.getStore());
  const schedulingStore = createSchedulingStore(BRAIN_DIR);
  startSchedulingTimer(schedulingStore);
  createContactStore(BRAIN_DIR);
  createCalendarStore(BRAIN_DIR);
  const credStore = createCredentialStore(BRAIN_DIR);
  await credStore.hydrate();
  initTraining();
  initGitHub();

  // Start metrics collector (system, HTTP, agent metrics at 30s interval)
  // brainDir enables tiered aggregation (hourly/daily rollups)
  startCollector(metricsStore, undefined, BRAIN_DIR);

  // Initialize skills registry, module registry, agent system, and runtime in parallel.
  // createRuntime() (registry load + agent recovery) is I/O-bound and independent
  // of skills/module init, so running them concurrently improves startup time (DASH-60).
  // Note: initAgents() only creates directories — recovery runs after the runtime
  // is ready so the monitor can skip runtime-managed tasks (DASH-82 fix).
  const [, moduleRegistry, , runtime] = await Promise.all([
    _skillRegistry.refresh(),
    Promise.resolve(createModuleRegistry(BRAIN_DIR)),
    initAgents(),
    createRuntime(),
  ]);
  const skillRegistry = _skillRegistry;

  // Recover tasks from previous session AFTER runtime is initialized.
  // The monitor checks the runtime registry to skip tasks that RuntimeManager
  // already handles, preventing the double-recovery race (DASH-82).
  await recoverAndStartMonitor();

  tracer.attachToBus(runtime.bus);
  attachOTelToBus(runtime.bus);

  // Initialize capability registry (action blocks + context providers)
  const capRegistry = createCapabilityRegistry();
  capRegistry.register(calendarCapability);
  capRegistry.register(emailCapability);
  capRegistry.register(docsCapability);
  capRegistry.register(boardCapability);
  capRegistry.register(browserCapability);
  // Meta capabilities
  capRegistry.register(taskDoneCapability);
  // Context providers — replace hardcoded injection logic
  capRegistry.register(calendarContextProvider);
  capRegistry.register(emailContextProvider);
  capRegistry.register(createWebSearchContextProvider({
    isAvailable: isSearchAvailable,
    classify: (msg) => classifySearchNeed(msg, resolveProvider(), resolveUtilityModel()),
    search,
  }));
  capRegistry.register(vaultContextProvider);

  // Start autonomous work timer (60-min coma failsafe — primary trigger is now tension-based)
  startAutonomousTimer();

  // Initialize metabolic pulse (tension-based heartbeat)
  const pulseSettings = getPulseSettings();
  if (pulseSettings.mode !== "timer") {
    const pulse = initPressureIntegrator(triggerPulse, { threshold: pulseSettings.threshold });
    log.info(`Metabolic pulse initialized: Θ=${pulseSettings.threshold}mV, mode=${pulseSettings.mode}`);

    // Boot scan: if todos already exist, inject tension so Core starts working immediately
    const todoCount = (await queueProvider.getStore().list()).filter((t) => t.state === "todo").length;
    if (todoCount > 0) {
      pulse.addTension("board", `Boot: ${todoCount} todo(s) waiting`);
      log.info(`Boot tension: ${todoCount} todo(s) found — pulse should fire`);
    }
  }

  // Initialize nerve push notifications (VAPID keys + subscriptions)
  try {
    await initPush();
    startPushMonitor(getNerveState, 30_000);
    log.info("Nerve push notifications ready (monitoring every 30s)");
  } catch (err) {
    log.warn("Nerve push init failed — push notifications disabled", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Start weekly backlog review timer (runs every Friday — DASH-59)
  startBacklogReviewTimer(queueProvider.getStore());

  // Start daily morning briefing timer (DASH-44)
  startBriefingTimer(queueProvider.getStore(), {
    smsTo: process.env.BRIEFING_SMS_TO?.split(",").filter(Boolean),
    emailTo: process.env.BRIEFING_EMAIL_TO?.split(",").filter(Boolean),
    whatsappTo: process.env.BRIEFING_WHATSAPP_TO?.split(",").filter(Boolean),
    briefingHour: process.env.BRIEFING_HOUR ? parseInt(process.env.BRIEFING_HOUR, 10) : undefined,
  });

  // Start trace insight analysis timer (builds trace chains, discovers patterns)
  startInsightsTimer();

  // Start open loop scanner (ambient resonance matching)
  startOpenLoopScanner();

  // Start Google polling timers at boot if already authenticated (don't wait for first chat)
  if (isGmailAvailable()) startGmailTimer();
  if (isCalendarAvailable()) {
    startCalendarTimer();
    // Initial sync: pull Google events into local calendar store
    getGoogleCalendarAdapter().sync().catch((err) => {
      log.warn("Initial Google Calendar sync failed", { error: err instanceof Error ? err.message : String(err) });
    });
  }
  if (isTasksAvailable()) startTasksTimer();

  // Initialize plugin registry (authenticate + start all registered plugins)
  await initPlugins().catch((err) => {
    log.warn("Plugin init failed", { error: err instanceof Error ? err.message : String(err) });
  });

  // Wire batch continuation: when all agents finish, commit + decide what's next (direct LLM, no HTTP)
  setOnBatchComplete(async (sessionId, results) => {
    try {
      logActivity({ source: "agent", summary: `Batch complete: session=${sessionId}, ${results.length} result(s)` });
      await continueAfterBatch(sessionId, results);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logActivity({ source: "agent", summary: `Continuation error: ${msg}` });
    }
  });

  // Initialize agent spawning — tier >= spawn only
  if (tierGate.canSpawn(tier)) {
    // Initialize instance manager (GC, health checks, load balancing)
    instanceManager = new AgentInstanceManager(runtime);
    await instanceManager.init();

    // Initialize agent pool (circuit breakers, isolation, resource management)
    agentPool = AgentPool.fromExisting(runtime, instanceManager);
    setAgentPool(agentPool);

    // Initialize workflow engine for multi-agent coordination
    workflowEngine = new WorkflowEngine(agentPool);
    await workflowEngine.loadAllDefinitions().catch((err) => {
      log.warn("Failed to load workflow definitions", { error: err instanceof Error ? err.message : String(err) });
    });
    log.info(`Agent spawning enabled (tier: ${tier})`);
  } else {
    log.info(`Agent spawning disabled (tier: ${tier} — requires spawn tier)`);
  }

  // --- Register component health checks (after all systems initialized) ---

  // Queue store: can we read the JSONL file?
  health.register("queue", queueStoreCheck(() => queueProvider.getStore()), { critical: false });

  // Board provider: is it registered and available?
  health.register("board", boardCheck(() => getBoardProvider()), { critical: false });

  // Agent runtime capacity: resource utilization
  health.register("agent_capacity", agentCapacityCheck(() => {
    const rt = getRuntime();
    return rt ? rt.getResourceSnapshot() : null;
  }), { critical: false });

  // Agent instance health: aggregate health scores
  health.register("agent_health", agentHealthCheck(() => {
    return instanceManager ? instanceManager.getHealthSummary() : null;
  }), { critical: false });

  // --- Register auto-recovery actions ---

  // Sidecar recovery: restart if unavailable for 3+ checks
  recovery.register(sidecarRecovery("search", "search", stopSidecar, startSidecar));
  recovery.register(sidecarRecovery("tts", "tts", stopTtsSidecar, startTtsSidecar));
  recovery.register(sidecarRecovery("stt", "stt", stopSttSidecar, startSttSidecar));

  // Start recovery loop (evaluates every 30s)
  recovery.start();

  // Start alert evaluation loop (evaluates every 30s)
  alertManager.start();

  // Wire notification channels — tier >= byok only (requires BYOK API keys)
  if (tierGate.canAlert(tier)) {
    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      alertDispatcher.add(new EmailChannel({
        endpoint: "https://api.resend.com/emails",
        apiKey: resendKey,
        from: `${getInstanceName()} <${getAlertEmailFrom()}>`,
        to: [resolveEnv("ALERT_EMAIL_TO") ?? ""].filter(Boolean),
      }));
      log.info("Alert channel: email (Resend)");
    }
    if (process.env.TWILIO_ACCOUNT_SID) {
      alertDispatcher.add(new PhoneChannel());
      log.info("Alert channel: phone (Twilio voice)");
    }
    alertManager.updateNotifications([
      { channel: "email", minSeverity: "warning" },
      { channel: "phone", minSeverity: "critical" },
    ]);
  }

  // Start credit monitoring (checks every 5 min, configurable via CORE_CREDIT_CHECK_INTERVAL_MS)
  startCreditMonitor(health, alertManager);

  // Avatar sidecar launches in background — slow (model loading) but non-blocking
  const avatarConfig = getAvatarConfig();
  let avatarAvailable = false;
  (async () => {
    avatarAvailable = await startAvatarSidecar();
    if (avatarAvailable) {
      const photoPath = join(process.cwd(), avatarConfig.photoPath);
      const prepared = await preparePhoto(photoPath).catch(() => false);
      if (!prepared) {
        log.warn("Photo preparation failed — place a photo at " + avatarConfig.photoPath, { namespace: "avatar" });
      } else {
        log.info("Avatar ready — MuseTalk sidecar (port " + avatarConfig.port + ")", { namespace: "avatar" });
      }
    }
  })();

  log.info(`${getInstanceName()} — Local Chat starting`);

  // Show LLM provider based on settings
  const provider = resolveProvider();
  if (settings.privateMode) {
    log.info("Mode: PRIVATE (network-isolated), LLM: Ollama only — cloud providers blocked");
    // Fail loudly at startup if Ollama isn't available in private mode
    try {
      const { assertOllamaAvailable } = await import("./llm/guard.js");
      await assertOllamaAvailable();
      log.info("Ollama: reachable ✓");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(msg);
      throw new Error("Cannot start in privateMode without Ollama. " + msg);
    }
  } else if (settings.airplaneMode) {
    log.info("Mode: Airplane (local only), LLM: Ollama");
  } else {
    log.info("Mode: Cloud, LLM: OpenRouter");
  }
  if (settings.models.chat !== "auto") log.info(`Chat model: ${settings.models.chat}`);
  if (settings.models.utility !== "auto") log.info(`Utility model: ${settings.models.utility}`);

  // Show search status (vault keys aren't loaded until auth, so Perplexity may activate later)
  if (searchAvailable) {
    log.info("Search: DuckDuckGo sidecar (port " + SIDECAR_PORT + ") + Perplexity if vault key set");
  } else {
    log.info("Search: awaiting auth (Perplexity via vault, or: cd sidecar/search && pip install -r requirements.txt)");
  }

  // Show voice status
  const ttsConfig = getTtsConfig();
  const sttConfig = getSttConfig();
  if (ttsAvailable) {
    log.info(`TTS: Piper sidecar (port ${ttsConfig.port})`);
  } else if (ttsConfig.enabled) {
    log.info("TTS: not available (pip install piper-tts — see sidecar/tts/setup.md)");
  } else {
    log.info("TTS: disabled");
  }
  if (sttAvailable) {
    log.info(`STT: Whisper sidecar (port ${sttConfig.port})`);
  } else if (sttConfig.enabled) {
    log.info("STT: not available (see sidecar/stt/setup.md)");
  } else {
    log.info("STT: disabled");
  }
  if (avatarConfig.enabled) {
    log.info(`Avatar: MuseTalk sidecar loading in background (port ${avatarConfig.port})`);
  } else {
    log.info("Avatar: disabled");
  }

  // Show runtime status
  const rt = getRuntime();
  if (rt) {
    const snap = rt.getResourceSnapshot();
    log.info(`Runtime: active (${snap.activeAgents}/${snap.maxAgents} agents, ${snap.totalMemoryMB}/${snap.maxMemoryMB}MB)`);
  }

  // Show Google integration status
  if (isGoogleAuthenticated()) {
    log.info("Google: connected (Calendar, Gmail, Drive)");
  } else if (isGoogleConfigured()) {
    log.info("Google: configured — visit /api/google/auth to connect");
  } else {
    log.info("Google: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in vault to enable");
  }

  // Show skills registry status
  {
    const allSkills = await skillRegistry.list();
    log.info(`Skills: ${allSkills.length} registered`);
  }

  // Show module registry status
  if (moduleRegistry) {
    const names = moduleRegistry.list().map((m) => m.manifest.name);
    log.info(`ModuleRegistry: discovered ${moduleRegistry.size} modules (${names.join(", ")})`);
  }

  // Show board provider status
  const board = getBoardProvider();
  if (board) {
    const taskCount = await queueProvider.getStore().count();
    log.info(`Board: ${board.name} (local, ${taskCount} tasks)`);
  }

  // Sync UI from CDN (non-blocking — falls back to bundled if offline)
  syncUi().then(({ source, revision }) => {
    if (source === "cdn") {
      UI_DIR = getUiPublicDir(PKG_ROOT);
      log.info(`UI synced from CDN: revision ${revision}`);
    } else {
      log.info(`UI source: ${source}${revision ? ` (revision ${revision})` : ""}`);
    }
  }).catch(() => {});

  // Generate startup token for zero-friction local auth
  const { randomBytes: rng } = await import("node:crypto");
  startupToken = rng(32).toString("hex");

  // Warm up local model in background (non-blocking)
  import("./llm/ollama.js").then(({ warmupOllama }) => warmupOllama()).catch(() => {});

  if (code) {
    log.info(`First launch detected. Pairing code: ${code}`);
  } else {
    const human = await readHuman();
    if (human) {
      log.info(`Paired with: ${human.name}`);
    }
  }

  // Register email handler — emails with instance name in subject are processed as chat
  onDashEmail(async (message) => {
    const human = await readHuman();
    const name = human?.name ?? "Human";
    const emailBody = message.body?.trim();
    if (!emailBody) return null;

    // Build a lightweight Brain for email context
    const ltm = new FileSystemLongTermMemory(MEMORY_DIR);
    await ltm.init();
    const emailBrain = new Brain(
      {
        systemPrompt: [
          `You are ${getInstanceName()}, a personal AI agent paired with ${name}. You run locally on ${name}'s machine.`,
          `Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`,
          `You are responding to an email that was sent to you. This is a working email channel — you received this email and your reply will be sent back automatically via Gmail.`,
          ``,
          `Your capabilities — USE THEM when the email requests action:`,
          `- Google Calendar: CREATE, UPDATE, DELETE events using [CALENDAR_ACTION] blocks.`,
          `- Gmail: SEND emails and REPLY to threads using [EMAIL_ACTION] blocks.`,
          `- Google Docs & Sheets: CREATE documents using [DOC_ACTION] blocks.`,
          `- Task board for tracking work.`,
          `- Long-term memory of past conversations and learned facts.`,
          ``,
          ...(getCapabilityRegistry()?.getPromptInstructions({ origin: "email", name }) ?? "").split("\n"),
          ``,
          `Rules for email replies:`,
          `- Write a natural, helpful reply as plain text (no markdown).`,
          `- Be warm and direct — you have personality, you're not a corporate assistant.`,
          `- Keep it concise and appropriate for email.`,
          `- Do not include a subject line. Just write the body of the reply.`,
          `- NEVER claim you can't do something you clearly just did (you ARE sending this email).`,
          `- When someone asks you to DO something (schedule, create, send), DO IT with the appropriate action block — don't just acknowledge it.`,
          `- Action blocks will be stripped from the email reply automatically. The recipient only sees your text.`,
          `- Sign off as "— ${getInstanceName()}"`,
        ].join("\n"),
      },
      ltm,
    );

    const senderName = message.from.split("<")[0].trim() || "someone";
    const ctx = await emailBrain.getContextForTurn({
      userInput: emailBody,
      conversationHistory: [],
    });

    // Inject email metadata so the agent knows the context
    ctx.messages.splice(1, 0, {
      role: "system" as const,
      content: [
        `--- Incoming email ---`,
        `From: ${message.from}`,
        `Subject: ${message.subject}`,
        `Date: ${message.date}`,
        `--- End email metadata ---`,
      ].join("\n"),
    });

    // Add the email body as the "user" message
    ctx.messages.push({ role: "user", content: emailBody });

    const provider = getProvider(resolveProvider());
    const model = resolveChatModel();
    let reply = await provider.completeChat(ctx.messages, model ?? undefined);

    if (!reply?.trim()) return null;

    // Process action blocks from the AI response via capability registry
    {
      const capReg = getCapabilityRegistry();
      if (capReg) {
        const { cleaned } = await capReg.processResponse(reply, { origin: "email", name });
        reply = cleaned;
      }
    }

    // Guard: if stripping action blocks left only a signature,
    // the reply has no real content — don't send an empty email.
    const signaturePattern = new RegExp(`[\\s\\n]*[—\\-]+\\s*${getInstanceName()}[\\s.!]*$`, "i");
    const withoutSignature = reply.replace(signaturePattern, "").trim();
    if (!withoutSignature) {
      log.warn("Email reply was empty after stripping action blocks — not sending", { to: message.from, subject: message.subject });
      return null;
    }

    log.info("Email reply generated", { to: message.from, subject: message.subject, replyLength: reply.length });
    return reply.trim();
  });
  log.info(`${getInstanceName()} email handler registered — emails with '${getInstanceName()}' in subject will be auto-replied`);

  await new Promise<void>((resolve) => {
    function onListening(server: ReturnType<typeof serve>) {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        actualPort = addr.port;
      }
      log.info(`Listening on http://localhost:${actualPort}`);
      acquireLock(actualPort, getInstanceName());
      console.log(`\n  ${getInstanceName()} is running:\n`);
      console.log(`  → http://localhost:${actualPort}\n`);

      // Show LAN IP for phone access
      try {
        import("node:os").then(({ networkInterfaces }) => {
          const nets = networkInterfaces();
          for (const name of Object.keys(nets)) {
            for (const net of nets[name] ?? []) {
              if (net.family === "IPv4" && !net.internal) {
                console.log(`  → http://${net.address}:${actualPort}  (LAN)\n`);
              }
            }
          }
        });
      } catch { /* ok */ }

      // Announce on LAN if mesh.lanAnnounce is enabled AND tier >= byok
      if (tierGate.canMesh(tier) && getMeshConfig().lanAnnounce) {
        try {
          startMdns(actualPort);
        } catch (err) {
          log.warn("mDNS announcement failed — discovery disabled", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      resolve();
    }

    try {
      const server = serve({ fetch: app.fetch, port: PORT }, () => onListening(server));
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && PORT !== 0) {
          log.warn(`Port ${PORT} in use, falling back to random port`);
          const fallback = serve({ fetch: app.fetch, port: 0 }, () => onListening(fallback));
        } else {
          throw err;
        }
      });
    } catch (err) {
      // If serve() throws synchronously (unlikely but safe)
      if (PORT !== 0) {
        log.warn(`Port ${PORT} failed, falling back to random port`);
        const fallback = serve({ fetch: app.fetch, port: 0 }, () => onListening(fallback));
      } else {
        throw err;
      }
    }
  });
}

/** Returns the port the server is actually listening on (resolves port 0). */
export function getActualPort(): number {
  return actualPort;
}

export { start };

const isDirectRun = process.argv[1]?.replace(/\\/g, "/").includes("server");
if (isDirectRun) {
  start().catch((err) => {
    log.error("Failed to start", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}

// --- Roadmap YAML parser ---

interface RoadmapPhase { id: string; label: string; start: string; end: string; }
interface RoadmapStream { id: string; name: string; color: string; description: string; parent?: string; }
interface RoadmapMilestone { id: string; stream: string; title: string; phase: string; status: string; target?: string; depends_on?: string[]; }
interface Roadmap { phases: RoadmapPhase[]; streams: RoadmapStream[]; milestones: RoadmapMilestone[]; layout?: { mode: string }; }

function parseRoadmapYaml(raw: string): Roadmap {
  const result: Roadmap = { phases: [], streams: [], milestones: [] };
  const lines = raw.split("\n");
  let section: "phases" | "streams" | "milestones" | "layout" | null = null;
  let currentObj: Record<string, unknown> | null = null;

  function flush() {
    if (currentObj && section && section !== "layout") {
      (result[section] as unknown as Record<string, unknown>[]).push(currentObj);
      currentObj = null;
    }
  }

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    // Top-level section headers
    if (/^layout:\s*$/.test(trimmed)) { flush(); section = "layout"; result.layout = {} as { mode: string }; continue; }
    if (/^phases:\s*$/.test(trimmed)) { flush(); section = "phases"; continue; }
    if (/^streams:\s*$/.test(trimmed)) { flush(); section = "streams"; continue; }
    if (/^milestones:\s*$/.test(trimmed)) { flush(); section = "milestones"; continue; }

    if (!section) continue;

    // Layout is a flat object, not an array
    if (section === "layout") {
      const kvMatch = trimmed.match(/^\s+(\w+)\s*:\s*(.*)/);
      if (kvMatch && result.layout) {
        (result.layout as Record<string, string>)[kvMatch[1]] = kvMatch[2].replace(/^["']|["']$/g, "").trim();
      }
      continue;
    }

    // New list item: "  - key: value"
    const newItemMatch = trimmed.match(/^\s+-\s+(\w+)\s*:\s*(.*)/);
    if (newItemMatch) {
      flush();
      currentObj = {};
      const key = newItemMatch[1];
      const val = newItemMatch[2].replace(/^["']|["']$/g, "").trim();
      if (val.startsWith("[")) {
        // Inline array: [a, b, c]
        currentObj[key] = val.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
      } else {
        currentObj[key] = val;
      }
      continue;
    }

    // Continuation key: "    key: value"
    if (currentObj) {
      const kvMatch = trimmed.match(/^\s+(\w+)\s*:\s*(.*)/);
      if (kvMatch) {
        const key = kvMatch[1];
        const val = kvMatch[2].replace(/^["']|["']$/g, "").trim();
        if (val.startsWith("[")) {
          currentObj[key] = val.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
        } else {
          currentObj[key] = val;
        }
      }
    }
  }
  flush();

  return result;
}

// Graceful shutdown: agent pool first (drains queue, terminates agents, cleans resources),
// then sidecars, timers, and monitors.
async function gracefulShutdown(signal: string): Promise<void> {
  // Agent pool handles coordinated shutdown: drain → terminate → cleanup
  if (workflowEngine) {
    await workflowEngine.shutdown().catch(() => {});
    workflowEngine = null;
  }
  if (agentPool) {
    await agentPool.shutdown(signal).catch(() => {});
    setAgentPool(null);
    agentPool = null;
  } else {
    // Fallback if pool wasn't initialized
    await instanceManager?.shutdown().catch(() => {});
    await shutdownRuntime(signal).catch(() => {});
  }
  recovery.stop();
  stopCollector();
  stopGmailTimer();
  stopCalendarTimer();
  stopTasksTimer();
  stopGroomingTimer();
  stopSchedulingTimer();
  shutdownGitHub();
  stopGoalTimer();
  stopAutonomousTimer();
  stopBacklogReviewTimer();
  stopBriefingTimer();
  stopInsightsTimer();
  stopOpenLoopScanner();
  stopCreditMonitor();
  stopPushMonitor();
  stopMdns();
  stopFileWatcher();
  stopAvatarSidecar();
  stopTtsSidecar();
  stopSttSidecar();
  stopSidecar();
  await closeBrowser();
  shutdownAgents();
  await shutdownPlugins().catch(() => {});
  await shutdownLLMCache();
  await shutdownTracing();
  releaseLock();
  process.exit(0);
}
process.on("SIGINT", () => { gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { gracefulShutdown("SIGTERM"); });

// Crash diagnostics — write to file since terminal output may be lost on tsx watch restart
process.on("uncaughtException", (err) => {
  const msg = `[${new Date().toISOString()}] UNCAUGHT: ${err.stack ?? err.message}\n`;
  try { writeFileSync(join(BRAIN_DIR, "ops", "crash.log"), msg, { flag: "a" }); } catch {}

  // EPIPE = broken pipe from stdout/stderr (e.g. tsx watch restart).
  // Transient I/O error — not application corruption. Log and continue.
  if ((err as NodeJS.ErrnoException).code === "EPIPE") {
    return;
  }

  log.error("Uncaught exception", { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  const msg = `[${new Date().toISOString()}] UNHANDLED_REJECTION: ${err.stack ?? err.message}\n`;
  try { writeFileSync(join(BRAIN_DIR, "ops", "crash.log"), msg, { flag: "a" }); } catch {}
  log.error("Unhandled rejection", { error: err.message, stack: err.stack });
});
