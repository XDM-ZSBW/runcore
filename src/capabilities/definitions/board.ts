/**
 * Board capability — create issues, mark done, comment, create projects.
 * Operates on the active BoardProvider (Core Queue or Linear).
 */

import { getBoardProvider } from "../../board/provider.js";
import { logActivity } from "../../activity/log.js";
import { getInstanceName } from "../../instance.js";
import type { BoardIssue, BoardProvider, BoardTeam } from "../../board/types.js";
import type { ActionBlockCapability, ActionContext, ActionExecutionResult, ActionOrigin } from "../types.js";
import type { QueueTask } from "../../queue/types.js";

/** Map ActionOrigin to QueueTask origin for causal backrefs. */
function mapOrigin(actionOrigin: ActionOrigin): QueueTask["origin"] {
  switch (actionOrigin) {
    case "chat": return "chat";
    case "autonomous": return "autonomous";
    case "email": return "external";
    default: return "external";
  }
}

const actionLabel = (ctx: ActionContext) =>
  ctx.origin === "autonomous" ? "AUTONOMOUS" : "PROMPTED";

const reason = (ctx: ActionContext) => {
  switch (ctx.origin) {
    case "email": return "email triggered board action";
    case "autonomous": return "autonomous agent board action";
    default: return "user requested via chat";
  }
};

/** Log activity and return a board result in one step. */
function boardResult(ok: boolean, message: string, ctx: ActionContext, detail?: string): ActionExecutionResult {
  logActivity({ source: "board", summary: message, detail, actionLabel: actionLabel(ctx), reason: reason(ctx) });
  return { capabilityId: "board", ok, message };
}

/** Find an issue by identifier, returning a failure result if not found. */
async function findIssueOrFail(
  board: BoardProvider,
  identifier: string,
  ctx: ActionContext,
): Promise<BoardIssue | ActionExecutionResult> {
  const issue = await board.findByIdentifier(identifier);
  return issue ?? boardResult(false, `Issue not found: ${identifier}`, ctx);
}

/** Type guard: is the value a failure result (not a BoardIssue)? */
function isFailure(v: BoardIssue | ActionExecutionResult): v is ActionExecutionResult {
  return "ok" in v;
}

