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

/** Query-driven semantic recall result. Patterns are routing hints, never factual authority. */
export type KnowledgeRecallResult =
  | { state: "disabled" }
  | { state: "ready"; patterns: string[] };

/** A full replacement proposal; it is not applied until native approval succeeds. */
export interface KnowledgeUpdate {
  /** 1–255 UTF-8 bytes, without control characters or surrounding whitespace. */
  documentKey: string;
  /** null when creating; otherwise the current revision ID returned by list() or search(). */
  baseSourceRevisionId: string | null;
  /** Exact Markdown content, at most 1 MiB. */
  content: string;
}

/** Current long-term knowledge available to this Manager. */
export interface KnowledgeBase {
  /** List current sources in stable document-key order; limit is an integer from 1 to 50; defaults to 20. */
  list(options?: { cursor?: string; limit?: number }): Promise<KnowledgePage>;
  /** Search by a normalized non-empty query of at most 256 UTF-8 bytes; limit is 1–50 and defaults to 20. */
  search(query: string, options?: { cursor?: string; limit?: number }): Promise<KnowledgePage>;
  /** Read one current source by a revision ID returned by list() or search(). */
  read(revisionId: string): Promise<KnowledgeSource>;
  /** Ask where to recall for the current request, then use search/read to ground claims in exact Sources. */
  recall(query: string): Promise<KnowledgeRecallResult>;
  /** Propose a new or replacement source; current content changes only after approval. */
  proposeUpdate(update: KnowledgeUpdate): Promise<void>;
}
