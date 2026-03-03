/**
 * Workflow Engine — File-based multi-step agent workflow definitions.
 *
 * Bridges the gap between declarative JSON workflow files in
 * `brain/agents/workflows/` and the in-memory Orchestrator.
 *
 * Adds on top of the Orchestrator:
 * 1. Loading/validating workflow definitions from JSON files
 * 2. Template interpolation ({{input.x}}, {{steps.y.output}})
 * 3. Conditional step gating (stepStatus, inputEquals, allOf/anyOf/not)
 * 4. Error recovery policies (stop, continue, fallback)
 * 5. Retry logic with per-step retry counts
 * 6. Workflow-level input parameters and output mapping
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";
import { readBrainFile, writeBrainFile } from "../lib/brain-io.js";
import type {
  CreateWorkflowInput,
  WorkflowTaskDef,
  WorkflowResult,
  ExecutionMode,
} from "./orchestration.js";
import { Orchestrator } from "./orchestration.js";
import type { AgentPool } from "./runtime.js";

const log = createLogger("workflow");

const WORKFLOWS_DIR = join(process.cwd(), "brain", "agents", "workflows");

// ---------------------------------------------------------------------------
// Types — workflow definition (matches schema.json)
// ---------------------------------------------------------------------------

export interface ParameterDef {
  type: "string" | "number" | "boolean";
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
}

export interface FailurePolicy {
  action: "stop" | "continue" | "fallback";
  fallbackStep?: string;
}

export interface Condition {
  stepStatus?: { step: string; equals: "completed" | "failed" | "skipped" };
  inputEquals?: { input: string; value: unknown };
  allOf?: Condition[];
  anyOf?: Condition[];
  not?: Condition;
}

export interface StepDef {
  key: string;
  label: string;
  prompt: string;
  dependsOn?: string[];
  condition?: Condition;
  inputs?: Record<string, string>;
  priority?: number;
  timeoutMs?: number;
  retries?: number;
  onFailure?: FailurePolicy;
  tags?: string[];
  cwd?: string;
}

export interface OutputMapping {
  fromStep: string;
  value: string;
}

export interface WorkflowDefinition {
  name: string;
  version: string;
  description?: string;
  tags?: string[];
  inputs?: Record<string, ParameterDef>;
  outputs?: Record<string, OutputMapping>;
  mode?: ExecutionMode;
  maxConcurrent?: number;
  timeoutMs?: number;
  onFailure?: FailurePolicy;
  steps: StepDef[];
}

// ---------------------------------------------------------------------------
// Step execution result (tracked per step during a run)
// ---------------------------------------------------------------------------

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface StepResult {
  key: string;
  status: StepStatus;
  output?: string;
  error?: string;
  retriesUsed: number;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Workflow run — a single execution of a definition
// ---------------------------------------------------------------------------

export interface WorkflowRun {
  id: string;
  definitionName: string;
  definitionVersion: string;
  status: "pending" | "running" | "completed" | "failed" | "partial" | "cancelled";
  inputs: Record<string, unknown>;
  stepResults: Map<string, StepResult>;
  outputs: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
  orchestratorResult?: WorkflowResult;
}

// ---------------------------------------------------------------------------
// WorkflowEngine
// ---------------------------------------------------------------------------

export class WorkflowEngine {
  private readonly orchestrator: Orchestrator;
  private readonly definitionCache = new Map<string, WorkflowDefinition>();
  private readonly runs = new Map<string, WorkflowRun>();
  private runCounter = 0;

  constructor(pool: AgentPool) {
    this.orchestrator = new Orchestrator(pool, { maxActiveWorkflows: 5 });
  }

  /** Access the underlying orchestrator for advanced use. */
  getOrchestrator(): Orchestrator {
    return this.orchestrator;
  }

  // -------------------------------------------------------------------------
  // Loading definitions
  // -------------------------------------------------------------------------

  /** Load a workflow definition from a JSON file path. */
  async loadDefinition(filePath: string): Promise<WorkflowDefinition> {
    const raw = await readBrainFile(filePath);
    const def = JSON.parse(raw) as WorkflowDefinition;
    this.validateDefinition(def);
    this.definitionCache.set(def.name, def);
    log.info("Workflow definition loaded", { name: def.name, version: def.version, steps: def.steps.length });
    return def;
  }

  /** Load all workflow definitions from the workflows directory. */
  async loadAllDefinitions(): Promise<WorkflowDefinition[]> {
    const loaded: WorkflowDefinition[] = [];
    let entries: string[];
    try {
      entries = await readdir(WORKFLOWS_DIR);
    } catch {
      log.warn("Workflows directory not found", { dir: WORKFLOWS_DIR });
      return [];
    }

    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry === "schema.json") continue;
      try {
        const def = await this.loadDefinition(join(WORKFLOWS_DIR, entry));
        loaded.push(def);
      } catch (err) {
        log.warn("Failed to load workflow definition", {
          file: entry,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return loaded;
  }

  /** Get a cached definition by name. */
  getDefinition(name: string): WorkflowDefinition | undefined {
    return this.definitionCache.get(name);
  }

  /** List all cached definition names. */
  listDefinitions(): string[] {
    return [...this.definitionCache.keys()];
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Execute a workflow by name.
   *
   * Resolves inputs, evaluates conditions, interpolates templates,
   * then delegates to the Orchestrator for agent coordination.
   */
  async execute(
    name: string,
    inputs: Record<string, unknown> = {},
  ): Promise<WorkflowRun> {
    const def = this.definitionCache.get(name);
    if (!def) {
      throw new Error(`Workflow definition not found: "${name}". Load it first.`);
    }

    // Resolve inputs with defaults
    const resolvedInputs = this.resolveInputs(def, inputs);

    // Create run tracking
    const run = this.createRun(def, resolvedInputs);
    this.runs.set(run.id, run);

    run.status = "running";
    run.startedAt = new Date().toISOString();

    log.info("Workflow execution started", {
      runId: run.id,
      workflow: def.name,
      stepCount: def.steps.length,
    });

    try {
      if (def.mode === "sequential") {
        await this.executeSequential(def, run);
      } else {
        // For parallel and dependency modes, delegate to orchestrator
        await this.executeViaOrchestrator(def, run);
      }
    } catch (err) {
      log.error("Workflow execution error", {
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Compute final status
    run.status = this.computeRunStatus(run);
    run.finishedAt = new Date().toISOString();

    // Map outputs
    run.outputs = this.mapOutputs(def, run);

    log.info("Workflow execution finished", {
      runId: run.id,
      workflow: def.name,
      status: run.status,
    });

    return run;
  }

  /** Get a run by ID. */
  getRun(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  // -------------------------------------------------------------------------
  // Sequential execution (handles conditions + retries inline)
  // -------------------------------------------------------------------------

  private async executeSequential(def: WorkflowDefinition, run: WorkflowRun): Promise<void> {
    for (const stepDef of def.steps) {
      if (run.status === "cancelled") break;

      const result = run.stepResults.get(stepDef.key)!;

      // Evaluate condition
      if (stepDef.condition && !this.evaluateCondition(stepDef.condition, run)) {
        result.status = "skipped";
        log.info("Step skipped (condition false)", { runId: run.id, step: stepDef.key });
        continue;
      }

      // Execute with retries
      await this.executeStepWithRetries(def, run, stepDef, result);

      // Handle failure
      if (result.status === "failed") {
        const policy = stepDef.onFailure ?? def.onFailure ?? { action: "stop" };
        if (policy.action === "stop") {
          log.info("Workflow stopping due to step failure", { runId: run.id, step: stepDef.key });
          break;
        }
        if (policy.action === "fallback" && policy.fallbackStep) {
          const fbDef = def.steps.find((s) => s.key === policy.fallbackStep);
          if (fbDef) {
            const fbResult: StepResult = { key: fbDef.key, status: "pending", retriesUsed: 0 };
            run.stepResults.set(fbDef.key, fbResult);
            await this.executeStepWithRetries(def, run, fbDef, fbResult);
          }
        }
        // "continue" just proceeds to next step
      }
    }
  }

  // -------------------------------------------------------------------------
  // Orchestrator-delegated execution (parallel/dependency)
  // -------------------------------------------------------------------------

  private async executeViaOrchestrator(def: WorkflowDefinition, run: WorkflowRun): Promise<void> {
    // Build task list, filtering by conditions
    const tasks: WorkflowTaskDef[] = [];
    for (const stepDef of def.steps) {
      // For dependency/parallel mode, evaluate conditions that can be checked upfront
      // (input-based conditions). Step-status conditions can't be pre-evaluated.
      if (stepDef.condition && this.isStaticCondition(stepDef.condition)) {
        if (!this.evaluateCondition(stepDef.condition, run)) {
          const result = run.stepResults.get(stepDef.key)!;
          result.status = "skipped";
          continue;
        }
      }

      const interpolatedPrompt = this.interpolateTemplate(stepDef.prompt, run);

      tasks.push({
        key: stepDef.key,
        label: stepDef.label,
        prompt: interpolatedPrompt,
        cwd: stepDef.cwd,
        dependsOn: stepDef.dependsOn,
        priority: stepDef.priority,
        tags: stepDef.tags,
        config: stepDef.timeoutMs ? { timeoutMs: stepDef.timeoutMs } as never : undefined,
      });
    }

    if (tasks.length === 0) {
      log.info("No steps to execute after condition filtering", { runId: run.id });
      return;
    }

    const workflowInput: CreateWorkflowInput = {
      name: `${def.name} (run ${run.id})`,
      description: def.description,
      tasks,
      mode: def.mode ?? "dependency",
      maxConcurrent: def.maxConcurrent,
      origin: "system",
    };

    const orcWorkflow = this.orchestrator.createWorkflow(workflowInput);
    const result = await this.orchestrator.execute(orcWorkflow.id);
    run.orchestratorResult = result;

    // Sync results back to our step tracking
    for (const taskResult of result.tasks) {
      const stepResult = run.stepResults.get(taskResult.key);
      if (stepResult) {
        stepResult.status = taskResult.status === "completed" ? "completed" : "failed";
        stepResult.output = taskResult.output;
        stepResult.error = taskResult.error;
        stepResult.durationMs = taskResult.durationMs;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step execution with retries
  // -------------------------------------------------------------------------

  private async executeStepWithRetries(
    def: WorkflowDefinition,
    run: WorkflowRun,
    stepDef: StepDef,
    result: StepResult,
  ): Promise<void> {
    const maxRetries = stepDef.retries ?? 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      result.status = "running";
      const startTime = Date.now();

      try {
        const interpolatedPrompt = this.interpolateTemplate(stepDef.prompt, run);

        // Create a single-task workflow via the orchestrator
        const taskDef: WorkflowTaskDef = {
          key: stepDef.key,
          label: stepDef.label,
          prompt: interpolatedPrompt,
          cwd: stepDef.cwd,
          priority: stepDef.priority,
          tags: stepDef.tags,
          config: stepDef.timeoutMs ? { timeoutMs: stepDef.timeoutMs } as never : undefined,
        };

        const wfInput: CreateWorkflowInput = {
          name: `${def.name}/${stepDef.key}${attempt > 0 ? ` (retry ${attempt})` : ""}`,
          tasks: [taskDef],
          mode: "sequential",
          origin: "system",
        };

        const orcWorkflow = this.orchestrator.createWorkflow(wfInput);
        const orchResult = await this.orchestrator.execute(orcWorkflow.id);
        const taskResult = orchResult.tasks[0];

        result.durationMs = Date.now() - startTime;

        if (taskResult && taskResult.status === "completed") {
          result.status = "completed";
          result.output = taskResult.output;
          result.retriesUsed = attempt;
          return;
        }

        // Task failed
        result.error = taskResult?.error ?? "Unknown error";
        result.retriesUsed = attempt;

        if (attempt < maxRetries) {
          log.info("Step failed, retrying", {
            runId: run.id,
            step: stepDef.key,
            attempt: attempt + 1,
            maxRetries,
          });
        }
      } catch (err) {
        result.durationMs = Date.now() - startTime;
        result.error = err instanceof Error ? err.message : String(err);
        result.retriesUsed = attempt;

        if (attempt < maxRetries) {
          log.info("Step threw, retrying", {
            runId: run.id,
            step: stepDef.key,
            attempt: attempt + 1,
          });
        }
      }
    }

    result.status = "failed";
  }

  // -------------------------------------------------------------------------
  // Template interpolation
  // -------------------------------------------------------------------------

  /**
   * Replace {{input.paramName}} and {{steps.stepKey.output}} placeholders.
   */
  interpolateTemplate(template: string, run: WorkflowRun): string {
    return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, expr: string) => {
      const parts = expr.split(".");

      // {{input.paramName}}
      if (parts[0] === "input" && parts.length === 2) {
        const val = run.inputs[parts[1]];
        return val !== undefined ? String(val) : "";
      }

      // {{steps.stepKey.output}} or {{steps.stepKey.status}}
      if (parts[0] === "steps" && parts.length === 3) {
        const stepResult = run.stepResults.get(parts[1]);
        if (!stepResult) return "";
        if (parts[2] === "output") return stepResult.output ?? "";
        if (parts[2] === "status") return stepResult.status;
        if (parts[2] === "error") return stepResult.error ?? "";
      }

      return "";
    });
  }

  // -------------------------------------------------------------------------
  // Condition evaluation
  // -------------------------------------------------------------------------

  evaluateCondition(condition: Condition, run: WorkflowRun): boolean {
    if (condition.stepStatus) {
      const result = run.stepResults.get(condition.stepStatus.step);
      return result?.status === condition.stepStatus.equals;
    }

    if (condition.inputEquals) {
      const val = run.inputs[condition.inputEquals.input];
      return val === condition.inputEquals.value;
    }

    if (condition.allOf) {
      return condition.allOf.every((c) => this.evaluateCondition(c, run));
    }

    if (condition.anyOf) {
      return condition.anyOf.some((c) => this.evaluateCondition(c, run));
    }

    if (condition.not) {
      return !this.evaluateCondition(condition.not, run);
    }

    // No operator set — treat as true (unconditional)
    return true;
  }

  /** Check if a condition only references inputs (can be evaluated before steps run). */
  private isStaticCondition(condition: Condition): boolean {
    if (condition.stepStatus) return false;
    if (condition.inputEquals) return true;
    if (condition.allOf) return condition.allOf.every((c) => this.isStaticCondition(c));
    if (condition.anyOf) return condition.anyOf.every((c) => this.isStaticCondition(c));
    if (condition.not) return this.isStaticCondition(condition.not);
    return true;
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  validateDefinition(def: WorkflowDefinition): void {
    if (!def.name || typeof def.name !== "string") {
      throw new Error("Workflow definition must have a 'name' string.");
    }
    if (!def.version || !/^\d+\.\d+\.\d+$/.test(def.version)) {
      throw new Error("Workflow definition must have a valid semver 'version'.");
    }
    if (!Array.isArray(def.steps) || def.steps.length === 0) {
      throw new Error("Workflow definition must have at least one step.");
    }

    const keys = new Set<string>();
    for (const step of def.steps) {
      if (!step.key || !step.label || !step.prompt) {
        throw new Error(`Step "${step.key ?? "(unnamed)"}" must have key, label, and prompt.`);
      }
      if (keys.has(step.key)) {
        throw new Error(`Duplicate step key: "${step.key}".`);
      }
      keys.add(step.key);
    }

    // Validate dependency references
    for (const step of def.steps) {
      if (step.dependsOn) {
        for (const dep of step.dependsOn) {
          if (!keys.has(dep)) {
            throw new Error(`Step "${step.key}" depends on unknown step "${dep}".`);
          }
        }
      }
    }

    // Validate fallback references
    const defaultPolicy = def.onFailure;
    if (defaultPolicy?.action === "fallback" && defaultPolicy.fallbackStep) {
      if (!keys.has(defaultPolicy.fallbackStep)) {
        throw new Error(`Default fallback step "${defaultPolicy.fallbackStep}" not found.`);
      }
    }
    for (const step of def.steps) {
      if (step.onFailure?.action === "fallback" && step.onFailure.fallbackStep) {
        if (!keys.has(step.onFailure.fallbackStep)) {
          throw new Error(`Step "${step.key}" fallback step "${step.onFailure.fallbackStep}" not found.`);
        }
      }
    }

    // Cycle detection for dependency mode
    if (def.mode === "dependency" || !def.mode) {
      this.detectCycles(def.steps);
    }
  }

  private detectCycles(steps: StepDef[]): void {
    const adj = new Map<string, string[]>();
    for (const step of steps) {
      adj.set(step.key, step.dependsOn ?? []);
    }

    const visited = new Set<string>();
    const inStack = new Set<string>();

    const visit = (key: string, path: string[]): void => {
      if (inStack.has(key)) {
        const cycle = [...path.slice(path.indexOf(key)), key];
        throw new Error(`Dependency cycle detected: ${cycle.join(" → ")}`);
      }
      if (visited.has(key)) return;
      visited.add(key);
      inStack.add(key);
      for (const dep of adj.get(key) ?? []) {
        visit(dep, [...path, key]);
      }
      inStack.delete(key);
    };

    for (const key of adj.keys()) {
      visit(key, []);
    }
  }

  // -------------------------------------------------------------------------
  // Input resolution
  // -------------------------------------------------------------------------

  private resolveInputs(
    def: WorkflowDefinition,
    provided: Record<string, unknown>,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    if (!def.inputs) return provided;

    for (const [name, paramDef] of Object.entries(def.inputs)) {
      if (name in provided) {
        resolved[name] = provided[name];
      } else if (paramDef.default !== undefined) {
        resolved[name] = paramDef.default;
      } else if (paramDef.required) {
        throw new Error(`Required workflow input "${name}" not provided.`);
      }
    }

    // Pass through any extra inputs not in the schema
    for (const [name, value] of Object.entries(provided)) {
      if (!(name in resolved)) {
        resolved[name] = value;
      }
    }

    return resolved;
  }

  // -------------------------------------------------------------------------
  // Output mapping
  // -------------------------------------------------------------------------

  private mapOutputs(
    def: WorkflowDefinition,
    run: WorkflowRun,
  ): Record<string, unknown> {
    const outputs: Record<string, unknown> = {};
    if (!def.outputs) return outputs;

    for (const [name, mapping] of Object.entries(def.outputs)) {
      const stepResult = run.stepResults.get(mapping.fromStep);
      if (!stepResult) continue;

      switch (mapping.value) {
        case "output":
          outputs[name] = stepResult.output;
          break;
        case "status":
          outputs[name] = stepResult.status;
          break;
        case "error":
          outputs[name] = stepResult.error;
          break;
        default:
          outputs[name] = stepResult.output;
      }
    }

    return outputs;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private createRun(def: WorkflowDefinition, inputs: Record<string, unknown>): WorkflowRun {
    this.runCounter++;
    const id = `wr_${Date.now()}_${this.runCounter}`;

    const stepResults = new Map<string, StepResult>();
    for (const step of def.steps) {
      stepResults.set(step.key, {
        key: step.key,
        status: "pending",
        retriesUsed: 0,
      });
    }

    return {
      id,
      definitionName: def.name,
      definitionVersion: def.version,
      status: "pending",
      inputs,
      stepResults,
      outputs: {},
    };
  }

  private computeRunStatus(run: WorkflowRun): WorkflowRun["status"] {
    const results = [...run.stepResults.values()];
    const allCompleted = results.every((r) => r.status === "completed" || r.status === "skipped");
    const anyFailed = results.some((r) => r.status === "failed");
    const anyCompleted = results.some((r) => r.status === "completed");

    if (allCompleted) return "completed";
    if (anyFailed && anyCompleted) return "partial";
    if (anyFailed) return "failed";
    return "completed";
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    await this.orchestrator.shutdown();
    log.info("Workflow engine shut down");
  }
}

// ---------------------------------------------------------------------------
// Convenience: load and parse a single workflow file
// ---------------------------------------------------------------------------

export async function parseWorkflowFile(filePath: string): Promise<WorkflowDefinition> {
  const raw = await readBrainFile(filePath);
  return JSON.parse(raw) as WorkflowDefinition;
}
