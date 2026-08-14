const TYPES_CODE = `/** Current long-term knowledge available to this Manager. */
interface KnowledgeReference {
  revisionId: string;
  documentKey: string;
  contentHash: string;
}

interface KnowledgePage {
  items: KnowledgeReference[];
  nextCursor: string | null;
}

interface KnowledgeSource extends KnowledgeReference {
  content: string;
}

interface KnowledgeUpdate {
  documentKey: string;
  baseSourceRevisionId: string | null;
  content: string;
}

interface KnowledgeBase {
  /** List current Knowledge Base sources in stable document-key order. */
  list(options?: { cursor?: string; limit?: number }): Promise<KnowledgePage>;
  /** Search current Knowledge Base sources by normalized substring query. */
  search(query: string, options?: { cursor?: string; limit?: number }): Promise<KnowledgePage>;
  /** Read one current source by the revision ID returned by list() or search(). */
  read(revisionId: string): Promise<KnowledgeSource>;
  /** Propose a new or replacement source; the current source changes only after approval. */
  proposeUpdate(update: KnowledgeUpdate): Promise<void>;
}
`;

export default TYPES_CODE;
