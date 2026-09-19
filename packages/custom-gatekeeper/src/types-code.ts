const TYPES_CODE = `interface KnowledgeSummary { knowledgeId: string; generation: 1; displayName: string; role: "initial" | "additional"; state: "provisioning" | "ready" | "blocked"; createdAt: string; updatedAt: string; access?: Knowledge; }
interface KnowledgePage { items: KnowledgeSummary[]; nextCursor: string | null; }
interface Knowledge { readBronze(input: { sourceId: string; revisionId?: string }): Promise<KnowledgeRevision | null>; }
interface KnowledgeRevision { knowledgeId: string; generation: 1; sourceId: string; revisionId: string; revisionNumber: 1; baseRevisionId: string | null; document: string; contentHash: string; type: "Source"; title: string; description: string; provenance: { sourceKind: "conversation" | "user_document" | "explicit_user_input"; reference: string; capturedAt: string }; committedAt: string; }
interface KnowledgeBase { list(options?: { cursor?: string; limit?: number }): Promise<KnowledgePage>; }
`;
export default TYPES_CODE;
