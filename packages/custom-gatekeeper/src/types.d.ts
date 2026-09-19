export interface KnowledgeSummary {
  knowledgeId: string;
  generation: 1;
  displayName: string;
  role: "initial" | "additional";
  state: "provisioning" | "ready" | "blocked";
  createdAt: string;
  updatedAt: string;
  access?: Knowledge;
}
export interface KnowledgeCreationSummary {
  knowledgeId: string;
  generation: 1;
  displayName: string;
  role: "additional";
  state: "provisioning" | "ready" | "blocked";
  createdAt: string;
  updatedAt: string;
}
export type CreationFailure =
  | "service_not_ready"
  | "capacity_exceeded"
  | "forbidden"
  | "invalid_input"
  | "operation_conflict"
  | "integrity_failure"
  | "deadline_exceeded"
  | "outcome_unknown"
  | "dependency_unavailable";
export type CreationTerminalFailure =
  | "service_not_ready"
  | "capacity_exceeded"
  | "forbidden"
  | "invalid_input"
  | "operation_conflict"
  | "integrity_failure";
export type KnowledgeCreationOutcome =
  | { operationId: string; status: "pending_approval" }
  | { operationId: string; status: "outcome_unknown"; reason: "outcome_unknown" }
  | { operationId: string; status: "failed"; reason: CreationTerminalFailure }
  | {
      operationId: string;
      status: "applied";
      outcome: "ready" | "already_ready" | "provisioning" | "blocked";
      knowledge: KnowledgeCreationSummary;
    };
export interface KnowledgePage {
  items: KnowledgeSummary[];
  nextCursor: string | null;
}
export interface Knowledge {
  readBronze(input: {
    sourceId: string;
    revisionId?: string;
  }): Promise<KnowledgeRevision | null>;
}
export interface KnowledgeRevision {
  knowledgeId: string;
  generation: 1;
  sourceId: string;
  revisionId: string;
  revisionNumber: 1;
  baseRevisionId: string | null;
  document: string;
  contentHash: string;
  type: "Source";
  title: string;
  description: string;
  provenance: {
    sourceKind: "conversation" | "user_document" | "explicit_user_input";
    reference: string;
    capturedAt: string;
  };
  committedAt: string;
}
export interface KnowledgeBase {
  list(options?: { cursor?: string; limit?: number }): Promise<KnowledgePage>;
  proposeKnowledgeCreate(input: { displayName: string }): Promise<{
    operationId: string;
    status: "pending_approval";
  }>;
  readCreationOutcome(input: { operationId: string }): Promise<KnowledgeCreationOutcome | null>;
}
