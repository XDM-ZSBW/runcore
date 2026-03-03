/**
 * Types for the contacts module — Core's entity relationship graph.
 */

export type EntityType = "human" | "ai" | "organization" | "service";

export type EdgeType =
  | "works_at"
  | "owns"
  | "introduced_by"
  | "collaborates_with"
  | "uses"
  | "built_by"
  | "reports_to";

export interface EntityChannel {
  type: "email" | "phone" | "slack" | "url" | "api";
  value: string;
}

export interface Entity {
  id: string;
  type: EntityType;
  name: string;
  aliases?: string[];
  channels?: EntityChannel[];
  /** Freeform type-specific data (role, model name, API base URL, etc.). */
  meta?: Record<string, unknown>;
  notes?: string;
  tags?: string[];
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  type: EdgeType;
  /** Optional qualifier (e.g. "Founder", "API provider"). */
  label?: string;
  /** When the relationship started (ISO date or YYYY-MM). */
  since?: string;
  notes?: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface EntityFilter {
  type?: EntityType;
  status?: "active" | "archived";
}

export interface EdgeFilter {
  type?: EdgeType;
  entityId?: string;
  status?: "active" | "archived";
}
