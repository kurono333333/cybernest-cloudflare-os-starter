import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  AccountDescription,
  AgentCatalog,
  AgentCatalogRequest,
  ApprovalQueue,
  ObservationAuthorizer,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { CustomGatekeeper } from "../src/custom.js";

export { default } from "../src/index.js";
export * from "../src/index.js";
export {
  CustomAccount,
  CustomGatekeeper,
  CustomVerifier,
  GatekeeperVendor,
} from "../src/custom.js";

const MANAGER_ID = "44444444-4444-4444-8444-444444444444";
const KNOWLEDGE_IDS = [
  "44444444-4444-4444-8444-444444444444",
  "54444444-4444-4444-8444-444444444444",
  "64444444-4444-4444-8444-444444444444",
] as const;
const SOURCE_ID = "74444444-4444-4444-8444-444444444444";
const REVISION_ID = "84444444-4444-4444-8444-444444444444";
const OTHER_ID = "94444444-4444-4444-8444-444444444444";
const NOW = "2026-01-01T00:00:00.000Z";

type KnowledgeState = "provisioning" | "ready" | "blocked";
type ListMode =
  | "valid"
  | "empty"
  | "failure"
  | "malformed"
  | "extra"
  | "rpc_failure";
type BronzeMode =
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
type NextCursorMode = "omit" | "null" | "string";
type AssertMode = "ok" | "wrong_manager" | "rpc_failure";
type InvalidInputMode =
  | "invalid_input_bare"
  | "invalid_input"
  | "invalid_input_many"
  | "invalid_input_large"
  | "invalid_input_extra";

type CreateMode =
  | "ready"
  | "malformed"
  | "throw"
  | "throw_once"
  | "delay"
  | "initial"
  | "blocked"
  | "wrong_display"
  | "dependency_unavailable"
  | "deadline_exceeded"
  | InvalidInputMode;
type OutcomeMode =
  | "ready"
  | "malformed"
  | "throw"
  | "failure"
  | "unobserved"
  | "initial"
  | "blocked"
  | "wrong_display"
  | "dependency_unavailable"
  | "deadline_exceeded"
  | InvalidInputMode;
type AdoptionMode =
  | "committed"
  | "throw_once"
  | "throw"
  | "dependency_unavailable"
  | "deadline_exceeded"
  | "malformed"
  | "wrong_identity";
type AdoptionOutcomeMode =
  | "committed"
  | "unobserved"
  | "forbidden"
  | "throw"
  | "dependency_unavailable"
  | "deadline_exceeded"
  | "malformed"
  | "wrong_identity";
type FixtureAccessProps = {
  managerId: string;
  token?: string;
  createMode?: CreateMode;
  outcomeMode?: OutcomeMode;
  states?: KnowledgeState[];
  listMode?: ListMode;
  bronzeMode?: BronzeMode;
  nextCursor?: NextCursorMode;
  assertMode?: AssertMode;
  adoptionMode?: AdoptionMode;
  adoptionOutcomeMode?: AdoptionOutcomeMode;
  reviewDisplayName?: string;
};

type BronzeCall = {
  knowledgeId: string;
  generation: 1;
  sourceId: string;
  revisionId?: string;
};

type FixtureAccessInspector = {
  readInputLog(): Promise<unknown[]>;
  boundInputLog(): Promise<string[]>;
  createInputLog(): Promise<unknown[]>;
  outcomeInputLog(): Promise<unknown[]>;
  adoptionInputLog(): Promise<unknown[]>;
  adoptionOutcomeInputLog(): Promise<unknown[]>;
  setAdoptionOutcomeMode(mode: AdoptionOutcomeMode): Promise<void>;
};

type FixtureKnowledge = {
  readBronze(input: { sourceId: string; revisionId?: string }): Promise<unknown>;
  proposeBronzeAdoption(input: unknown): Promise<unknown>;
  readAdoptionOutcome(input: unknown): Promise<unknown | null>;
};

type FixtureSummary = {
  knowledgeId: string;
  generation: 1;
  displayName: string;
  role: "initial" | "additional";
  state: KnowledgeState;
  createdAt: string;
  updatedAt: string;
  access?: FixtureKnowledge;
};

type FixturePage = {
  items: FixtureSummary[];
  nextCursor?: string | null;
};

type FixtureSession = {
  list(options?: { cursor?: string; limit?: number }): Promise<FixturePage>;
  proposeKnowledgeCreate(input: unknown): Promise<unknown>;
  readCreationOutcome(input: unknown): Promise<unknown | null>;
  [Symbol.dispose](): void;
};

type BronzeTamperField = "document" | "content_hash" | "action_ref" | "fingerprint";

