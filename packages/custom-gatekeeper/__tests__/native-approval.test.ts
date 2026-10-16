import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import type { ActionLogEntry } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";

const NOW = "2026-09-27T00:00:00.000Z";
const MANAGER_HEADER = "X-Cybernest-Manager-Id";
const ARTICLE = {
  sections: [
    {
      text: "Deployment begins on Monday.\n",
      meaning: "observed_result",
      sourceIds: ["conversation-42"],
    },
    {
      text: "The user deferred the deadline decision.\n",
      meaning: "explicit_decision",
      sourceIds: ["conversation-42"],
    },
  ],
  sources: [
    {
      sourceId: "conversation-42",
      kind: "conversation",
      reference: "chat/42",
      actor: { kind: "user", reference: "profile/7" },
      recordedAt: NOW,
      eventAt: "2026-09-26T15:30:00.000Z",
      excerpt: "We will start Monday; please decide the deadline later.",
    },
  ],
} as const;
const EXPECTED_BODY = ARTICLE.sections.map((section) => section.text).join("");

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

type NativeArticleCapability = {
  initialize(managerId: string): Promise<void>;
  clearFixture(): Promise<void>;
  setArticleSaveMode(mode: "normal" | "commit_then_throw_once" | "forbidden_once"): Promise<void>;
  articleSnapshot(): Promise<{
    saveInputs: Array<{ commandJson: string; payloadHash: string }>;
    readInputs: Array<{ articleId: string; revisionId: string }>;
    articles: Array<{
      operationId: string;
      commandJson: string;
      payloadHash: string;
      articleId: string;
      revisionId: string;
      receiptId: string;
      committedAt: string;
    }>;
  }>;
};

type NativeApprovalOwner = {
  prepareWorkspace(managerId: string): Promise<string>;
  cleanupWorkspace(managerId: string, workspaceId: string): Promise<void>;
  listActions(managerId: string, workspaceId: string): Promise<ActionLogEntry[]>;
  proposeArticle(
    managerId: string,
    workspaceId: string,
    gatekeeperId: number,
    article: unknown,
  ): Promise<unknown>;
  readArticleOutcome(
    managerId: string,
    workspaceId: string,
    gatekeeperId: number,
    operationId: string,
  ): Promise<unknown>;
  decideAction(
    managerId: string,
    workspaceId: string,
    actionId: number,
    decision: "approve" | "reject",
  ): Promise<{ error: string | null }>;
};

type NativeOverseerInstance = {
  ctx: {
    exports: {
      InspectableCustomGatekeeper(input: { props: { managerId: string } }): unknown;
    };
  };
  impl: {
    addGatekeeper(cls: unknown): Promise<{ getId(): Promise<number> }>;
    getGatekeeperFacet(id: number): unknown;
  };
};

type TestWorkerExports = {
  default: { fetch(request: Request): Promise<Response> };
  OverseerDurableObject: {
    idFromString(id: string): unknown;
    get(id: unknown): unknown;
  };
  KnowledgeAccountAccess: {
    getByName(name: string): {
      bind(managerId: string, access: unknown): Promise<void>;
      bindBronzeRoles(managerId: string, writer: unknown, sourceReader: unknown): Promise<void>;
      reserveBronzeAction(managerId: string, reservation: {
        workspaceId: string;
        gatekeeperInstanceId: string;
        localActionId: number;
        operationId: string;
        operationDeadlineMs: number;
        retainedBytesReserved: number;
      }): Promise<void>;
      clearBronzeAction(managerId: string, reservation: {
        workspaceId: string;
        gatekeeperInstanceId: string;
        localActionId: number;
        operationId: string;
        operationDeadlineMs: number;
      }): Promise<void>;
      armCapabilityProbeForTest(managerId: string, token: string): Promise<void>;
      probeCapabilitiesForTest(managerId: string, token: string): Promise<{ token: string }>;
      capabilityProbeStateForTest(token: string): Promise<{
        armed: boolean;
        waiting: boolean;
        completed: boolean;
      } | undefined>;
      releaseCapabilityProbeForTest(token: string): Promise<void>;
      disposeCapabilityProbeForTest(token: string): Promise<void>;
      getBronzeCapabilities(managerId: string): Promise<{
        writer: NativeBronzeCapabilityFixture;
        sourceReader: NativeBronzeCapabilityFixture;
      }>;
    };
  };
  NativeArticleAccess: {
    getByName(name: string): NativeArticleCapability;
  };
  NativeApprovalOwner: {
    getByName(name: string): NativeApprovalOwner;
  };
  InspectableCustomGatekeeper(input: { props: { managerId: string } }): unknown;
  NativeBronzeCapability(input: {
    props: { managerId: string; role: "writer" | "sourceReader"; token: string };
  }): NativeBronzeCapabilityFixture;
};

