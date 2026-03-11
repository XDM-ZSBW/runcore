/**
 * Zod schemas for all Core MCP tools — shared between the MCP server
 * and the chat model tool-calling layer.
 *
 * Extracted from src/mcp-server.ts so both surfaces import from here.
 */

import { z } from "zod";

// ── Memory tools ──────────────────────────────────────────────────────────────

export const memoryRetrieveSchema = z.object({
  query: z.string().max(500).describe("Search query"),
  type: z
    .enum(["episodic", "semantic", "procedural"])
    .optional()
    .describe("Filter by memory type"),
  max: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max results (default 10)"),
});

export const memoryLearnSchema = z.object({
  type: z.enum(["episodic", "semantic", "procedural"]).describe("Memory type"),
  content: z.string().min(1).max(10000).describe("Content to store"),
  meta: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Optional metadata"),
});

export const memoryListSchema = z.object({
  type: z
    .enum(["episodic", "semantic", "procedural"])
    .optional()
    .describe("Filter by type (omit for all)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max entries (default 20)"),
});

// ── Brain file tools ──────────────────────────────────────────────────────────

export const readBrainFileSchema = z.object({
  path: z
    .string()
    .max(500)
    .describe("Relative path under brain/, e.g. 'operations/goals.yaml'"),
});

export const filesSearchSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .describe("Search query — keywords to find in brain files"),
  max: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Max results (default 10)"),
});

// ── Settings / locked / rooms ─────────────────────────────────────────────────

export const getSettingsSchema = z.object({});

export const listLockedSchema = z.object({});

export const listRoomsSchema = z.object({});

// ── Whiteboard tools ──────────────────────────────────────────────────────────

export const whiteboardPlantSchema = z.object({
  title: z.string().describe("Short label for the node"),
  type: z
    .enum(["goal", "task", "question", "decision", "note"])
    .describe("Node type"),
  parentId: z.string().optional().describe("Parent node ID (omit for root)"),
  tags: z.array(z.string()).optional().describe("Category tags"),
  body: z.string().optional().describe("Markdown detail"),
  question: z
    .string()
    .optional()
    .describe("Question text (required if type=question)"),
});

export const whiteboardStatusSchema = z.object({});

// ── Voucher tools ─────────────────────────────────────────────────────────────

export const voucherIssueSchema = z.object({
  scope: z
    .string()
    .optional()
    .describe("What the voucher authorizes (e.g. 'read:settings')"),
  ttlMinutes: z
    .number()
    .int()
    .min(1)
    .max(1440)
    .optional()
    .describe("Time-to-live in minutes (default 30)"),
});

export const voucherCheckSchema = z.object({
  token: z
    .string()
    .describe("The voucher token to verify (e.g. 'vch_a8f3x9b2')"),
});

// ── Alert tool ────────────────────────────────────────────────────────────────

export const sendAlertSchema = z.object({
  subject: z.string().max(200).describe("Alert subject line"),
  body: z.string().max(2000).describe("Alert body with details"),
});

// ── Crystallizer (open loops) ─────────────────────────────────────────────────

export const loopOpenSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(500)
    .describe("The search shape — terms that define what this loop catches"),
  context: z
    .string()
    .min(1)
    .max(2000)
    .describe("Why this loop exists — what question you're trying to answer"),
  threshold: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("How many evidence hits before precipitation (default 3)"),
  minScore: z
    .number()
    .min(0.1)
    .max(2.0)
    .optional()
    .describe("Minimum match score to count as evidence (default 0.4)"),
});

export const loopListSchema = z.object({
  status: z
    .enum(["open", "precipitated", "resolved", "all"])
    .optional()
    .describe("Filter by status (default: all)"),
});

export const loopResolveSchema = z.object({
  loopId: z.string().describe("The loop ID to resolve"),
});

// ── Instance status ───────────────────────────────────────────────────────────

export const dashStatusSchema = z.object({});

// ── Web fetch ────────────────────────────────────────────────────────────────

export const webFetchSchema = z.object({
  url: z.string().url().describe("The URL to fetch"),
  prompt: z
    .string()
    .max(500)
    .optional()
    .describe("Optional: what to extract from the page"),
});
