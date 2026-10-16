import { env } from "cloudflare:workers";
import type { RpcStub } from "cloudflare:workers";
import type {
  ApprovalQueue,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { KnowledgeAccess } from "../src/custom.js";
import { describe, expect, it } from "vitest";
import TYPES_CODE from "../src/types-code.js";
import {
  KnowledgeSession,
  describeCustomAccount,
  describeCustomVendor,
} from "../src/custom.js";

const KNOWLEDGE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_KNOWLEDGE_ID = "54444444-4444-4444-8444-444444444444";
const SOURCE_ID = "74444444-4444-4444-8444-444444444444";
const REVISION_ID = "84444444-8444-4444-8444-444444444444";
const NOW = "2026-01-01T00:00:00.000Z";

type ListInput = { cursor?: string; limit?: number };
type BronzeInput = { sourceId: string; revisionId?: string };
type BronzeProvenance = {
  sourceKind: "conversation" | "user_document" | "explicit_user_input";
  reference: string;
  capturedAt: string;
};
type BronzeAdoptionInput = {
  document: string;
  provenance: BronzeProvenance;
};
type FakeAccess = {
  list(input?: ListInput): Promise<unknown>;
  readBronze(input: Record<string, unknown>): Promise<unknown>;
  adoptBronze(input: Record<string, unknown>): Promise<unknown>;
  readAdoptionOutcome(input: Record<string, unknown>): Promise<unknown>;
};

const summary = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  knowledgeId: KNOWLEDGE_ID,
  generation: 1,
  displayName: "Initial Knowledge",
  role: "initial",
  state: "ready",
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const revision = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  knowledgeId: KNOWLEDGE_ID,
  generation: 1,
  sourceId: SOURCE_ID,
  revisionId: REVISION_ID,
  revisionNumber: 1,
  baseRevisionId: null,
  document: "# K",
  contentHash:
    "896969cf655830641e58e58c011508ac9d3e7ff9cfbd87d3152a41347949b582",
  type: "Source",
  title: "Knowledge",
  description: "Description",
  provenance: {
    sourceKind: "explicit_user_input",
    reference: "fixture",
    capturedAt: NOW,
  },
  committedAt: NOW,
  ...overrides,
});

class FakeQueue {
  readonly observations: ObservationDescription[] = [];
  duplicateCount = 0;
  disposeCount = 0;
  reject = false;

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push({ ...description });
    if (this.reject) throw new Error("observation denied");
  }

  dup(): FakeQueue {
    this.duplicateCount += 1;
    return this;
  }

  [Symbol.dispose](): void {
    this.disposeCount += 1;
  }
}

class FakeAccessImpl implements FakeAccess {
  listResult: unknown = { _tag: "page", items: [] };
  bronzeResult: unknown = { _tag: "not_found" };
  listError: Error | null = null;
  bronzeError: Error | null = null;
  readonly listInputs: Array<ListInput | undefined> = [];
  readonly bronzeInputs: Array<Record<string, unknown>> = [];
  readonly adoptionInputs: Array<Record<string, unknown>> = [];
  readonly adoptionOutcomeInputs: Array<Record<string, unknown>> = [];

  async list(input?: ListInput): Promise<unknown> {
    this.listInputs.push(input);
    if (this.listError !== null) throw this.listError;
    return this.listResult;
  }

  async readBronze(input: Record<string, unknown>): Promise<unknown> {
    this.bronzeInputs.push({ ...input });
    if (this.bronzeError !== null) throw this.bronzeError;
    return this.bronzeResult;
  }

  async adoptBronze(input: Record<string, unknown>): Promise<unknown> {
    this.adoptionInputs.push({ ...input });
    return {
      _tag: "committed",
      outcome: "committed",
      receipt: {
        receiptId: REVISION_ID,
        knowledgeId: input.knowledgeId,
        generation: input.generation,
        operationId: input.operationId,
        sourceId: SOURCE_ID,
        revisionId: REVISION_ID,
        revisionNumber: 1,
        contentHash: "a".repeat(64),
        committedAt: NOW,
      },
    };
  }

  async readAdoptionOutcome(input: Record<string, unknown>): Promise<unknown> {
    this.adoptionOutcomeInputs.push({ ...input });
    return { _tag: "unobserved" };
  }
}

const newSession = (
  queue: FakeQueue,
  access: FakeAccessImpl,
): KnowledgeSession =>
  new KnowledgeSession(
    queue as unknown as RpcStub<ApprovalQueue>,
    access as unknown as never,
  );

describe("S15 generated type contract", () => {
  it("publishes only list/search/read DTO types, without authority or receipt fields", () => {
    expect(TYPES_CODE).toContain("interface KnowledgeBase");
    expect(TYPES_CODE).toContain("list(input: KnowledgeListInput)");
    expect(TYPES_CODE).toContain("search(input: KnowledgeSearchInput)");
    expect(TYPES_CODE).toContain("read(input: KnowledgeReadInput)");
    expect(TYPES_CODE).not.toMatch(/proposal|propose|readBronze|readArticle|managerId|userId|ownerId|assertBoundTo|expiresAt|receiptId/u);
  });
});

describe("S14 public surface and descriptions", () => {
  it("publishes a private Knowledge Base singleton with exact metadata", () => {
    expect(describeCustomAccount()).toEqual({
      displayName: "Knowledge Base",
      avatar: expect.objectContaining({ url: expect.stringContaining("data:image/svg+xml") }),
      singleton: { tsType: "KnowledgeBase" },
    });
    expect(describeCustomVendor()).toMatchObject({
      displayName: "Custom Gatekeeper",
      providesAuth: false,
    });
  });

  it("keeps generated Agent types free of owner, receipt, and write APIs", () => {
    expect(TYPES_CODE).toContain("interface KnowledgeBase");
    expect(TYPES_CODE).toMatch(/list\(/u);
    expect(TYPES_CODE).toMatch(/search\(/u);
    expect(TYPES_CODE).toMatch(/read\(/u);
    expect(TYPES_CODE).not.toMatch(/managerId|userId|ownerId|assertBoundTo|expiresAt|receiptId|propose|readBronze|readArticle/u);
  });
});

describe.skip("Retired catalog summary and child-handle API", () => {
  it.each([
    ["undefined", undefined],
    ["empty", {}],
    ["cursor-only", { cursor: "cursor" }],
    ["limit-only", { limit: 1 }],
    ["both", { cursor: "cursor", limit: 1 }],
  ])("accepts %s options", async (_name, input) => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    access.listResult = { _tag: "page", items: [] };
    await expect(newSession(queue, access).list(input)).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(access.listInputs).toHaveLength(1);
  });

  it.each([
    ["extra key", { cursor: "ok", extra: true }],
    ["empty cursor", { cursor: "" }],
    ["bad cursor", { cursor: "!" }],
    ["oversized cursor", { cursor: "a".repeat(257) }],
    ["fractional limit", { limit: 1.5 }],
    ["zero limit", { limit: 0 }],
    ["oversized limit", { limit: 51 }],
  ])("rejects %s before the capability call", async (_name, input) => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    await expect(
      newSession(queue, access).list(input as unknown as ListInput),
    ).rejects.toThrow(/invalid_input/);
    expect(access.listInputs).toHaveLength(0);
    expect(queue.observations).toHaveLength(0);
  });

  it("enforces requested/default/max page sizes and exact summary shape", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    access.listResult = {
      _tag: "page",
      items: [
        summary(),
        summary({
          knowledgeId: OTHER_KNOWLEDGE_ID,
          displayName: "Additional Knowledge",
          role: "additional",
          state: "blocked",
        }),
      ],
      nextCursor: "next",
    };
    const result = await newSession(queue, access).list({ limit: 2 });
    expect(result.nextCursor).toBe("next");
    expect(result.items[0]).toMatchObject({ knowledgeId: KNOWLEDGE_ID });
    expect(result.items[0]).toHaveProperty("access");
    expect(result.items[1]).toEqual(
      summary({
        knowledgeId: OTHER_KNOWLEDGE_ID,
        displayName: "Additional Knowledge",
        role: "additional",
        state: "blocked",
      }),
    );
    expect(Object.keys(result.items[0] ?? {}).toSorted()).toEqual([
      "access",
      "createdAt",
      "displayName",
      "generation",
      "knowledgeId",
      "role",
      "state",
      "updatedAt",
    ]);

    access.listResult = {
      _tag: "page",
      items: Array.from({ length: 3 }, () => summary()),
    };
    await expect(newSession(new FakeQueue(), access).list({ limit: 2 })).rejects.toThrow(
      /integrity_failure/,
    );
  });

  it.each([null, "next"])("accepts a strict nextCursor %s", async (nextCursor) => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    access.listResult = { _tag: "page", items: [], nextCursor };
    const result = await newSession(queue, access).list();
    expect(result.nextCursor).toBe(nextCursor);
  });

  it("rejects an explicit undefined nextCursor key", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    access.listResult = { _tag: "page", items: [], nextCursor: undefined };
    await expect(newSession(queue, access).list()).rejects.toThrow(/integrity_failure/);
    expect(queue.observations).toHaveLength(0);
  });

  it("does not expose handles for provisioning or blocked summaries", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    access.listResult = {
      _tag: "page",
      items: [summary({ state: "provisioning" }), summary({ state: "blocked" })],
    };
    const result = await newSession(queue, access).list();
    expect(result.items.every((item) => !Object.hasOwn(item, "access"))).toBe(true);
    expect(queue.duplicateCount).toBe(0);
  });

  it("rejects untrimmed display names before authorizing the list", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    access.listResult = { _tag: "page", items: [summary({ displayName: " Initial Knowledge" })] };
    await expect(newSession(queue, access).list()).rejects.toThrow(/integrity_failure/);
    expect(queue.observations).toHaveLength(0);
  });
});

