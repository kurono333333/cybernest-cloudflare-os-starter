/** A current Knowledge Base source reference. */
export interface KnowledgeReference {
  revisionId: string;
  documentKey: string;
  contentHash: string;
}

/** A bounded page of current Knowledge Base source references. */
export interface KnowledgePage {
  items: KnowledgeReference[];
  nextCursor: string | null;
}

/** One current Knowledge Base source. */
export interface KnowledgeSource extends KnowledgeReference {
  content: string;
}

/** A full replacement proposal; it is not applied until native approval succeeds. */
export interface KnowledgeUpdate {
  documentKey: string;
  baseSourceRevisionId: string | null;
  content: string;
}

/** Current long-term knowledge available to this Manager. */
export interface KnowledgeBase {
  /** List current sources in stable document-key order. */
  list(options?: { cursor?: string; limit?: number }): Promise<KnowledgePage>;
  /** Search current sources by normalized substring query. */
  search(query: string, options?: { cursor?: string; limit?: number }): Promise<KnowledgePage>;
  /** Read one current source by a revision ID returned by list() or search(). */
  read(revisionId: string): Promise<KnowledgeSource>;
  /** Propose a new or replacement source; current content changes only after approval. */
  proposeUpdate(update: KnowledgeUpdate): Promise<void>;
}
