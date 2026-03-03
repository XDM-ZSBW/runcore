/**
 * Core local chat server.
 * Hono app: serves static UI, handles pairing/auth, streams chat via Ollama (local) or OpenRouter (cloud).
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { initInstanceName, getInstanceName, getInstanceNameLower, resolveEnv, getAlertEmailFrom } from "./instance.js";

import { readBrainFile, writeBrainFile, appendBrainLine } from "./lib/brain-io.js";
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
} from "./auth/identity.js";
import { streamChat } from "./llm/openrouter.js";
import { streamChatLocal } from "./llm/ollama.js";
import { getProvider } from "./llm/providers/index.js";
import type { StreamOptions } from "./llm/providers/types.js";
import { withStreamRetry } from "./llm/retry.js";
import { LLMError } from "./llm/errors.js";
import {
  loadSettings,
  getSettings,
  updateSettings,
  resolveProvider,
  resolveChatModel,
  resolveUtilityModel,
  getPulseSettings,
} from "./settings.js";
import { ingestDirectory } from "./files/ingest.js";
import { processIngestFolder } from "./files/ingest-folder.js";
import { saveSession, loadSession } from "./sessions/store.js";
import { extractAndLearn } from "./learning/extractor.js";
import { startSidecar, stopSidecar, isSidecarAvailable } from "./search/sidecar.js";
import { classifySearchNeed } from "./search/classify.js";
import { findBrainDocument } from "./search/brain-docs.js";
import { isSearchAvailable, search } from "./search/client.js";
import { browseUrl, detectUrl } from "./search/browse.js";
import { startTtsSidecar, stopTtsSidecar } from "./tts/sidecar.js";
import { isTtsAvailable, synthesize } from "./tts/client.js";
import { startSttSidecar, stopSttSidecar } from "./stt/sidecar.js";
import { isSttAvailable, transcribe } from "./stt/client.js";
import { startAvatarSidecar, stopAvatarSidecar, isAvatarAvailable } from "./avatar/sidecar.js";
import { preparePhoto, generateVideo, getCachedVideo, cacheVideo, clearVideoCache } from "./avatar/client.js";
import { getTtsConfig, getSttConfig, getAvatarConfig } from "./settings.js";
import { loadVault, listVaultKeys, setVaultKey, deleteVaultKey, getDashReadableVault, getVaultEntries } from "./vault/store.js";
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
import { createSkillRegistry, getSkillRegistry } from "./skills/index.js";
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

const PORT = parseInt(resolveEnv("PORT") ?? "3577", 10);
const SIDECAR_PORT = resolveEnv("SEARCH_PORT") ?? "3578";
const BRAIN_DIR = join(process.cwd(), "brain");
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
}

const chatSessions = new Map<string, ChatSession>();
const sessionKeys = new Map<string, Buffer>();
let goalTimerStarted = false;

/** Autonomous timer started flag. */
let autonomousStarted = false;
const tracer = new Tracer();
let instanceManager: AgentInstanceManager | null = null;
let agentPool: AgentPool | null = null;
let workflowEngine: WorkflowEngine | null = null;

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

  // Read custom personality instructions (empty string if file doesn't exist)
  let personality = "";
  try {
    personality = (await readBrainFile(PERSONALITY_PATH)).trim();
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
        `You are ${getInstanceName()}, a personal AI agent. You just came into existence and paired with your human partner, ${name}.`,
        ``,
        `CRITICAL RULES:`,
        `- NEVER invent information. You have no knowledge of reports, accounts, schedules, or tasks unless they appear in the context below.`,
        `- If context is provided below, reference ONLY that. If no context is provided, you know nothing yet — and that's okay.`,
        `- This is a new relationship. You and ${name} are just getting to know each other. Be curious. Ask real questions.`,
        `- Be warm, honest, and direct. Have personality. Don't be a corporate assistant.`,
        `- If you don't know something, say so plainly. Never fabricate details to seem helpful.`,
        `- NEVER reference board items, tasks, backlog items, or project work unless they appear verbatim in injected context below. If no "board issues" section is present, you know NOTHING about the board — do not guess, summarize from memory, or invent items.`,
        `- NEVER claim you searched the web unless "Web search results" appear in your context. If no search results are present, you did NOT search.`,
        ``,
        `You are running locally on ${name}'s machine. This conversation is private.`,
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
        ``,
        `## Security: encrypted memories`,
        `Some of your memories (experiences, decisions, failures) are encrypted at rest. They are only available when ${name} has authenticated with the safe word.`,
        `You do NOT know the safe word. NEVER guess, reveal, or claim to know it. If ${name} asks about it, tell them the safe word is verified at the system level, not by you.`,
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
      cs = { history: restored.history, historySummary: restored.historySummary ?? "", brain, fileContext: restored.fileContext, learnedPaths: restored.learnedPaths, ingestedContext, turnCount: 0, lastExtractionTurn: 0, foldedBack: false };
      chatSessions.set(sessionId, cs);
      return cs;
    }
  }

  cs = { history: [], historySummary: "", brain, fileContext: "", learnedPaths: [], ingestedContext, turnCount: 0, lastExtractionTurn: 0, foldedBack: false };
  chatSessions.set(sessionId, cs);
  return cs;
}

