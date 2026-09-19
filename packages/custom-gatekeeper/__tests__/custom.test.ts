import { env } from "cloudflare:workers";
import type { RpcStub } from "cloudflare:workers";
import type {
  ApprovalQueue,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { describe, expect, it } from "vitest";
import TYPES_CODE from "../src/types-code.js";
import {
  Knowledge,
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
type FakeAccess = {
  list(input?: ListInput): Promise<unknown>;
  readBronze(input: Record<string, unknown>): Promise<unknown>;
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
}

const newSession = (
  queue: FakeQueue,
  access: FakeAccessImpl,
): KnowledgeSession =>
  new KnowledgeSession(
    queue as unknown as RpcStub<ApprovalQueue>,
    access as unknown as never,
  );

const newHandle = async (
  queue: FakeQueue,
  access: FakeAccessImpl,
  item: Record<string, unknown> = summary(),
): Promise<Knowledge> => {
  access.listResult = { _tag: "page", items: [item] };
  const result = await newSession(queue, access).list();
  const handle = result.items[0]?.access;
  if (handle === undefined) throw new Error("Expected a ready Knowledge handle.");
  return handle;
};

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

  it("keeps only list on KnowledgeBase and readBronze on Knowledge", () => {
    expect(TYPES_CODE).toContain("interface KnowledgeBase");
    expect(TYPES_CODE).toContain("list(options?");
    expect(TYPES_CODE).toContain("interface Knowledge");
    expect(TYPES_CODE).toContain("readBronze(input");
    expect(TYPES_CODE).not.toMatch(
      /managerId|userId|targetName|raw|search\(|read\(|proposeUpdate\(/,
    );
  });
});

describe("S14 list projection", () => {
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

describe("S14 Bronze handle and strict result projection", () => {
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

describe("S14 observation and capability lifecycle", () => {
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
      page: Array<Record<string, unknown>>;
      observations: ObservationDescription[];
      boundInputs: string[];
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

  it("executes the real WorkerEntrypoint -> DO -> RpcTarget read path", async () => {
    const result = await factory().runRead({ nextCursor: "string" });
    expect(result.page).toHaveLength(3);
    expect(result.page?.map((item) => item.hasAccess)).toEqual([true, false, false]);
    expect(result.nextCursor).toBe("next-page");
    expect(result.read).toMatchObject({
      knowledgeId: "44444444-4444-4444-8444-444444444444",
      sourceId: "74444444-4444-4444-8444-444444444444",
    });
    expect(result.readInputs).toEqual([
      {
        knowledgeId: "44444444-4444-4444-8444-444444444444",
        generation: 1,
        sourceId: "74444444-4444-4444-8444-444444444444",
      },
    ]);
    expect(result.observations).toHaveLength(2);
    expect(result.observations.every((observation) => observation.prohibitAllSharing)).toBe(
      true,
    );
  });

  it("exercises account install/binding through the real vendor and singleton DO", async () => {
    const result = await factory().runAccount();
    expect(result.binding).toBe("bound");
    expect(result.description).toMatchObject({
      displayName: "Knowledge Base",
      singleton: { tsType: "KnowledgeBase" },
    });
    expect(result.page[0]).toMatchObject({ hasAccess: true, state: "ready" });
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

  it("bounds catalog limits and keeps observer registration private", async () => {
    const zero = await factory().runCatalog(0);
    expect(zero.catalog.entries).toEqual([]);
    expect(zero.observations).toHaveLength(1);
    const one = await factory().runCatalog(1);
    expect(one.catalog.entries).toHaveLength(1);
    expect(one.catalog.entries[0]).toEqual({
      id: "knowledge-base",
      title: "Knowledge Base",
      description: "Available. Use list to inspect current Knowledge summaries.",
    });
    expect(await factory().runObserverRejection()).toMatch(/private/i);
  });

  it("proves malformed and authorization-failed integration paths leak no page/data", async () => {
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
