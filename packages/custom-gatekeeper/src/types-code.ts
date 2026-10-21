const D04_TYPES_CODE = `interface KnowledgeListInput { offset: number; limit: number; }
type KnowledgeComputerSearchInput = { query: string; offset: number; limit: number; };
type KnowledgeArticleSearchInput = { kind: "articles"; filters?: { type?: string; title?: string; description?: string; tag?: string; }; cursor?: string; limit: number; };
type KnowledgeArticleLinksSearchInput = { kind: "article-links"; articleId: string; direction: "links" | "backlinks"; maxDepth: number; candidateBudget: number; };
type KnowledgeSearchInput = KnowledgeComputerSearchInput | KnowledgeArticleSearchInput | KnowledgeArticleLinksSearchInput;
interface KnowledgeReadInput { path: string; }
type KnowledgeArticleSourceSelector =
  | { kind: "chat_message"; chatId: number; sequence: number }
  | { kind: "os_observation"; actionId: number; gatekeeperId: number };
type KnowledgeArticleProposal =
  | {
      kind: "adopt";
      body: string;
      sourceSelector: KnowledgeArticleSourceSelector;
      observedTargetDescription: string;
      sourceRelationshipClaim: string;
      initialUsePolicy: "included" | "excluded";
      expectedCurrentRevision: null;
    }
  | {
      kind: "revise";
      articleId: string;
      body: string;
      sourceSelector: KnowledgeArticleSourceSelector;
      observedTargetDescription: string;
      sourceRelationshipClaim: string;
      expectedCurrentRevision: string;
    };
type KnowledgeGoldJobControlIntent = {
  operation: "stop" | "resume";
  jobId: string;
  expectedJobState: "disabled" | "clean" | "dirty" | "running" | "candidate" | "published" | "partial" | "retry_wait" | "budget_wait" | "paused_user" | "paused_deterministic" | "paused_unknown" | "needs_reconciliation";
  expectedJobFence: number;
  expectedControlRevision: number;
  system1Recovery?: { decisionKeyHash: string; expectedRequestId: string; additionalMaxMicroUsd: 5000; };
};
type KnowledgeGoldPageSourceContextEntry = {
  articleId: string;
  revisionId: string;
  bodyHash: string;
  metadataRevision: number;
  projectionVersions: {
    projectionRuleVersion: string;
    processedVersion: string;
    relationVersion: string;
  };
};
type KnowledgeGoldPageActionIntent = {
  path: string;
  pageId: string;
  expectedPageVersion: number;
  expectedProtectionVersion: number;
  expectedControlRevision: number;
  sourceContext: KnowledgeGoldPageSourceContextEntry[];
};
type KnowledgeGoldPageEditIntent = KnowledgeGoldPageActionIntent & { content: string; };
interface KnowledgeListResult { bundleId: string; versionId: string; items: Array<{ path: string }>; nextOffset?: number; }
type KnowledgeSilverFacetCoverage = { status: "complete" | "partial"; reasons: string[]; };
type KnowledgeSilverSearchCoverage = { metadata: KnowledgeSilverFacetCoverage; internalLinks: KnowledgeSilverFacetCoverage; sources: KnowledgeSilverFacetCoverage; };
type KnowledgeSilverMetadataUnknownCoverage = KnowledgeSilverSearchCoverage & { metadata: { status: "partial"; reasons: string[]; }; };
type KnowledgeSilverProjectionLink =
  | { rawDestination: string; targetPath: string; fragment: string | null; resolution: "resolved_current"; targetArticleId: string; }
  | { rawDestination: string; targetPath: string; fragment: string | null; resolution: "resolved_exact"; targetArticleId: string; targetRevisionId: string; targetBodyHash: string; }
  | { rawDestination: string; targetPath: string; fragment: string | null; resolution: "unresolved" | "external_or_scope"; };
type KnowledgeSilverProjectionSource =
  | { descriptor: unknown; resolution: "resolved_current"; targetArticleId: string; }
  | { descriptor: unknown; resolution: "resolved_exact"; targetArticleId: string; targetRevisionId: string; targetBodyHash: string; }
  | { descriptor: unknown; resolution: "unresolved" | "external_or_scope"; };
type KnowledgeSilverProjectionResult = {
  articleId: string; inputRevisionId: string; projectionRuleVersion: string; processedVersion: string; relationVersion: string;
  metadata: Record<string, unknown> | null; literalLinks: KnowledgeSilverProjectionLink[];
  backlinks: Array<{ sourceArticleId: string; sourceRevisionId: string; targetRevisionId: string | null; targetBodyHash: string | null; }>;
  sources: KnowledgeSilverProjectionSource[]; coverage: KnowledgeSilverSearchCoverage;
};
type KnowledgeArticleSearchItemCommon = {
  articleId: string; currentRevisionId: string; usePolicy: "included"; currentPath: string; exactRevisionPath: string;
  bodyHash: string; coverage: KnowledgeSilverSearchCoverage;
};
type KnowledgeArticleSearchItem =
  | (KnowledgeArticleSearchItemCommon & { state: "indexed"; projection: KnowledgeSilverProjectionResult; })
  | (Omit<KnowledgeArticleSearchItemCommon, "coverage"> & { state: "metadata_unknown"; projection: KnowledgeSilverProjectionResult; coverage: KnowledgeSilverMetadataUnknownCoverage; })
  | (KnowledgeArticleSearchItemCommon & { state: "pending"; projection: null; });
type KnowledgeSearchResult =
  | { bundleId: string; versionId: string; hits: Array<{ path: string; line: number; snippet: string }>; nextOffset?: number; }
  | { kind: "articles"; items: KnowledgeArticleSearchItem[]; nextCursor?: string; coverage: KnowledgeSilverSearchCoverage; }
  | { kind: "article-links"; items: Array<{ depth: number; item: KnowledgeArticleSearchItem; }>; coverage: KnowledgeSilverSearchCoverage; };
type KnowledgeReadResult =
  | { kind: "navigation"; path: "articles" | "index.md"; sourceMarkdown: string; goldStatus: "disabled" | "enabled" | "paused"; }
  | { bundleId: string; versionId: string; path: string; sourceMarkdown: string; metadata: Record<string, unknown>; }
  | {
      kind: "article";
      articleId: string;
      revisionId: string;
      bodyHash: string;
      path: string;
      sourceMarkdown: string;
      metadata: Record<string, unknown>;
    };
interface KnowledgeBase {
  list(input: KnowledgeListInput): Promise<KnowledgeListResult>;
  search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult>;
  read(input: KnowledgeReadInput): Promise<KnowledgeReadResult>;
  proposeArticle(input: { article: KnowledgeArticleProposal }): Promise<{ status: "pending_approval"; operationId: string }>;
  proposeArticlePolicy(input: { articleId: string; usePolicy: "included" | "excluded"; expectedMetadataRevision: number; }): Promise<{ status: "pending_approval"; operationId: string; }>;
  proposeGoldJobControl(input: { intent: KnowledgeGoldJobControlIntent; }): Promise<{ status: "pending_approval"; operationId: string; }>;
  proposeGoldPageEdit(input: { intent: KnowledgeGoldPageEditIntent; }): Promise<{ status: "pending_approval"; operationId: string; }>;
  proposeGoldCleanReplacement(input: { intent: KnowledgeGoldPageActionIntent; }): Promise<{ status: "pending_approval"; operationId: string; }>;
}
`;
export default D04_TYPES_CODE;
