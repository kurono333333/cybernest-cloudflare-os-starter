# Custom Gatekeeper

This package installs the Manager-private, read-only Knowledge Base singleton for Cloudflare OS.
The native Agent surface is deliberately small:

```ts
KnowledgeBase.list({ cursor?, limit? })
  -> KnowledgePage
KnowledgeSummary.state === "ready"
  -> Knowledge.readBronze({ sourceId, revisionId? })
```

`list` returns bounded summaries. Only a `ready` summary receives a `Knowledge` capability; that
capability captures the validated `knowledgeId` and `generation` from the summary and does not ask
the Agent to provide Manager identity or a physical target name. Bronze reads are strict,
read-only projections of the S13 capability. Every list/read result is validated before the native
observation authorization is awaited, and malformed results are never authorized or returned.

The Knowledge Base is private to its Manager. Observer registration is rejected, catalog discovery
is one bounded metadata entry, and read observations are marked `prohibitAllSharing`. The account
install path validates the exact capability props and binds the capability to the Manager before
creating the singleton account. Legacy `undefined`/`{}` account props remain inspectable for
backward compatibility, but cannot create a bound Gatekeeper.

## S14 boundary

This slice has no search API, flat read API, LLM or MCP endpoint, OAuth flow, public HTTP resource,
or write/proposal/action API. Manual writes and Core adoption are deferred to the next slice.

## Files and checks

- `src/types.d.ts` is the checked reference for the Agent-facing `KnowledgeBase` and `Knowledge`
  interfaces.
- `src/types-code.ts` is the runtime declaration returned by the Gatekeeper; keep it synchronized
  with `types.d.ts`.
- `src/custom.ts` owns the account binding, bounded projection, strict decoding, observations, and
  lifecycle/disposal behavior.
- `__tests__/worker.ts` is the local Worker/Durable Object/RPC fixture used by integration tests.

Run the package checks from `cloudflare-os-starter`:

```sh
pnpm --filter custom-gatekeeper test
pnpm --filter custom-gatekeeper types:check
pnpm --filter custom-gatekeeper build
```
