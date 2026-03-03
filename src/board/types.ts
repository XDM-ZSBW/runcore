/**
 * Generic task board abstraction.
 * Linear, GitHub Issues, Notion, Jira, etc. all implement BoardProvider.
 * Server routes and chat commands only talk to this interface.
 */

export interface BoardIssue {
  id: string;
  identifier: string;    // e.g. "CORE-1", "TRI-3"
  title: string;
  state: string;         // display name: "In Progress", "Done", etc.
  priority: number;
  assignee: string | null;
  project?: string;      // project id — undefined = urgent escalation
  url: string;
}

export interface BoardTeam {
  id: string;
  name: string;
  key: string;           // prefix used in identifiers
}

export interface BoardState {
  id: string;
  name: string;
  type: string;          // "icebox" | "triage" | "backlog" | "unstarted" | "started" | "completed" | "cancelled"
  position: number;
}

export interface BoardUser {
  id: string;
  name: string;
  email: string;
  displayName: string;
}

export interface BoardProvider {
  /** Human-readable name for startup banner / UI. */
  readonly name: string;

  /** Check if this provider is configured and ready. */
  isAvailable(): boolean;

  /** Get the authenticated user. */
  getMe(): Promise<BoardUser | null>;

  /** List teams/projects. */
  getTeams(): Promise<BoardTeam[] | null>;

  /** List workflow states for a team. */
  getTeamStates(teamId: string): Promise<BoardState[] | null>;

  /** List issues, optionally filtered. */
  listIssues(opts?: {
    teamId?: string;
    stateType?: string;
    limit?: number;
    excludeAssigned?: boolean;
  }): Promise<BoardIssue[] | null>;

  /** Create a new issue. Returns the created issue. */
  createIssue(
    title: string,
    opts?: {
      description?: string;
      teamId?: string;
      assigneeId?: string;
      priority?: number;
      labelIds?: string[];
      project?: string;
      origin?: "chat" | "agent" | "autonomous" | "external";
      originSessionId?: string;
    },
  ): Promise<BoardIssue | null>;

  /** Update an existing issue. Returns the updated issue. */
  updateIssue(
    id: string,
    opts: {
      title?: string;
      stateId?: string;
      assigneeId?: string;
      priority?: number;
    },
  ): Promise<BoardIssue | null>;

  /** Add a comment to an issue. */
  addComment(issueId: string, body: string): Promise<boolean>;

  /** Find issue by its human-readable identifier (e.g. "DASH-12"). */
  findByIdentifier(identifier: string): Promise<BoardIssue | null>;

  /** Get the "Done" / completed state ID for a team. */
  getDoneStateId(teamId: string): Promise<string | null>;
}
