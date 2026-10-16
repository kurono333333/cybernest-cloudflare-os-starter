const D04_TYPES_CODE = `interface KnowledgeListInput { offset: number; limit: number; }
interface KnowledgeSearchInput { query: string; offset: number; limit: number; }
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
interface KnowledgeListResult { bundleId: string; versionId: string; items: Array<{ path: string }>; nextOffset?: number; }
interface KnowledgeSearchResult { bundleId: string; versionId: string; hits: Array<{ path: string; line: number; snippet: string }>; nextOffset?: number; }
interface KnowledgeReadResult { bundleId: string; versionId: string; path: string; sourceMarkdown: string; metadata: Record<string, unknown>; }
interface KnowledgeBase {
  list(input: KnowledgeListInput): Promise<KnowledgeListResult>;
  search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult>;
  read(input: KnowledgeReadInput): Promise<KnowledgeReadResult>;
  proposeArticle(input: { article: KnowledgeArticleProposal }): Promise<{ status: "pending_approval"; operationId: string }>;
}
`;
export default D04_TYPES_CODE;
