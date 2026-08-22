# Issue 640 — Gold recall capability seam

This maintenance keeps Cloudflare OS `AgentCatalog` in its native discovery role and exposes Gold only through an explicit `KnowledgeBase.recall(query)` call.

It does not implement Gold generation, Silver Semantic Graph storage, embeddings, Vectorize, or Source retrieval changes.

```txt
Cloudflare OS system context
  -> Knowledge Base is available
    -> describe/use KNOWLEDGE when relevant
      -> KNOWLEDGE.recall(current request)
        -> bounded abstract semantic directions
          -> search/read exact Sources
```

Invariants:

- `AgentCatalog` does not carry Gold patterns; it remains bounded discovery metadata.
- Gold is routing data only; it is not fact or instruction authority.
- `recall(query)` is request-driven; Gold is not pushed into ambient system context.
- A malformed, unavailable, or mixed-version Gold capability returns `state: disabled`, leaving list/search/read available.
- Internal generation/version metadata is not exposed through the agent-facing `KnowledgeBase` session.
- Gold results are not persisted into conversation or Source authority by this Gatekeeper.
- Bronze Knowledge remains the grounding source for final claims.