type NativeBronzeCapabilityFixture = {
  holdNextAssertion(): Promise<void>;
  assertionState(): Promise<{ count: number; waiting: boolean }>;
  disposeTestControl(): Promise<void>;
  tokenForTest(): Promise<string>;
};

type NativeHarness = {
  managerId: string;
  capabilityToken: string;
  workspaceId: string;
  owner: NativeApprovalOwner;
  articleAccess: NativeArticleCapability;
  close(): Promise<void>;
};

const workerExports = exports as unknown as TestWorkerExports;

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitForAssertionHold(
  capability: NativeBronzeCapabilityFixture,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const state = await capability.assertionState();
    if (state.count >= count && state.waiting) return;
    if (Date.now() >= deadline) throw new Error("The stored capability RPC did not reach its hold point.");
    await delay(1);
  }
}

async function waitForCapabilityProbe(
  store: Pick<ReturnType<TestWorkerExports["KnowledgeAccountAccess"]["getByName"]>, "capabilityProbeStateForTest">,
  token: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if ((await store.capabilityProbeStateForTest(token))?.waiting) return;
    if (Date.now() >= deadline) throw new Error("The Account capability RPC did not reach its hold point.");
    await delay(1);
  }
}

describe("Knowledge Account Bronze binding concurrency", () => {
  it("keeps local reservation RPC responsive while stored capability validation is held", async () => {
    const managerId = crypto.randomUUID();
    const store = workerExports.KnowledgeAccountAccess.getByName(managerId);
    const originalWriter = workerExports.NativeBronzeCapability({
      props: { managerId, role: "writer", token: crypto.randomUUID() },
    });
    const originalSourceReader = workerExports.NativeBronzeCapability({
      props: { managerId, role: "sourceReader", token: crypto.randomUUID() },
    });
    const replacementWriter = workerExports.NativeBronzeCapability({
      props: { managerId, role: "writer", token: crypto.randomUUID() },
    });
    const replacementSourceReader = workerExports.NativeBronzeCapability({
      props: { managerId, role: "sourceReader", token: crypto.randomUUID() },
    });
    const reservation = {
      workspaceId: "native-bronze-gate-probe",
      gatekeeperInstanceId: crypto.randomUUID(),
      localActionId: 1,
      operationId: crypto.randomUUID(),
      operationDeadlineMs: 0,
      retainedBytesReserved: 128,
    };
    let rebind: Promise<void> | undefined;
    let probe: Promise<void> | undefined;
    let probeReturnedBeforeRpcRelease = false;
    let traceBeforeRpcCompletion: { count: number; waiting: boolean } | undefined;
    let setupError: unknown;
    let operationResults: PromiseSettledResult<void>[] = [];
    try {
      await store.bindBronzeRoles(managerId, originalWriter, originalSourceReader);
      await originalWriter.holdNextAssertion();
      rebind = store.bindBronzeRoles(managerId, replacementWriter, replacementSourceReader);
      await waitForAssertionHold(originalWriter, 2);
      probe = store.reserveBronzeAction(managerId, reservation);
      probeReturnedBeforeRpcRelease = await Promise.race([
        probe.then(() => true, () => false),
        delay(1_000).then(() => false),
      ]);
      traceBeforeRpcCompletion = await originalWriter.assertionState();
    } catch (error) {
      setupError = error;
    } finally {
      const operations = [rebind, probe].filter(
        (operation): operation is Promise<void> => operation !== undefined,
      );
      operationResults = await Promise.allSettled(operations);
      const probeIndex = operations.indexOf(probe as Promise<void>);
      if (probeIndex >= 0 && operationResults[probeIndex]?.status === "fulfilled") {
        try {
          await store.clearBronzeAction(managerId, {
            workspaceId: reservation.workspaceId,
            gatekeeperInstanceId: reservation.gatekeeperInstanceId,
            localActionId: reservation.localActionId,
            operationId: reservation.operationId,
            operationDeadlineMs: reservation.operationDeadlineMs,
          });
        } catch (error) {
          setupError ??= error;
        }
      }
      await Promise.all([
        originalWriter.disposeTestControl(),
        originalSourceReader.disposeTestControl(),
        replacementWriter.disposeTestControl(),
        replacementSourceReader.disposeTestControl(),
      ]);
    }

    if (setupError !== undefined) throw setupError;
    for (const result of operationResults) {
      if (result.status === "rejected") throw result.reason;
    }
    expect(traceBeforeRpcCompletion).toMatchObject({ count: 2, waiting: true });
    expect(probe).toBeDefined();

    expect(probeReturnedBeforeRpcRelease).toBe(true);
    const stored = await store.getBronzeCapabilities(managerId);
    expect(await stored.writer.tokenForTest()).toBe(await originalWriter.tokenForTest());
    expect(await stored.sourceReader.tokenForTest()).toBe(await originalSourceReader.tokenForTest());
  }, 10_000);

  it("does not reset an in-flight Account RPC when a conflicting reservation is rejected", async () => {
    const managerId = crypto.randomUUID();
    const store = workerExports.KnowledgeAccountAccess.getByName(managerId);
    const writer = workerExports.NativeBronzeCapability({
      props: { managerId, role: "writer", token: crypto.randomUUID() },
    });
    const sourceReader = workerExports.NativeBronzeCapability({
      props: { managerId, role: "sourceReader", token: crypto.randomUUID() },
    });
    const retained = {
      workspaceId: "native-bronze-gate-reset-probe",
      gatekeeperInstanceId: crypto.randomUUID(),
      localActionId: 1,
      operationId: crypto.randomUUID(),
      operationDeadlineMs: 0,
      retainedBytesReserved: 128,
    };
    const conflicting = {
      ...retained,
      localActionId: 2,
      operationId: crypto.randomUUID(),
    };
    const token = crypto.randomUUID();
    let probe: Promise<{ token: string }> | undefined;
    let probeCompletion: Promise<"fulfilled" | "rejected"> | undefined;
    let capacityError: unknown;
    let traceBeforeConflict: {
      armed: boolean;
      waiting: boolean;
      completed: boolean;
    } | undefined;
    let probeBeforeRelease: "fulfilled" | "rejected" | "pending" | undefined;
    let probeAfterRelease: "fulfilled" | "rejected" | undefined;
    let setupError: unknown;
    try {
      await store.bindBronzeRoles(managerId, writer, sourceReader);
      await store.reserveBronzeAction(managerId, retained);
      await store.armCapabilityProbeForTest(managerId, token);
      probe = store.probeCapabilitiesForTest(managerId, token);
      probeCompletion = probe.then(() => "fulfilled" as const, () => "rejected" as const);
      await waitForCapabilityProbe(store, token);
      traceBeforeConflict = await store.capabilityProbeStateForTest(token);

      try {
        await store.reserveBronzeAction(managerId, conflicting);
      } catch (error) {
        capacityError = error;
      }
      probeBeforeRelease = await Promise.race([
        probeCompletion,
        delay(1_000).then(() => "pending" as const),
      ]);
    } catch (error) {
      setupError = error;
    } finally {
      await store.releaseCapabilityProbeForTest(token).catch(() => undefined);
      if (probeCompletion !== undefined) probeAfterRelease = await probeCompletion;
      try {
        await store.clearBronzeAction(managerId, {
          workspaceId: retained.workspaceId,
          gatekeeperInstanceId: retained.gatekeeperInstanceId,
          localActionId: retained.localActionId,
          operationId: retained.operationId,
          operationDeadlineMs: retained.operationDeadlineMs,
        });
      } catch {
        // The original capacity error may have reset the DO before cleanup could run.
      }
      await Promise.allSettled([
        writer.disposeTestControl(),
        sourceReader.disposeTestControl(),
        store.disposeCapabilityProbeForTest(token),
      ]);
    }

    if (setupError !== undefined) throw setupError;
    expect(String(capacityError)).toContain("capacity_exceeded");
    expect(traceBeforeConflict).toMatchObject({ waiting: true, completed: false });
    expect(probeBeforeRelease).toBe("pending");
    expect(probeAfterRelease).toBe("fulfilled");
    if (!probe) throw new Error("The Account capability probe was not started.");
    expect(await probe).toEqual({ token });
  }, 10_000);
});

