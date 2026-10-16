export interface KnowledgeListInput {
  offset: number;
  limit: number;
}
export interface KnowledgeSearchInput {
  query: string;
  offset: number;
  limit: number;
}
export interface KnowledgeReadInput {
  path: string;
}
export interface KnowledgeListResult {
  bundleId: string;
  versionId: string;
  items: Array<{ path: string }>;
  nextOffset?: number;
}
export interface KnowledgeSearchResult {
  bundleId: string;
  versionId: string;
  hits: Array<{ path: string; line: number; snippet: string }>;
  nextOffset?: number;
}
export interface KnowledgeReadResult {
  bundleId: string;
  versionId: string;
  path: string;
  sourceMarkdown: string;
  metadata: Record<string, unknown>;
}
export interface KnowledgeBase {
  list(input: KnowledgeListInput): Promise<KnowledgeListResult>;
  search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult>;
  read(input: KnowledgeReadInput): Promise<KnowledgeReadResult>;
}
