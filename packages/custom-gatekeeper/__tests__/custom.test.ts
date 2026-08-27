import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  KnowledgeSession,
  assertKnowledgeActionId,
  describeCustomAccount,
  describeCustomVendor,
  nextKnowledgeActionId,
  parseKnowledgeActionRecord,
} from "../src/custom.js";
import TYPES_CODE from "../src/types-code.js";

const VALID_REVISION_ID = "44444444-4444-4444-8444-444444444444";
const VALID_CONTENT_HASH = "a".repeat(64);
const PENDING_ACTION_KEYS = [
  "baseSourceRevisionId",
  "body",
  "contentHash",
  "documentKey",
  "revisionId",
  "state",
];
const APPLIED_TOMBSTONE = {
  state: "applied",
  keys: ["state"],
  bodyByteLength: null,
};
const REJECTED_TOMBSTONE = {
  state: "rejected",
  keys: ["state"],
  bodyByteLength: null,
};

type TestWorkerExports = {
  TEST_FACTORY: DurableObjectNamespace<{
    runProposal(managerId: string, content?: string): Promise<{
      submission: { action: number; description: Record<string, unknown> };
      proposalCallCount: number;
      proposalContent: string;
    }>;
    runCatalog(managerId: string, limit: number): Promise<{
      catalog: {entries: Array<{id: string; title: string; description: string}>; truncated?: boolean};
      observations: unknown[];
    }>;
    runConversationBridge(
      managerId: string,
      mode?: "valid" | "extra" | "malformed" | "missing",
    ): Promise<Record<string, unknown>>;
    runConversationMethod(
      managerId: string,
      method: "save" | "current" | "historical",
      mode?: "valid" | "extra" | "malformed" | "missing",
    ): Promise<string | null>;
    runAccountScenario(managerId: string): Promise<Record<string, unknown>>;
    runActionScenario(
      managerId: string,
      scenario: string,
    ): Promise<Record<string, unknown>>;
  }>;
};