describe.skip("Retired Bronze read and adoption API", () => {
  it("captures the validated locator and supports current and historical reads", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    const handle = await newHandle(queue, access);
    access.bronzeResult = { _tag: "found", revision: revision() };
    await expect(handle.readBronze({ sourceId: SOURCE_ID })).resolves.toMatchObject({
      knowledgeId: KNOWLEDGE_ID,
      sourceId: SOURCE_ID,
    });
    access.bronzeResult = {
      _tag: "found",
      revision: revision({
        revisionId: REVISION_ID,
        document: "# historical",
        contentHash:
          "baddadc05c983f0496ebc443f13428501c639a05583577f118e0f7bcdbd705b5",
      }),
    };
    const historical = await handle.readBronze({
      sourceId: SOURCE_ID,
      revisionId: REVISION_ID,
    });
    expect(historical?.revisionId).toBe(REVISION_ID);
    expect(access.bronzeInputs).toEqual([
      { knowledgeId: KNOWLEDGE_ID, generation: 1, sourceId: SOURCE_ID },
      {
        knowledgeId: KNOWLEDGE_ID,
        generation: 1,
        sourceId: SOURCE_ID,
        revisionId: REVISION_ID,
      },
    ]);
  });

  it("returns null only for exact not_found", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    const handle = await newHandle(queue, access);
    await expect(handle.readBronze({ sourceId: SOURCE_ID })).resolves.toBeNull();
    expect(queue.observations).toHaveLength(2);
    access.bronzeResult = { _tag: "not_found", extra: true };
    await expect(handle.readBronze({ sourceId: SOURCE_ID })).rejects.toThrow(
      /integrity_failure/,
    );
    expect(queue.observations).toHaveLength(2);
  });

  it.each([
    "forbidden",
    "service_not_ready",
    "invalid_input",
    "integrity_failure",
    "deadline_exceeded",
    "provisioning",
    "blocked",
  ] as const)("authorizes then returns safe %s failure", async (tag) => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    const handle = await newHandle(queue, access);
    access.bronzeResult = { _tag: tag };
    await expect(handle.readBronze({ sourceId: SOURCE_ID })).rejects.toThrow(tag);
    expect(queue.observations).toHaveLength(2);
  });

  it("decodes dependency failures strictly and rejects unknown tags without observing", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    const handle = await newHandle(queue, access);
    access.bronzeResult = {
      _tag: "dependency_unavailable",
      dependency: "knowledge-read",
    };
    await expect(handle.readBronze({ sourceId: SOURCE_ID })).rejects.toThrow(
      /dependency_unavailable/,
    );
    expect(queue.observations).toHaveLength(2);
    access.bronzeResult = { _tag: "dependency_unavailable", dependency: "unknown" };
    await expect(handle.readBronze({ sourceId: SOURCE_ID })).rejects.toThrow(
      /integrity_failure/,
    );
    access.bronzeResult = { _tag: "future_failure" };
    await expect(handle.readBronze({ sourceId: SOURCE_ID })).rejects.toThrow(
      /integrity_failure/,
    );
    expect(queue.observations).toHaveLength(2);
  });

  it.each([
    ["extra revision key", revision({ extra: true })],
    ["correlation mismatch", revision({ knowledgeId: OTHER_KNOWLEDGE_ID })],
    ["hash mismatch", revision({ contentHash: "0".repeat(64) })],
    ["unpaired surrogate", revision({ document: "\uD800" })],
  ] as const)("rejects malformed %s before authorization", async (_name, value) => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    const handle = await newHandle(queue, access);
    access.bronzeResult = { _tag: "found", revision: value };
    await expect(handle.readBronze({ sourceId: SOURCE_ID })).rejects.toThrow(
      /integrity_failure/,
    );
    expect(queue.observations).toHaveLength(1);
  });

  it("accepts upstream projection text with whitespace and line controls", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    const handle = await newHandle(queue, access);
    access.bronzeResult = {
      _tag: "found",
      revision: revision({
        title: "Title line 1\n\tTitle line 2\r\n",
        description: "Description line 1\r\n\tDescription line 2",
      }),
    };
    await expect(handle.readBronze({ sourceId: SOURCE_ID })).resolves.toMatchObject({
      title: "Title line 1\n\tTitle line 2\r\n",
      description: "Description line 1\r\n\tDescription line 2",
      contentHash:
        "896969cf655830641e58e58c011508ac9d3e7ff9cfbd87d3152a41347949b582",
    });
    expect(queue.observations).toHaveLength(2);
  });

  it("rejects untrimmed provenance references before authorization", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    const handle = await newHandle(queue, access);
    access.bronzeResult = {
      _tag: "found",
      revision: revision({
        provenance: {
          sourceKind: "explicit_user_input",
          reference: " fixture",
          capturedAt: NOW,
        },
      }),
    };
    await expect(handle.readBronze({ sourceId: SOURCE_ID })).rejects.toThrow(
      /integrity_failure/,
    );
    expect(queue.observations).toHaveLength(1);
  });

  it("validates input keys and canonical timestamps/UTF-8 bounds", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    const handle = await newHandle(queue, access);
    await expect(
      handle.readBronze({ sourceId: SOURCE_ID, extra: true } as unknown as BronzeInput),
    ).rejects.toThrow(/invalid_input/);
    access.bronzeResult = {
      _tag: "found",
      revision: revision({ committedAt: "2026-02-30T00:00:00.000Z" }),
    };
    await expect(handle.readBronze({ sourceId: SOURCE_ID })).rejects.toThrow(
      /integrity_failure/,
    );
    access.bronzeResult = {
      _tag: "found",
      revision: revision({ document: "a".repeat(65_537) }),
    };
    await expect(handle.readBronze({ sourceId: SOURCE_ID })).rejects.toThrow(
      /integrity_failure/,
    );
  });
});

describe.skip("Retired Bronze capability lifecycle", () => {
  it("awaits authorization and returns no page/data when authorization rejects", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    access.listResult = { _tag: "page", items: [summary()] };
    queue.reject = true;
    await expect(newSession(queue, access).list()).rejects.toThrow("observation denied");
    expect(queue.duplicateCount).toBe(1);
    expect(queue.disposeCount).toBe(1);

    const readQueue = new FakeQueue();
    const readAccess = new FakeAccessImpl();
    const handle = await newHandle(readQueue, readAccess);
    readQueue.reject = true;
    readAccess.bronzeResult = { _tag: "found", revision: revision() };
    await expect(handle.readBronze({ sourceId: SOURCE_ID })).rejects.toThrow(
      "observation denied",
    );
  });

  it("duplicates once per ready handle and disposes handles/session exactly once", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    access.listResult = {
      _tag: "page",
      items: [summary(), summary({ knowledgeId: OTHER_KNOWLEDGE_ID })],
    };
    const session = newSession(queue, access);
    const page = await session.list();
    expect(page.items.filter((item) => item.access !== undefined)).toHaveLength(2);
    expect(queue.duplicateCount).toBe(2);
    const first = page.items[0]?.access;
    first?.[Symbol.dispose]?.();
    first?.[Symbol.dispose]?.();
    session[Symbol.dispose]();
    session[Symbol.dispose]();
    expect(queue.disposeCount).toBe(3);
  });

  it("maps capability RPC failures without authorizing", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    access.listError = new Error("remote unavailable");
    await expect(newSession(queue, access).list()).rejects.toThrow(
      /dependency_unavailable/,
    );
    expect(queue.observations).toHaveLength(0);
    const readQueue = new FakeQueue();
    const readAccess = new FakeAccessImpl();
    const handle = await newHandle(readQueue, readAccess);
    readAccess.bronzeError = new Error("remote unavailable");
    await expect(handle.readBronze({ sourceId: SOURCE_ID })).rejects.toThrow(
      /dependency_unavailable/,
    );
    expect(readQueue.observations).toHaveLength(1);
  });
});

