# Issue 640 — Gold recall context seam

This maintenance prepares the existing native Cloudflare OS `AgentCatalog` path to carry bounded Gold recall patterns from Manager-scoped Personal Knowledge.

It does not implement Gold generation, Silver Semantic Graph storage, embeddings, Vectorize, or Source retrieval changes.

Invariants:

- Gold is routing data only; it is not fact or instruction authority.
- A malformed, unavailable, or mixed-version Gold capability falls back to the existing Knowledge Base catalog description.
- No Gold projection is persisted into conversation state by this Gatekeeper.
- Only bounded abstract patterns enter the prompt-facing catalog; generation metadata stays internal.
- Bronze Knowledge discoverability remains available when Gold is disabled.