export const boardCapability: ActionBlockCapability = {
  id: "board",
  pattern: "action",
  tag: "BOARD_ACTION",
  keywords: ["task", "issue", "board", "backlog", "project", "todo", "done", "queue", "triage", "icebox"],

  getPromptInstructions(ctx) {
    const name = ctx.name ?? "the user";
    const boardName = getBoardProvider()?.name ?? `${getInstanceName()} Queue`;
    return [
      `## Task Board (via [BOARD_ACTION] blocks)`,
      `You have an internal task queue (${boardName}) that is always available, even offline.`,
      `Tasks are organized into **projects**, each with its own identifier prefix (e.g. CORE-1, TRI-3).`,
      `You can perform board operations by including [BOARD_ACTION] blocks in your response (similar to AGENT_REQUEST).`,
      `Each block contains a JSON action. Available actions:`,
      `- {"action": "create", "title": "Issue title", "description": "optional details", "project": "core-dev"} — project is required for normal tasks`,
      `- {"action": "create_project", "name": "Project Name", "prefix": "PRJ", "description": "optional"} — create a new project`,
      `- {"action": "done", "identifier": "CORE-1"}`,
      `- {"action": "comment", "identifier": "CORE-1", "body": "Comment text"}`,
      `- {"action": "comment", "identifier": "TRI-3", "body": "Comment text", "author": "Sarah", "exchangeSource": "external"} — track an exchange with an outside party`,
      ``,
      `Example — create an issue:`,
      `[BOARD_ACTION]`,
      `{"action": "create", "title": "Groom backlog weekly", "project": "core-dev"}`,
      `[/BOARD_ACTION]`,
      ``,
      `Example — batch: comment on two issues (each block MUST have its own [BOARD_ACTION]...[/BOARD_ACTION] wrapper):`,
      `[BOARD_ACTION]`,
      `{"action": "comment", "identifier": "DASH-1", "body": "Spec added"}`,
      `[/BOARD_ACTION]`,
      `[BOARD_ACTION]`,
      `{"action": "comment", "identifier": "DASH-2", "body": "Spec added"}`,
      `[/BOARD_ACTION]`,
      ``,
      `CRITICAL: Every block MUST end with [/BOARD_ACTION] — not "}]" or any other closing. Without the closing tag, the action is silently dropped.`,
      `You can include MULTIPLE [BOARD_ACTION] blocks to perform batch operations (e.g. close several issues at once).`,
      `Results appear as activity notifications. When board context is injected below, use the real identifiers and titles you see there.`,
      `The user can also type commands directly: "issues" (list), "todo <title>" (create), "done <ID>" (close).`,
      `Do NOT use AGENT_REQUEST for task board operations — use BOARD_ACTION instead.`,
      ``,
      `## Projects`,
      `Every task should belong to a project. When creating a task, always include the "project" field.`,
      `Omitting "project" marks the item as an **urgent escalation** — it triggers a phone call to the user. Only do this for genuine emergencies.`,
      ``,
      `**When to create a new project:** If ${name} starts discussing a new domain, initiative, or workstream that doesn't fit existing projects, proactively suggest creating one. Use "create_project" with a short uppercase prefix (2-4 chars).`,
      `**When to reuse:** If the work fits an existing project's scope, use that project's id.`,
      `**Triage project:** Use "triage" for items that need categorization but aren't urgent.`,
      ``,
      `## Board rules (CRITICAL)`,
      `- NEVER mark a coding task "done" unless an agent ACTUALLY completed the work and you saw success confirmation. Talking about it is not doing it.`,
      `- Recurring/continuous tasks (grooming, reviews, maintenance) stay open permanently — NEVER mark them done.`,
      `- To do coding work on a board item: spawn an AGENT_REQUEST first. Only mark "done" AFTER the agent succeeds.`,
      ``,
      `### Backlog vs ideas — two-tier system`,
      `The board has TWO uses:`,
      `1. **Backlog** = spec'd, ready-to-build work. Every backlog item MUST have: a concrete deliverable, which files/modules are involved, and acceptance criteria. If an item is in the backlog, an agent should be able to pick it up and build it.`,
      `2. **Ideas/needs-spec** = vague concepts that need refinement. When you encounter a vague idea (e.g. "Rules Engine", "Skills Library"), create a board item titled "Spec: [topic]" with description of what needs to be decided. Do NOT put unspec'd ideas directly in the backlog.`,
      ``,
      `When grooming: review vague items, break them into spec'd work, and move the spec'd pieces to backlog. The goal is a backlog where every item is actionable by an agent. After grooming, commit changes to the queue in a single batch.`,
      `When ${name} asks to work the backlog: only spawn agents for items that have real specs. For unspec'd items, ask ${name} for direction or propose a spec yourself.`,
      `NEVER spawn an agent for a task that is already In Progress or already has an assignee. Check the board state carefully before spawning.`,
      ``,
      `## Viewing board items (BOARD_VIEW)`,
      `When the user asks to SEE board items (e.g. "show the backlog", "what's in progress?", "list issues"), emit a [BOARD_VIEW] block.`,
      `This renders issues as interactive cards in the UI — much better than plain text lists.`,
      `BOARD_VIEW is for READING. BOARD_ACTION is for WRITING (create/done/comment). Never mix them.`,
      ``,
      `Format:`,
      `[BOARD_VIEW]`,
      `{"filter": "all"}`,
      `[/BOARD_VIEW]`,
      ``,
      `Supported filters:`,
      `- {"filter": "all"} — show all issues (default, up to 30)`,
      `- {"stateType": "started"} — filter by state type: "icebox", "triage", "backlog", "unstarted", "started", "completed", "cancelled"`,
      `- {"identifiers": ["DASH-1", "DASH-3"]} — show specific issues by identifier`,
      ``,
      `You may include brief conversational text alongside the block. The block itself is stripped from visible output and replaced with cards.`,
    ].join("\n");
  },

  async execute(payload, ctx): Promise<ActionExecutionResult> {
    const req = payload as Record<string, any>;
    const board = getBoardProvider();

    if (!board || !board.isAvailable()) {
      return { capabilityId: "board", ok: false, message: "No board provider available" };
    }

    // ── Create issue ─────────────────────────────────────────────────────
    if (req.action === "create" && req.title) {
      try {
        const issue = await board.createIssue(req.title, {
          description: req.description,
          project: req.project,
          origin: mapOrigin(ctx.origin),
          originSessionId: ctx.sessionId,
        });
        if (issue) return boardResult(true, `Created ${issue.identifier}: ${issue.title}`, ctx, issue.url);
      } catch {}
      return boardResult(false, `Failed to create issue: ${req.title}`, ctx);
    }

    // ── Mark done ────────────────────────────────────────────────────────
    if (req.action === "done" && req.identifier) {
      try {
        const found = await findIssueOrFail(board, req.identifier, ctx);
        if (isFailure(found)) return found;

        const teamPrefix = req.identifier.split("-")[0];
        const teams = await board.getTeams();
        const team = teams?.find((t: BoardTeam) => t.key === teamPrefix);
        if (!team) return boardResult(false, `Team not found for: ${req.identifier}`, ctx);

        const doneStateId = await board.getDoneStateId(team.id);
        if (!doneStateId) return boardResult(false, `No Done state for team ${team.name}`, ctx);

        const updated = await board.updateIssue(found.id, { stateId: doneStateId });
        if (updated) return boardResult(true, `Closed ${req.identifier}: ${updated.title}`, ctx);
      } catch {}
      return boardResult(false, `Failed to close ${req.identifier}`, ctx);
    }

    // ── Comment ──────────────────────────────────────────────────────────
    if (req.action === "comment" && req.identifier && req.body) {
      try {
        const found = await findIssueOrFail(board, req.identifier, ctx);
        if (isFailure(found)) return found;

        // If author is specified, route to exchange tracking (queue store)
        const queueStore = (board as any).getStore?.();
        if (req.author && queueStore) {
          const ex = await queueStore.addExchange(found.id, {
            author: req.author,
            body: req.body,
            source: req.exchangeSource ?? "external",
          });
          const msg = ex ? `Exchange on ${req.identifier} from ${req.author}` : `Failed to add exchange on ${req.identifier}`;
          return boardResult(!!ex, msg, ctx);
        }

        const ok = await board.addComment(found.id, req.body);
        return boardResult(ok, ok ? `Commented on ${req.identifier}` : `Failed to comment on ${req.identifier}`, ctx);
      } catch {}
      return boardResult(false, `Failed to comment on ${req.identifier}`, ctx);
    }

    // ── Create project ───────────────────────────────────────────────────
    if (req.action === "create_project" && req.name && req.prefix) {
      try {
        const projectStore = (board as any).getProjectStore?.();
        if (!projectStore) return boardResult(false, "No project store available", ctx);

        const project = await projectStore.create({ name: req.name, prefix: req.prefix, description: req.description });
        return boardResult(true, `Created project: ${project.name} (${project.prefix})`, ctx);
      } catch (err: any) {
        return boardResult(false, `Failed to create project "${req.name}": ${err.message}`, ctx);
      }
    }

    // ── View (read-only) ────────────────────────────────────────────────
    if (req.action === "view") {
      try {
        let issues: BoardIssue[] | null = null;

        if (req.identifiers && Array.isArray(req.identifiers)) {
          const found: BoardIssue[] = [];
          for (const ident of req.identifiers as string[]) {
            const issue = await board.findByIdentifier(ident);
            if (issue) found.push(issue);
          }
          issues = found;
        } else if (req.stateType) {
          issues = await board.listIssues({ stateType: req.stateType as string });
        } else {
          // Default: exclude done/cancelled so active items aren't crowded out
          issues = await board.listIssues({});
          if (issues) {
            issues = issues.filter((i) => !["Done", "Cancelled", "Icebox"].includes(i.state));
          }
        }

        // Cap results to prevent oversized payloads
        if (issues && issues.length > 50) {
          issues = issues.slice(0, 50);
        }

        return { capabilityId: "board", ok: true, message: `Found ${issues?.length ?? 0} issues`, data: issues ?? [] };
      } catch {
        return { capabilityId: "board", ok: false, message: "Failed to fetch board issues" };
      }
    }

    return { capabilityId: "board", ok: false, message: "Unknown or incomplete board action" };
  },
};