async function openNativeHarness(): Promise<NativeHarness> {
  const managerId = crypto.randomUUID();
  const managerResponse = await workerExports.default.fetch(
    new Request("https://workshop.invalid/_cybernest/manager", {
      method: "POST",
      headers: { [MANAGER_HEADER]: managerId },
    }),
  );
  expect(managerResponse.status).toBe(204);

  const capabilityToken = `article-${managerId}`;
  const articleAccess = workerExports.NativeArticleAccess.getByName(capabilityToken);
  await articleAccess.initialize(managerId);
  await workerExports.KnowledgeAccountAccess.getByName(managerId)
    .bind(managerId, articleAccess);

  const owner = workerExports.NativeApprovalOwner.getByName(managerId);
  const workspaceId = await owner.prepareWorkspace(managerId);
  return {
    managerId,
    capabilityToken,
    workspaceId,
    owner,
    articleAccess,
    async close() {
      await owner.cleanupWorkspace(managerId, workspaceId);
      await articleAccess.clearFixture();
    },
  };
}

async function articleSnapshot(harness: NativeHarness) {
  return harness.articleAccess.articleSnapshot();
}

async function decideAction(
  harness: NativeHarness,
  actionId: number,
  decision: "approve" | "reject",
  mode?: "normal" | "commit_then_throw_once" | "forbidden_once",
): Promise<{ error: string | null; snapshot: Awaited<ReturnType<NativeArticleCapability["articleSnapshot"]>> }> {
  if (mode !== undefined) await harness.articleAccess.setArticleSaveMode(mode);
  const result = await harness.owner.decideAction(
    harness.managerId,
    harness.workspaceId,
    actionId,
    decision,
  );
  return { ...result, snapshot: await articleSnapshot(harness) };
}

