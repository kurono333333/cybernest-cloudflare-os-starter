import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  KnowledgeSession,
  describeCustomAccount,
  describeCustomVendor,
  parseKnowledgeActionRecord,
} from "../src/custom.js";
import TYPES_CODE from "../src/types-code.js";

const VALID_REVISION_ID = "44444444-4444-4444-8444-444444444444";
const VALID_CONTENT_HASH = "a".repeat(64);

type TestWorkerExports = {
  TEST_FACTORY: DurableObjectNamespace<{
    runProposal(managerId: string): Promise<{
      submission: { action: number; description: Record<string, unknown> };
      proposalCallCount: number;
    }>;
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

  it("publishes only the read methods in the KnowledgeBase agent surface", () => {
    expect(TYPES_CODE).toContain("interface KnowledgeBase")
    expect(TYPES_CODE).toMatch(/list\(options\?:/u)
    expect(TYPES_CODE).toMatch(/search\(query: string,/u)
    expect(TYPES_CODE).toMatch(/read\(revisionId: string\)/u)
    expect(TYPES_CODE).toContain("proposeUpdate")
    expect(TYPES_CODE).not.toContain("managerId")
    expect(TYPES_CODE).not.toContain("userId")
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

  it("stages a proposal, submits a manual action, and applies it idempotently", async () => {
    const workerEnv = env as unknown as TestWorkerExports;
    const factory = workerEnv.TEST_FACTORY.getByName("m05-03");
    const result = await factory.runProposal(crypto.randomUUID());

    expect(result.submission.description).toMatchObject({
      awaitDecision: true,
      autoApprovable: false,
      implementsRevert: false,
    });
    expect(result.submission.description.description).toContain(
      "Content hash (SHA-256):",
    );
    expect(result.proposalCallCount).toBe(1);
  });

  it("authorizes Knowledge reads before returning data and disposes its queue", async () => {
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
    await expect(session.read(VALID_REVISION_ID)).resolves.toMatchObject({
      documentKey: "manager-principles",
      content: "# Principles",
    });
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({ title: "Knowledge Base list" });
    expect(observations[1]).toMatchObject({ title: "Knowledge Base read" });

    session[Symbol.dispose]();
    expect(disposed).toBe(true);
  });
});