describe("S14 actual Worker/DO/RPC integration", () => {
  type TestFactory = {
    runRead(options?: {
      listMode?: "valid" | "empty" | "failure" | "malformed" | "extra" | "rpc_failure";
      bronzeMode?:
        | "current"
        | "historical"
        | "not_found"
        | "failure"
        | "unknown_tag"
        | "malformed"
        | "extra"
        | "hash_mismatch"
        | "correlation_mismatch"
        | "rpc_failure";
      states?: Array<"provisioning" | "ready" | "blocked">;
      nextCursor?: "omit" | "null" | "string";
      listOptions?: { cursor?: string; limit?: number };
      rejectObservationAt?: number | null;
    }): Promise<{
      page: Array<Record<string, unknown>> | null;
      nextCursor: string | null;
      read: unknown;
      error: string | null;
      observations: ObservationDescription[];
      readInputs: unknown[];
      queueDisposals: number;
    }>;
    runAccount(managerId?: string): Promise<{
      description: { displayName?: string; singleton?: { tsType: string } };
      binding: "legacy" | "bound";
      page: Record<string, unknown>;
      observations: ObservationDescription[];
      boundInputs: string[];
    }>;
    runConcurrentAccountBinding(): Promise<{
      bindResults: Array<"fulfilled" | "rejected">;
      firstStored: string;
      afterRebind: string;
      foreignError: string | null;
      afterForeign: string;
    }>;
    runAccountError(options?: {
      requestedManagerId?: string;
      capabilityManagerId?: string;
      assertMode?: "ok" | "wrong_manager" | "rpc_failure";
      extraProps?: boolean;
    }): Promise<string | null>;
    runLegacyAccount(): Promise<{ binding: string | null; error: string | null }>;
    runCatalog(limit: number): Promise<{
      catalog: { entries: Array<Record<string, unknown>>; truncated?: boolean };
      observations: ObservationDescription[];
    }>;
    runObserverRejection(): Promise<string | null>;
    runMalformedSession(): Promise<{ duplicateCount: number; error: string | null }>;
  };

  const testEnv = env as unknown as { TEST_FACTORY: DurableObjectNamespace<TestFactory> };
  const factory = (): DurableObjectStub<TestFactory> =>
    testEnv.TEST_FACTORY.getByName("s14-" + crypto.randomUUID());

  it.skip("executes the retired catalog-summary and Bronze-handle path", async () => {
    await factory().runRead({ nextCursor: "string" });
  });

  it("exercises account install/binding through the real vendor and singleton DO", async () => {
    const result = await factory().runAccount();
    expect(result.binding).toBe("bound");
    expect(result.description).toMatchObject({
      displayName: "Knowledge Base",
      singleton: { tsType: "KnowledgeBase" },
    });
    expect(result.page).toEqual({
      bundleId: "a".repeat(64),
      versionId: "94444444-4444-4444-8444-444444444444",
      items: [{ path: "index.md" }],
    });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      containsRestrictedData: true,
      ownerInvitesOnly: true,
    });
    expect(result.boundInputs).toEqual([
      "44444444-4444-4444-8444-444444444444",
      "44444444-4444-4444-8444-444444444444",
    ]);
  });

  it("rejects wrong manager, capability RPC failure, and malformed account props", async () => {
    const wrongManager = await factory().runAccountError({
      requestedManagerId: "54444444-4444-4444-8444-444444444444",
    });
    expect(wrongManager).toMatch(/another Manager|wrong manager/i);
    const rpcFailure = await factory().runAccountError({ assertMode: "rpc_failure" });
    expect(rpcFailure).toMatch(/RPC failure|unavailable/i);
    const extraProps = await factory().runAccountError({ extraProps: true });
    expect(extraProps).toMatch(/only access|props/i);
    expect(await factory().runLegacyAccount()).toEqual({ binding: "legacy", error: null });
  });

  it("serializes first account binding and never replaces it with a later capability", async () => {
    const result = await factory().runConcurrentAccountBinding();
    expect(result.bindResults).toEqual(["fulfilled", "fulfilled"]);
    expect(["parallel-bind-first", "parallel-bind-second"]).toContain(result.firstStored);
    expect(result.afterRebind).toBe(result.firstStored);
    expect(result.foreignError).toMatch(/another Manager/u);
    expect(result.afterForeign).toBe(result.firstStored);
  });

  it("keeps the prompt catalog generic and observer registration private", async () => {
    const zero = await factory().runCatalog(0);
    expect(zero.catalog.entries).toHaveLength(1);
    expect(zero.observations).toHaveLength(0);
    const one = await factory().runCatalog(1);
    expect(one.catalog.entries).toHaveLength(1);
    expect(one.catalog.entries[0]).toEqual({
      id: "knowledge-base",
      title: "Knowledge Base",
      description: "Available. Use list, search, and read to inspect Knowledge pages.",
    });
    expect(await factory().runObserverRejection()).toMatch(/private/i);
  });

  it.skip("proves the retired catalog and Bronze boundary rejects malformed legacy responses", async () => {
    const malformedList = await factory().runRead({ listMode: "malformed" });
    expect(malformedList.page).toBeNull();
    expect(malformedList.error).toMatch(/integrity_failure/);
    expect(malformedList.observations).toHaveLength(0);
    const deniedList = await factory().runRead({ rejectObservationAt: 1 });
    expect(deniedList.page).toBeNull();
    expect(deniedList.read).toBeNull();
    expect(deniedList.error).toMatch(/observation denied/);
    const deniedRead = await factory().runRead({ rejectObservationAt: 2 });
    expect(deniedRead.page).not.toBeNull();
    expect(deniedRead.read).toBeNull();
    expect(deniedRead.error).toMatch(/observation denied/);
  });

  it("checks malformed DO props before duplicating the approval queue", async () => {
    const result = await factory().runMalformedSession();
    expect(result.error).toMatch(/only access|props/);
    expect(result.duplicateCount).toBe(0);
  });

});