// --- App ---

const app = new Hono();

// Global error handler — return JSON with details instead of plain "Internal Server Error"
app.onError((err, c) => {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  log.error("Unhandled route error", { error: msg, stack, path: c.req.path, method: c.req.method });
  return c.json({ error: msg }, 500);
});

// Serve static files from public/
app.use("/public/*", serveStatic({ root: "./" }));

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

// Serve index.html at root
app.get("/", async (c) => {
  const html = await serveHtmlTemplate(join(process.cwd(), "public", "index.html"));
  return c.html(html);
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

// --- Webhook initialization (batch registration + config + admin routes) ---

const webhookInitStart = performance.now();

// Phase 1: Batch-register all webhook providers (deferred from module imports to avoid
// 5 individual logActivity calls during startup — now a single batch call).
const registerStart = performance.now();
registerProviders([githubProvider, slackEventsProvider, slackCommandsProvider, slackInteractionsProvider, twilioProvider]);
const registerMs = performance.now() - registerStart;

// Phase 2: Configure webhook providers (secrets resolved from env vars)
const configStart = performance.now();
setProviderConfigs([
  { name: "slack-events", secret: "SLACK_SIGNING_SECRET", signatureHeader: "x-slack-signature", algorithm: "slack-v0", path: "/api/slack/events" },
  { name: "slack-commands", secret: "SLACK_SIGNING_SECRET", signatureHeader: "x-slack-signature", algorithm: "slack-v0", path: "/api/slack/commands" },
  { name: "slack-interactions", secret: "SLACK_SIGNING_SECRET", signatureHeader: "x-slack-signature", algorithm: "slack-v0", path: "/api/slack/interactions" },
  { name: "twilio", secret: "TWILIO_AUTH_TOKEN", signatureHeader: "x-twilio-signature", algorithm: "twilio", path: "/api/twilio/whatsapp" },
  { name: "github", secret: "GITHUB_WEBHOOK_SECRET", signatureHeader: "x-hub-signature-256", algorithm: "hmac-sha256-hex", path: "/api/github/webhooks" },
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

// Status: what screen should the UI show?
app.get("/api/status", async (c) => {
  const status = await getStatus();
  const settings = getSettings();
  return c.json({
    ...status,
    provider: resolveProvider(),
    airplaneMode: settings.airplaneMode,
    safeWordMode: settings.safeWordMode,
    search: isSearchAvailable(),
    tts: isTtsAvailable(),
    stt: isSttAvailable(),
    avatar: isAvatarAvailable(),
  });
});

// Pairing ceremony
app.post("/api/pair", async (c) => {
  const body = await c.req.json();
  const { code, name, safeWord, recoveryQuestion, recoveryAnswer } = body;

  if (!code || !name || !safeWord || !recoveryQuestion || !recoveryAnswer) {
    return c.json({ error: "All fields required" }, 400);
  }

  const result = await pair({ code, name, safeWord, recoveryQuestion, recoveryAnswer });
  if ("error" in result) {
    return c.json({ error: result.error }, 400);
  }

  sessionKeys.set(result.session.id, result.sessionKey);
  setEncryptionKey(result.sessionKey);
  cacheSessionKey(result.sessionKey);
  await loadVault(result.sessionKey);
  return c.json({ sessionId: result.session.id, name: result.session.name });
});

// Auth: return visit
app.post("/api/auth", async (c) => {
  const body = await c.req.json();
  const { safeWord } = body;

  if (!safeWord) {
    return c.json({ error: "Safe word required" }, 400);
  }

  const result = await authenticate(safeWord);
  if ("error" in result) {
    return c.json({ error: result.error }, 401);
  }

  sessionKeys.set(result.session.id, result.sessionKey);
  setEncryptionKey(result.sessionKey);
  cacheSessionKey(result.sessionKey);
  await loadVault(result.sessionKey);
  return c.json({ sessionId: result.session.id, name: result.name });
});

// Validate an existing session (for "restart" safe-word mode)
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

// Recovery question (GET)
app.get("/api/recover", async (c) => {
  const question = await getRecoveryQuestion();
  if (!question) {
    return c.json({ error: "Not paired yet" }, 400);
  }
  return c.json({ question });
});

// Recovery: reset safe word
app.post("/api/recover", async (c) => {
  const body = await c.req.json();
  const { answer, newSafeWord } = body;

  if (!answer || !newSafeWord) {
    return c.json({ error: "Answer and new safe word required" }, 400);
  }

  const result = await recover(answer, newSafeWord);
  if ("error" in result) {
    return c.json({ error: result.error }, 401);
  }

  sessionKeys.set(result.session.id, result.sessionKey);
  setEncryptionKey(result.sessionKey);
  cacheSessionKey(result.sessionKey);
  await loadVault(result.sessionKey);
  return c.json({ sessionId: result.session.id, name: result.name });
});

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

  const filePath = join(process.cwd(), "public", "avatar", "cache", hash);
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
  await mkdir(join(process.cwd(), "public", "avatar"), { recursive: true });
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
  // Return only user and assistant messages (not system)
  const messages = cs.history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));

  return c.json({ messages });
});