describe("custom-gatekeeper", () => {
  it("describes a private Knowledge singleton without advertising ambient provisioning", () => {
    expect(describeCustomVendor()).toMatchObject({
      displayName: "Custom Gatekeeper",
      providesAuth: false,
    });
    expect(describeCustomVendor()).not.toHaveProperty("autoProvisionsAccount");
    expect(describeCustomAccount()).toMatchObject({
      displayName: "Knowledge Base",
      singleton: { tsType: "KnowledgeBase" },
    });
  });

  it("accepts only the exact Manager-bound Account props and the legacy no-props shape", async () => {
    const workerEnv = env as unknown as TestWorkerExports;
    const factory = workerEnv.TEST_FACTORY.getByName("m05-02-account-props");
    const result = await factory.runAccountScenario(crypto.randomUUID());

    expect(result).toMatchObject({
      bound: "bound",
      legacyUndefined: "legacy",
      legacyEmpty: "legacy",
      displayName: "Knowledge Base",
      singletonType: "KnowledgeBase",
      missingError: expect.stringMatching(/only access/u),
      extraError: expect.stringMatching(/only access/u),
      malformedError: expect.stringMatching(/RPC stub/u),
      mismatchError: expect.stringMatching(/wrong manager/u),
      rpcError: expect.stringMatching(/test capability unavailable/u),
      connectError: expect.stringMatching(/no connect flow/u),
      supportedResources: [],
    });
  });

  it("publishes only the five bounded KnowledgeBase methods", () => {
    const knowledgeBase = TYPES_CODE.match(/interface KnowledgeBase \{(?<body>[\s\S]*?)\n\}/u);
    expect(knowledgeBase?.groups?.body).toBeDefined();
    const methods = [...(knowledgeBase?.groups?.body ?? "").matchAll(
      /^\s{2}(\w+)\(/gmu,
    )].map((match) => match[1]);
    expect(methods).toEqual(["list", "search", "read", "recall", "proposeUpdate"]);
    expect(TYPES_CODE).toContain("integer from 1 to 50; defaults to 20");
    expect(TYPES_CODE).toContain("at most 256 UTF-8 bytes");
    expect(TYPES_CODE).toContain("1–255 UTF-8 bytes");
    expect(TYPES_CODE).toContain("at most 1 MiB");
    expect(TYPES_CODE).toContain("routing hints, not authority");
    expect(TYPES_CODE).not.toContain("managerId");
    expect(TYPES_CODE).not.toContain("userId");
    expect(TYPES_CODE).not.toContain("generation");
  });

  it("forwards private conversation methods without exposing them through the Agent KnowledgeBase", async () => {
    const workerEnv = env as unknown as TestWorkerExports;
    const factory = workerEnv.TEST_FACTORY.getByName("m07-02-conversation-bridge");

    await expect(factory.runConversationBridge(crypto.randomUUID())).resolves.toEqual({
      save: {
        ok: true,
        value: {
          revisionId: VALID_REVISION_ID,
          documentKey: "conversation-context",
          contentHash: VALID_CONTENT_HASH,
        },
      },
      current: {
        ok: true,
        value: {
          revisionId: VALID_REVISION_ID,
          documentKey: "conversation-context",
          contentHash: VALID_CONTENT_HASH,
          content: "# Conversation\n",
        },
      },
      historical: {
        ok: true,
        value: {
          revisionId: VALID_REVISION_ID,
          documentKey: "conversation-context",
          contentHash: VALID_CONTENT_HASH,
          content: "# Conversation\n",
        },
      },
    });
    await expect(
      factory.runConversationBridge(crypto.randomUUID(), "missing"),
    ).resolves.toEqual({
      save: {
        ok: true,
        value: {
          revisionId: VALID_REVISION_ID,
          documentKey: "conversation-context",
          contentHash: VALID_CONTENT_HASH,
        },
      },
      current: {ok: true, value: null},
      historical: {
        ok: true,
        value: {
          revisionId: VALID_REVISION_ID,
          documentKey: "conversation-context",
          contentHash: VALID_CONTENT_HASH,
          content: "# Conversation\n",
        },
      },
    });

    for (const method of ["save", "current", "historical"] as const) {
      await expect(
        factory.runConversationMethod(crypto.randomUUID(), method, "extra"),
      ).resolves.toBe("Knowledge Base integrity_failure: malformed value.");
      await expect(
        factory.runConversationMethod(crypto.randomUUID(), method, "malformed"),
      ).resolves.toBe("Knowledge Base integrity_failure: malformed error.");
    }
  });

  it("bounds the native Agent catalog and authorizes only its count", async () => {
    const workerEnv = env as unknown as TestWorkerExports;
    const factory = workerEnv.TEST_FACTORY.getByName("m05-02-catalog");

    const hidden = await factory.runCatalog(crypto.randomUUID(), 0);
    expect(hidden.catalog).toEqual({entries: [], truncated: true});
    expect(hidden.observations).toEqual([
      expect.objectContaining({
        title: "Knowledge Base catalog",
        description: "Listed 0 Knowledge Base catalog entries.",
      }),
    ]);

    const visible = await factory.runCatalog(crypto.randomUUID(), 1);
    expect(visible.catalog).toEqual({
      entries: [{
        id: "knowledge-base",
        title: "Knowledge Base",
        description: "Available. Use recall to choose a memory direction, then search/read exact sources.",
      }],
      truncated: false,
    });
    expect(JSON.stringify(visible.observations)).not.toContain("content");
    expect(JSON.stringify(visible.catalog)).not.toContain("BEGIN CYBERNEST GOLD");
  });

  it("passes a bounded proposal to the gatekeeper action boundary", async () => {
    let received: unknown;
    const session = new KnowledgeSession(
      {
        authorizeObservation: () => Promise.resolve(),
        submitAction: () => Promise.resolve(),
      },
      {
        list: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
        search: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
        read: async () => ({
          ok: true as const,
          value: {
            revisionId: "44444444-4444-4444-8444-444444444444",
            documentKey: "principles",
            contentHash: "a".repeat(64),
            content: "# Principles",
          },
        }),
        recallGold: async () => ({ok: true as const, value: {version: 1, state: "disabled" as const}}),
        assertBoundTo: async () => {},
        applyProposal: async () => ({ ok: false as const, error: { code: "not_used" } }),
        cancelProposal: async () => ({ ok: true as const, value: null }),
      },
      async (input) => {
        received = input;
      },
    );

    await session.proposeUpdate({
      documentKey: "principles",
      baseSourceRevisionId: null,
      content: "# New principles",
    });
    expect(received).toEqual({
      documentKey: "principles",
      baseSourceRevisionId: null,
      content: "# New principles",
    });
  });

  it("rejects capability results that are not exact Agent projections", async () => {
    let observationCount = 0;
    const approvalQueue = {
      authorizeObservation: async () => {
        observationCount += 1;
      },
      submitAction: async () => {},
    };
    const makeAccess = (listResult: unknown, readResult: unknown) =>
      ({
        list: async () => listResult,
        search: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
        read: async () => readResult,
        recallGold: async () => ({ok: true as const, value: {version: 1, state: "disabled" as const}}),
        assertBoundTo: async () => {},
        applyProposal: async () => ({ ok: false as const, error: { code: "not_used" } }),
        cancelProposal: async () => ({ ok: true as const, value: null }),
      }) as ConstructorParameters<typeof KnowledgeSession>[1];

    const extraReference = new KnowledgeSession(
      approvalQueue,
      makeAccess(
        {
          ok: true,
          value: {
            items: [
              {
                revisionId: VALID_REVISION_ID,
                documentKey: "manager-principles",
                contentHash: VALID_CONTENT_HASH,
                userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              },
            ],
            nextCursor: null,
          },
        },
        { ok: true, value: null },
      ),
    );

    await expect(extraReference.list()).rejects.toThrow(/integrity_failure/u);

    const extraEnvelope = new KnowledgeSession(
      approvalQueue,
      makeAccess(
        { ok: true, value: { items: [], nextCursor: null }, managerId: "hidden" },
        { ok: true, value: null },
      ),
    );
    await expect(extraEnvelope.list()).rejects.toThrow(/integrity_failure/u);

    const unknownError = new KnowledgeSession(
      approvalQueue,
      makeAccess(
        { ok: true, value: { items: [], nextCursor: null } },
        { ok: false, error: { code: "unknown_internal_code" } },
      ),
    );
    await expect(unknownError.read(VALID_REVISION_ID)).rejects.toThrow(
      /integrity_failure/u,
    );
    expect(observationCount).toBe(0);
  });

  it("accepts only the exact pending and state-only terminal record shapes", () => {
    const pending = {
      state: "pending" as const,
      revisionId: VALID_REVISION_ID,
      documentKey: "manager-principles",
      baseSourceRevisionId: null,
      contentHash: VALID_CONTENT_HASH,
      body: new ArrayBuffer(0),
    };

    expect(parseKnowledgeActionRecord(pending)).toEqual(pending);
    expect(() =>
      parseKnowledgeActionRecord({ ...pending, userId: "hidden" }),
    ).toThrow(/integrity_failure/u);
    expect(() =>
      parseKnowledgeActionRecord({ ...pending, body: new Uint8Array() }),
    ).toThrow(/integrity_failure/u);
    expect(() =>
      parseKnowledgeActionRecord({ ...pending, version: 1 }),
    ).toThrow(/integrity_failure/u);
    expect(() =>
      parseKnowledgeActionRecord({
        ...pending,
        body: new ArrayBuffer(1_048_577),
      }),
    ).toThrow(/integrity_failure/u);

    expect(parseKnowledgeActionRecord({ state: "applied" })).toEqual({
      state: "applied",
    });
    expect(parseKnowledgeActionRecord({ state: "rejected" })).toEqual({
      state: "rejected",
    });
    expect(() =>
      parseKnowledgeActionRecord({ state: "applied", version: 1 }),
    ).toThrow(/integrity_failure/u);
  });

  it("applies the exact staged UTF-8 content, including a leading BOM, idempotently", async () => {
    const workerEnv = env as unknown as TestWorkerExports;
    const factory = workerEnv.TEST_FACTORY.getByName("m05-03");
    const result = await factory.runProposal(crypto.randomUUID());

    expect(result.submission.description).toMatchObject({
      awaitDecision: true,
      autoApprovable: false,
      implementsRevert: false,
    });
    expect(result.submission.description).not.toHaveProperty("actionKind");
    expect(result.submission.description.description).toContain(
      "Content hash (SHA-256):",
    );
    expect(result.proposalCallCount).toBe(1);
    expect(result.proposalContent).toBe("\uFEFF# Approved principles");
  });

  it("keeps every approval preview line literal across CR, LF, and CRLF", async () => {
    const workerEnv = env as unknown as TestWorkerExports;
    const factory = workerEnv.TEST_FACTORY.getByName("m05-03-card");
    const content = "# title\r# injected\n[link](https://example.test)\r\n```";

    const result = await factory.runProposal(crypto.randomUUID(), content);
    const description = String(result.submission.description.description);

    expect(result.proposalContent).toBe(content);
    expect(description).toContain(
      "Preview (first 2,000 Unicode code points):\n" +
        "    # title\n" +
        "    # injected\n" +
        "    [link](https://example.test)\n" +
        "    ```",
    );
    expect(description).not.toContain("\r");
  });

  it("round-trips an exact 1 MiB non-BMP action and leaves only an applied tombstone", async () => {
    const workerEnv = env as unknown as TestWorkerExports;
    const factory = workerEnv.TEST_FACTORY.getByName("m05-03-one-mib");
    const result = await factory.runActionScenario(
      crypto.randomUUID(),
      "one-mib-non-bmp",
    );
    expect(result.appliedContentByteLength).toBe(1_048_576);
    expect(result.appliedContentHash).toBe(result.expectedHash);
    expect(result.applyCalls).toBe(1);
    expect(result.record).toMatchObject(APPLIED_TOMBSTONE);
  });

  it("keeps capacity and mismatched apply failures pending for the same correlated retry", async () => {
    const workerEnv = env as unknown as TestWorkerExports;
    const factory = workerEnv.TEST_FACTORY.getByName("m05-03-apply-failures");

    const capacity = await factory.runActionScenario(
      crypto.randomUUID(),
      "capacity-retry",
    );
    expect(capacity.firstError).toMatch(/capacity_exceeded/u);
    expect(capacity.pendingAfterFailure).toMatchObject({
      state: "pending",
      keys: PENDING_ACTION_KEYS,
      bodyByteLength: expect.any(Number),
    });
    expect(capacity.terminalRecord).toMatchObject(APPLIED_TOMBSTONE);
    const correlations = capacity.correlations as Array<{
      revisionId: string;
      documentKey: string;
    }>;
    expect(correlations).toHaveLength(2);
    expect(correlations[1]).toEqual(correlations[0]);

    const mismatch = await factory.runActionScenario(
      crypto.randomUUID(),
      "mismatch-retry",
    );
    expect(mismatch.errors).toEqual([
      expect.stringMatching(/integrity_failure/u),
      expect.stringMatching(/integrity_failure/u),
      expect.stringMatching(/integrity_failure/u),
    ]);
    expect(mismatch.applyCalls).toBe(4);
    expect(mismatch.terminalRecord).toMatchObject(APPLIED_TOMBSTONE);
    const mismatchCorrelations = mismatch.correlations as Array<{
      revisionId: string;
      documentKey: string;
    }>;
    expect(mismatchCorrelations).toHaveLength(4);
    expect(new Set(mismatchCorrelations.map(({revisionId}) => revisionId)).size).toBe(1);
    expect(new Set(mismatchCorrelations.map(({documentKey}) => documentKey)).size).toBe(1);
  });

  it("keeps reject terminal and cancellation-conflict semantics one-way", async () => {
    const workerEnv = env as unknown as TestWorkerExports;
    const factory = workerEnv.TEST_FACTORY.getByName("m05-03-reject");

    const rejected = await factory.runActionScenario(
      crypto.randomUUID(),
      "reject-terminal",
    );
    expect(rejected.applyAfterReject).toMatch(/integrity_failure/u);
    expect(rejected.applyCalls).toBe(0);
    expect(rejected.cancelCalls).toBe(1);
    expect(rejected.terminalRecord).toMatchObject(REJECTED_TOMBSTONE);

    const conflict = await factory.runActionScenario(
      crypto.randomUUID(),
      "cancel-conflict",
    );
    expect(conflict.firstError).toMatch(/revision_conflict/u);
    expect(conflict.pendingAfterConflict).toMatchObject({
      state: "pending",
      keys: PENDING_ACTION_KEYS,
    });
    expect(conflict.applyAfterReject).toMatch(/integrity_failure/u);
    expect(conflict.applyCalls).toBe(0);
    const cancelInputs = conflict.cancelInputs as string[];
    expect(cancelInputs).toHaveLength(2);
    expect(cancelInputs[1]).toBe(cancelInputs[0]);
    expect(conflict.terminalRecord).toMatchObject(REJECTED_TOMBSTONE);
  });

  it("fails closed on submission loss and never reuses its action ID", async () => {
    const workerEnv = env as unknown as TestWorkerExports;
    const factory = workerEnv.TEST_FACTORY.getByName("m05-03-storage-guards");

    const submission = await factory.runActionScenario(
      crypto.randomUUID(),
      "submission-loss",
    );
    expect(submission.firstError).toMatch(/response lost/u);
    expect(submission).toMatchObject({
      firstAction: 1,
      lostRecord: null,
      lostCallbackError: expect.stringMatching(/integrity_failure/u),
      applyCallsAfterLoss: 0,
      secondAction: 2,
      applyCalls: 1,
      secondRecord: APPLIED_TOMBSTONE,
    });

    const unpaired = await factory.runActionScenario(
      crypto.randomUUID(),
      "unpaired-content",
    );
    expect(unpaired).toMatchObject({
      error: expect.stringMatching(/invalid_input/u),
      submissions: 0,
    });
  });

  it("fails closed on callback, counter, staged-write, and stored-record corruption", async () => {
    const workerEnv = env as unknown as TestWorkerExports;

    const callback = await workerEnv.TEST_FACTORY
      .getByName("m05-03-invalid-callback")
      .runActionScenario(crypto.randomUUID(), "invalid-callback");
    expect(callback).toMatchObject({
      error: expect.stringMatching(/integrity_failure/u),
      before: [],
      after: [],
      applyCalls: 0,
      cancelCalls: 0,
    });

    const counters = await workerEnv.TEST_FACTORY
      .getByName("m05-03-counter-guards")
      .runActionScenario(crypto.randomUUID(), "counter-guards");
    expect(counters).toMatchObject({
      malformedError: expect.stringMatching(/integrity_failure/u),
      exhaustedError: expect.stringMatching(/capacity_exceeded/u),
      submissions: 0,
      actionKeys: [],
      applyCalls: 0,
    });

    const writeFailure = await workerEnv.TEST_FACTORY
      .getByName("m05-03-write-failure")
      .runActionScenario(crypto.randomUUID(), "staged-write-failure");
    expect(writeFailure).toMatchObject({
      error: expect.stringMatching(/injected staged write failure/u),
      submissions: 0,
      knowledgeKeys: [],
      applyCalls: 0,
    });

    const corruption = await workerEnv.TEST_FACTORY
      .getByName("m05-03-stored-corruption")
      .runActionScenario(crypto.randomUUID(), "stored-corruption");
    const results = corruption.results as Array<{
      error: string;
      coreCalls: number;
      record: {state: string; keys: string[]};
    }>;
    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(result.error).toMatch(/integrity_failure/u);
      expect(result.coreCalls).toBe(0);
      expect(result.record).toMatchObject({state: "pending"});
    }
  });

  it("rejects malformed counters and callback IDs before deriving action state", () => {
    expect(nextKnowledgeActionId(undefined)).toBe(1);
    expect(nextKnowledgeActionId(1)).toBe(1);
    expect(nextKnowledgeActionId(Number.MAX_SAFE_INTEGER - 1)).toBe(
      Number.MAX_SAFE_INTEGER - 1,
    );
    for (const value of [null, "1", 0, -1, 1.5, Number.NaN]) {
      expect(() => nextKnowledgeActionId(value)).toThrow(/integrity_failure/u);
    }
    expect(() => nextKnowledgeActionId(Number.MAX_SAFE_INTEGER)).toThrow(
      /capacity_exceeded/u,
    );

    expect(() => assertKnowledgeActionId(1)).not.toThrow();
    expect(() => assertKnowledgeActionId(Number.MAX_SAFE_INTEGER - 1)).not.toThrow();
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => assertKnowledgeActionId(value)).toThrow(/integrity_failure/u);
    }
  });

  it("serializes concurrent apply and reject callbacks without coalescing them", async () => {
    const workerEnv = env as unknown as TestWorkerExports;
    const factory = workerEnv.TEST_FACTORY.getByName("m05-03-concurrency");
    const result = await factory.runActionScenario(
      crypto.randomUUID(),
      "concurrent-apply-reject",
    );

    expect([result.applyStatus, result.rejectStatus].toSorted()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(Number(result.applyCalls) + Number(result.cancelCalls)).toBe(1);
    expect(`${result.applyError ?? ""}${result.rejectError ?? ""}`).toMatch(
      /integrity_failure/u,
    );
    expect(result.terminalRecord).toMatchObject({
      state: expect.stringMatching(/^(applied|rejected)$/u),
      keys: ["state"],
      bodyByteLength: null,
    });
  });

  it("authorizes Knowledge reads and recall before returning data and disposes its queue", async () => {
    const observations: unknown[] = [];
    let disposed = false;
    const session = new KnowledgeSession(
      {
        authorizeObservation(value: unknown) {
          observations.push(value);
          return Promise.resolve();
        },
        [Symbol.dispose]() {
          disposed = true;
        },
      },
      {
        list: async () => ({
          ok: true as const,
          value: {
            items: [
              {
                revisionId: VALID_REVISION_ID,
                documentKey: "manager-principles",
                contentHash: VALID_CONTENT_HASH,
              },
            ],
            nextCursor: null,
          },
        }),
        search: async () => ({
          ok: true as const,
          value: { items: [], nextCursor: null },
        }),
        read: async () => ({
          ok: true as const,
          value: {
            revisionId: VALID_REVISION_ID,
            documentKey: "manager-principles",
            contentHash: VALID_CONTENT_HASH,
            content: "# Principles",
          },
        }),
        recallGold: async (query: string) => ({
          ok: true as const,
          value: {
            version: 1 as const,
            state: "ready" as const,
            generation: "internal-generation",
            patterns: [`person -> ${query}`],
          },
        }),
        assertBoundTo: async () => {},
        applyProposal: async () => {
          throw new Error("not used");
        },
        cancelProposal: async () => {
          throw new Error("not used");
        },
      },
    );

    await expect(session.list()).resolves.toMatchObject({
      items: [{ documentKey: "manager-principles" }],
    });
    await expect(session.search("  ＭＡＮＡＧＥＲ  ")).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(session.read(VALID_REVISION_ID)).resolves.toMatchObject({
      documentKey: "manager-principles",
      content: "# Principles",
    });
    await expect(session.recall("  ＹＡＭＡＤＡ  ")).resolves.toEqual({
      state: "ready",
      patterns: ["person -> YAMADA"],
    });
    expect(observations).toHaveLength(4);
    expect(observations[0]).toMatchObject({ title: "Knowledge Base list" });
    expect(observations[1]).toMatchObject({
      title: "Knowledge Base search",
      description: "Searched the Knowledge Base for manager. Returned 0 current source(s).",
    });
    expect(observations[2]).toMatchObject({ title: "Knowledge Base read" });
    expect(observations[3]).toMatchObject({
      title: "Knowledge Base recall",
      description: "Recalled 1 abstract semantic direction(s).",
    });
    expect(JSON.stringify(observations)).not.toContain("# Principles");
    expect(JSON.stringify(observations)).not.toContain("internal-generation");

    session[Symbol.dispose]();
    expect(disposed).toBe(true);
  });

  it("returns no Knowledge data when observation authorization fails", async () => {
    let readCount = 0;
    const session = new KnowledgeSession(
      {
        authorizeObservation: async () => {
          throw new Error("observation denied");
        },
        submitAction: async () => {},
      },
      {
        list: async () => ({ok: true as const, value: {items: [], nextCursor: null}}),
        search: async () => ({ok: true as const, value: {items: [], nextCursor: null}}),
        read: async () => {
          readCount += 1;
          return {
            ok: true as const,
            value: {
              revisionId: VALID_REVISION_ID,
              documentKey: "manager-principles",
              contentHash: VALID_CONTENT_HASH,
              content: "# Must not escape",
            },
          };
        },
        recallGold: async () => ({ok: true as const, value: {version: 1, state: "disabled" as const}}),
        assertBoundTo: async () => {},
        applyProposal: async () => ({ok: false as const, error: {code: "not_used"}}),
        cancelProposal: async () => ({ok: true as const, value: null}),
      },
    );

    await expect(session.read(VALID_REVISION_ID)).rejects.toThrow("observation denied");
    expect(readCount).toBe(1);
  });
});