describe("D04 private Knowledge reader integration (test-first)", () => {
  type TestFactory = {
    runD04ReaderSurface(): Promise<{
      typesCode: string;
      catalog: { entries: Array<Record<string, unknown>>; truncated?: boolean } | null;
      list: unknown;
      search: unknown;
      read: unknown;
      errors: { list: string | null; search: string | null; read: string | null };
      observations: Array<Record<string, unknown>>;
      readerSnapshot: {
        listInputs: unknown[];
        searchInputs: unknown[];
        readInputs: unknown[];
        readExpirySnapshots: number[];
      };
    }>;
    runD04ObservationReject(): Promise<{
      result: unknown;
      error: string | null;
      observationCount: number;
    }>;
    runD04ConcurrentReceiptExpiry(): Promise<{
      first: { value?: unknown; error?: string };
      second: unknown;
      secondError: string | null;
      firstExpiry: number | null;
      secondExpiry: number | null;
      firstObservationReached: boolean;
    }>;
    runObserverRejection(): Promise<string | null>;
  };

  const testEnv = env as unknown as { TEST_FACTORY: DurableObjectNamespace<TestFactory> };
  const factory = (): DurableObjectStub<TestFactory> =>
    testEnv.TEST_FACTORY.getByName("d04-reader-" + crypto.randomUUID());
  const localSession = (queue: FakeQueue, access: KnowledgeAccess) =>
    new KnowledgeSession(
      queue as unknown as RpcStub<ApprovalQueue>,
      access,
    );

  const expectedList = {
    bundleId: "a".repeat(64),
    versionId: "94444444-4444-4444-8444-444444444444",
    items: [{ path: "index.md" }],
  };
  const expectedSearch = {
    bundleId: "a".repeat(64),
    versionId: "94444444-4444-4444-8444-444444444444",
    hits: [{ path: "index.md", line: 1, snippet: "Private Knowledge fixture." }],
  };
  const expectedRead = {
    bundleId: "a".repeat(64),
    versionId: "94444444-4444-4444-8444-444444444444",
    path: "index.md",
    sourceMarkdown: "# Private Knowledge fixture\n",
    metadata: { type: "Concept" },
  };

  it("exposes only list/search/read and strips receipt metadata before returning each DTO", async () => {
    const result = await factory().runD04ReaderSurface();
    const knowledgeBaseIndex = result.typesCode.indexOf("interface KnowledgeBase {");
    const knowledgeBase = result.typesCode.slice(knowledgeBaseIndex);
    expect(knowledgeBaseIndex).toBeGreaterThanOrEqual(0);
    expect(knowledgeBase).toMatch(/\blist\(/u);
    expect(knowledgeBase).toMatch(/\bsearch\(/u);
    expect(knowledgeBase).toMatch(/\bread\(/u);
    expect(knowledgeBase).not.toMatch(/propose|readBronze|readArticle|managerId|userId|ownerId|assertBoundTo/u);
    expect(result.typesCode).not.toMatch(/expiresAt|receiptId|capability|managerId|userId|ownerId/u);
    expect(result.catalog?.entries).toEqual([
      {
        id: "knowledge-base",
        title: "Knowledge Base",
        description: "Available. Use list, search, and read to inspect Knowledge pages.",
      },
    ]);
    expect(JSON.stringify(result.catalog)).not.toContain("Private Knowledge fixture");

    expect(result.errors).toEqual({ list: null, search: null, read: null });
    expect(result.list).toEqual(expectedList);
    expect(result.search).toEqual(expectedSearch);
    expect(result.read).toEqual(expectedRead);
    expect(JSON.stringify([result.list, result.search, result.read])).not.toMatch(
      /expiresAt|receiptId|managerId|userId|ownerId/u,
    );
    expect(result.readerSnapshot).toMatchObject({
      listInputs: [{ offset: 0, limit: 16 }],
      searchInputs: [{ query: "private", offset: 0, limit: 16 }],
      readInputs: [{ path: "index.md" }],
    });
    expect(result.readerSnapshot.readExpirySnapshots).toHaveLength(1);
    expect(result.readerSnapshot.readExpirySnapshots[0]).toBeGreaterThan(Date.now());
    expect(result.observations).toHaveLength(3);
    expect(result.observations.every((item) =>
      item.containsRestrictedData === true && item.ownerInvitesOnly === true,
    )).toBe(true);
  });

  it("does not return private content when native observation rejects the read", async () => {
    const result = await factory().runD04ObservationReject();
    expect(result.error).not.toBeNull();
    expect(result.result).toBeUndefined();
    expect(result.observationCount).toBe(1);
  });

  it("removes legacy proposal and raw read methods from the runtime Knowledge prototypes", () => {
    const exposedMethods = new Set(Object.getOwnPropertyNames(KnowledgeSession.prototype));
    const legacyMethods = [
      "proposeArticle",
      "readArticle",
      "readArticleOutcome",
      "proposeKnowledgeCreate",
      "readCreationOutcome",
      "proposeBronzeAdoption",
      "readAdoptionOutcome",
      "readBronze",
      "assertBoundTo",
      "getAccess",
    ];
    expect(legacyMethods.filter((method) => exposedMethods.has(method))).toEqual([]);
  });

  it("does not let a concurrent renewal extend an earlier read held in native observation", async () => {
    const result = await factory().runD04ConcurrentReceiptExpiry();
    expect(result.firstObservationReached).toBe(true);
    expect(result.firstExpiry).not.toBeNull();
    expect(result.secondExpiry).not.toBeNull();
    expect(result.secondExpiry).toBeGreaterThan(result.firstExpiry!);
    expect(result.secondError).toBeNull();
    expect(result.second).toEqual(expectedRead);
    expect(result.first.error).toMatch(/permission_denied/u);
    expect(result.first).not.toHaveProperty("value");
  }, 15_000);

  it("keeps private reader ownership unavailable to observer registration", async () => {
    await expect(factory().runObserverRejection()).resolves.toMatch(/private/i);
  });

  it.each([
    ["list", { offset: -1, limit: 16 }],
    ["search", { query: String.fromCharCode(0xd800), offset: 0, limit: 16 }],
    ["read", { path: "../index.md" }],
  ] as const)("rejects invalid %s input before the Core call", async (method, input) => {
    const queue = new FakeQueue();
    let calls = 0;
    const access: KnowledgeAccess = {
      assertBoundTo() { return "cybernest-knowledge-read-v1" as const; },
      async list() { calls += 1; return { ok: false, code: "permission_denied" }; },
      async search() { calls += 1; return { ok: false, code: "permission_denied" }; },
      async read() { calls += 1; return { ok: false, code: "permission_denied" }; },
    };
    const session = localSession(queue, access);
    const operation = method === "list"
      ? session.list(input)
      : method === "search"
        ? session.search(input)
        : session.read(input);

    await expect(operation).rejects.toThrow(/invalid_input/u);
    expect(calls).toBe(0);
    expect(queue.observations).toHaveLength(0);
  });

  it("rejects a read DTO that does not match its requested page", async () => {
    const queue = new FakeQueue();
    const access: KnowledgeAccess = {
      assertBoundTo() { return "cybernest-knowledge-read-v1" as const; },
      async list() { throw new Error("unused"); },
      async search() { throw new Error("unused"); },
      async read() {
        return {
          ok: true,
          value: { value: { ...expectedRead, path: "other.md" }, expiresAt: Date.now() + 30_000 },
        };
      },
    };

    await expect(localSession(queue, access).read({ path: "index.md" })).rejects.toThrow(
      /integrity_failure/u,
    );
    expect(queue.observations).toHaveLength(0);
  });

  it("accepts the producer's full TTL starting when the receipt arrives", async () => {
    const queue = new FakeQueue();
    const startedAt = Date.now();
    let receiptCreatedAt = 0;
    let expiresAt = 0;
    const access: KnowledgeAccess = {
      assertBoundTo() { return "cybernest-knowledge-read-v1" as const; },
      async list() {
        await new Promise((resolve) => setTimeout(resolve, 15));
        receiptCreatedAt = Date.now();
        expiresAt = receiptCreatedAt + 3_600_000;
        return {
          ok: true,
          value: {
            value: expectedList,
            expiresAt,
          },
        };
      },
      async search() { throw new Error("unused"); },
      async read() { throw new Error("unused"); },
    };

    await expect(localSession(queue, access).list({ offset: 0, limit: 16 })).resolves.toEqual(expectedList);
    expect(queue.observations).toHaveLength(1);
    expect(queue.observations[0]).toMatchObject({
      containsRestrictedData: true,
      ownerInvitesOnly: true,
    });
    expect(receiptCreatedAt).toBeGreaterThan(startedAt);
    expect(expiresAt).toBeGreaterThan(startedAt + 3_600_000);
  });

  it("accepts producer UUIDs without imposing a UUIDv4 version or lowercase rule", async () => {
    const queue = new FakeQueue();
    const result = {
      ...expectedList,
      versionId: "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
    };
    const access: KnowledgeAccess = {
      assertBoundTo() { return "cybernest-knowledge-read-v1" as const; },
      async list() {
        return { ok: true, value: { value: result, expiresAt: Date.now() + 30_000 } };
      },
      async search() { throw new Error("unused"); },
      async read() { throw new Error("unused"); },
    };

    await expect(localSession(queue, access).list({ offset: 0, limit: 16 })).resolves.toEqual(result);
    expect(queue.observations).toHaveLength(1);
  });

  it.each([
    ["missing expiry", { value: expectedRead }],
    ["unsafe expiry", { value: expectedRead, expiresAt: Number.MAX_SAFE_INTEGER + 1 }],
    ["overlong expiry", { value: expectedRead, expiresAt: Date.now() + 3_605_000 }],
  ])("rejects a %s receipt before observation", async (_name, receipt) => {
    const queue = new FakeQueue();
    const access: KnowledgeAccess = {
      assertBoundTo() { return "cybernest-knowledge-read-v1" as const; },
      async list() { throw new Error("unused"); },
      async search() { throw new Error("unused"); },
      async read() { return { ok: true, value: receipt }; },
    };

    await expect(localSession(queue, access).read({ path: "index.md" })).rejects.toThrow(
      /integrity_failure/u,
    );
    expect(queue.observations).toHaveLength(0);
  });

  it("returns permission_denied for a receipt already expired at arrival", async () => {
    const queue = new FakeQueue();
    const access: KnowledgeAccess = {
      assertBoundTo() { return "cybernest-knowledge-read-v1" as const; },
      async list() { throw new Error("unused"); },
      async search() { throw new Error("unused"); },
      async read() {
        return {
          ok: true,
          value: { value: expectedRead, expiresAt: Date.now() - 1 },
        };
      },
    };

    await expect(localSession(queue, access).read({ path: "index.md" })).rejects.toThrow(
      /permission_denied/u,
    );
    expect(queue.observations).toHaveLength(0);
  });

  it("keeps typed producer failures separate from unexpected private RPC rejection", async () => {
    const typedQueue = new FakeQueue();
    const typedAccess: KnowledgeAccess = {
      assertBoundTo() { return "cybernest-knowledge-read-v1" as const; },
      async list() { return { ok: false, code: "permission_denied" }; },
      async search() { throw new Error("unused"); },
      async read() { throw new Error("unused"); },
    };
    await expect(localSession(typedQueue, typedAccess).list({ offset: 0, limit: 16 })).rejects.toThrow(
      /permission_denied/u,
    );
    expect(typedQueue.observations).toHaveLength(0);

    const rejectedQueue = new FakeQueue();
    const privateCause = new Error("private transport details");
    const rejectedAccess: KnowledgeAccess = {
      assertBoundTo() { return "cybernest-knowledge-read-v1" as const; },
      async list() { throw privateCause; },
      async search() { throw new Error("unused"); },
      async read() { throw new Error("unused"); },
    };
    await expect(localSession(rejectedQueue, rejectedAccess).list({ offset: 0, limit: 16 })).rejects.toThrow(
      "Knowledge Base read failed.",
    );
    expect(rejectedQueue.observations).toHaveLength(0);
  });

  it.each(["list", "search", "read"] as const)(
    "returns no %s payload when native observation rejects",
    async (method) => {
      const queue = new FakeQueue();
      queue.reject = true;
      const receipt = (value: unknown) => ({
        ok: true,
        value: { value, expiresAt: Date.now() + 30_000 },
      });
      const access: KnowledgeAccess = {
        assertBoundTo() { return "cybernest-knowledge-read-v1" as const; },
        async list() { return receipt(expectedList); },
        async search() { return receipt(expectedSearch); },
        async read() { return receipt(expectedRead); },
      };
      const session = localSession(queue, access);
      const operation = method === "list"
        ? session.list({ offset: 0, limit: 16 })
        : method === "search"
          ? session.search({ query: "private", offset: 0, limit: 16 })
          : session.read({ path: "index.md" });

      await expect(operation).rejects.toThrow("observation denied");
      expect(queue.observations).toHaveLength(1);
    },
  );
});

describe.skip("Retired Knowledge create proposal API", () => {
  it("fails closed when the direct unit seam has no durable proposal owner", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    const session = newSession(queue, access) as unknown as {
      proposeKnowledgeCreate(input: unknown): Promise<unknown>;
    };

    await expect(
      Promise.resolve().then(() => session.proposeKnowledgeCreate({ displayName: "Team Notes" })),
    ).rejects.toThrow(/dependency_unavailable/);
    expect(queue.observations).toHaveLength(0);
  });

  it("fails closed for a direct outcome read without the durable proposal owner", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    const session = newSession(queue, access) as unknown as {
      readCreationOutcome(input: unknown): Promise<unknown>;
    };

    await expect(
      Promise.resolve().then(() =>
        session.readCreationOutcome({ operationId: KNOWLEDGE_ID }),
      ),
    ).rejects.toThrow(/dependency_unavailable/);
    expect(queue.observations).toHaveLength(0);
  });

  it("rejects manager/target/action injection before any staged or capability mutation", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    const session = newSession(queue, access) as unknown as {
      proposeKnowledgeCreate(input: unknown): Promise<unknown>;
    };

    await expect(
      Promise.resolve().then(() =>
        session.proposeKnowledgeCreate({
          displayName: "Team Notes",
          managerId: KNOWLEDGE_ID,
          targetName: "manager-root",
          actionRef: KNOWLEDGE_ID,
          approved: true,
          rawCapability: {},
        }),
      ),
    ).rejects.toThrow(/invalid_input/);
    expect(access.listInputs).toHaveLength(0);
    expect(access.bronzeInputs).toHaveLength(0);
    expect(queue.observations).toHaveLength(0);
  });
});