// Activity log: poll for background actions
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
  const stream_fn = pickStreamFn();
  const reqSignal = c.req.raw.signal;

  return streamSSE(c, async (stream) => {
    // Send branch trace metadata so the UI can track lineage
    await stream.writeSSE({
      data: JSON.stringify({
        meta: {
          provider: activeProvider,
          model: activeChatModel ?? (activeProvider === "ollama" ? "llama3.1:8b" : "claude-sonnet-4"),
          traceId: branchTraceId,
          backref: primaryBackref,
        },
      }),
    });

    await new Promise<void>((resolve) => {
      if (reqSignal?.aborted) { resolve(); return; }
      const onAbort = () => resolve();
      reqSignal?.addEventListener("abort", onAbort, { once: true });

      stream_fn({
        messages,
        model: activeChatModel,
        signal: reqSignal,
        onToken: (token) => {
          stream.writeSSE({ data: JSON.stringify({ token }) }).catch(() => {});
        },
        onDone: () => {
          reqSignal?.removeEventListener("abort", onAbort);
          stream.writeSSE({ data: JSON.stringify({ done: true }) }).catch(() => {});
          resolve();
        },
        onError: (err) => {
          reqSignal?.removeEventListener("abort", onAbort);
          const errorMsg = err instanceof LLMError ? err.userMessage : (err.message || "Stream error");
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
  const registry = getSkillRegistry();
  if (!registry) return c.json({ error: "Skills registry not initialized" }, 503);

  const stateFilter = c.req.query("state") as import("./skills/types.js").SkillState | undefined;
  const slotFilter = c.req.query("slot") as import("./skills/types.js").SkillSlot | undefined;

  const skills = registry.list({
    state: stateFilter,
    slot: slotFilter,
  });

  return c.json(skills.map((s) => ({
    name: s.meta.name,
    description: s.meta.description,
    slot: s.meta.slot,
    state: s.state,
    userInvocable: s.meta.userInvocable,
    source: s.meta.source.type,
    version: s.meta.version,
    registeredAt: s.registeredAt,
  })));
});

// Get a single skill (metadata + body)
app.get("/api/skills/:name", async (c) => {
  const registry = getSkillRegistry();
  if (!registry) return c.json({ error: "Skills registry not initialized" }, 503);

  const name = c.req.param("name");
  const skill = registry.get(name);
  if (!skill) return c.json({ error: "Skill not found" }, 404);

  // Load body on demand
  await registry.loadBody(name);

  return c.json({
    name: skill.meta.name,
    description: skill.meta.description,
    slot: skill.meta.slot,
    state: skill.state,
    userInvocable: skill.meta.userInvocable,
    disableModelInvocation: skill.meta.disableModelInvocation,
    source: skill.meta.source,
    version: skill.meta.version,
    body: skill.body,
    referencedFiles: skill.referencedFiles,
    registeredAt: skill.registeredAt,
    refreshedAt: skill.refreshedAt,
  });
});

// Resolve intent → matching skills
app.post("/api/skills/resolve", async (c) => {
  const registry = getSkillRegistry();
  if (!registry) return c.json({ error: "Skills registry not initialized" }, 503);

  const { intent, includeReference, limit } = await c.req.json<{
    intent: string;
    includeReference?: boolean;
    limit?: number;
  }>();

  if (!intent) return c.json({ error: "intent is required" }, 400);

  const results = registry.resolve(intent, { includeReference, limit });
  return c.json(results.map((r) => ({
    name: r.skill.meta.name,
    description: r.skill.meta.description,
    slot: r.skill.meta.slot,
    reason: r.reason,
    confidence: r.confidence,
    priority: r.priority,
  })));
});

// Validate a skill file
app.post("/api/skills/:name/validate", async (c) => {
  const registry = getSkillRegistry();
  if (!registry) return c.json({ error: "Skills registry not initialized" }, 503);

  const { content } = await c.req.json<{ content: string }>();
  if (!content) return c.json({ error: "content is required" }, 400);

  const name = c.req.param("name");
  const result = registry.validate(name, content);
  return c.json(result);
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
  const html = await serveHtmlTemplate(join(process.cwd(), "public", "help.html"));
  return c.html(html);
});

app.get("/api/help/context", async (c) => {
  const result = await health.check();
  const activities = await getActivities();
  const last20 = activities.slice(-20).reverse();

  let changelog = "";
  try {
    changelog = await readBrainFile(join(process.cwd(), "brain", "operations", "changelog.md"));
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

// --- Ops dashboard routes (no auth — local-only diagnostics) ---

// Serve observatory.html
app.get("/observatory", async (c) => {
  const html = await serveHtmlTemplate(join(process.cwd(), "public", "observatory.html"));
  return c.html(html);
});

// Serve ops.html
app.get("/ops", async (c) => {
  const html = await serveHtmlTemplate(join(process.cwd(), "public", "ops.html"));
  return c.html(html);
});

// Serve board.html (kanban view)
app.get("/board", async (c) => {
  const html = await serveHtmlTemplate(join(process.cwd(), "public", "board.html"));
  return c.html(html);
});

// Serve library.html (file explorer)
app.get("/library", async (c) => {
  const html = await serveHtmlTemplate(join(process.cwd(), "public", "library.html"));
  return c.html(html);
});

// Serve browser.html (agent's-eye view of web pages)
app.get("/browser", async (c) => {
  const html = await serveHtmlTemplate(join(process.cwd(), "public", "browser.html"));
  return c.html(html);
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
    const sharesPath = join(process.cwd(), "brain", "ops", "shares.jsonl");
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

// Chat: streamed response (or learn command)
app.post("/api/chat", async (c) => {
  const body = await c.req.json();
  const { sessionId, message, images } = body as {
    sessionId?: string;
    message?: string;
    images?: { data: string; mimeType: string }[];
  };

  if (!sessionId || !message) {
    return c.json({ error: "sessionId and message required" }, 400);
  }

  const session = validateSession(sessionId);
  if (!session) {
    return c.json({ error: "Invalid or expired session" }, 401);
  }

  const cs = await getOrCreateChatSession(sessionId, session.name);

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
      saveSession(sessionId, {
        history: cs.history,
        fileContext: cs.fileContext,
        learnedPaths: cs.learnedPaths,
        historySummary: cs.historySummary,
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

  // Inject resolved skill content (reference skills auto-load by intent match)
  try {
    const registry = getSkillRegistry();
    if (registry) {
      const resolved = registry.resolve(chatMessage, { includeReference: true });
      for (const res of resolved) {
        const body = await registry.loadBody(res.skill.meta.name);
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
            `--- Skill: ${res.skill.meta.name} (${res.reason}, confidence ${res.confidence.toFixed(2)}) ---`,
            body,
            ...refContents,
            `--- end skill ---`,
          ].join("\n");

          ctx.messages.splice(1, 0, { role: "system" as const, content: skillSection });
          logActivity({ source: "system", summary: `Loaded skill: ${res.skill.meta.name} (${res.reason})` });
        }
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
      const docMsg = {
        role: "system" as const,
        content: [
          `--- Brain document: ${doc.filename} ---`,
          doc.content,
          `--- End ${doc.filename} ---`,
          `This document was found in your brain files. Use it to answer the user's question.`,
        ].join("\n"),
      };
      ctx.messages.splice(1, 0, docMsg);
      logActivity({ source: "system", summary: `Auto-loaded brain document: ${doc.filename}`, actionLabel: "PROMPTED", reason: "user message referenced a brain document" });
    }
  } catch {
    // Non-critical — fall through to web search
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
      const changelogPath = join(process.cwd(), "brain", "operations", "changelog.md");
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

  const stream_fn = pickStreamFn();

  const activeProvider = resolveProvider();
  const activeChatModel = resolveChatModel();

  const reqSignal = c.req.raw.signal;

  return streamSSE(c, async (stream) => {
    // Send metadata first so UI can show which model is responding
    await stream.writeSSE({ data: JSON.stringify({ meta: { provider: activeProvider, model: activeChatModel ?? (activeProvider === "ollama" ? "llama3.1:8b" : "claude-sonnet-4") } }) });

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

      stream_fn({
        messages: ctx.messages,
        model: activeChatModel,
        signal: reqSignal,
        onToken: (token) => {
          fullResponse += token;
          stream.writeSSE({ data: JSON.stringify({ token }) }).catch(() => {});
        },
        onDone: () => {
          reqSignal?.removeEventListener("abort", onAbort);

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
                  stream.writeSSE({ data: JSON.stringify({ agentSpawned: { label } }) }).catch(() => {});
                  submitTask({
                    label,
                    prompt: finalPrompt,
                    origin: "ai",
                    sessionId,
                    boardTaskId: req.taskId,
                  }).then((task) => {
                    logActivity({ source: "agent", summary: `AI-triggered agent: ${task.label}`, detail: `Task ${task.id}, PID ${task.pid}`, actionLabel: "PROMPTED", reason: "user chat triggered agent" });
                  }).catch((err) => {
                    agentLog.error(`Spawn failed for "${label}": ${err.message}`);
                    logActivity({ source: "agent", summary: `AI agent spawn failed: ${err.message}`, actionLabel: "PROMPTED", reason: "user chat triggered agent spawn failed" });
                    stream.writeSSE({ data: JSON.stringify({ agentError: { label, error: err.message } }) }).catch(() => {});
                  });
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
        onError: (err) => {
          reqSignal?.removeEventListener("abort", onAbort);
          // If this error is from an abort, save partial and exit quietly
          if (reqSignal?.aborted) {
            savePartial();
          } else {
            const errorMsg = err instanceof LLMError ? err.userMessage : (err.message || "Stream error");
            stream.writeSSE({ data: JSON.stringify({ error: errorMsg }) }).catch(() => {});
          }
          resolve(); // Still resolve so stream closes
        },
      });
    });
  });
});

// --- Startup ---

async function start() {
  // Initialize instance name before anything else
  initInstanceName();

  // Initialize OpenTelemetry tracing (must be early, before instrumented code)
  initTracing({
    serviceName: `${getInstanceNameLower()}-brain`,
    serviceVersion: "0.1.0",
    consoleExport: process.env.OTEL_CONSOLE_EXPORT !== "false",
  });

  // Load settings (airplane mode, model selection)
  const settings = await loadSettings();

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
  const [skillRegistry, moduleRegistry, , runtime] = await Promise.all([
    createSkillRegistry({ skillsDir: SKILLS_DIR, brainDir: BRAIN_DIR }),
    Promise.resolve(createModuleRegistry(BRAIN_DIR)),
    initAgents(),
    createRuntime(),
  ]);

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

  // Wire notification channels — email (Resend) and phone (Twilio voice)
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
  if (settings.airplaneMode) {
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
  if (skillRegistry) {
    const counts = skillRegistry.countByState();
    log.info(`Skills: ${skillRegistry.size} registered (${counts.registered} active)`);
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

  serve({ fetch: app.fetch, port: PORT }, () => {
    log.info(`Listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  log.error("Failed to start", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

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
  stopAvatarSidecar();
  stopTtsSidecar();
  stopSttSidecar();
  stopSidecar();
  await closeBrowser();
  shutdownAgents();
  await shutdownLLMCache();
  await shutdownTracing();
  process.exit(0);
}
process.on("SIGINT", () => { gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { gracefulShutdown("SIGTERM"); });

// Crash diagnostics — write to file since terminal output may be lost on tsx watch restart
process.on("uncaughtException", (err) => {
  const msg = `[${new Date().toISOString()}] UNCAUGHT: ${err.stack ?? err.message}\n`;
  try { writeFileSync(join(process.cwd(), "brain", "ops", "crash.log"), msg, { flag: "a" }); } catch {}

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
  try { writeFileSync(join(process.cwd(), "brain", "ops", "crash.log"), msg, { flag: "a" }); } catch {}
  log.error("Unhandled rejection", { error: err.message, stack: err.stack });
});