type FixtureGatekeeper = {
  startSession(queue: RpcStub<ApprovalQueue>): Promise<FixtureSession>;
  getAgentCatalog(
    request: AgentCatalogRequest,
    authorizer: RpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog>;
  addObserver(
    observerId: string,
    user: unknown,
  ): Promise<void>;
  applyAction(actionId: number): Promise<void>;
  rejectAction(actionId: number): Promise<void | { restart?: boolean }>;
  getAutoApprovableActions(): Promise<unknown>;
  inspectBronzeRow(operationId: string): Promise<Record<string, unknown> | null>;
  tamperBronzeRow(operationId: string, field: BronzeTamperField): Promise<void>;
  probeActionCollision(): Promise<{
    applyError: string | null;
    rejectError: string | null;
    createRows: number;
    bronzeRows: number;
  }>;
};

type FixtureGatekeeperProbe = {
  probeMalformedSession(): Promise<{ duplicateCount: number; error: string | null }>;
  probeStoredOutcomeUnknown(): Promise<{ observations: number; error: string | null }>;
  probeCreateFailureRecovery(): Promise<{
    createInputs: unknown[];
    outcomeInputs: unknown[];
    outcome: unknown | null;
    status: string;
    errors: string[];
  }>;
  probeAccessResolutionFailureRecovery(): Promise<{
    createInputs: unknown[];
    outcomeInputs: unknown[];
    outcome: unknown | null;
    status: string;
    errors: string[];
  }>;
  probeBronzeAccessResolutionFailure(): Promise<{
    adoptionInputs: unknown[];
    adoptionOutcomeInputs: unknown[];
    outcome: unknown | null;
    bronzeRow: Record<string, unknown> | null;
    errors: string[];
  }>;
  probeApplyRejectRace(): Promise<{ createInputs: unknown[]; errors: string[] }>;
  probeResponseLoss(): Promise<{ createInputs: unknown[]; outcomeInputs: unknown[]; status: string; errors: string[] }>;
  probeActionRefFingerprintMismatch(): Promise<{ observations: number; error: string | null }>;
};

type FixtureAccount = {
  describe(): Promise<AccountDescription>;
  inspectManagerBinding(managerId: string): Promise<"legacy" | "bound">;
  getSingletonGatekeeperClass(): Promise<unknown>;
};

type WorkerExports = {
  TestKnowledgeAccess(options: { props: FixtureAccessProps }): unknown;
  CustomGatekeeper(options: { props: { access: unknown } }): unknown;
  InspectableCustomGatekeeper(options: { props: { access: unknown } }): unknown;
  CustomAccount(options: { props?: unknown }): FixtureAccount;
  GatekeeperVendor(options: { props?: unknown }): {
    createManagerAccount(managerId: string, capability: unknown): Promise<FixtureAccount>;
  };
  CustomVerifier(options: { props?: unknown }): unknown;
};

type AccessLog = {
  readInputs: BronzeCall[];
  boundInputs: string[];
  createInputs: unknown[];
  outcomeInputs: unknown[];
  adoptionInputs: unknown[];
  adoptionOutcomeInputs: unknown[];
  adoptionOutcomeMode?: AdoptionOutcomeMode;
};

const accessLogs = new Map<string, AccessLog>();
const accessLog = (props: FixtureAccessProps): AccessLog => {
  const key = props.token ?? props.managerId;
  const existing = accessLogs.get(key);
  if (existing !== undefined) return existing;
  const created: AccessLog = {
    readInputs: [],
    boundInputs: [],
    createInputs: [],
    outcomeInputs: [],
    adoptionInputs: [],
    adoptionOutcomeInputs: [],
  };
  accessLogs.set(key, created);
  return created;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hashText = async (content: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const makeSummary = (
  index: number,
  state: KnowledgeState,
  reviewDisplayName?: string,
): FixtureSummary => ({
  knowledgeId: KNOWLEDGE_IDS[index] ?? KNOWLEDGE_IDS[0],
  generation: 1,
  displayName:
    reviewDisplayName ?? (index === 0 ? "Initial Knowledge" : "Additional Knowledge"),
  role: index === 0 ? "initial" : "additional",
  state,
  createdAt: NOW,
  updatedAt: NOW,
});

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const invalidInputModes = [
  "invalid_input_bare",
  "invalid_input",
  "invalid_input_many",
  "invalid_input_large",
  "invalid_input_extra",
] as const satisfies readonly InvalidInputMode[];
const isInvalidInputMode = (mode: unknown): mode is InvalidInputMode =>
  typeof mode === "string" && invalidInputModes.includes(mode as InvalidInputMode);
const invalidInputResult = (mode: InvalidInputMode): Record<string, unknown> => {
  if (mode === "invalid_input_bare") return { _tag: "invalid_input" };
  const issues =
    mode === "invalid_input_many"
      ? Array.from({ length: 17 }, (_, index) => `issue-${index}`)
      : mode === "invalid_input_large"
        ? ["x".repeat(129)]
        : ["schema"];
  return mode === "invalid_input_extra"
    ? { _tag: "invalid_input", issues, extra: true }
    : { _tag: "invalid_input", issues };
};

export class TestKnowledgeAccess extends WorkerEntrypoint<
  Cloudflare.Env,
  FixtureAccessProps
> {
  #adoptionOutcomeMode: AdoptionOutcomeMode | undefined;

  async assertBoundTo(managerId: string): Promise<void> {
    accessLog(this.ctx.props).boundInputs.push(managerId);
    if (this.ctx.props.assertMode === "rpc_failure") {
      throw new Error("fixture capability RPC failure");
    }
    if (
      this.ctx.props.assertMode === "wrong_manager" ||
      managerId !== this.ctx.props.managerId
    ) {
      throw new Error("fixture capability is bound to another Manager");
    }
  }

  async list(input?: { cursor?: string; limit?: number }): Promise<unknown> {
    const mode = this.ctx.props.listMode ?? "valid";
    if (mode === "rpc_failure") throw new Error("fixture list RPC failure");
    if (mode === "failure") return { _tag: "forbidden" };
    if (mode === "malformed") return { _tag: "page", items: [{ invalid: true }] };
    const states = this.ctx.props.states ?? ["ready", "provisioning", "blocked"];
    const requested = input?.limit ?? states.length;
    const items = states
      .slice(0, requested)
      .map((state, index) => makeSummary(index, state, this.ctx.props.reviewDisplayName));
    if (mode === "empty") return { _tag: "page", items };
    const page: Record<string, unknown> = { _tag: "page", items };
    const nextCursor = this.ctx.props.nextCursor ?? "string";
    if (nextCursor === "null") page.nextCursor = null;
    if (nextCursor === "string") page.nextCursor = "next-page";
    if (mode === "extra") page.extra = true;
    return page;
  }

  async readBronze(input: BronzeCall): Promise<unknown> {
    accessLog(this.ctx.props).readInputs.push({ ...input });
    const mode = this.ctx.props.bronzeMode ?? "current";
    if (mode === "rpc_failure") throw new Error("fixture Bronze RPC failure");
    if (mode === "not_found") return { _tag: "not_found" };
    if (mode === "failure") return { _tag: "service_not_ready" };
    if (mode === "unknown_tag") return { _tag: "future_failure" };
    if (mode === "malformed") return { _tag: "found", revision: { invalid: true } };

    const document = mode === "historical" ? "# Historical knowledge\n" : "# Current knowledge\n";
    const revisionId = input.revisionId ?? REVISION_ID;
    const revision: Record<string, unknown> = {
      knowledgeId: input.knowledgeId,
      generation: input.generation,
      sourceId: input.sourceId,
      revisionId,
      revisionNumber: 1,
      baseRevisionId: null,
      document,
      contentHash: await hashText(document),
      type: "Source",
      title: mode === "historical" ? "Historical knowledge" : "Current knowledge",
      description: "Fixture Bronze source",
      provenance: {
        sourceKind: "explicit_user_input",
        reference: "fixture",
        capturedAt: NOW,
      },
      committedAt: NOW,
    };
    if (mode === "hash_mismatch") revision.contentHash = "0".repeat(64);
    if (mode === "correlation_mismatch") revision.knowledgeId = OTHER_ID;
    if (mode === "extra") revision.extra = true;
    return { _tag: "found", revision };
  }

  async createKnowledge(input: unknown): Promise<unknown> {
    const log = accessLog(this.ctx.props);
    log.createInputs.push(structuredClone(input));
    if (this.ctx.props.createMode === "throw")
      return Promise.reject(new Error("fixture create failure"));
    if (this.ctx.props.createMode === "throw_once" && log.createInputs.length === 1) {
      // The fixture models a committed Core/Root mutation whose response was lost.
      // Recovery must observe this same operation instead of sending a second create.
      return Promise.reject(new Error("fixture response lost after commit"));
    }
    const buildResult = (): unknown => {
      if (this.ctx.props.createMode === "malformed") return { _tag: "ready", extra: true };
      if (isInvalidInputMode(this.ctx.props.createMode))
        return invalidInputResult(this.ctx.props.createMode);
      if (this.ctx.props.createMode === "dependency_unavailable")
        return { _tag: "dependency_unavailable", dependency: "knowledge-agent" };
      if (this.ctx.props.createMode === "deadline_exceeded")
        return { _tag: "deadline_exceeded" };
      const value = input as { operationId: string; displayName: string };
      const correlationMode = this.ctx.props.createMode;
      return {
        _tag: "ready",
        outcome: "ready",
        operationId: value.operationId,
        knowledge: {
          knowledgeId: "64444444-4444-4444-8444-444444444444",
          generation: 1,
          displayName: correlationMode === "wrong_display" ? "Other Name" : value.displayName,
          role: correlationMode === "initial" ? "initial" : "additional",
          state: correlationMode === "blocked" ? "blocked" : "ready",
          createdAt: NOW,
          updatedAt: NOW,
        },
      };
    };
    if (this.ctx.props.createMode === "delay")
      return new Promise<void>((resolve) => setTimeout(resolve, 5)).then(buildResult);
    return Promise.resolve(buildResult());
  }

  async adoptBronze(input: unknown): Promise<unknown> {
    const log = accessLog(this.ctx.props);
    log.adoptionInputs.push(structuredClone(input));
    const mode = this.ctx.props.adoptionMode ?? "committed";
    if (mode === "throw") throw new Error("fixture Bronze adoption failure");
    if (mode === "throw_once" && log.adoptionInputs.length === 1) {
      throw new Error("fixture response lost after Bronze commit");
    }
    if (mode === "dependency_unavailable")
      return { _tag: "dependency_unavailable", dependency: "knowledge-agent" };
    if (mode === "deadline_exceeded") return { _tag: "deadline_exceeded" };
    if (mode === "malformed") return { _tag: "committed", extra: true };
    const value = input as {
      operationId: string;
      knowledgeId: string;
      generation: 1;
      document: string;
      provenance: { sourceKind: string; reference: string; capturedAt: string };
    };
    const contentHash = await hashText(value.document);
    return {
      _tag: "committed",
      outcome: "committed",
      receipt: {
        receiptId: OTHER_ID,
        knowledgeId: mode === "wrong_identity" ? OTHER_ID : value.knowledgeId,
        generation: value.generation,
        operationId: value.operationId,
        sourceId: SOURCE_ID,
        revisionId: REVISION_ID,
        revisionNumber: 1,
        contentHash,
        committedAt: NOW,
      },
    };
  }

  async readAdoptionOutcome(input: unknown): Promise<unknown> {
    const log = accessLog(this.ctx.props);
    log.adoptionOutcomeInputs.push(structuredClone(input));
    const mode =
      accessLog(this.ctx.props).adoptionOutcomeMode ??
      this.#adoptionOutcomeMode ??
      this.ctx.props.adoptionOutcomeMode ??
      "committed";
    if (mode === "throw") throw new Error("fixture Bronze outcome failure");
    if (mode === "forbidden") return { _tag: "forbidden" };
    if (mode === "unobserved") return { _tag: "unobserved" };
    if (mode === "dependency_unavailable")
      return { _tag: "dependency_unavailable", dependency: "knowledge-agent" };
    if (mode === "deadline_exceeded") return { _tag: "deadline_exceeded" };
    if (mode === "malformed") return { _tag: "committed", extra: true };
    const adoption = log.adoptionInputs[0] as {
      knowledgeId: string;
      generation: 1;
      document: string;
    } | undefined;
    const operationId = (input as { operationId: string }).operationId;
    const contentHash = await hashText(adoption?.document ?? "");
    return {
      _tag: "committed",
      receipt: {
        receiptId: OTHER_ID,
        knowledgeId: mode === "wrong_identity" ? OTHER_ID : adoption?.knowledgeId,
        generation: adoption?.generation ?? 1,
        operationId,
        sourceId: SOURCE_ID,
        revisionId: REVISION_ID,
        revisionNumber: 1,
        contentHash,
        committedAt: NOW,
      },
    };
  }

  async readCreationOutcome(input: unknown): Promise<unknown> {
    const log = accessLog(this.ctx.props);
    log.outcomeInputs.push(structuredClone(input));
    if (this.ctx.props.outcomeMode === "throw") throw new Error("fixture outcome failure");
    if (this.ctx.props.outcomeMode === "failure") return { _tag: "service_not_ready" };
    if (this.ctx.props.outcomeMode === "unobserved") {
      const value = input as { operationId: string };
      return { _tag: "unobserved", operationId: value.operationId };
    }
    if (this.ctx.props.outcomeMode === "dependency_unavailable")
      return { _tag: "dependency_unavailable", dependency: "knowledge-agent" };
    if (this.ctx.props.outcomeMode === "deadline_exceeded") return { _tag: "deadline_exceeded" };
    if (this.ctx.props.outcomeMode === "malformed") return { _tag: "ready", extra: true };
    if (isInvalidInputMode(this.ctx.props.outcomeMode))
      return invalidInputResult(this.ctx.props.outcomeMode);
    const value = input as { operationId: string };
    const correlationMode = this.ctx.props.outcomeMode;
    return {
      _tag: "ready",
      operationId: value.operationId,
      knowledge: {
        knowledgeId: "64444444-4444-4444-8444-444444444444",
        generation: 1,
        displayName: correlationMode === "wrong_display" ? "Other Name" : "Team Notes",
        role: correlationMode === "initial" ? "initial" : "additional",
        state: correlationMode === "blocked" ? "blocked" : "ready",
        createdAt: NOW,
        updatedAt: NOW,
      },
    };
  }

  async readInputLog(): Promise<unknown[]> {
    return accessLog(this.ctx.props).readInputs.map((input) => ({ ...input }));
  }

  async boundInputLog(): Promise<string[]> {
    return [...accessLog(this.ctx.props).boundInputs];
  }

  async createInputLog(): Promise<unknown[]> {
    return accessLog(this.ctx.props).createInputs.map((input) => structuredClone(input));
  }

  async outcomeInputLog(): Promise<unknown[]> {
    return accessLog(this.ctx.props).outcomeInputs.map((input) => structuredClone(input));
  }
  async adoptionInputLog(): Promise<unknown[]> {
    return accessLog(this.ctx.props).adoptionInputs.map((input) => structuredClone(input));
  }

  async adoptionOutcomeInputLog(): Promise<unknown[]> {
    return accessLog(this.ctx.props).adoptionOutcomeInputs.map((input) => structuredClone(input));
  }

  async setAdoptionOutcomeMode(mode: AdoptionOutcomeMode): Promise<void> {
    accessLog(this.ctx.props).adoptionOutcomeMode = mode;
  }

}

class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  readonly observations: ObservationDescription[] = [];
  #calls = 0;
  #disposals = 0;
  readonly submissions: Array<{ action: number; description: unknown }> = [];

  constructor(
    private readonly rejectAt: number | null = null,
    private readonly submitFailure = false,
  ) {
    super();
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.#calls += 1;
    this.observations.push({ ...description });
    if (this.rejectAt !== null && this.#calls === this.rejectAt) {
      throw new Error("fixture observation denied");
    }
  }

  async submitAction(action: number, description: unknown): Promise<void> {
    if (this.submitFailure) throw new Error("fixture submit failure");
    this.submissions.push({ action, description: structuredClone(description) });
  }

  snapshot(): {
    calls: number;
    observations: ObservationDescription[];
    disposals: number;
    submissions: Array<{ action: number; description: unknown }>;
  } {
    return {
      calls: this.#calls,
      observations: this.observations.map((observation) => ({ ...observation })),
      disposals: this.#disposals,
      submissions: this.submissions.map((submission) => ({
        action: submission.action,
        description: structuredClone(submission.description),
      })),
    };
  }

  [Symbol.dispose](): void {
    this.#disposals += 1;
  }
}

export class InspectableCustomGatekeeper extends DurableObject {
  readonly #gatekeeper: CustomGatekeeper;
  readonly #access: FixtureAccessInspector;

  constructor(
    state: ConstructorParameters<typeof CustomGatekeeper>[0],
    env: ConstructorParameters<typeof CustomGatekeeper>[1],
  ) {
    super(state, env);
    this.#gatekeeper = new CustomGatekeeper(state, env);
    this.#access = (state.props as unknown as { access: FixtureAccessInspector }).access;
  }
  async inspectBronzeRow(operationId: string): Promise<Record<string, unknown> | null> {
    const row = this.ctx.storage.sql
      .exec<Record<string, unknown>>(
        "SELECT * FROM custom_gatekeeper_bronze_adoptions WHERE operation_id = ?",
        operationId,
      )
      .toArray()[0];
    return row === undefined ? null : structuredClone(row);
  }

  async tamperBronzeRow(operationId: string, field: BronzeTamperField): Promise<void> {
    const updates: Record<BronzeTamperField, [string, string]> = {
      document: ["document", "# tampered document\n"],
      content_hash: ["content_hash", "0".repeat(64)],
      action_ref: ["action_ref", OTHER_ID],
      fingerprint: ["payload_fingerprint", "f".repeat(64)],
    };
    const update = updates[field];
    if (update === undefined) throw new Error("unknown Bronze tamper field");
    this.ctx.storage.sql.exec(
      "UPDATE custom_gatekeeper_bronze_adoptions SET " + update[0] + " = ? WHERE operation_id = ?",
      update[1],
      operationId,
    );
  }


  async probeActionCollision(): Promise<{
    applyError: string | null;
    rejectError: string | null;
    createRows: number;
    bronzeRows: number;
  }> {
    const operationId = "a4444444-4444-4444-8444-444444444444";
    const bronzeOperationId = "b4444444-4444-4444-8444-444444444444";
    const actionRef = "c4444444-4444-4444-8444-444444444444";
    const bronzeActionRef = "d4444444-4444-4444-8444-444444444444";
    this.ctx.storage.sql.exec(
      "INSERT INTO custom_gatekeeper_staged_actions (local_action_id, operation_id, action_ref, kind, display_name, status, payload_fingerprint, outcome_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      1,
      operationId,
      actionRef,
      "knowledge.create",
      "Collision create",
      "pending_approval",
      "0".repeat(64),
      null,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO custom_gatekeeper_bronze_adoptions (local_action_id, operation_id, action_ref, kind, knowledge_id, generation, display_name, document, content_hash, source_kind, reference, captured_at, status, payload_fingerprint, outcome_json, outcome_observed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      1,
      bronzeOperationId,
      bronzeActionRef,
      "knowledge.bronze.adopt",
      "44444444-4444-4444-8444-444444444444",
      1,
      "Collision Bronze",
      "# collision\n",
      "0".repeat(64),
      "explicit_user_input",
      "collision",
      "2026-01-01T00:00:00.000Z",
      "pending_approval",
      "f".repeat(64),
      null,
      0,
    );
    let applyError: string | null = null;
    let rejectError: string | null = null;
    try {
      await this.#gatekeeper.applyAction(1);
    } catch (cause) {
      applyError = messageOf(cause);
    }
    try {
      await this.#gatekeeper.rejectAction(1);
    } catch (cause) {
      rejectError = messageOf(cause);
    }
    const createRows = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM custom_gatekeeper_staged_actions WHERE local_action_id = 1",
      )
      .one().count;
    const bronzeRows = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM custom_gatekeeper_bronze_adoptions WHERE local_action_id = 1",
      )
      .one().count;
    return { applyError, rejectError, createRows, bronzeRows };
  }

  async startSession(queue: RpcStub<ApprovalQueue>): Promise<FixtureSession> {
    return this.#gatekeeper.startSession(queue) as unknown as FixtureSession;
  }

  async applyAction(actionId: number): Promise<void> {
    return this.#gatekeeper.applyAction(actionId);
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    return this.#gatekeeper.rejectAction(actionId);
  }

  async getAutoApprovableActions(): Promise<unknown> {
    return this.#gatekeeper.getAutoApprovableActions();
  }
  async probeMalformedSession(): Promise<{ duplicateCount: number; error: string | null }> {

    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    let duplicateCount = 0;
    const duplicate = queue.dup.bind(queue);
    Object.defineProperty(queue, "dup", {
      value: () => {
        duplicateCount += 1;
        return duplicate();
      },
    });
    let error: string | null = null;
    try {
      await this.#gatekeeper.startSession(queue);
      error = "unexpected success";
    } catch (cause) {
      error = messageOf(cause);
    } finally {
      queue[Symbol.dispose]();
    }
    return { duplicateCount, error };
  }

  async probeCreateFailureRecovery(): Promise<{
    createInputs: unknown[];
    outcomeInputs: unknown[];
    outcome: unknown | null;
    status: string;
    errors: string[];
  }> {
    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await this.#gatekeeper.startSession(queue);
    const errors: string[] = [];
    let outcome: unknown | null = null;
    let operationId: string | null = null;
    try {
      const proposal = await session.proposeKnowledgeCreate({ displayName: "Team Notes" }) as { operationId: string };
      operationId = proposal.operationId;
      const submission = target.submissions[0];
      if (submission === undefined) throw new Error("missing native submission");
      try {
        await this.#gatekeeper.applyAction(submission.action);
      } catch (cause) {
        errors.push(messageOf(cause));
      }
      try {
        await this.#gatekeeper.applyAction(submission.action);
      } catch (cause) {
        errors.push(messageOf(cause));
      }
      try {
        outcome = await session.readCreationOutcome({ operationId });
      } catch (cause) {
        errors.push(messageOf(cause));
      }
      const row = this.ctx.storage.sql
        .exec<{ status: string }>(
          "SELECT status FROM custom_gatekeeper_staged_actions WHERE operation_id = ?",
          operationId,
        )
        .one();
      return {
        createInputs: await this.#access.createInputLog(),
        outcomeInputs: await this.#access.outcomeInputLog(),
        outcome,
        status: row.status,
        errors,
      };
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
  }

  async probeAccessResolutionFailureRecovery(): Promise<{
    createInputs: unknown[];
    outcomeInputs: unknown[];
    outcome: unknown | null;
    status: string;
    errors: string[];
  }> {
    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await this.#gatekeeper.startSession(queue);
    const errors: string[] = [];
    let outcome: unknown | null = null;
    let operationId: string | null = null;
    try {
      const proposal = await session.proposeKnowledgeCreate({ displayName: "Team Notes" }) as { operationId: string };
      operationId = proposal.operationId;
      const submission = target.submissions[0];
      if (submission === undefined) throw new Error("missing native submission");
      const props = this.ctx.props as unknown as { access?: unknown };
      const access = props.access;
      props.access = undefined;
      try {
        await this.#gatekeeper.applyAction(submission.action);
      } catch (cause) {
        errors.push(messageOf(cause));
      } finally {
        props.access = access;
      }
      try {
        await this.#gatekeeper.applyAction(submission.action);
      } catch (cause) {
        errors.push(messageOf(cause));
      }
      outcome = await session.readCreationOutcome({ operationId });
      const row = this.ctx.storage.sql
        .exec<{ status: string }>(
          "SELECT status FROM custom_gatekeeper_staged_actions WHERE operation_id = ?",
          operationId,
        )
        .one();
      return {
        createInputs: await this.#access.createInputLog(),
        outcomeInputs: await this.#access.outcomeInputLog(),
        outcome,
        status: row.status,
        errors,
      };
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
  }

  async probeBronzeAccessResolutionFailure(): Promise<{
    adoptionInputs: unknown[];
    adoptionOutcomeInputs: unknown[];
    outcome: unknown | null;
    bronzeRow: Record<string, unknown> | null;
    errors: string[];
  }> {
    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await this.#gatekeeper.startSession(queue);
    const errors: string[] = [];
    let outcome: unknown | null = null;
    let bronzeRow: Record<string, unknown> | null = null;
    let operationId: string | null = null;
    try {
      const page = await session.list({ limit: 1 });
      const handle = page.items[0]?.access;
      if (handle === undefined) throw new Error("missing native Bronze handle");
      const proposal = await handle.proposeBronzeAdoption({
        document: "# Exact concept\n",
        provenance: {
          sourceKind: "explicit_user_input",
          reference: "s16-sync-fixture",
          capturedAt: NOW,
        },
      }) as { operationId: string };
      operationId = proposal.operationId;
      const submission = target.submissions[0];
      if (submission === undefined) throw new Error("missing native Bronze submission");
      const props = this.ctx.props as unknown as { access?: unknown };
      const access = props.access;
      props.access = undefined;
      try {
        await this.#gatekeeper.applyAction(submission.action);
      } catch (cause) {
        errors.push(messageOf(cause));
      } finally {
        props.access = access;
      }
      try {
        await this.#gatekeeper.applyAction(submission.action);
      } catch (cause) {
        errors.push(messageOf(cause));
      }
      outcome = await handle.readAdoptionOutcome({ operationId });
      const row = this.ctx.storage.sql
        .exec<Record<string, unknown>>(
          "SELECT * FROM custom_gatekeeper_bronze_adoptions WHERE operation_id = ?",
          operationId,
        )
        .toArray()[0];
      bronzeRow = row === undefined ? null : structuredClone(row);
      return {
        adoptionInputs: await this.#access.adoptionInputLog(),
        adoptionOutcomeInputs: await this.#access.adoptionOutcomeInputLog(),
        outcome,
        bronzeRow,
        errors,
      };
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
  }

  async probeStoredOutcomeUnknown(): Promise<{ observations: number; error: string | null }> {
    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await this.#gatekeeper.startSession(queue);
    let error: string | null = null;
    try {
      const proposal = await session.proposeKnowledgeCreate({ displayName: "Team Notes" }) as { operationId: string };
      const stored = JSON.stringify({
        operationId: proposal.operationId,
        status: "failed",
        reason: "outcome_unknown",
      });
      this.ctx.storage.sql.exec(
        "UPDATE custom_gatekeeper_staged_actions SET status = 'failed', outcome_json = ? WHERE operation_id = ?",
        stored,
        proposal.operationId,
      );
      try {
        await session.readCreationOutcome({ operationId: proposal.operationId });
        error = "unexpected success";
      } catch (cause) {
        error = messageOf(cause);
      }
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
    return { observations: target.snapshot().observations.length, error };
  }

  async probeApplyRejectRace(): Promise<{ createInputs: unknown[]; errors: string[] }> {
    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await this.#gatekeeper.startSession(queue);
    const errors: string[] = [];
    try {
      await session.proposeKnowledgeCreate({ displayName: "Team Notes" });
      const submission = target.submissions[0];
      if (submission === undefined) throw new Error("missing native submission");
      const applying = this.#gatekeeper.applyAction(submission.action);
      const rejecting = this.#gatekeeper.rejectAction(submission.action);
      const results = await Promise.allSettled([applying, rejecting]);
      for (const result of results) {
        if (result.status === "rejected") errors.push(messageOf(result.reason));
      }
      return { createInputs: await this.#access.createInputLog(), errors };
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
  }


  async probeResponseLoss(): Promise<{
    createInputs: unknown[];
    outcomeInputs: unknown[];
    status: string;
    errors: string[];
  }> {
    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await this.#gatekeeper.startSession(queue);
    const errors: string[] = [];
    try {
      const proposal = await session.proposeKnowledgeCreate({ displayName: "Team Notes" }) as { operationId: string };
      const submission = target.submissions[0];
      if (submission === undefined) throw new Error("missing native submission");
      try {
        await this.#gatekeeper.applyAction(submission.action);
      } catch (cause) {
        errors.push(messageOf(cause));
      }
      try {
        await this.#gatekeeper.applyAction(submission.action);
      } catch (cause) {
        errors.push(messageOf(cause));
      }
      const row = this.ctx.storage.sql
        .exec<{ status: string }>(
          "SELECT status FROM custom_gatekeeper_staged_actions WHERE operation_id = ?",
          proposal.operationId,
        )
        .one();
      return {
        createInputs: await this.#access.createInputLog(),
        outcomeInputs: await this.#access.outcomeInputLog(),
        status: row.status,
        errors,
      };
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
  }


  async probeActionRefFingerprintMismatch(): Promise<{ observations: number; error: string | null }> {
    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await this.#gatekeeper.startSession(queue);
    let error: string | null = null;
    try {
      const proposal = await session.proposeKnowledgeCreate({ displayName: "Team Notes" }) as { operationId: string };
      this.ctx.storage.sql.exec(
        "UPDATE custom_gatekeeper_staged_actions SET action_ref = ? WHERE operation_id = ?",
        "54444444-4444-4444-8444-444444444444",
        proposal.operationId,
      );
      try {
        await session.readCreationOutcome({ operationId: proposal.operationId });
        error = "unexpected success";
      } catch (cause) {
        error = messageOf(cause);
      }
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
    return { observations: target.snapshot().observations.length, error };
  }

}

class TestObservationAuthorizer extends RpcTarget implements ObservationAuthorizer {
  readonly observations: ObservationDescription[] = [];

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push({ ...description });
  }
}

class TestVerifier extends RpcTarget {}

export class TestGatekeeperFactory extends DurableObject {
  #exports(): WorkerExports {
    return this.ctx.exports as unknown as WorkerExports;
  }

  #newBinding(props: FixtureAccessProps): {
    gatekeeper: FixtureGatekeeper;
    access: FixtureAccessInspector;
  } {
    const workerExports = this.#exports();
    const accessProps = { ...props, token: crypto.randomUUID() };
    const access = workerExports.TestKnowledgeAccess({ props: accessProps });
    const gatekeeperClass = workerExports.CustomGatekeeper({ props: { access } });
    const facetName = "fixture-knowledge-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    })) as unknown as FixtureGatekeeper;
    return {
      gatekeeper,
      access: access as FixtureAccessInspector,
    };
  }

  async runMalformedSession(): Promise<{ duplicateCount: number; error: string | null }> {
    const workerExports = this.#exports();
    const access = workerExports.TestKnowledgeAccess({
      props: { managerId: MANAGER_ID, token: crypto.randomUUID() },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({
      props: { access, unexpected: true } as unknown as { access: unknown },
    });
    const facetName = "fixture-malformed-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    })) as unknown as FixtureGatekeeperProbe;
    return gatekeeper.probeMalformedSession();
  }

  async runStoredOutcomeUnknown(): Promise<{ observations: number; error: string | null }> {
    const workerExports = this.#exports();
    const access = workerExports.TestKnowledgeAccess({
      props: { managerId: MANAGER_ID, token: crypto.randomUUID() },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({ props: { access } });
    const facetName = "fixture-stored-outcome-unknown-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    })) as unknown as FixtureGatekeeperProbe;
    return gatekeeper.probeStoredOutcomeUnknown();
  }

  async runRead(options: {
    listMode?: ListMode;
    bronzeMode?: BronzeMode;
    states?: KnowledgeState[];
    nextCursor?: NextCursorMode;
    listOptions?: { cursor?: string; limit?: number };
    rejectObservationAt?: number | null;
  } = {}): Promise<{
    page: Array<Record<string, unknown>> | null;
    nextCursor: string | null;
    read: unknown;
    error: string | null;
    observations: ObservationDescription[];
    readInputs: unknown[];
    queueDisposals: number;
  }> {
    const props: FixtureAccessProps = {
      managerId: MANAGER_ID,
      listMode: options.listMode,
      bronzeMode: options.bronzeMode,
      states: options.states,
      nextCursor: options.nextCursor,
    };
    const { gatekeeper, access } = this.#newBinding(props);
    const target = new TestApprovalQueue(options.rejectObservationAt ?? null);
    const queue = new RpcStub<ApprovalQueue>(target);
    let page: Array<Record<string, unknown>> | null = null;
    let nextCursor: string | null = null;
    let read: unknown = null;
    let error: string | null = null;
    const session = await gatekeeper.startSession(queue);
    try {
      const result = await session.list(options.listOptions);
      nextCursor = result.nextCursor ?? null;
      page = result.items.map((item) => {
        const summary: Record<string, unknown> = { ...item };
        delete summary.access;
        summary.hasAccess = item.access !== undefined;
        return summary;
      });
      const ready = result.items.find((item) => item.access !== undefined);
      if (ready?.access !== undefined) {
        try {
          read = await ready.access.readBronze({ sourceId: SOURCE_ID });
        } catch (cause) {
          error = messageOf(cause);
        }
      }
    } catch (cause) {
      error = messageOf(cause);
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
    return {
      page,
      nextCursor,
      read,
      error,
      observations: target.observations.map((observation) => ({ ...observation })),
      readInputs: await access.readInputLog(),
      queueDisposals: target.snapshot().disposals,
    };
  }

  async runProposal(options: {
    input?: unknown;
    createMode?: "ready" | "malformed" | "throw" | "throw_once" | "delay" | "initial" | "blocked" | "wrong_display";
    outcomeMode?: "ready" | "malformed" | "throw" | "failure" | "initial" | "blocked" | "wrong_display";
    submitFailure?: boolean;
    decision?: "none" | "approve" | "retry" | "reject";
  } = {}): Promise<{
    proposal: unknown | null;
    outcome: unknown | null;
    error: string | null;
    submissions: Array<{ action: number; description: unknown }>;
    createInputs: unknown[];
    outcomeInputs: unknown[];
    observations: ObservationDescription[];
    queueDisposals: number;
    autoApprovable: unknown;
  }> {
    const { gatekeeper, access } = this.#newBinding({
      managerId: MANAGER_ID,
      createMode: options.createMode,
      outcomeMode: options.outcomeMode,
    });
    const target = new TestApprovalQueue(null, options.submitFailure ?? false);
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await gatekeeper.startSession(queue);
    let proposal: unknown | null = null;
    let outcome: unknown | null = null;
    let error: string | null = null;
    try {
      proposal = await session.proposeKnowledgeCreate(options.input ?? { displayName: "Team Notes" });
      const submission = target.submissions[0];
      if (submission && options.decision === "approve") await gatekeeper.applyAction(submission.action);
      if (submission && options.decision === "retry") {
        try { await gatekeeper.applyAction(submission.action); } catch { /* response-loss fixture */ }
        await gatekeeper.applyAction(submission.action);
      }
      if (submission && options.decision === "reject") await gatekeeper.rejectAction(submission.action);
      if (proposal && typeof proposal === "object" && "operationId" in proposal) {
        outcome = await session.readCreationOutcome({ operationId: (proposal as { operationId: string }).operationId });
      }
    } catch (cause) {
      error = messageOf(cause);
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
    const snapshot = target.snapshot();
    return {
      proposal,
      outcome,
      error,
      submissions: snapshot.submissions,
      createInputs: await access.createInputLog(),
      outcomeInputs: await access.outcomeInputLog(),
      observations: snapshot.observations,
      queueDisposals: snapshot.disposals,
      autoApprovable: await gatekeeper.getAutoApprovableActions(),
    };
  }

  async runBronzeProposal(options: {
    document?: string;
    provenance?: {
      sourceKind: "conversation" | "user_document" | "explicit_user_input";
      reference: string;
      capturedAt: string;
    };
    adoptionMode?: AdoptionMode;
    outcomeMode?: AdoptionOutcomeMode;
    secondOutcomeMode?: AdoptionOutcomeMode;
    readOutcomeTwice?: boolean;
    decision?: "none" | "approve" | "retry" | "reject";
    wrongHandle?: boolean;
    displayName?: string;
    submitFailure?: boolean;
    tamper?: BronzeTamperField;
  } = {}): Promise<{
    proposal: unknown | null;
    outcome: unknown | null;
    error: string | null;
    submissions: Array<{ action: number; description: unknown }>;
    adoptionInputs: unknown[];
    adoptionOutcomeInputs: unknown[];
    observations: ObservationDescription[];
    bronzeRow: Record<string, unknown> | null;
    queueDisposals: number;
  }> {
    const workerExports = this.#exports();
    const access = workerExports.TestKnowledgeAccess({
      props: {
        managerId: MANAGER_ID,
        states: options.wrongHandle ? ["ready", "ready"] : ["ready"],
        adoptionMode: options.adoptionMode,
        adoptionOutcomeMode: options.outcomeMode,
        reviewDisplayName: options.displayName,
        token: crypto.randomUUID(),
      },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({ props: { access } });
    const facetName = "fixture-s16-bronze-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    })) as unknown as FixtureGatekeeper;
    const target = new TestApprovalQueue(null, options.submitFailure ?? false);
    const queue = new RpcStub<ApprovalQueue>(target);
    const defaultDocument = "# Exact concept\n\n~~~\nnot a fence escape\n~~~~~\n";
    const defaultProvenance = {
      sourceKind: "explicit_user_input" as const,
      reference: "s16-fixture",
      capturedAt: NOW,
    };
    let proposal: unknown | null = null;
    let outcome: unknown | null = null;
    let error: string | null = null;
    let operationId: string | null = null;
    try {
      const session = await gatekeeper.startSession(queue);
      try {
        const page = await session.list({ limit: options.wrongHandle ? 2 : 1 });
        const proposalHandle = page.items[0]?.access;
        const outcomeHandle = options.wrongHandle ? page.items[1]?.access : proposalHandle;
        if (proposalHandle === undefined || outcomeHandle === undefined) {
          throw new Error("missing ready Knowledge fixture handle");
        }
        proposal = await proposalHandle.proposeBronzeAdoption({
          document: options.document ?? defaultDocument,
          provenance: options.provenance ?? defaultProvenance,
        });
        if (isRecord(proposal) && typeof proposal.operationId === "string") {
          operationId = proposal.operationId;
        }
        const submission = target.submissions[0];
        if (submission !== undefined && operationId !== null && options.tamper !== undefined) {
          try {
            await gatekeeper.tamperBronzeRow(operationId, options.tamper);
          } catch (cause) {
            error = messageOf(cause);
          }
        }
        if (submission !== undefined && options.decision === "approve") {
          try {
            await gatekeeper.applyAction(submission.action);
          } catch (cause) {
            error = messageOf(cause);
          }
        }
        if (submission !== undefined && options.decision === "retry") {
          try {
            await gatekeeper.applyAction(submission.action);
          } catch {
            // Response-loss fixture: the second callback must only read the same operation.
          }
          try {
            await gatekeeper.applyAction(submission.action);
          } catch (cause) {
            error = messageOf(cause);
          }
        }
        if (submission !== undefined && options.decision === "reject") {
          await gatekeeper.rejectAction(submission.action);
        }
        if (
          options.decision !== "reject" &&
          operationId !== null
        ) {
          try {
            outcome = await outcomeHandle.readAdoptionOutcome({ operationId });
          } catch (cause) {
            error ??= messageOf(cause);
          }
          if (options.secondOutcomeMode !== undefined) {
            await (access as unknown as {
              setAdoptionOutcomeMode(mode: AdoptionOutcomeMode): Promise<void>;
            }).setAdoptionOutcomeMode(options.secondOutcomeMode);
          }
          if (options.readOutcomeTwice || options.secondOutcomeMode !== undefined) {
            try {
              await outcomeHandle.readAdoptionOutcome({ operationId });
            } catch (cause) {
              error ??= messageOf(cause);
            }
          }
        }
      } finally {
        session[Symbol.dispose]();
      }
    } catch (cause) {
      error = messageOf(cause);
    } finally {
      queue[Symbol.dispose]();
    }
    let bronzeRow: Record<string, unknown> | null = null;
    if (operationId !== null) {
      try {
        bronzeRow = await gatekeeper.inspectBronzeRow(operationId);
      } catch (cause) {
        error ??= messageOf(cause);
      }
    }
    const snapshot = target.snapshot();
    return {
      proposal,
      outcome,
      error,
      submissions: snapshot.submissions,
      adoptionInputs: await access.adoptionInputLog(),
      adoptionOutcomeInputs: await access.adoptionOutcomeInputLog(),
      observations: snapshot.observations,
      bronzeRow,
      queueDisposals: snapshot.disposals,
    };
  }

  async runBronzeSynchronousAccessFailureRecovery(): Promise<{
    adoptionInputs: unknown[];
    adoptionOutcomeInputs: unknown[];
    outcome: unknown | null;
    bronzeRow: Record<string, unknown> | null;
    errors: string[];
  }> {
    const workerExports = this.#exports();
    const access = workerExports.TestKnowledgeAccess({
      props: { managerId: MANAGER_ID, token: crypto.randomUUID() },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({ props: { access } });
    const facetName = "fixture-s16-access-failure-recovery-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    })) as unknown as FixtureGatekeeperProbe;
    return gatekeeper.probeBronzeAccessResolutionFailure();
  }

  async runCombinedCapacityAdoptionThenCreate(): Promise<{
    adoptionSuccesses: number;
    adoptionFailures: number;
    createError: string | null;
    submissions: number;
  }> {
    const workerExports = this.#exports();
    const access = workerExports.TestKnowledgeAccess({
      props: {
        managerId: MANAGER_ID,
        states: ["ready"],
        token: crypto.randomUUID(),
      },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({ props: { access } });
    const facetName = "fixture-s16-combined-capacity-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    })) as unknown as FixtureGatekeeper;
    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await gatekeeper.startSession(queue);
    try {
      const page = await session.list({ limit: 1 });
      const handle = page.items[0]?.access;
      if (handle === undefined) throw new Error("missing native Bronze handle");
      const results = await Promise.allSettled(
        Array.from({ length: 64 }, (_, index) =>
          handle.proposeBronzeAdoption({
            document: "# Combined " + index + "\n",
            provenance: {
              sourceKind: "explicit_user_input",
              reference: "s16-combined-" + index,
              capturedAt: NOW,
            },
          }),
        ),
      );
      let createError: string | null = null;
      try {
        await session.proposeKnowledgeCreate({ displayName: "Blocked create" });
      } catch (cause) {
        createError = messageOf(cause);
      }
      return {
        adoptionSuccesses: results.filter((result) => result.status === "fulfilled").length,
        adoptionFailures: results.filter((result) => result.status === "rejected").length,
        createError,
        submissions: target.snapshot().submissions.length,
      };
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
  }

  async probeActionCollision(): Promise<{
    applyError: string | null;
    rejectError: string | null;
    createRows: number;
    bronzeRows: number;
  }> {
    const workerExports = this.#exports();
    const access = workerExports.TestKnowledgeAccess({
      props: { managerId: MANAGER_ID, token: crypto.randomUUID() },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({ props: { access } });
    const facetName = "fixture-s16-action-collision-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    })) as unknown as FixtureGatekeeper;
    return gatekeeper.probeActionCollision();
  }

  async runConcurrentBronzeProposals(count: number): Promise<{
    successes: number;
    capacityFailures: number;
    submissions: number;
    adoptionInputs: unknown[];
  }> {
    const workerExports = this.#exports();
    const access = workerExports.TestKnowledgeAccess({
      props: {
        managerId: MANAGER_ID,
        states: ["ready"],
        token: crypto.randomUUID(),
      },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({ props: { access } });
    const facetName = "fixture-s16-capacity-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    })) as unknown as FixtureGatekeeper;
    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await gatekeeper.startSession(queue);
    try {
      const page = await session.list({ limit: 1 });
      const handle = page.items[0]?.access;
      if (handle === undefined) throw new Error("missing native Bronze handle");
      const results = await Promise.allSettled(
        Array.from({ length: count }, (_, index) =>
          handle.proposeBronzeAdoption({
            document: "# Concurrent " + index + "\n",
            provenance: {
              sourceKind: "explicit_user_input",
              reference: "s16-capacity-" + index,
              capturedAt: NOW,
            },
          }),
        ),
      );
      return {
        successes: results.filter((result) => result.status === "fulfilled").length,
        capacityFailures: results.filter(
          (result) =>
            result.status === "rejected" &&
            messageOf(result.reason).includes("capacity_exceeded"),
        ).length,
        submissions: target.snapshot().submissions.length,
        adoptionInputs: await access.adoptionInputLog(),
      };
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
  }

  async runInvalidCreate(mode: InvalidInputMode): Promise<{
    error: string | null;
    outcome: unknown | null;
    createInputs: unknown[];
  }> {
    const { gatekeeper, access } = this.#newBinding({
      managerId: MANAGER_ID,
      createMode: mode,
    });
    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await gatekeeper.startSession(queue);
    let error: string | null = null;
    let outcome: unknown | null = null;
    try {
      const proposal = await session.proposeKnowledgeCreate({ displayName: "Team Notes" }) as { operationId: string };
      const submission = target.submissions[0];
      if (submission === undefined) throw new Error("missing native submission");
      try {
        await gatekeeper.applyAction(submission.action);
      } catch (cause) {
        error = messageOf(cause);
      }
      try {
        outcome = await session.readCreationOutcome({ operationId: proposal.operationId });
      } catch (cause) {
        error ??= messageOf(cause);
      }
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
    return {
      error,
      outcome,
      createInputs: await access.createInputLog(),
    };
  }

  async runConcurrentProposals(count: number): Promise<{
    successes: number;
    capacityFailures: number;
    submissions: number;
  }> {
    const { gatekeeper } = this.#newBinding({ managerId: MANAGER_ID });
    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await gatekeeper.startSession(queue);
    try {
      const results = await Promise.allSettled(
        Array.from({ length: count }, (_, index) =>
          session.proposeKnowledgeCreate({ displayName: `Concurrent ${index}` }),
        ),
      );
      return {
        successes: results.filter((result) => result.status === "fulfilled").length,
        capacityFailures: results.filter(
          (result) => result.status === "rejected" && messageOf(result.reason).includes("capacity_exceeded"),
        ).length,
        submissions: target.snapshot().submissions.length,
      };
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
  }

  async runConcurrentApply(): Promise<{
    createInputs: unknown[];
    outcomeInputs: unknown[];
    errors: string[];
  }> {
    const { gatekeeper, access } = this.#newBinding({
      managerId: MANAGER_ID,
      createMode: "delay",
    });
    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await gatekeeper.startSession(queue);
    const errors: string[] = [];
    try {
      await session.proposeKnowledgeCreate({ displayName: "Team Notes" });
      const submission = target.submissions[0];
      if (submission === undefined) throw new Error("missing native submission");
      const results = await Promise.allSettled([
        gatekeeper.applyAction(submission.action),
        gatekeeper.applyAction(submission.action),
      ]);
      for (const result of results) {
        if (result.status === "rejected") errors.push(messageOf(result.reason));
      }
      return {
        createInputs: await access.createInputLog(),
        outcomeInputs: await access.outcomeInputLog(),
        errors,
      };
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
  }

  async runApplyRejectRace(): Promise<{ createInputs: unknown[]; errors: string[] }> {
    const workerExports = this.#exports();
    const access = workerExports.TestKnowledgeAccess({
      props: { managerId: MANAGER_ID, token: crypto.randomUUID() },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({ props: { access } });
    const facetName = "fixture-apply-reject-race-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    })) as unknown as FixtureGatekeeperProbe;
    return gatekeeper.probeApplyRejectRace();
  }

  async runResponseLoss(): Promise<{
    createInputs: unknown[];
    outcomeInputs: unknown[];
    status: string;
    errors: string[];
  }> {
    const workerExports = this.#exports();
    const access = workerExports.TestKnowledgeAccess({
      props: { managerId: MANAGER_ID, createMode: "throw_once", token: crypto.randomUUID() },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({ props: { access } });
    const facetName = "fixture-response-loss-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    })) as unknown as FixtureGatekeeperProbe;
    return gatekeeper.probeResponseLoss();
  }

  async runCreateFailureRecovery(
    createMode: CreateMode,
    outcomeMode: OutcomeMode,
  ): Promise<{
    createInputs: unknown[];
    outcomeInputs: unknown[];
    outcome: unknown | null;
    status: string;
    errors: string[];
  }> {
    const workerExports = this.#exports();
    const access = workerExports.TestKnowledgeAccess({
      props: {
        managerId: MANAGER_ID,
        createMode,
        outcomeMode,
        token: crypto.randomUUID(),
      },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({ props: { access } });
    const facetName = "fixture-create-failure-recovery-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    })) as unknown as FixtureGatekeeperProbe;
    return gatekeeper.probeCreateFailureRecovery();
  }

  async runSynchronousCreateFailureRecovery(): Promise<{
    createInputs: unknown[];
    outcomeInputs: unknown[];
    outcome: unknown | null;
    status: string;
    errors: string[];
  }> {
    const workerExports = this.#exports();
    const access = workerExports.TestKnowledgeAccess({
      props: { managerId: MANAGER_ID, token: crypto.randomUUID() },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({ props: { access } });
    const facetName = "fixture-access-failure-recovery-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    })) as unknown as FixtureGatekeeperProbe;
    return gatekeeper.probeAccessResolutionFailureRecovery();
  }

  async runActionRefFingerprintMismatch(): Promise<{ observations: number; error: string | null }> {
    const workerExports = this.#exports();
    const access = workerExports.TestKnowledgeAccess({
      props: { managerId: MANAGER_ID, token: crypto.randomUUID() },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({ props: { access } });
    const facetName = "fixture-action-ref-fingerprint-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    })) as unknown as FixtureGatekeeperProbe;
    return gatekeeper.probeActionRefFingerprintMismatch();
  }

  async runOutcomeFailureRecovery(
    outcomeMode: "failure" | InvalidInputMode = "failure",
  ): Promise<{
    createInputs: unknown[];
    outcomeInputs: unknown[];
    outcome: unknown | null;
    errors: string[];
  }> {
    const { gatekeeper, access } = this.#newBinding({
      managerId: MANAGER_ID,
      createMode: "throw_once",
      outcomeMode,
    });
    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await gatekeeper.startSession(queue);
    const errors: string[] = [];
    let outcome: unknown | null = null;
    try {
      const proposal = await session.proposeKnowledgeCreate({ displayName: "Team Notes" }) as { operationId: string };
      const submission = target.submissions[0];
      if (submission === undefined) throw new Error("missing native submission");
      for (let i = 0; i < 2; i += 1) {
        try {
          await gatekeeper.applyAction(submission.action);
        } catch (cause) {
          errors.push(messageOf(cause));
        }
      }
      outcome = await session.readCreationOutcome({ operationId: proposal.operationId });
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
    return {
      createInputs: await access.createInputLog(),
      outcomeInputs: await access.outcomeInputLog(),
      outcome,
      errors,
    };
  }

  async runAccount(managerId = MANAGER_ID): Promise<{
    description: AccountDescription;
    binding: "legacy" | "bound";
    page: Array<Record<string, unknown>>;
    observations: ObservationDescription[];
    boundInputs: string[];
  }> {
    const workerExports = this.#exports();
    const access = workerExports.TestKnowledgeAccess({
      props: { managerId, token: crypto.randomUUID() },
    });
    const vendor = workerExports.GatekeeperVendor({});
    const account = await vendor.createManagerAccount(managerId, access);
    const description = await account.describe();
    const binding = await account.inspectManagerBinding(managerId);
    const gatekeeperClass = await account.getSingletonGatekeeperClass();
    const facetName = "fixture-account-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    })) as unknown as FixtureGatekeeper;
    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await gatekeeper.startSession(queue);
    let page: Array<Record<string, unknown>> = [];
    try {
      const result = await session.list({});
      page = result.items.map((item) => {
        const summary: Record<string, unknown> = { ...item };
        delete summary.access;
        summary.hasAccess = item.access !== undefined;
        return summary;
      });
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
    const inspector = access as unknown as FixtureAccessInspector;
    return {
      description,
      binding,
      page,
      observations: target.observations.map((observation) => ({ ...observation })),
      boundInputs: await inspector.boundInputLog(),
    };
  }

  async runAccountError(options: {
    requestedManagerId?: string;
    capabilityManagerId?: string;
    assertMode?: AssertMode;
    extraProps?: boolean;
  } = {}): Promise<string | null> {
    const workerExports = this.#exports();
    const access = workerExports.TestKnowledgeAccess({
      props: {
        managerId: options.capabilityManagerId ?? MANAGER_ID,
        assertMode: options.assertMode,
      },
    });
    const capability = options.extraProps
      ? { access, unexpected: true }
      : access;
    try {
      if (options.extraProps) {
        const account = workerExports.CustomAccount({ props: capability });
        await account.inspectManagerBinding(MANAGER_ID);
        return null;
      }
      const vendor = workerExports.GatekeeperVendor({});
      const account = await vendor.createManagerAccount(
        options.requestedManagerId ?? MANAGER_ID,
        capability,
      );
      if (options.extraProps) await account.inspectManagerBinding(MANAGER_ID);
      return null;
    } catch (cause) {
      return messageOf(cause);
    }
  }

  async runLegacyAccount(): Promise<{ binding: string | null; error: string | null }> {
    const account = this.#exports().CustomAccount({ props: undefined });
    try {
      return { binding: await account.inspectManagerBinding(MANAGER_ID), error: null };
    } catch (cause) {
      return { binding: null, error: messageOf(cause) };
    }
  }

  async runCatalog(limit: number): Promise<{
    catalog: AgentCatalog;
    observations: ObservationDescription[];
  }> {
    const { gatekeeper } = this.#newBinding({ managerId: MANAGER_ID });
    const target = new TestObservationAuthorizer();
    const authorizer = new RpcStub<ObservationAuthorizer>(target);
    try {
      return {
        catalog: await gatekeeper.getAgentCatalog({ limit }, authorizer),
        observations: target.observations.map((observation) => ({ ...observation })),
      };
    } finally {
      authorizer[Symbol.dispose]();
    }
  }

  async runObserverRejection(): Promise<string | null> {
    const { gatekeeper } = this.#newBinding({ managerId: MANAGER_ID });
    const verifier = new RpcStub(new TestVerifier());
    try {
      await gatekeeper.addObserver("observer", verifier);
      return null;
    } catch (cause) {
      return messageOf(cause);
    } finally {
      verifier[Symbol.dispose]();
    }
  }
}