async function stageArticle(harness: NativeHarness): Promise<{
  gatekeeperId: number;
  operationId: string;
}> {
  const namespace = workerExports.OverseerDurableObject;
  const overseerStub = namespace.get(namespace.idFromString(harness.workspaceId));
  const gatekeeperId = await runInDurableObject(overseerStub as never, async (rawInstance) => {
    const instance = rawInstance as unknown as NativeOverseerInstance;
    const gatekeeperClass = instance.ctx.exports.InspectableCustomGatekeeper({
      props: { managerId: harness.managerId },
    });
    const client = await instance.impl.addGatekeeper(gatekeeperClass);
    return client.getId();
  });
  const proposal = await harness.owner.proposeArticle(
    harness.managerId,
    harness.workspaceId,
    gatekeeperId,
    ARTICLE,
  ) as { operationId?: unknown; status?: unknown };
  if (typeof proposal.operationId !== "string") {
    throw new Error("Article proposal did not return an operation ID.");
  }
  expect(proposal.status).toBe("pending_approval");
  return { gatekeeperId, operationId: proposal.operationId };
}

async function readArticleOutcome(
  harness: NativeHarness,
  gatekeeperId: number,
  operationId: string,
): Promise<unknown> {
  return harness.owner.readArticleOutcome(
    harness.managerId,
    harness.workspaceId,
    gatekeeperId,
    operationId,
  );
}

