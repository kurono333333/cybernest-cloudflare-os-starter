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
export interface BronzeProvenance {
  sourceKind: "conversation" | "user_document" | "explicit_user_input";
  reference: string;
  capturedAt: string;
}
export type BronzeAdoptionProposal = { operationId: string; status: "pending_approval" };
export type BronzeReceipt = {
  receiptId: string;
  knowledgeId: string;
  generation: 1;
  operationId: string;
  sourceId: string;
  revisionId: string;
  revisionNumber: 1;
  contentHash: string;
  committedAt: string;
};
export type KnowledgeAdoptionOutcome =
  | { operationId: string; status: "pending_approval" }
  | { operationId: string; status: "outcome_unknown"; reason: "outcome_unknown" }
  | { operationId: string; status: "failed"; reason: "service_not_ready" | "not_found" | "provisioning" | "blocked" | "forbidden" | "invalid_input" | "payload_too_large" | "operation_conflict" }
  | { operationId: string; status: "applied"; outcome: "committed" | "already_committed"; receipt: BronzeReceipt };
export type ArticleMeaning =
  | "proposal"
  | "inference"
  | "explicit_decision"
  | "observed_result";
export type ArticleSourceKind =
  | "conversation"
  | "tool_result"
  | "explicit_user_input"
  | "user_document"
  | "artifact";
export type ArticleActorKind = "user" | "assistant" | "tool" | "system";
export interface ActivityArticleSection {
  text: string;
  meaning: ArticleMeaning;
  sourceIds: string[];
}
export interface ActivityArticleSource {
  sourceId: string;
  kind: ArticleSourceKind;
  reference: string;
  version?: string;
  contentHash?: string;
  actor: { kind: ArticleActorKind; reference?: string };
  recordedAt: string;
  eventAt?: string;
  excerpt?: string;
}
export interface ActivityArticle {
  sections: ActivityArticleSection[];
  sources: ActivityArticleSource[];
}
export type ArticleFailure =
  | "service_not_ready"
  | "capacity_exceeded"
  | "forbidden"
  | "invalid_input"
  | "article_too_large"
  | "operation_conflict"
  | "integrity_failure";
export type ArticleReceipt = {
  receiptId: string;
  knowledgeId: string;
  generation: 1;
  operationId: string;
  actionRef: string;
  payloadHash: string;
  articleId: string;
  revisionId: string;
  revisionNumber: 1;
  committedAt: string;
};
export type KnowledgeArticleOutcome =
  | { operationId: string; status: "pending_approval" }
  | { operationId: string; status: "outcome_unknown"; reason: "outcome_unknown" }
  | { operationId: string; status: "failed"; reason: ArticleFailure }
  | {
      operationId: string;
      status: "applied";
      outcome: "committed" | "already_committed";
      receipt: ArticleReceipt;
    };
export interface KnowledgeArticleProposal {
  operationId: string;
  status: "pending_approval";
}
export interface Knowledge {
  readBronze(input: {
    sourceId: string;
    revisionId?: string;
  }): Promise<KnowledgeRevision | null>;
  proposeBronzeAdoption(input: {
    document: string;
    provenance: BronzeProvenance;
  }): Promise<BronzeAdoptionProposal>;
  readAdoptionOutcome(input: {
    operationId: string;
  }): Promise<KnowledgeAdoptionOutcome | null>;
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
  proposeArticle(input: { article: ActivityArticle }): Promise<KnowledgeArticleProposal>;
  readArticleOutcome(input: { operationId: string }): Promise<KnowledgeArticleOutcome | null>;
  proposeKnowledgeCreate(input: { displayName: string }): Promise<{
    operationId: string;
    status: "pending_approval";
  }>;
  readCreationOutcome(input: { operationId: string }): Promise<KnowledgeCreationOutcome | null>;
}
