import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  AgentCatalog,
  AgentCatalogRequest,
  ApprovalQueue,
  ObservationAuthorizer,
} from "@gadgets/workshop-shared/gatekeeper";
import { CustomGatekeeper } from "../src/custom.js";

export { default } from "../src/index.js";
export * from "../src/index.js";
export { CustomAccount, GatekeeperVendor } from "../src/custom.js";
export { CustomGatekeeper };

type TestProps = { managerId: string; failAssert?: boolean };

const proposalCalls: unknown[] = [];

type ApplyOutcome =
  | "success"
  | "capacity_exceeded"
  | "mismatch_revision"
  | "mismatch_document"
  | "mismatch_hash";

type CancelOutcome = "success" | "revision_conflict";

type AccessState = {
  applyOutcomes: ApplyOutcome[];
  cancelOutcomes: CancelOutcome[];
  applyInputs: Array<{
    revisionId: string;
    documentKey: string;
    baseSourceRevisionId?: string | null;
    content: string;
  }>;
  cancelInputs: string[];
};

const accessStates = new Map<string, AccessState>();

const hashBytes = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const hashText = (content: string): Promise<string> =>
  hashBytes(new TextEncoder().encode(content));

const messageOf = async (operation: Promise<unknown>): Promise<string | null> => {
  try {
    await operation;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  readonly submissions: Array<{ action: number; description: Record<string, unknown> }> = [];

  constructor(private failNextSubmission = false) {
    super();
  }

  async authorizeObservation(): Promise<void> {}

  async submitAction(action: number, description: Record<string, unknown>): Promise<void> {
    this.submissions.push({ action, description });
    if (this.failNextSubmission) {
      this.failNextSubmission = false;
      throw new Error("accepted submission response lost");
    }
  }
}

class TestObservationAuthorizer extends RpcTarget implements ObservationAuthorizer {
  readonly observations: unknown[] = [];

  async authorizeObservation(observation: unknown): Promise<void> {
    this.observations.push(observation);
  }
}

export class TestKnowledgeAccess extends WorkerEntrypoint<Cloudflare.Env, TestProps> {
  async assertBoundTo(managerId: string): Promise<void> {
    if (this.ctx.props.failAssert) throw new Error("test capability unavailable");
    if (managerId !== this.ctx.props.managerId) throw new Error("wrong manager");
  }

  async list(): Promise<unknown> {
    return { ok: true, value: { items: [], nextCursor: null } };
  }

  async search(): Promise<unknown> {
    return { ok: true, value: { items: [], nextCursor: null } };
  }

  async read(): Promise<unknown> {
    return { ok: false, error: { code: "target_missing" } };
  }

  async applyProposal(input: {
    revisionId: string;
    documentKey: string;
    baseSourceRevisionId?: string | null;
    content: string;
  }): Promise<unknown> {
    proposalCalls.push(input);
    const state = accessStates.get(this.ctx.props.managerId);
    state?.applyInputs.push(input);

    const outcome = state?.applyOutcomes.shift() ?? "success";
    if (outcome === "capacity_exceeded") {
      return { ok: false, error: { code: outcome } };
    }

    const contentHash = await hashText(input.content);
    const value = {
      revisionId: input.revisionId,
      documentKey: input.documentKey,
      contentHash,
    };
    if (outcome === "mismatch_revision") value.revisionId = crypto.randomUUID();
    if (outcome === "mismatch_document") value.documentKey = "different-document";
    if (outcome === "mismatch_hash") value.contentHash = "b".repeat(64);
    return {
      ok: true,
      value,
    };
  }

  async cancelProposal(revisionId: string): Promise<unknown> {
    const state = accessStates.get(this.ctx.props.managerId);
    state?.cancelInputs.push(revisionId);
    const outcome = state?.cancelOutcomes.shift() ?? "success";
    if (outcome !== "success") {
      return {
        ok: false,
        error: {
          code: outcome,
          ...(outcome === "revision_conflict" ? { revisionId } : {}),
        },
      };
    }
    return { ok: true, value: null };
  }

  readProposalCalls(): unknown[] {
    return [...proposalCalls];
  }

  resetProposalCalls(): void {
    proposalCalls.length = 0;
  }
}

type InspectableGatekeeper = {
  startSession(queue: RpcStub<ApprovalQueue>): Promise<{
    proposeUpdate(input: {
      documentKey: string;
      baseSourceRevisionId: string | null;
      content: string;
    }): Promise<void>;
    [Symbol.dispose](): void;
  }>;
  getAgentCatalog(
    request: AgentCatalogRequest,
    authorizer: RpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog>;
  applyAction(actionId: number): Promise<void>;
  rejectAction(actionId: number): Promise<void>;
  inspectAction(actionId: number): Promise<Record<string, unknown> | null>;
  knowledgeKeys(): Promise<string[]>;
  setCounter(value: unknown): Promise<void>;
  failNextCounterWrite(): Promise<void>;
  corruptAction(
    actionId: number,
    mode: "extra" | "hash" | "invalid-utf8" | "oversized",
  ): Promise<void>;
};

type InspectableAccount = {
  describe(): Promise<{
    displayName: string;
    singleton?: { tsType?: string };
  }>;
  inspectManagerBinding(managerId: string): Promise<"legacy" | "bound">;
  [Symbol.dispose]?(): void;
};

type InspectableVendor = {
  createManagerAccount(
    managerId: string,
    capability: unknown,
  ): Promise<InspectableAccount>;
  connectAccount(callback: unknown): Promise<{url: string}>;
  getSupportedResources(): Promise<unknown[]>;
  [Symbol.dispose]?(): void;
};

const newAccessState = (
  applyOutcomes: ApplyOutcome[] = [],
  cancelOutcomes: CancelOutcome[] = [],
): AccessState => ({
  applyOutcomes: [...applyOutcomes],
  cancelOutcomes: [...cancelOutcomes],
  applyInputs: [],
  cancelInputs: [],
});

export class InspectableCustomGatekeeper extends DurableObject {
  readonly #gatekeeper: CustomGatekeeper;

  constructor(
    state: ConstructorParameters<typeof CustomGatekeeper>[0],
    env: ConstructorParameters<typeof CustomGatekeeper>[1],
  ) {
    super(state, env);
    this.#gatekeeper = new CustomGatekeeper(state, env);
  }

  startSession(queue: RpcStub<ApprovalQueue>) {
    return this.#gatekeeper.startSession(queue);
  }

  getAgentCatalog(
    request: AgentCatalogRequest,
    authorizer: RpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog> {
    return this.#gatekeeper.getAgentCatalog(request, authorizer);
  }

  applyAction(actionId: number): Promise<void> {
    return this.#gatekeeper.applyAction(actionId);
  }

  rejectAction(actionId: number): Promise<void> {
    return this.#gatekeeper.rejectAction(actionId);
  }

  async inspectAction(actionId: number): Promise<Record<string, unknown> | null> {
    const record = this.ctx.storage.kv.get<Record<string, unknown>>(
      "knowledge:action:" + actionId,
    );
    if (record === undefined) return null;
    return {
      state: record.state,
      keys: Object.keys(record).toSorted(),
      bodyByteLength:
        record.body instanceof ArrayBuffer ? record.body.byteLength : null,
      revisionId: record.revisionId,
      documentKey: record.documentKey,
      contentHash: record.contentHash,
    };
  }

  async knowledgeKeys(): Promise<string[]> {
    return [...this.ctx.storage.kv.list({prefix: "knowledge:"})]
      .map(([key]) => key)
      .toSorted();
  }

  async setCounter(value: unknown): Promise<void> {
    this.ctx.storage.kv.put("knowledge:next-action-id", value);
  }

  async failNextCounterWrite(): Promise<void> {
    const kv = this.ctx.storage.kv as unknown as {
      put(key: string, value: unknown): void;
    };
    const originalPut = kv.put;
    kv.put = (key, value) => {
      if (key === "knowledge:next-action-id") {
        kv.put = originalPut;
        throw new Error("injected staged write failure");
      }
      originalPut.call(kv, key, value);
    };
  }

  async corruptAction(
    actionId: number,
    mode: "extra" | "hash" | "invalid-utf8" | "oversized",
  ): Promise<void> {
    const key = "knowledge:action:" + actionId;
    const record = this.ctx.storage.kv.get<Record<string, unknown>>(key);
    if (record === undefined) throw new Error("Expected a staged action record.");
    if (mode === "extra") {
      this.ctx.storage.kv.put(key, {...record, extra: true});
      return;
    }
    if (mode === "hash") {
      this.ctx.storage.kv.put(key, {...record, contentHash: "b".repeat(64)});
      return;
    }
    if (mode === "invalid-utf8") {
      const invalidUtf8 = new Uint8Array([0xff]);
      this.ctx.storage.kv.put(key, {
        ...record,
        body: invalidUtf8.buffer,
        contentHash: await hashBytes(invalidUtf8),
      });
      return;
    }
    this.ctx.storage.kv.put(key, {
      ...record,
      body: new ArrayBuffer(1_048_577),
    });
  }
}

export class TestGatekeeperFactory extends DurableObject {
  #newGatekeeper(managerId: string): InspectableGatekeeper {
    const workerExports = this.ctx.exports as unknown as {
      TestKnowledgeAccess(options: { props: TestProps }): unknown;
      InspectableCustomGatekeeper(options: {
        props: { access: unknown };
      }): DurableObjectClass;
    };
    const access = workerExports.TestKnowledgeAccess({ props: { managerId } });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({props: {access}});
    const facetName = "inspectable-knowledge-" + crypto.randomUUID();
    return this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    })) as unknown as InspectableGatekeeper;
  }

  async #stage(
    gatekeeper: InspectableGatekeeper,
    approvalTarget: TestApprovalQueue,
    content = "# Proposed principles",
  ): Promise<{ action: number; description: Record<string, unknown> }> {
    const approvalQueue = new RpcStub(approvalTarget);
    const session = await gatekeeper.startSession(approvalQueue);
    try {
      await session.proposeUpdate({
        documentKey: "principles",
        baseSourceRevisionId: null,
        content,
      });
    } finally {
      session[Symbol.dispose]();
      approvalQueue[Symbol.dispose]();
    }
    const submission = approvalTarget.submissions.at(-1);
    if (submission === undefined) throw new Error("Expected a submitted action.");
    return submission;
  }

  async runProposal(managerId: string, content = "\uFEFF# Approved principles"): Promise<{
    submission: { action: number; description: Record<string, unknown> };
    proposalCallCount: number;
    proposalContent: string;
  }> {
    const workerExports = this.ctx.exports as unknown as {
      TestKnowledgeAccess(options: { props: TestProps }): unknown;
      CustomGatekeeper(options: { props: { access: unknown } }): DurableObjectClass;
    };
    const access = workerExports.TestKnowledgeAccess({ props: { managerId } });
    const gatekeeperClass = workerExports.CustomGatekeeper({ props: { access } });
    const facetName = "knowledge-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    }));
    const approvalTarget = new TestApprovalQueue();
    const approvalQueue = new RpcStub(approvalTarget);
    const session = await gatekeeper.startSession(approvalQueue);
    const proposalCallCountBefore = proposalCalls.length;
    await session.proposeUpdate({
      documentKey: "principles",
      baseSourceRevisionId: null,
      content,
    });
    const submission = approvalTarget.submissions[0];
    if (!submission) throw new Error("Expected a submitted action.");
    await gatekeeper.applyAction(submission.action);
    await gatekeeper.applyAction(submission.action);
    session[Symbol.dispose]();
    approvalQueue[Symbol.dispose]();
    const newProposalCalls = proposalCalls.slice(proposalCallCountBefore);
    const proposal = newProposalCalls[0] as { content?: unknown } | undefined;
    if (typeof proposal?.content !== "string") throw new Error("Expected an applied proposal.");
    return {
      submission,
      proposalCallCount: newProposalCalls.length,
      proposalContent: proposal.content,
    };
  }

  async runCatalog(managerId: string, limit: number): Promise<{
    catalog: AgentCatalog;
    observations: unknown[];
  }> {
    const gatekeeper = this.#newGatekeeper(managerId);
    const target = new TestObservationAuthorizer();
    const authorizer = new RpcStub<ObservationAuthorizer>(target);
    try {
      return {
        catalog: await gatekeeper.getAgentCatalog({limit}, authorizer),
        observations: [...target.observations],
      };
    } finally {
      authorizer[Symbol.dispose]();
    }
  }

  async runAccountScenario(managerId: string): Promise<Record<string, unknown>> {
    const workerExports = this.ctx.exports as unknown as {
      TestKnowledgeAccess(options: { props: TestProps }): unknown;
      CustomAccount(options: { props?: unknown }): InspectableAccount;
      GatekeeperVendor(options: object): InspectableVendor;
    };
    const access = workerExports.TestKnowledgeAccess({ props: { managerId } });
    const failingAccess = workerExports.TestKnowledgeAccess({
      props: { managerId, failAssert: true },
    });
    const vendor = workerExports.GatekeeperVendor({});
    const bound = await vendor.createManagerAccount(managerId, access);
    const legacyUndefined = workerExports.CustomAccount({});
    const legacyEmpty = workerExports.CustomAccount({ props: {} });
    const missing = workerExports.CustomAccount({ props: { version: 1 } });
    const extra = workerExports.CustomAccount({ props: { access, version: 1 } });
    const malformed = workerExports.CustomAccount({ props: { access: null } });

    try {
      const description = await bound.describe();
      return {
        bound: await bound.inspectManagerBinding(managerId),
        legacyUndefined: await legacyUndefined.inspectManagerBinding(managerId),
        legacyEmpty: await legacyEmpty.inspectManagerBinding(managerId),
        displayName: description.displayName,
        singletonType: description.singleton?.tsType,
        missingError: await messageOf(missing.inspectManagerBinding(managerId)),
        extraError: await messageOf(extra.inspectManagerBinding(managerId)),
        malformedError: await messageOf(malformed.inspectManagerBinding(managerId)),
        mismatchError: await messageOf(
          bound.inspectManagerBinding("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        ),
        rpcError: await messageOf(
          vendor.createManagerAccount(managerId, failingAccess),
        ),
        connectError: await messageOf(vendor.connectAccount(access)),
        supportedResources: await vendor.getSupportedResources(),
      };
    } finally {
      bound[Symbol.dispose]?.();
      legacyUndefined[Symbol.dispose]?.();
      legacyEmpty[Symbol.dispose]?.();
      missing[Symbol.dispose]?.();
      extra[Symbol.dispose]?.();
      malformed[Symbol.dispose]?.();
      vendor[Symbol.dispose]?.();
    }
  }

  async runActionScenario(managerId: string, scenario: string): Promise<Record<string, unknown>> {
    const gatekeeper = this.#newGatekeeper(managerId);
    const state = newAccessState();
    accessStates.set(managerId, state);

    try {
      if (scenario === "submission-loss") {
        const queue = new TestApprovalQueue(true);
        const firstError = await messageOf(this.#stage(gatekeeper, queue, "# First"));
        const firstAction = queue.submissions[0]?.action;
        if (firstAction === undefined) throw new Error("Expected a lost-response submission.");
        const lostRecord = await gatekeeper.inspectAction(firstAction);
        const lostCallbackError = await messageOf(gatekeeper.applyAction(firstAction));
        const applyCallsAfterLoss = state.applyInputs.length;
        const second = await this.#stage(gatekeeper, queue, "# Second");
        await gatekeeper.applyAction(second.action);
        await gatekeeper.applyAction(second.action);
        return {
          firstError,
          firstAction,
          lostRecord,
          lostCallbackError,
          applyCallsAfterLoss,
          secondAction: second.action,
          applyCalls: state.applyInputs.length,
          secondRecord: await gatekeeper.inspectAction(second.action),
        };
      }

      if (scenario === "unpaired-content") {
        const queue = new TestApprovalQueue();
        return {
          error: await messageOf(this.#stage(gatekeeper, queue, "broken\ud800")),
          submissions: queue.submissions.length,
        };
      }

      if (scenario === "one-mib-non-bmp") {
        const content = "😀".repeat(262_144);
        const expectedHash = await hashText(content);
        const queue = new TestApprovalQueue();
        const submission = await this.#stage(gatekeeper, queue, content);
        await gatekeeper.applyAction(submission.action);
        await gatekeeper.applyAction(submission.action);
        const appliedContent = state.applyInputs[0]?.content;
        return {
          expectedHash,
          appliedContentByteLength:
            appliedContent === undefined
              ? null
              : new TextEncoder().encode(appliedContent).byteLength,
          appliedContentHash:
            appliedContent === undefined ? null : await hashText(appliedContent),
          applyCalls: state.applyInputs.length,
          record: await gatekeeper.inspectAction(submission.action),
        };
      }

      if (scenario === "invalid-callback") {
        const before = await gatekeeper.knowledgeKeys();
        const error = await messageOf(gatekeeper.applyAction(0));
        return {
          error,
          before,
          after: await gatekeeper.knowledgeKeys(),
          applyCalls: state.applyInputs.length,
          cancelCalls: state.cancelInputs.length,
        };
      }

      if (scenario === "counter-guards") {
        const queue = new TestApprovalQueue();
        await gatekeeper.setCounter("1");
        const malformedError = await messageOf(this.#stage(gatekeeper, queue));
        await gatekeeper.setCounter(Number.MAX_SAFE_INTEGER);
        const exhaustedError = await messageOf(this.#stage(gatekeeper, queue));
        return {
          malformedError,
          exhaustedError,
          submissions: queue.submissions.length,
          actionKeys: (await gatekeeper.knowledgeKeys()).filter((key) =>
            key.startsWith("knowledge:action:"),
          ),
          applyCalls: state.applyInputs.length,
        };
      }

      if (scenario === "staged-write-failure") {
        const queue = new TestApprovalQueue();
        await gatekeeper.failNextCounterWrite();
        const error = await messageOf(this.#stage(gatekeeper, queue));
        return {
          error,
          submissions: queue.submissions.length,
          knowledgeKeys: await gatekeeper.knowledgeKeys(),
          applyCalls: state.applyInputs.length,
        };
      }

      if (scenario === "stored-corruption") {
        const queue = new TestApprovalQueue();
        const results: Array<Record<string, unknown>> = [];
        const corruptAndApply = async (
          mode: "extra" | "hash" | "invalid-utf8" | "oversized",
        ): Promise<void> => {
          const submission = await this.#stage(gatekeeper, queue);
          await gatekeeper.corruptAction(submission.action, mode);
          const callsBefore = state.applyInputs.length;
          results.push({
            error: await messageOf(gatekeeper.applyAction(submission.action)),
            coreCalls: state.applyInputs.length - callsBefore,
            record: await gatekeeper.inspectAction(submission.action),
          });
        };

        await corruptAndApply("extra");
        await corruptAndApply("hash");
        await corruptAndApply("invalid-utf8");
        await corruptAndApply("oversized");
        return {results};
      }

      const queue = new TestApprovalQueue();
      const submission = await this.#stage(gatekeeper, queue);

      if (scenario === "capacity-retry") {
        state.applyOutcomes.push("capacity_exceeded", "success");
        const firstError = await messageOf(gatekeeper.applyAction(submission.action));
        const pendingAfterFailure = await gatekeeper.inspectAction(submission.action);
        await gatekeeper.applyAction(submission.action);
        await gatekeeper.applyAction(submission.action);
        return {
          firstError,
          pendingAfterFailure,
          terminalRecord: await gatekeeper.inspectAction(submission.action),
          correlations: state.applyInputs.map(({revisionId, documentKey}) => ({
            revisionId,
            documentKey,
          })),
        };
      }

      if (scenario === "mismatch-retry") {
        state.applyOutcomes.push(
          "mismatch_revision",
          "mismatch_document",
          "mismatch_hash",
          "success",
        );
        const errors = [];
        for (let index = 0; index < 3; index += 1) {
          errors.push(await messageOf(gatekeeper.applyAction(submission.action)));
        }
        await gatekeeper.applyAction(submission.action);
        await gatekeeper.applyAction(submission.action);
        return {
          errors,
          applyCalls: state.applyInputs.length,
          terminalRecord: await gatekeeper.inspectAction(submission.action),
          correlations: state.applyInputs.map(({revisionId, documentKey}) => ({
            revisionId,
            documentKey,
          })),
        };
      }

      if (scenario === "reject-terminal") {
        await gatekeeper.rejectAction(submission.action);
        await gatekeeper.rejectAction(submission.action);
        return {
          applyAfterReject: await messageOf(gatekeeper.applyAction(submission.action)),
          applyCalls: state.applyInputs.length,
          cancelCalls: state.cancelInputs.length,
          terminalRecord: await gatekeeper.inspectAction(submission.action),
        };
      }

      if (scenario === "cancel-conflict") {
        state.cancelOutcomes.push("revision_conflict", "success");
        const firstError = await messageOf(gatekeeper.rejectAction(submission.action));
        const pendingAfterConflict = await gatekeeper.inspectAction(submission.action);
        await gatekeeper.rejectAction(submission.action);
        return {
          firstError,
          pendingAfterConflict,
          applyAfterReject: await messageOf(gatekeeper.applyAction(submission.action)),
          applyCalls: state.applyInputs.length,
          cancelInputs: state.cancelInputs,
          terminalRecord: await gatekeeper.inspectAction(submission.action),
        };
      }

      if (scenario === "concurrent-apply-reject") {
        const [applyResult, rejectResult] = await Promise.allSettled([
          gatekeeper.applyAction(submission.action),
          gatekeeper.rejectAction(submission.action),
        ]);
        return {
          applyStatus: applyResult.status,
          rejectStatus: rejectResult.status,
          applyError:
            applyResult.status === "rejected"
              ? applyResult.reason instanceof Error
                ? applyResult.reason.message
                : String(applyResult.reason)
              : null,
          rejectError:
            rejectResult.status === "rejected"
              ? rejectResult.reason instanceof Error
                ? rejectResult.reason.message
                : String(rejectResult.reason)
              : null,
          applyCalls: state.applyInputs.length,
          cancelCalls: state.cancelInputs.length,
          terminalRecord: await gatekeeper.inspectAction(submission.action),
        };
      }

      throw new Error(`Unknown action scenario: ${scenario}`);
    } finally {
      accessStates.delete(managerId);
    }
  }
}