async function inspectArticleRow(
  harness: NativeHarness,
  gatekeeperId: number,
  operationId: string,
): Promise<Record<string, unknown> | null> {
  const namespace = workerExports.OverseerDurableObject;
  const overseerStub = namespace.get(namespace.idFromString(harness.workspaceId));
  return runInDurableObject(overseerStub as never, async (rawInstance) => {
    const instance = rawInstance as unknown as NativeOverseerInstance;
    const facet = instance.impl.getGatekeeperFacet(gatekeeperId) as {
      inspectArticleRow(id: string): Promise<Record<string, unknown> | null>;
    };
    return facet.inspectArticleRow(operationId);
  });
}

async function tamperArticleCommand(
  harness: NativeHarness,
  gatekeeperId: number,
  operationId: string,
): Promise<void> {
  const namespace = workerExports.OverseerDurableObject;
  const overseerStub = namespace.get(namespace.idFromString(harness.workspaceId));
  await runInDurableObject(overseerStub as never, async (rawInstance) => {
    const instance = rawInstance as unknown as NativeOverseerInstance;
    const facet = instance.impl.getGatekeeperFacet(gatekeeperId) as {
      tamperArticleCommand(id: string): Promise<void>;
    };
    await facet.tamperArticleCommand(operationId);
  });
}

async function listActions(harness: NativeHarness): Promise<ActionLogEntry[]> {
  return harness.owner.listActions(harness.managerId, harness.workspaceId);
}

async function pendingAction(harness: NativeHarness, gatekeeperId: number) {
  const actions = await harness.owner.listActions(harness.managerId, harness.workspaceId);
  const pending = actions.filter(
    (entry): entry is Extract<ActionLogEntry, { type: "action" }> =>
      entry.type === "action" && entry.state === "pending" &&
      entry.gatekeeperId === gatekeeperId,
  );
  expect(pending).toHaveLength(1);
  return pending[0]!;
}

