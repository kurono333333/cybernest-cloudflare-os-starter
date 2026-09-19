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
}