describe.skip("Retired native Knowledge create approval flow", () => {
  type InvalidInputMode =
    | "invalid_input_bare"
    | "invalid_input"
    | "invalid_input_many"
    | "invalid_input_large"
    | "invalid_input_extra";
  type TestFactory = {
    runProposal(options?: {
      input?: unknown;
      createMode?: "ready" | "malformed" | "throw" | "throw_once" | "delay" | "initial" | "blocked" | "wrong_display" | "dependency_unavailable" | "deadline_exceeded" | InvalidInputMode;
      outcomeMode?: "ready" | "malformed" | "throw" | "failure" | "unobserved" | "initial" | "blocked" | "wrong_display" | "dependency_unavailable" | "deadline_exceeded" | InvalidInputMode;
      submitFailure?: boolean;
      decision?: "none" | "approve" | "retry" | "reject";
    }): Promise<{
      proposal: unknown | null;
      outcome: unknown | null;
      error: string | null;
      submissions: Array<{ action: number; description: Record<string, unknown> }>;
      createInputs: unknown[];
      outcomeInputs: unknown[];
      observations: ObservationDescription[];
      queueDisposals: number;
      autoApprovable: unknown;
    }>;
    runCreateFailureRecovery(
      createMode: "dependency_unavailable" | "deadline_exceeded",
      outcomeMode: "ready" | "failure" | "unobserved",
    ): Promise<{
      createInputs: unknown[];
      outcomeInputs: unknown[];
      outcome: unknown | null;
      status: string;
      errors: string[];
    }>;
    runSynchronousCreateFailureRecovery(): Promise<{
      createInputs: unknown[];
      outcomeInputs: unknown[];
      outcome: unknown | null;
      status: string;
      errors: string[];
    }>;
    runInvalidCreate(mode: InvalidInputMode): Promise<{
      error: string | null;
      outcome: unknown | null;
      createInputs: unknown[];
    }>;
    runConcurrentProposals(count: number): Promise<{
      successes: number;
      capacityFailures: number;
      submissions: number;
    }>;
    runConcurrentApply(): Promise<{
      createInputs: unknown[];
      outcomeInputs: unknown[];
      errors: string[];
    }>;
    runApplyRejectRace(): Promise<{ createInputs: unknown[]; errors: string[] }>;
    runResponseLoss(): Promise<{
      createInputs: unknown[];
      outcomeInputs: unknown[];
      status: string;
      errors: string[];
    }>;
    runActionRefFingerprintMismatch(): Promise<{ observations: number; error: string | null }>;
    runStoredOutcomeUnknown(): Promise<{ observations: number; error: string | null }>;
    runOutcomeFailureRecovery(outcomeMode?: "failure" | InvalidInputMode): Promise<{
      createInputs: unknown[];
      outcomeInputs: unknown[];
      outcome: unknown | null;
      errors: string[];
    }>;
  };
  const testEnv = env as unknown as { TEST_FACTORY: DurableObjectNamespace<TestFactory> };
  const factory = (): DurableObjectStub<TestFactory> =>
    testEnv.TEST_FACTORY.getByName("s15-" + crypto.randomUUID());

  it.each([
    ["extra", { displayName: "Team Notes", approved: true }],
    ["blank", { displayName: "   " }],
    ["trim", { displayName: " Team Notes" }],
    ["control", { displayName: "Team\nNotes" }],
    ["utf8", { displayName: "\u{1F4DA}".repeat(31) }],
    ["surrogate", { displayName: "\ud800" }],
    ["manager", { displayName: "Team Notes", managerId: "44444444-4444-4444-8444-444444444444" }],
    ["target", { displayName: "Team Notes", targetName: "manager-root" }],
    ["action", { displayName: "Team Notes", actionRef: "44444444-4444-4444-8444-444444444444" }],
    ["approved", { displayName: "Team Notes", approved: true }],
  ])("rejects %s input at the actual session boundary", async (_label, input) => {
    const result = await factory().runProposal({ input });
    expect(result.proposal).toBeNull();
    expect(result.error).toMatch(/invalid_input/);
    expect(result.submissions).toHaveLength(0);
    expect(result.createInputs).toHaveLength(0);
  });

  it("stages one exact action and requires native manual approval", async () => {
    const result = await factory().runProposal();
    expect(result.proposal).toMatchObject({ status: "pending_approval" });
    expect(result.submissions).toHaveLength(1);
    expect(result.submissions[0]?.action).toBe(1);
    expect(result.submissions[0]?.description).toMatchObject({
      implementsRevert: false,
      awaitDecision: true,
    });
    expect(result.submissions[0]?.description).not.toHaveProperty("autoApprovable");
    expect(result.submissions[0]?.description.description).toContain("Team Notes");
    expect(result.autoApprovable).toEqual([]);
    expect(result.createInputs).toHaveLength(0);
    expect(result.outcome).toMatchObject({ status: "pending_approval" });
  });

  it("applies stored payload only after approval and keeps a compact same-operation result", async () => {
    const result = await factory().runProposal({ decision: "approve" });
    expect(result.error).toBeNull();
    expect(result.proposal).toMatchObject({ status: "pending_approval" });
    expect(result.createInputs).toEqual([
      expect.objectContaining({ displayName: "Team Notes" }),
    ]);
    expect(result.createInputs[0]).not.toHaveProperty("managerId");
    expect(result.createInputs[0]).not.toHaveProperty("targetName");
    expect(result.outcome).toMatchObject({ status: "applied", outcome: "ready" });
    expect(result.outcomeInputs).toHaveLength(1);
  });

  it("retries response loss with the same operation/action/payload", async () => {
    const result = await factory().runProposal({ createMode: "throw_once", decision: "retry" });
    expect(result.error).toBeNull();
    expect(result.createInputs).toHaveLength(1);
    expect(result.outcome).toMatchObject({ status: "applied", outcome: "ready" });
  });

  it("recovers a commit-then-throw response with one create and one authority read", async () => {
    const result = await factory().runResponseLoss();
    expect(result.createInputs).toHaveLength(1);
    expect(result.outcomeInputs).toHaveLength(1);
    expect(result.status).toBe("applied");
    expect(result.errors).toEqual(["Knowledge Base outcome_unknown."]);
  });

  it("rejects by deleting the staged row without invoking the installed capability", async () => {
    const result = await factory().runProposal({ decision: "reject" });
    expect(result.error).toBeNull();
    expect(result.createInputs).toHaveLength(0);
    expect(result.outcome).toBeNull();
  });

  it("rolls back the row when native submit fails", async () => {
    const result = await factory().runProposal({ submitFailure: true });
    expect(result.proposal).toBeNull();
    expect(result.error).toMatch(/dependency_unavailable/);
    expect(result.submissions).toHaveLength(0);
    expect(result.createInputs).toHaveLength(0);
  });

  it.each([
    "dependency_unavailable",
    "deadline_exceeded",
  ] as const)("keeps %s create recoverable until the same operation outcome is ready", async (createMode) => {
    const result = await factory().runCreateFailureRecovery(createMode, "ready");
    expect(result.createInputs).toHaveLength(1);
    expect(result.errors).toEqual([`Knowledge Base ${createMode}.`]);
    expect(result.status).toBe("applied");
    expect(result.outcome).toMatchObject({ status: "applied", outcome: "ready" });
  });

  it.each([
    ["dependency_unavailable", "failure"],
    ["dependency_unavailable", "unobserved"],
    ["deadline_exceeded", "failure"],
    ["deadline_exceeded", "unobserved"],
  ] as const)("returns outcome_unknown for a recoverable %s when the later outcome is %s", async (createMode, outcomeMode) => {
    const result = await factory().runCreateFailureRecovery(createMode, outcomeMode);
    expect(result.createInputs).toHaveLength(1);
    expect(result.errors).toEqual([
      `Knowledge Base ${createMode}.`,
      "Knowledge Base outcome_unknown.",
    ]);
    expect(result.status).toBe("applying");
    expect(result.outcome).toMatchObject({ status: "outcome_unknown" });
  });

  it("rolls back applying when access resolution throws synchronously before create", async () => {
    const result = await factory().runSynchronousCreateFailureRecovery();
    expect(result.createInputs).toHaveLength(1);
    expect(result.errors).toEqual(["Knowledge Base dependency_unavailable."]);
    expect(result.status).toBe("applied");
    expect(result.outcome).toMatchObject({ status: "applied", outcome: "ready" });
  });

  it.each([
    ["bare tag", "invalid_input_bare"],
    ["bounded issues", "invalid_input"],
  ] as const)("stores valid invalid_input create as terminal failure: %s", async (_label, mode) => {
    const result = await factory().runInvalidCreate(mode);
    expect(result.error).toMatch(/invalid_input/);
    expect(result.createInputs).toHaveLength(1);
    expect(result.outcome).toMatchObject({ status: "failed", reason: "invalid_input" });
  });

  it.each([
    "invalid_input_many",
    "invalid_input_large",
    "invalid_input_extra",
  ] as const)("rejects malformed invalid_input create as integrity failure: %s", async (createMode) => {
    const result = await factory().runProposal({ createMode, decision: "approve" });
    expect(result.error).toMatch(/integrity_failure/);
    expect(result.createInputs).toHaveLength(1);
    expect(result.outcome).toBeNull();
  });

  it.each([
    ["initial role", "initial"],
    ["ready tag with blocked state", "blocked"],
    ["stored display name mismatch", "wrong_display"],
  ] as const)("rejects strict create correlation: %s", async (_label, createMode) => {
    const result = await factory().runProposal({
      createMode,
      decision: "approve",
    });
    expect(result.error).toMatch(/integrity_failure/);
    expect(result.createInputs).toHaveLength(1);
    expect(result.outcome).toBeNull();
    expect(result.observations).toHaveLength(0);
  });

  it.each([
    ["initial role", "initial"],
    ["ready tag with blocked state", "blocked"],
    ["stored display name mismatch", "wrong_display"],
  ] as const)("rejects strict outcome correlation: %s", async (_label, outcomeMode) => {
    const result = await factory().runProposal({
      decision: "retry",
      createMode: "throw_once",
      outcomeMode,
    });
    expect(result.error).toMatch(/integrity_failure/);
    expect(result.createInputs).toHaveLength(1);
    expect(result.outcome).toBeNull();
    expect(result.observations).toHaveLength(0);
  });

  it("admits exactly 64 of 65 concurrent proposals at the native DO boundary", async () => {
    const result = await factory().runConcurrentProposals(65);
    expect(result.successes).toBe(64);
    expect(result.capacityFailures).toBe(1);
    expect(result.submissions).toBe(64);
  });

  it("lets concurrent native apply callbacks issue one create and recover applying through one outcome read", async () => {
    const result = await factory().runConcurrentApply();
    expect(result.createInputs).toHaveLength(1);
    expect(result.outcomeInputs).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it("does not create from a stale row deleted by reject during fingerprint hashing", async () => {
    const result = await factory().runApplyRejectRace();
    expect(result.createInputs).toHaveLength(0);
    expect(result.errors).toEqual([expect.stringMatching(/invalid_input/)]);
  });

  it("revalidates actionRef in the staged fingerprint before readOutcome", async () => {
    const result = await factory().runActionRefFingerprintMismatch();
    expect(result.error).toMatch(/integrity_failure/);
    expect(result.observations).toBe(0);
  });

  it("keeps applying after an outcome read failure and never retries create", async () => {
    const result = await factory().runOutcomeFailureRecovery();
    expect(result.createInputs).toHaveLength(1);
    expect(result.outcomeInputs).toHaveLength(2);
    expect(result.errors).toEqual(["Knowledge Base outcome_unknown.", "Knowledge Base outcome_unknown."]);
    expect(result.outcome).toMatchObject({ status: "outcome_unknown" });
  });

  it("keeps applying when an outcome read returns valid invalid_input", async () => {
    const result = await factory().runOutcomeFailureRecovery("invalid_input");
    expect(result.createInputs).toHaveLength(1);
    expect(result.outcomeInputs).toHaveLength(2);
    expect(result.errors).toEqual(["Knowledge Base outcome_unknown.", "Knowledge Base outcome_unknown."]);
    expect(result.outcome).toMatchObject({ status: "outcome_unknown" });
  });

  it.each([
    "invalid_input_many",
    "invalid_input_large",
    "invalid_input_extra",
  ] as const)("rejects malformed invalid_input outcome as integrity failure: %s", async (outcomeMode) => {
    const result = await factory().runProposal({
      createMode: "throw_once",
      outcomeMode,
      decision: "retry",
    });
    expect(result.error).toMatch(/integrity_failure/);
    expect(result.createInputs).toHaveLength(1);
    expect(result.outcome).toBeNull();
  });

  it("rejects a legacy stored outcome_unknown instead of exposing it as terminal failure", async () => {
    const result = await factory().runStoredOutcomeUnknown();
    expect(result.error).toMatch(/integrity_failure/);
    expect(result.observations).toBe(0);
  });

  it("does not authorize or expose malformed installed outcomes", async () => {
    const result = await factory().runProposal({ decision: "approve", outcomeMode: "malformed" });
    expect(result.error).toMatch(/integrity_failure/);
    expect(result.outcome).toBeNull();
    expect(result.observations).toHaveLength(0);
  });
});


describe.skip("Retired Bronze adoption API", () => {
  const exactDocument = "# Exact concept\n\n~~~\nnot a fence escape\n~~~~~\n";
  const provenance: BronzeProvenance = {
    sourceKind: "explicit_user_input",
    reference: "s16-fixture",
    capturedAt: NOW,
  };

  it("requires only the two sealed-handle methods and hides authority fields", () => {
    expect(TYPES_CODE).toContain(
      "proposeBronzeAdoption(input: { document: string; provenance: BronzeProvenance }): Promise<BronzeAdoptionProposal>;",
    );
    expect(TYPES_CODE).toContain(
      "readAdoptionOutcome(input: { operationId: string }): Promise<KnowledgeAdoptionOutcome | null>;",
    );
    expect(TYPES_CODE).not.toMatch(
      /proposeBronzeAdoption\([^)]*(managerId|knowledgeId|generation|contentHash|actionRef|approved|raw)/u,
    );
  });

  it("fails closed before any access call until the missing proposal owner exists", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    const handle = await newHandle(queue, access);
    const adoption = handle as unknown as {
      proposeBronzeAdoption(input: BronzeAdoptionInput): Promise<unknown>;
    };

    await expect(
      adoption.proposeBronzeAdoption({ document: exactDocument, provenance }),
    ).rejects.toThrow(/dependency_unavailable/);
    expect(access.bronzeInputs).toHaveLength(0);
    expect(queue.observations).toHaveLength(1);
  });

  it("rejects authority injection and malformed exact documents before any capability mutation", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    const handle = await newHandle(queue, access);
    const adoption = handle as unknown as {
      proposeBronzeAdoption(input: unknown): Promise<unknown>;
    };
    await expect(
      adoption.proposeBronzeAdoption({
        document: "\uD800",
        provenance,
        managerId: KNOWLEDGE_ID,
        knowledgeId: OTHER_KNOWLEDGE_ID,
        generation: 99,
        contentHash: "0".repeat(64),
        actionRef: KNOWLEDGE_ID,
        approved: true,
        rawCapability: {},
      }),
    ).rejects.toThrow(/invalid_input/);
    expect(access.bronzeInputs).toHaveLength(0);
    expect(queue.observations).toHaveLength(1);
  });

  it("rejects malformed provenance before any capability mutation", async () => {
    const queue = new FakeQueue();
    const access = new FakeAccessImpl();
    const handle = await newHandle(queue, access);
    const adoption = handle as unknown as {
      proposeBronzeAdoption(input: unknown): Promise<unknown>;
    };

    await expect(
      adoption.proposeBronzeAdoption({
        document: exactDocument,
        provenance: {
          sourceKind: "explicit_user_input",
          reference: " untrimmed",
          capturedAt: "2026-01-01T00:00:00Z",
        },
      }),
    ).rejects.toThrow(/invalid_input/);
    expect(access.bronzeInputs).toHaveLength(0);
    expect(queue.observations).toHaveLength(1);
  });
});

