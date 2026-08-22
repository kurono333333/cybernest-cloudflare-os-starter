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

/** Query-driven semantic recall result. Patterns are routing hints, never factual authority. */
type KnowledgeRecallResult =
  | { state: "disabled" }
  | { state: "ready"; patterns: string[] };

interface KnowledgeUpdate {
  /** 1–255 UTF-8 bytes, without control characters or surrounding whitespace. */
  documentKey: string;
  /** null when creating; otherwise the current revision ID returned by list() or search(). */
  baseSourceRevisionId: string | null;
  /** Exact Markdown content, at most 1 MiB. */
  content: string;
}

interface KnowledgeBase {
  /** List current sources in stable document-key order; limit is an integer from 1 to 50; defaults to 20. */
  list(options?: { cursor?: string; limit?: number }): Promise<KnowledgePage>;
  /** Search by a normalized non-empty query of at most 256 UTF-8 bytes; limit is 1–50 and defaults to 20. */
  search(query: string, options?: { cursor?: string; limit?: number }): Promise<KnowledgePage>;
  /** Read one current source by the revision ID returned by list() or search(). */
  read(revisionId: string): Promise<KnowledgeSource>;
  /**
   * Ask Personal Knowledge where to recall for the current request.
   * Returned patterns are routing hints, not authority. Use search/read afterwards to ground claims in exact Sources.
   */
  recall(query: string): Promise<KnowledgeRecallResult>;
  /** Propose a new or replacement source; the current source changes only after approval. */
  proposeUpdate(update: KnowledgeUpdate): Promise<void>;
}
`;

export default TYPES_CODE;