describe.skip("Retired Knowledge article approval through the pinned native Overseer", () => {

  it("submits one full article review payload to the native pending-action owner", async () => {
    const harness = await openNativeHarness();
    try {
      const { gatekeeperId, operationId } = await stageArticle(harness);
      const action = await pendingAction(harness, gatekeeperId);
      const row = await inspectArticleRow(harness, gatekeeperId, operationId);
      expect(row).not.toBeNull();
      const commandJson = String(row?.command_json);
      const command = JSON.parse(commandJson) as {
        protocolVersion: string;
        operationId: string;
        actionRef: string;
        article: unknown;
      };
      const payloadHash = String(row?.payload_hash);
      const description = action.description.description;

      expect(action.description).toMatchObject({ implementsRevert: false, awaitDecision: true });
      expect(action.description.autoApprovable).not.toBe(true);
      expect(command).toMatchObject({
        protocolVersion: "activity-article/1",
        operationId,
        article: ARTICLE,
      });
      expect(row).toMatchObject({ status: "pending_approval", action_ref: command.actionRef });
      expect(payloadHash).toBe(await sha256(commandJson));
      expect(description).toContain(EXPECTED_BODY);
      expect(description).toContain("Personal Knowledge");
      expect(description).toContain("observed_result");
      expect(description).toContain("explicit_decision");
      expect(description).toContain("conversation-42");
      expect(description).toContain("chat/42");
      expect(description).toContain("user");
      expect(description).toContain("profile/7");
      expect(description).toContain(NOW);
      expect(description).toContain("2026-09-26T15:30:00.000Z");
      expect(description).toContain("We will start Monday; please decide the deadline later.");
      expect(await articleSnapshot(harness)).toMatchObject({
        saveInputs: [],
        readInputs: [],
        articles: [],
      });
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("does not save when the real Overseer rejects the pending action", async () => {
    const harness = await openNativeHarness();
    try {
      const { gatekeeperId, operationId } = await stageArticle(harness);
      const action = await pendingAction(harness, gatekeeperId);

      const rejected = await decideAction(harness, action.id, "reject");
      expect(rejected.error).toBeNull();

      const resolved = (await listActions(harness)).find((entry) => entry.id === action.id);
      expect(resolved).toMatchObject({ state: "rejected", type: "action" });
      expect(rejected.snapshot).toMatchObject({
        saveInputs: [],
        readInputs: [],
        articles: [],
      });
      expect(await inspectArticleRow(harness, gatekeeperId, operationId)).toBeNull();
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("applies once through native approve and verifies the exact readback", async () => {
    const harness = await openNativeHarness();
    try {
      const { gatekeeperId, operationId } = await stageArticle(harness);
      const action = await pendingAction(harness, gatekeeperId);
      const row = await inspectArticleRow(harness, gatekeeperId, operationId);
      expect(row).not.toBeNull();
      const commandJson = String(row?.command_json);
      const payloadHash = String(row?.payload_hash);

      const approved = await decideAction(harness, action.id, "approve");
      expect(approved.error).toBeNull();

      const resolved = (await listActions(harness)).find((entry) => entry.id === action.id);
      expect(resolved).toMatchObject({ state: "approved", type: "action", autoApproved: false });
      const snapshot = approved.snapshot;
      expect(snapshot.saveInputs).toEqual([{ commandJson, payloadHash }]);
      expect(snapshot.articles).toHaveLength(1);
      expect(snapshot.articles[0]).toMatchObject({ operationId, commandJson, payloadHash });
      expect(snapshot.readInputs).toEqual([
        {
          articleId: snapshot.articles[0]?.articleId,
          revisionId: snapshot.articles[0]?.revisionId,
        },
      ]);
      const command = JSON.parse(commandJson) as { actionRef: string };
      expect(await readArticleOutcome(harness, gatekeeperId, operationId)).toMatchObject({
        operationId,
        status: "applied",
        outcome: "committed",
        receipt: {
          operationId,
          actionRef: command.actionRef,
          payloadHash,
          articleId: snapshot.articles[0]?.articleId,
          revisionId: snapshot.articles[0]?.revisionId,
          revisionNumber: 1,
          knowledgeId: expect.any(String),
          generation: 1,
          receiptId: snapshot.articles[0]?.receiptId,
          committedAt: snapshot.articles[0]?.committedAt,
        },
      });
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("coalesces concurrent native approvals for one pending Article action", async () => {
    const harness = await openNativeHarness();
    try {
      const { gatekeeperId, operationId } = await stageArticle(harness);
      const action = await pendingAction(harness, gatekeeperId);
      const input = [harness.managerId, harness.workspaceId, action.id, "approve"] as const;
      const [first, second] = await Promise.all([
        harness.owner.decideAction(...input),
        harness.owner.decideAction(...input),
      ]);

      expect(first.error).toBeNull();
      expect(second.error).toBeNull();
      expect(await listActions(harness)).toContainEqual(
        expect.objectContaining({
          id: action.id,
          type: "action",
          state: "approved",
          autoApproved: false,
        }),
      );
      const snapshot = await articleSnapshot(harness);
      expect(snapshot.saveInputs).toHaveLength(1);
      expect(snapshot.articles).toHaveLength(1);
      expect(snapshot.articles[0]?.operationId).toBe(operationId);
      expect(snapshot.readInputs).toHaveLength(1);
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("keeps a response-lost approval pending and retries the same idempotent save once", async () => {
    const harness = await openNativeHarness();
    try {
      const { gatekeeperId, operationId } = await stageArticle(harness);
      const action = await pendingAction(harness, gatekeeperId);
      const responseLost = await decideAction(
        harness, action.id, "approve", "commit_then_throw_once",
      );
      expect(responseLost.error).toMatch(/outcome_unknown/iu);
      expect((await listActions(harness)).find((entry) => entry.id === action.id))
        .toMatchObject({ state: "pending" });
      const rejectedUnknown = await decideAction(harness, action.id, "reject");
      expect(rejectedUnknown.error).toMatch(/outcome_unknown/iu);
      expect((await listActions(harness)).find((entry) => entry.id === action.id))
        .toMatchObject({ state: "pending" });
      expect(responseLost.snapshot).toMatchObject({
        saveInputs: [{ commandJson: expect.any(String), payloadHash: expect.any(String) }],
        readInputs: [],
        articles: [{ operationId }],
      });

      const forbiddenRetry = await decideAction(
        harness, action.id, "approve", "forbidden_once",
      );
      expect(forbiddenRetry.error).toMatch(/outcome_unknown/iu);
      expect((await listActions(harness)).find((entry) => entry.id === action.id))
        .toMatchObject({ state: "pending" });
      const stillUnknown = forbiddenRetry.snapshot;
      expect(stillUnknown.saveInputs).toHaveLength(2);
      expect(stillUnknown.saveInputs[1]).toEqual(stillUnknown.saveInputs[0]);
      expect(stillUnknown.readInputs).toEqual([]);
      expect(stillUnknown.articles).toHaveLength(1);

      const retried = await decideAction(harness, action.id, "approve");
      expect(retried.error).toBeNull();

      const resolved = (await listActions(harness)).find((entry) => entry.id === action.id);
      expect(resolved).toMatchObject({ state: "approved", type: "action", autoApproved: false });
      const snapshot = retried.snapshot;
      expect(snapshot.saveInputs).toHaveLength(3);
      expect(snapshot.saveInputs[1]).toEqual(snapshot.saveInputs[0]);
      expect(snapshot.saveInputs[2]).toEqual(snapshot.saveInputs[0]);
      expect(snapshot.articles).toHaveLength(1);
      expect(snapshot.articles[0]).toMatchObject({ operationId });
      expect(snapshot.readInputs).toEqual([
        {
          articleId: snapshot.articles[0]?.articleId,
          revisionId: snapshot.articles[0]?.revisionId,
        },
      ]);
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("refuses a staged-command mutation before the native owner can save it", async () => {
    const harness = await openNativeHarness();
    try {
      const { gatekeeperId, operationId } = await stageArticle(harness);
      const action = await pendingAction(harness, gatekeeperId);
      const originalRow = await inspectArticleRow(harness, gatekeeperId, operationId);
      expect(originalRow).not.toBeNull();

      await tamperArticleCommand(harness, gatekeeperId, operationId);

      const rejectedIntegrity = await decideAction(harness, action.id, "approve");
      expect(rejectedIntegrity.error).toMatch(/integrity_failure/iu);
      expect((await listActions(harness)).find((entry) => entry.id === action.id))
        .toMatchObject({ state: "pending" });
      expect(rejectedIntegrity.snapshot).toMatchObject({
        saveInputs: [],
        readInputs: [],
        articles: [],
      });
      const tamperedRow = await inspectArticleRow(harness, gatekeeperId, operationId);
      expect(tamperedRow?.command_json).not.toBe(originalRow?.command_json);
    } finally {
      await harness.close();
    }
  }, 60_000);
});