describe.skip("Retired Bronze approval integration", () => {
  const exactDocument = "# Exact concept\n\n~~~\nnot a fence escape\n~~~~~\n";
  const provenance: BronzeProvenance = {
    sourceKind: "explicit_user_input",
    reference: "s16-fixture",
    capturedAt: NOW,
  };

  type TestFactory = {
    runBronzeProposal(options?: {
      document?: string;
      provenance?: BronzeProvenance;
      adoptionMode?:
        | "committed"
        | "throw_once"
        | "throw"
        | "dependency_unavailable"
        | "deadline_exceeded"
        | "malformed"
        | "wrong_identity";
      outcomeMode?:
        | "committed"
        | "unobserved"
        | "forbidden"
        | "throw"
        | "dependency_unavailable"
        | "deadline_exceeded"
        | "malformed"
        | "wrong_identity";
      secondOutcomeMode?:
        | "committed"
        | "unobserved"
        | "forbidden"
        | "throw"
        | "dependency_unavailable"
        | "deadline_exceeded"
        | "malformed"
        | "wrong_identity";
      readOutcomeTwice?: boolean;
      decision?: "none" | "approve" | "retry" | "reject";
      wrongHandle?: boolean;
      displayName?: string;
      submitFailure?: boolean;
      tamper?: "document" | "content_hash" | "action_ref" | "fingerprint";
    }): Promise<{
      proposal: unknown | null;
      outcome: unknown | null;
      error: string | null;
      submissions: Array<{ action: number; description: Record<string, unknown> }>;
      adoptionInputs: unknown[];
      adoptionOutcomeInputs: unknown[];
      observations: ObservationDescription[];
      bronzeRow: Record<string, unknown> | null;
      queueDisposals: number;
    }>;
    runBronzeSynchronousAccessFailureRecovery(): Promise<{
      adoptionInputs: unknown[];
      adoptionOutcomeInputs: unknown[];
      outcome: unknown | null;
      bronzeRow: Record<string, unknown> | null;
      errors: string[];
    }>;
    runCombinedCapacityAdoptionThenCreate(): Promise<{
      adoptionSuccesses: number;
      adoptionFailures: number;
      createError: string | null;
      submissions: number;
    }>;
    runConcurrentBronzeProposals(count: number): Promise<{
      successes: number;
      capacityFailures: number;
      submissions: number;
      adoptionInputs: unknown[];
    }>;
    probeActionCollision(): Promise<{
      applyError: string | null;
      rejectError: string | null;
      createRows: number;
      bronzeRows: number;
    }>;
  };
  const testEnv = env as unknown as { TEST_FACTORY: DurableObjectNamespace<TestFactory> };
  const factory = (): DurableObjectStub<TestFactory> =>
    testEnv.TEST_FACTORY.getByName("s16-" + crypto.randomUUID());

  it("stages complete inert exact bytes and performs no Core/target mutation before approval", async () => {
    const result = await factory().runBronzeProposal({
      document: exactDocument,
      provenance,
      decision: "none",
    });
    expect(result.error).toBeNull();
    expect(result.proposal).toMatchObject({ status: "pending_approval" });
    expect(result.adoptionInputs).toHaveLength(0);
    expect(result.adoptionOutcomeInputs).toHaveLength(0);
    expect(result.submissions).toHaveLength(1);
    const description = result.submissions[0]?.description;
    expect(description).toMatchObject({ implementsRevert: false, awaitDecision: true });
    expect(description?.description).toContain(exactDocument);
    expect(description?.description).toContain("s16-fixture");
    expect(description?.description).toMatch(/[0-9a-f]{64}/u);
    expect(result.bronzeRow).toMatchObject({ status: "pending_approval" });
    expect(result.bronzeRow?.document).toBe(exactDocument);
  });

  it("keeps document and untrusted metadata inert inside a dynamically safe fence", async () => {
    const hostileDocument = "~~~~~\n```\n[document](https://evil.invalid)\n~~~~~~";
    const hostileDisplayName = "[name](https://evil.invalid) `display`";
    const hostileReference = "![reference](https://evil.invalid) `ref`";
    const result = await factory().runBronzeProposal({
      document: hostileDocument,
      displayName: hostileDisplayName,
      provenance: {
        sourceKind: "explicit_user_input",
        reference: hostileReference,
        capturedAt: NOW,
      },
      decision: "none",
    });
    expect(result.error).toBeNull();
    const rendered = String(result.submissions[0]?.description?.description);
    expect(rendered).toContain(hostileDocument);
    expect(rendered).toContain(hostileDisplayName);
    expect(rendered).toContain(hostileReference);
    const openingFence = rendered.split("\n")[1];
    expect(openingFence).toMatch(/^(`{3,}|~{3,})$/u);
    const fenceCharacter = openingFence?.[0] ?? "";
    expect(fenceCharacter).not.toBe("");
    const selectedInputMax = Math.max(
      ...[hostileDocument, hostileDisplayName, hostileReference].map((value) =>
        [...value.matchAll(new RegExp(fenceCharacter + "+", "gu"))].reduce(
          (max, match) => Math.max(max, match[0].length),
          0,
        ),
      ),
      0,
    );
    expect(openingFence?.length).toBeGreaterThan(selectedInputMax);
    expect(rendered.split("\n").at(-1)).toBe(openingFence);
  });

  it("rejects without adoption and removes the staged Bronze row", async () => {
    const result = await factory().runBronzeProposal({
      document: exactDocument,
      provenance,
      decision: "reject",
    });
    expect(result.error).toBeNull();
    expect(result.adoptionInputs).toHaveLength(0);
    expect(result.adoptionOutcomeInputs).toHaveLength(0);
    expect(result.outcome).toBeNull();
    expect(result.bronzeRow).toBeNull();
  });

  it("rejects a wrong Knowledge handle before Core/adoption observation", async () => {
    const result = await factory().runBronzeProposal({
      wrongHandle: true,
      decision: "approve",
    });
    expect(result.error).toMatch(/integrity_failure|wrong|handle/iu);
    expect(result.adoptionInputs).toHaveLength(1);
    expect(result.adoptionOutcomeInputs).toHaveLength(0);
    expect(result.submissions).toHaveLength(1);
  });

  it("rolls back the complete staged proposal when native submit fails", async () => {
    const result = await factory().runBronzeProposal({
      submitFailure: true,
      decision: "none",
    });
    expect(result.proposal).toBeNull();
    expect(result.error).toMatch(/dependency_unavailable/);
    expect(result.submissions).toHaveLength(0);
    expect(result.adoptionInputs).toHaveLength(0);
    expect(result.bronzeRow).toBeNull();
  });

  it.each(["document", "content_hash", "action_ref", "fingerprint"] as const)(
    "fails closed on a tampered Bronze %s before Core mutation",
    async (tamper) => {
      const result = await factory().runBronzeProposal({
        document: exactDocument,
        provenance,
        tamper,
        decision: "approve",
      });
      expect(result.error).toMatch(/integrity_failure/);
      expect(result.adoptionInputs).toHaveLength(0);
      expect(result.adoptionOutcomeInputs).toHaveLength(0);
      expect(result.bronzeRow).toMatchObject({ status: "pending_approval" });
    },
  );

  it("approves once, preserves exact payload, and compacts the staged document", async () => {
    const result = await factory().runBronzeProposal({
      document: exactDocument,
      provenance,
      decision: "approve",
    });
    expect(result.error).toBeNull();
    expect(result.adoptionInputs).toHaveLength(1);
    expect(result.adoptionInputs[0]).toMatchObject({
      knowledgeId: KNOWLEDGE_ID,
      generation: 1,
      document: exactDocument,
      provenance,
    });
    expect(result.adoptionInputs[0]).not.toHaveProperty("approved");
    expect(result.outcome).toMatchObject({ status: "applied", outcome: "committed" });
    expect(result.adoptionOutcomeInputs).toHaveLength(1);
    expect(result.bronzeRow).toMatchObject({ status: "applied" });
    expect(result.bronzeRow?.document).toBeNull();
  });

  it("keeps one dispatch across response loss and reads only the same operation outcome", async () => {
    const result = await factory().runBronzeProposal({
      document: exactDocument,
      provenance,
      adoptionMode: "throw_once",
      decision: "retry",
    });
    expect(result.adoptionInputs).toHaveLength(1);
    expect(result.adoptionOutcomeInputs).toHaveLength(2);
    expect(result.bronzeRow).toMatchObject({ status: "applied", document: null });
    expect(result.outcome).toMatchObject({ status: "applied", outcome: "committed" });
  });

  it("rolls back synchronously before Promise acquisition, then permits one later dispatch", async () => {
    const result = await factory().runBronzeSynchronousAccessFailureRecovery();
    expect(result.adoptionInputs).toHaveLength(1);
    expect(result.adoptionOutcomeInputs).toHaveLength(1);
    expect(result.errors[0]).toMatch(/dependency_unavailable/);
    expect(result.bronzeRow).toMatchObject({ status: "applied", document: null });
  });

  it("freshly observes an already observed applied receipt instead of returning the cache", async () => {
    const result = await factory().runBronzeProposal({
      decision: "approve",
      outcomeMode: "committed",
      secondOutcomeMode: "forbidden",
    });
    expect(result.adoptionOutcomeInputs).toHaveLength(2);
    expect(result.error).toMatch(/forbidden/);
    expect(result.outcome).toMatchObject({ status: "applied" });
    expect(result.bronzeRow).toMatchObject({
      status: "applied",
      outcome_observed: 1,
      document: null,
    });
  });

  it.each(["forbidden", "dependency_unavailable", "malformed", "unobserved"] as const)(
    "does not disclose a cached applied receipt after fresh %s outcome failure",
    async (outcomeMode) => {
      const result = await factory().runBronzeProposal({
        decision: "approve",
        outcomeMode,
      });
      expect(result.adoptionOutcomeInputs).toHaveLength(1);
      expect(result.bronzeRow).toMatchObject({ status: "applied", document: null });
      expect(result.outcome).not.toMatchObject({ status: "applied", receipt: expect.anything() });
      if (outcomeMode === "unobserved") {
        expect(result.outcome).toMatchObject({ status: "outcome_unknown" });
      } else {
        expect(result.error).toMatch(/forbidden|dependency_unavailable|integrity_failure/);
      }
    },
  );

  it("chooses the shorter dynamic fence at the maximum document boundary", async () => {
    const document = "~".repeat(65536);
    const result = await factory().runBronzeProposal({
      document,
      decision: "none",
    });
    expect(result.error).toBeNull();
    const rendered = String(result.submissions[0]?.description?.description);
    const openingFence = rendered.split("\n")[1];
    expect(openingFence).toBe("```");
    expect(rendered.split("\n").at(-1)).toBe(openingFence);
    expect(rendered).toContain(document);
    expect(rendered.length).toBeLessThan(document.length * 2);
  });

  it.each(["dependency_unavailable", "deadline_exceeded"] as const)(
    "keeps post-dispatch %s nonterminal and reads the same operation only",
    async (mode) => {
      const result = await factory().runBronzeProposal({
        adoptionMode: mode,
        outcomeMode: "unobserved",
        decision: "approve",
      });
      expect(result.adoptionInputs).toHaveLength(1);
      expect(result.adoptionOutcomeInputs).toHaveLength(1);
      expect(result.bronzeRow).toMatchObject({ status: "applying", document: null });
      expect(result.outcome).toMatchObject({ status: "outcome_unknown" });
    },
  );

  it("enforces the combined create plus adoption pending cap when create follows 64 adoptions", async () => {
    const result = await factory().runCombinedCapacityAdoptionThenCreate();
    expect(result.adoptionSuccesses).toBe(64);
    expect(result.adoptionFailures).toBe(0);
    expect(result.createError).toMatch(/capacity_exceeded/);
    expect(result.submissions).toBe(64);
  });

  it("fails closed on an actual SQLite local-action collision across both action tables", async () => {
    const result = await factory().probeActionCollision();
    expect(result.applyError).toMatch(/integrity_failure/);
    expect(result.rejectError).toMatch(/integrity_failure/);
    expect(result.createRows).toBe(1);
    expect(result.bronzeRows).toBe(1);
  });
});
