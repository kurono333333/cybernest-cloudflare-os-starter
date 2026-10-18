import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  AccountDescription,
  AgentCatalog,
  ApprovalQueue,
  ObservationAuthorizer,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { CustomGatekeeper, KnowledgeSession } from "../src/custom.js";
import type { GatekeeperClient, Overseer } from "@gadgets/workshop-shared/api";
import type { RpcStub as CapnwebRpcStub } from "capnweb";

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
type ListMode = "valid" | "empty" | "failure" | "malformed" | "extra" | "rpc_failure";
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
  d04ReaderMode?: boolean;
  d04ArticleRead?: boolean;
  receiptSchedule?: "stable" | "renewal_during_observation";
  createMode?: CreateMode;
  outcomeMode?: OutcomeMode;
  states?: KnowledgeState[];
  listMode?: ListMode;
  bronzeMode?: BronzeMode;
  nextCursor?: NextCursorMode;
  assertMode?: AssertMode;
  bindDelayMs?: number;
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

type D04ListInput = { offset: number; limit: number };
type D04SearchInput =
  | { query: string; offset: number; limit: number }
  | {
      kind: "articles";
      filters?: { type?: string; title?: string; description?: string; tag?: string };
      cursor?: string;
      limit: number;
    }
  | {
      kind: "article-links";
      articleId: string;
      direction: "links" | "backlinks";
      maxDepth: number;
      candidateBudget: number;
    };
type D04ReadInput = { path: string };
type D04ReaderResult = {
  list: {
    bundleId: string;
    versionId: string;
    items: Array<{ path: string }>;
  };
  search: {
    bundleId: string;
    versionId: string;
    hits: Array<{ path: string; line: number; snippet: string }>;
  };
  read: {
    bundleId: string;
    versionId: string;
    path: string;
    sourceMarkdown: string;
    metadata: Record<string, unknown>;
  };
};
type D04ArticleReadResult = {
  kind: "article";
  articleId: string;
  revisionId: string;
  bodyHash: string;
  path: string;
  sourceMarkdown: string;
  metadata: Record<string, unknown>;
};
const D04_BUNDLE_ID = "a".repeat(64);
const D04_VERSION_ID = "94444444-4444-4444-8444-444444444444";
const D04_READER_RESULT: D04ReaderResult = {
  list: {
    bundleId: D04_BUNDLE_ID,
    versionId: D04_VERSION_ID,
    items: [{ path: "index.md" }],
  },
  search: {
    bundleId: D04_BUNDLE_ID,
    versionId: D04_VERSION_ID,
    hits: [{ path: "index.md", line: 1, snippet: "Private Knowledge fixture." }],
  },
  read: {
    bundleId: D04_BUNDLE_ID,
    versionId: D04_VERSION_ID,
    path: "index.md",
    sourceMarkdown: "# Private Knowledge fixture\n",
    metadata: { type: "Concept" },
  },
};
const D04_ARTICLE_READ_RESULT: D04ArticleReadResult = {
  kind: "article",
  articleId: "a",
  revisionId: "silver-revision-7",
  bodyHash: "b".repeat(64),
  path: "articles/YQ.md",
  sourceMarkdown: "# Private Knowledge article\n",
  metadata: { type: "Concept" },
};
const D04_SILVER_COVERAGE = {
  metadata: { status: "complete", reasons: [] },
  internalLinks: { status: "complete", reasons: [] },
  sources: { status: "complete", reasons: [] },
} as const;
const D04_SILVER_ITEM = {
  articleId: "a",
  currentRevisionId: "r",
  usePolicy: "included",
  currentPath: "articles/YQ.md",
  exactRevisionPath: "articles/YQ/revisions/cg.md",
  bodyHash: "b".repeat(64),
  state: "indexed",
  projection: {
    articleId: "a",
    inputRevisionId: "r",
    projectionRuleVersion: "silver-v1",
    processedVersion: "c".repeat(64),
    relationVersion: "d".repeat(64),
    metadata: { type: "Source", title: "Article A" },
    literalLinks: [],
    backlinks: [],
    sources: [],
    coverage: D04_SILVER_COVERAGE,
  },
  coverage: D04_SILVER_COVERAGE,
} as const;
const D04_ARTICLES_SEARCH_RESULT = {
  kind: "articles",
  items: [D04_SILVER_ITEM],
  nextCursor: "a",
  coverage: D04_SILVER_COVERAGE,
};
const D04_ARTICLE_LINKS_SEARCH_RESULT = {
  kind: "article-links",
  items: [{ depth: 0, item: D04_SILVER_ITEM }],
  coverage: D04_SILVER_COVERAGE,
};
const d04SuccessReceipt = <A>(value: A, expiresAt: number) => ({
  ok: true as const,
  value: { value, expiresAt },
});

type FixtureAccessInspector = {
  readInputLog(): Promise<unknown[]>;
  boundInputLog(): Promise<string[]>;
  createInputLog(): Promise<unknown[]>;
  outcomeInputLog(): Promise<unknown[]>;
  adoptionInputLog(): Promise<unknown[]>;
  adoptionOutcomeInputLog(): Promise<unknown[]>;
  setAdoptionOutcomeMode(mode: AdoptionOutcomeMode): Promise<void>;
  d04ReaderSnapshot(): Promise<{
    listInputs: unknown[];
    searchInputs: unknown[];
    readInputs: unknown[];
    readExpirySnapshots: number[];
  }>;
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
  // This test-only compatibility surface is used solely by suites below that are retired in D04.
  // It does not describe or exercise the Agent-facing KnowledgeSession implementation.
  list(options?: { cursor?: string; limit?: number }): Promise<FixturePage>;
  proposeKnowledgeCreate(input: unknown): Promise<unknown>;
  readCreationOutcome(input: unknown): Promise<unknown | null>;
  [Symbol.dispose](): void;
};

type BronzeTamperField = "document" | "content_hash" | "action_ref" | "fingerprint";

type FixtureGatekeeper = {
  startSession(queue: RpcStub<ApprovalQueue>): Promise<FixtureSession>;
  getTypeScriptTypes(): Promise<string>;
  getAgentCatalog(...args: unknown[]): Promise<AgentCatalog>;
  addObserver(observerId: string, user: unknown): Promise<void>;
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
  probeResponseLoss(): Promise<{
    createInputs: unknown[];
    outcomeInputs: unknown[];
    status: string;
    errors: string[];
  }>;
  probeActionRefFingerprintMismatch(): Promise<{ observations: number; error: string | null }>;
};

type FixtureAccount = {
  describe(): Promise<AccountDescription>;
  inspectManagerBinding(managerId: string): Promise<"legacy" | "bound">;
  getSingletonGatekeeperClass(): Promise<DurableObjectClass<CustomGatekeeper>>;
};

type WorkerExports = {
  TestKnowledgeAccess(options: { props: FixtureAccessProps }): FixtureAccessInspector & {
    managerIdForTest(): Promise<string>;
    tokenForTest(): Promise<string>;
  };
  KnowledgeAccountAccess: {
    getByName(managerId: string): {
      bind(managerId: string, capability: unknown): Promise<void>;
      getAccess(): Promise<unknown>;
    };
  };
  CustomGatekeeper(options: { props: { managerId: string } }): DurableObjectClass<CustomGatekeeper>;
  InspectableCustomGatekeeper(options: {
    props: { managerId: string };
  }): DurableObjectClass<InspectableCustomGatekeeper>;
  CustomAccount(options: { props?: unknown }): FixtureAccount;
  GatekeeperVendor(options: { props?: unknown }): {
    createManagerAccount(managerId: string, capability: unknown): Promise<FixtureAccount>;
  };
  CustomVerifier(options: { props?: unknown }): unknown;
};

type D04AgentReaderSession = {
  list(input: D04ListInput): Promise<unknown>;
  search(input: D04SearchInput): Promise<unknown>;
  read(input: D04ReadInput): Promise<unknown>;
  [Symbol.dispose](): void;
};

type AccessLog = {
  readInputs: BronzeCall[];
  d04ListInputs: unknown[];
  d04SearchInputs: unknown[];
  d04ReadInputs: unknown[];
  d04ReadExpirySnapshots: number[];
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
    d04ListInputs: [],
    d04SearchInputs: [],
    d04ReadInputs: [],
    d04ReadExpirySnapshots: [],
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
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const makeSummary = (
  index: number,
  state: KnowledgeState,
  reviewDisplayName?: string,
): FixtureSummary => ({
  knowledgeId: KNOWLEDGE_IDS[index] ?? KNOWLEDGE_IDS[0],
  generation: 1,
  displayName: reviewDisplayName ?? (index === 0 ? "Initial Knowledge" : "Additional Knowledge"),
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

export class TestKnowledgeAccess extends WorkerEntrypoint<Cloudflare.Env, FixtureAccessProps> {
  #adoptionOutcomeMode: AdoptionOutcomeMode | undefined;

  async managerIdForTest(): Promise<string> {
    return this.ctx.props.managerId;
  }
  async tokenForTest(): Promise<string> {
    return this.ctx.props.token ?? "";
  }
  async assertBoundTo(managerId: string): Promise<"cybernest-knowledge-read-v1"> {
    accessLog(this.ctx.props).boundInputs.push(managerId);
    if (this.ctx.props.bindDelayMs !== undefined)
      await new Promise((resolve) => setTimeout(resolve, this.ctx.props.bindDelayMs));
    if (this.ctx.props.assertMode === "rpc_failure") {
      throw new Error("fixture capability RPC failure");
    }
    if (this.ctx.props.assertMode === "wrong_manager" || managerId !== this.ctx.props.managerId) {
      throw new Error("fixture capability is bound to another Manager");
    }
    return "cybernest-knowledge-read-v1";
  }

  async list(input?: { cursor?: string; limit?: number } | D04ListInput): Promise<unknown> {
    if (this.ctx.props.d04ReaderMode) {
      accessLog(this.ctx.props).d04ListInputs.push(structuredClone(input));
      return d04SuccessReceipt(D04_READER_RESULT.list, Date.now() + 3_599_000);
    }
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

  async search(input: D04SearchInput): Promise<unknown> {
    accessLog(this.ctx.props).d04SearchInputs.push(structuredClone(input));
    const result =
      "kind" in input
        ? input.kind === "articles"
          ? D04_ARTICLES_SEARCH_RESULT
          : D04_ARTICLE_LINKS_SEARCH_RESULT
        : D04_READER_RESULT.search;
    return d04SuccessReceipt(result, Date.now() + 3_599_000);
  }

  async read(input: D04ReadInput): Promise<unknown> {
    const log = accessLog(this.ctx.props);
    log.d04ReadInputs.push(structuredClone(input));
    const readIndex = log.d04ReadInputs.length;
    const expiry =
      this.ctx.props.receiptSchedule === "renewal_during_observation" && readIndex === 1
        ? Date.now() + 2_000
        : Date.now() + 3_599_000;
    log.d04ReadExpirySnapshots.push(expiry);
    return d04SuccessReceipt(
      this.ctx.props.d04ArticleRead ? D04_ARTICLE_READ_RESULT : D04_READER_RESULT.read,
      expiry,
    );
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
      if (this.ctx.props.createMode === "deadline_exceeded") return { _tag: "deadline_exceeded" };
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
    const adoption = log.adoptionInputs[0] as
      | {
          knowledgeId: string;
          generation: 1;
          document: string;
        }
      | undefined;
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

  async d04ReaderSnapshot() {
    const log = accessLog(this.ctx.props);
    return {
      listInputs: structuredClone(log.d04ListInputs),
      searchInputs: structuredClone(log.d04SearchInputs),
      readInputs: structuredClone(log.d04ReadInputs),
      readExpirySnapshots: [...log.d04ReadExpirySnapshots],
    };
  }
}

class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  readonly observations: ObservationDescription[] = [];
  #calls = 0;
  #disposals = 0;
  #observationEntered: Promise<void>;
  #resolveObservationEntered!: () => void;
  readonly submissions: Array<{ action: number; description: unknown }> = [];

  constructor(
    private readonly rejectAt: number | null = null,
    private readonly submitFailure = false,
    private readonly observationBarrier?: Promise<void>,
  ) {
    super();
    this.#observationEntered = new Promise((resolve) => {
      this.#resolveObservationEntered = resolve;
    });
  }

  waitForObservation(): Promise<void> {
    return this.#observationEntered;
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.#calls += 1;
    this.observations.push({ ...description });
    this.#resolveObservationEntered();
    if (this.observationBarrier !== undefined) await this.observationBarrier;
    if (this.rejectAt !== null && this.#calls === this.rejectAt) {
      throw new Error("fixture observation denied");
    }
  }

  async getGitCache(): Promise<never> {
    throw new Error("Unexpected GitCache access in Knowledge fixture.");
  }

  async submitAction(action: number, description: unknown): Promise<void> {
    if (this.submitFailure) throw new Error("fixture submit failure");
    this.submissions.push({ action, description: structuredClone(description) });
  }

  async bindHook(): Promise<void> {
    throw new Error("Unexpected hook in Knowledge fixture.");
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
  readonly #managerId: string;

  constructor(
    state: ConstructorParameters<typeof CustomGatekeeper>[0],
    env: ConstructorParameters<typeof CustomGatekeeper>[1],
  ) {
    super(state, env);
    this.#gatekeeper = new CustomGatekeeper(state, env);
    this.#managerId = (state.props as unknown as { managerId: string }).managerId;
  }
  async describe(): Promise<unknown> {
    return this.#gatekeeper.describe();
  }
  async getTypeScriptTypes(): Promise<string> {
    return this.#gatekeeper.getTypeScriptTypes();
  }
  async addObserver(observerId: string, user: unknown): Promise<void> {
    return this.#gatekeeper.addObserver(observerId, user as never);
  }
  async removeObserver(): Promise<void> {
    return this.#gatekeeper.removeObserver();
  }
  async revertAction(): Promise<void> {
    return this.#gatekeeper.revertAction();
  }
  async #access(): Promise<FixtureAccessInspector> {
    return (await this.ctx.exports.KnowledgeAccountAccess.getByName(
      this.#managerId,
    ).getAccess()) as unknown as FixtureAccessInspector;
  }
  async inspectBronzeRow(operationId: string): Promise<Record<string, unknown> | null> {
    const row = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT * FROM custom_gatekeeper_bronze_adoptions WHERE operation_id = ?",
        operationId,
      )
      .toArray()[0];
    return row === undefined ? null : structuredClone(row);
  }

  async inspectArticleRow(operationId: string): Promise<Record<string, unknown> | null> {
    const row = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT * FROM custom_gatekeeper_article_actions WHERE operation_id = ?",
        operationId,
      )
      .toArray()[0];
    return row === undefined ? null : structuredClone(row);
  }

  async tamperArticleCommand(operationId: string): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<{ command_json: string }>(
        "SELECT command_json FROM custom_gatekeeper_article_actions WHERE operation_id = ?",
        operationId,
      )
      .toArray()[0];
    if (row === undefined) throw new Error("Missing staged Article row.");
    const command = JSON.parse(row.command_json) as {
      article?: { sections?: Array<{ text: string }> };
    };
    const firstSection = command.article?.sections?.[0];
    if (firstSection === undefined) throw new Error("Missing staged Article section.");
    firstSection.text += "[tampered]";
    this.ctx.storage.sql.exec(
      "UPDATE custom_gatekeeper_article_actions SET command_json = ? WHERE operation_id = ?",
      JSON.stringify(command),
      operationId,
    );
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
    const session = await this.startSession(queue);
    const errors: string[] = [];
    let outcome: unknown | null = null;
    let operationId: string | null = null;
    try {
      const proposal = (await session.proposeKnowledgeCreate({ displayName: "Team Notes" })) as {
        operationId: string;
      };
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
        createInputs: await (await this.#access()).createInputLog(),
        outcomeInputs: await (await this.#access()).outcomeInputLog(),
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
    const session = await this.startSession(queue);
    const errors: string[] = [];
    let outcome: unknown | null = null;
    let operationId: string | null = null;
    try {
      const proposal = (await session.proposeKnowledgeCreate({ displayName: "Team Notes" })) as {
        operationId: string;
      };
      operationId = proposal.operationId;
      const submission = target.submissions[0];
      if (submission === undefined) throw new Error("missing native submission");
      const props = this.ctx.props as unknown as { managerId?: string };
      const managerId = props.managerId;
      props.managerId = undefined;
      try {
        await this.#gatekeeper.applyAction(submission.action);
      } catch (cause) {
        errors.push(messageOf(cause));
      } finally {
        props.managerId = managerId;
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
        createInputs: await (await this.#access()).createInputLog(),
        outcomeInputs: await (await this.#access()).outcomeInputLog(),
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
    const session = await this.startSession(queue);
    const errors: string[] = [];
    let outcome: unknown | null = null;
    let bronzeRow: Record<string, unknown> | null = null;
    let operationId: string | null = null;
    try {
      const page = await session.list({ limit: 1 });
      const handle = page.items[0]?.access;
      if (handle === undefined) throw new Error("missing native Bronze handle");
      const proposal = (await handle.proposeBronzeAdoption({
        document: "# Exact concept\n",
        provenance: {
          sourceKind: "explicit_user_input",
          reference: "s16-sync-fixture",
          capturedAt: NOW,
        },
      })) as { operationId: string };
      operationId = proposal.operationId;
      const submission = target.submissions[0];
      if (submission === undefined) throw new Error("missing native Bronze submission");
      const props = this.ctx.props as unknown as { managerId?: string };
      const managerId = props.managerId;
      props.managerId = undefined;
      try {
        await this.#gatekeeper.applyAction(submission.action);
      } catch (cause) {
        errors.push(messageOf(cause));
      } finally {
        props.managerId = managerId;
      }
      try {
        await this.#gatekeeper.applyAction(submission.action);
      } catch (cause) {
        errors.push(messageOf(cause));
      }
      outcome = await handle.readAdoptionOutcome({ operationId });
      const row = this.ctx.storage.sql
        .exec<Record<string, SqlStorageValue>>(
          "SELECT * FROM custom_gatekeeper_bronze_adoptions WHERE operation_id = ?",
          operationId,
        )
        .toArray()[0];
      bronzeRow = row === undefined ? null : structuredClone(row);
      return {
        adoptionInputs: await (await this.#access()).adoptionInputLog(),
        adoptionOutcomeInputs: await (await this.#access()).adoptionOutcomeInputLog(),
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
    const session = await this.startSession(queue);
    let error: string | null = null;
    try {
      const proposal = (await session.proposeKnowledgeCreate({ displayName: "Team Notes" })) as {
        operationId: string;
      };
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
    const session = await this.startSession(queue);
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
      return { createInputs: await (await this.#access()).createInputLog(), errors };
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
    const session = await this.startSession(queue);
    const errors: string[] = [];
    try {
      const proposal = (await session.proposeKnowledgeCreate({ displayName: "Team Notes" })) as {
        operationId: string;
      };
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
        createInputs: await (await this.#access()).createInputLog(),
        outcomeInputs: await (await this.#access()).outcomeInputLog(),
        status: row.status,
        errors,
      };
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
  }

  async probeActionRefFingerprintMismatch(): Promise<{
    observations: number;
    error: string | null;
  }> {
    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await this.startSession(queue);
    let error: string | null = null;
    try {
      const proposal = (await session.proposeKnowledgeCreate({ displayName: "Team Notes" })) as {
        operationId: string;
      };
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

  async getGitCache(): Promise<never> {
    throw new Error("Unexpected GitCache access in catalog fixture.");
  }
}

class TestVerifier extends RpcTarget {}

export class TestGatekeeperFactory extends DurableObject {
  #exports(): WorkerExports {
    return this.ctx.exports as unknown as WorkerExports;
  }

  async #props(access: unknown): Promise<{ managerId: string }> {
    const managerId = await (access as { managerIdForTest(): Promise<string> }).managerIdForTest();
    await this.#exports().GatekeeperVendor({}).createManagerAccount(managerId, access);
    return { managerId };
  }

  async #newBinding(props: FixtureAccessProps): Promise<{
    gatekeeper: FixtureGatekeeper;
    access: FixtureAccessInspector;
  }> {
    const workerExports = this.#exports();
    const accessProps = { ...props, token: crypto.randomUUID() };
    const access = workerExports.TestKnowledgeAccess({ props: accessProps });
    const gatekeeperClass = workerExports.CustomGatekeeper({ props: await this.#props(access) });
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

  async runMalformedSession(): Promise<{ error: string | null }> {
    const workerExports = this.#exports();
    const access = workerExports.TestKnowledgeAccess({
      props: { managerId: crypto.randomUUID(), token: crypto.randomUUID() },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({
      props: { ...(await this.#props(access)), unexpected: true } as { managerId: string },
    });
    const facetName = "fixture-malformed-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    })) as unknown as FixtureGatekeeperProbe;
    try {
      await gatekeeper.probeMalformedSession();
      return { error: "session probe unexpectedly completed" };
    } catch (cause) {
      // Invalid props reject the Durable Object constructor before the session probe can run.
      return { error: messageOf(cause) };
    }
  }

  async runStoredOutcomeUnknown(): Promise<{ observations: number; error: string | null }> {
    const workerExports = this.#exports();
    const access = workerExports.TestKnowledgeAccess({
      props: { managerId: crypto.randomUUID(), token: crypto.randomUUID() },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({
      props: await this.#props(access),
    });
    const facetName = "fixture-stored-outcome-unknown-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    })) as unknown as FixtureGatekeeperProbe;
    return gatekeeper.probeStoredOutcomeUnknown();
  }

  async runRead(
    options: {
      listMode?: ListMode;
      bronzeMode?: BronzeMode;
      states?: KnowledgeState[];
      nextCursor?: NextCursorMode;
      listOptions?: { cursor?: string; limit?: number };
      rejectObservationAt?: number | null;
    } = {},
  ): Promise<{
    page: Array<Record<string, unknown>> | null;
    nextCursor: string | null;
    read: unknown;
    error: string | null;
    observations: ObservationDescription[];
    readInputs: unknown[];
    queueDisposals: number;
  }> {
    const props: FixtureAccessProps = {
      managerId: crypto.randomUUID(),
      listMode: options.listMode,
      bronzeMode: options.bronzeMode,
      states: options.states,
      nextCursor: options.nextCursor,
    };
    const { gatekeeper, access } = await this.#newBinding(props);
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

  async runD04ReaderSurface(
    options: {
      articleRead?: boolean;
      searchMode?: "articles" | "article-links";
    } = {},
  ): Promise<{
    typesCode: string;
    catalog: AgentCatalog | null;
    list: unknown;
    search: unknown;
    read: unknown;
    errors: { list: string | null; search: string | null; read: string | null };
    observations: ObservationDescription[];
    readerSnapshot: Awaited<ReturnType<FixtureAccessInspector["d04ReaderSnapshot"]>>;
  }> {
    const { gatekeeper, access } = await this.#newBinding({
      managerId: crypto.randomUUID(),
      token: crypto.randomUUID(),
      d04ReaderMode: true,
      d04ArticleRead: options.articleRead === true,
    });
    const typesCode = await gatekeeper.getTypeScriptTypes();
    let catalog: AgentCatalog | null = null;
    catalog = await gatekeeper.getAgentCatalog();

    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await gatekeeper.startSession(queue);
    const reader = session as unknown as D04AgentReaderSession;
    let list: unknown;
    let search: unknown;
    let read: unknown;
    const errors: { list: string | null; search: string | null; read: string | null } = {
      list: null,
      search: null,
      read: null,
    };
    try {
      try {
        list = await reader.list({ offset: 0, limit: 16 });
      } catch (cause) {
        errors.list = messageOf(cause);
      }
      try {
        const searchInput: D04SearchInput =
          options.searchMode === "articles"
            ? {
                kind: "articles",
                filters: { type: "Source", tag: "research" },
                cursor: "0",
                limit: 16,
              }
            : options.searchMode === "article-links"
              ? {
                  kind: "article-links",
                  articleId: "a",
                  direction: "links",
                  maxDepth: 4,
                  candidateBudget: 32,
                }
              : { query: "private", offset: 0, limit: 16 };
        search = await reader.search(searchInput);
      } catch (cause) {
        errors.search = messageOf(cause);
      }
      try {
        read = await reader.read({
          path: options.articleRead ? D04_ARTICLE_READ_RESULT.path : "index.md",
        });
      } catch (cause) {
        errors.read = messageOf(cause);
      }
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
    return {
      typesCode,
      catalog,
      list,
      search,
      read,
      errors,
      observations: target.observations.map((observation) => ({ ...observation })),
      readerSnapshot: await access.d04ReaderSnapshot(),
    };
  }

  async runD04ObservationReject(): Promise<{
    result: unknown;
    error: string | null;
    observationCount: number;
  }> {
    const { gatekeeper } = await this.#newBinding({
      managerId: crypto.randomUUID(),
      token: crypto.randomUUID(),
      d04ReaderMode: true,
    });
    const target = new TestApprovalQueue(1);
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await gatekeeper.startSession(queue);
    const reader = session as unknown as D04AgentReaderSession;
    let result: unknown;
    let error: string | null = null;
    try {
      result = await reader.read({ path: "index.md" });
    } catch (cause) {
      error = messageOf(cause);
    } finally {
      session[Symbol.dispose]();
      queue[Symbol.dispose]();
    }
    return { result, error, observationCount: target.snapshot().calls };
  }

  async runD04ConcurrentReceiptExpiry(): Promise<{
    first: { value?: unknown; error?: string };
    second: unknown;
    secondError: string | null;
    firstExpiry: number | null;
    secondExpiry: number | null;
    firstObservationReached: boolean;
  }> {
    const { gatekeeper, access } = await this.#newBinding({
      managerId: crypto.randomUUID(),
      token: crypto.randomUUID(),
      d04ReaderMode: true,
      receiptSchedule: "renewal_during_observation",
    });
    let releaseObservation!: () => void;
    const observationBarrier = new Promise<void>((resolve) => {
      releaseObservation = resolve;
    });
    const firstTarget = new TestApprovalQueue(null, false, observationBarrier);
    const firstQueue = new RpcStub<ApprovalQueue>(firstTarget);
    const firstSession = await gatekeeper.startSession(firstQueue);
    const firstReader = firstSession as unknown as D04AgentReaderSession;
    const firstSettled = firstReader.read({ path: "index.md" }).then(
      (value) => ({ value }),
      (cause) => ({ error: messageOf(cause) }),
    );
    const firstObservationReached = await Promise.race([
      firstTarget.waitForObservation().then(() => true),
      firstSettled.then(() => false),
    ]);
    if (!firstObservationReached) {
      releaseObservation();
      firstSession[Symbol.dispose]();
      firstQueue[Symbol.dispose]();
      return {
        first: await firstSettled,
        second: null,
        secondError: null,
        firstExpiry: null,
        secondExpiry: null,
        firstObservationReached,
      };
    }

    const afterRenewalTarget = new TestApprovalQueue();
    const afterRenewalQueue = new RpcStub<ApprovalQueue>(afterRenewalTarget);
    const afterRenewalSession = await gatekeeper.startSession(afterRenewalQueue);
    const afterRenewalReader = afterRenewalSession as unknown as D04AgentReaderSession;
    let second: unknown;
    try {
      let secondError: string | null = null;
      try {
        second = await afterRenewalReader.read({ path: "index.md" });
      } catch (cause) {
        secondError = messageOf(cause);
      }
      const receipts = (await access.d04ReaderSnapshot()).readExpirySnapshots;
      const firstExpiry = receipts[0] ?? null;
      const secondExpiry = receipts[1] ?? null;
      if (firstExpiry !== null) {
        const waitMs = Math.max(0, firstExpiry - Date.now() + 5);
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      releaseObservation();
      const first = await firstSettled;
      return {
        first,
        second,
        secondError,
        firstExpiry,
        secondExpiry,
        firstObservationReached,
      };
    } finally {
      releaseObservation();
      firstSession[Symbol.dispose]();
      firstQueue[Symbol.dispose]();
      afterRenewalSession[Symbol.dispose]();
      afterRenewalQueue[Symbol.dispose]();
    }
  }

  async runProposal(
    options: {
      input?: unknown;
      createMode?:
        | "ready"
        | "malformed"
        | "throw"
        | "throw_once"
        | "delay"
        | "initial"
        | "blocked"
        | "wrong_display";
      outcomeMode?:
        | "ready"
        | "malformed"
        | "throw"
        | "failure"
        | "initial"
        | "blocked"
        | "wrong_display";
      submitFailure?: boolean;
      decision?: "none" | "approve" | "retry" | "reject";
    } = {},
  ): Promise<{
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
    const { gatekeeper, access } = await this.#newBinding({
      managerId: crypto.randomUUID(),
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
      proposal = await session.proposeKnowledgeCreate(
        options.input ?? { displayName: "Team Notes" },
      );
      const submission = target.submissions[0];
      if (submission && options.decision === "approve")
        await gatekeeper.applyAction(submission.action);
      if (submission && options.decision === "retry") {
        try {
          await gatekeeper.applyAction(submission.action);
        } catch {
          /* response-loss fixture */
        }
        await gatekeeper.applyAction(submission.action);
      }
      if (submission && options.decision === "reject")
        await gatekeeper.rejectAction(submission.action);
      if (proposal && typeof proposal === "object" && "operationId" in proposal) {
        outcome = await session.readCreationOutcome({
          operationId: (proposal as { operationId: string }).operationId,
        });
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

  async runBronzeProposal(
    options: {
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
    } = {},
  ): Promise<{
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
        managerId: crypto.randomUUID(),
        states: options.wrongHandle ? ["ready", "ready"] : ["ready"],
        adoptionMode: options.adoptionMode,
        adoptionOutcomeMode: options.outcomeMode,
        reviewDisplayName: options.displayName,
        token: crypto.randomUUID(),
      },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({
      props: await this.#props(access),
    });
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
        if (options.decision !== "reject" && operationId !== null) {
          try {
            outcome = await outcomeHandle.readAdoptionOutcome({ operationId });
          } catch (cause) {
            error ??= messageOf(cause);
          }
          if (options.secondOutcomeMode !== undefined) {
            await (
              access as unknown as {
                setAdoptionOutcomeMode(mode: AdoptionOutcomeMode): Promise<void>;
              }
            ).setAdoptionOutcomeMode(options.secondOutcomeMode);
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
      props: { managerId: crypto.randomUUID(), token: crypto.randomUUID() },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({
      props: await this.#props(access),
    });
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
        managerId: crypto.randomUUID(),
        states: ["ready"],
        token: crypto.randomUUID(),
      },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({
      props: await this.#props(access),
    });
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
      props: { managerId: crypto.randomUUID(), token: crypto.randomUUID() },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({
      props: await this.#props(access),
    });
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
        managerId: crypto.randomUUID(),
        states: ["ready"],
        token: crypto.randomUUID(),
      },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({
      props: await this.#props(access),
    });
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
            result.status === "rejected" && messageOf(result.reason).includes("capacity_exceeded"),
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
    const { gatekeeper, access } = await this.#newBinding({
      managerId: crypto.randomUUID(),
      createMode: mode,
    });
    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await gatekeeper.startSession(queue);
    let error: string | null = null;
    let outcome: unknown | null = null;
    try {
      const proposal = (await session.proposeKnowledgeCreate({ displayName: "Team Notes" })) as {
        operationId: string;
      };
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
    const { gatekeeper } = await this.#newBinding({ managerId: crypto.randomUUID() });
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
          (result) =>
            result.status === "rejected" && messageOf(result.reason).includes("capacity_exceeded"),
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
    const { gatekeeper, access } = await this.#newBinding({
      managerId: crypto.randomUUID(),
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
      props: { managerId: crypto.randomUUID(), token: crypto.randomUUID() },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({
      props: await this.#props(access),
    });
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
      props: {
        managerId: crypto.randomUUID(),
        createMode: "throw_once",
        token: crypto.randomUUID(),
      },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({
      props: await this.#props(access),
    });
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
        managerId: crypto.randomUUID(),
        createMode,
        outcomeMode,
        token: crypto.randomUUID(),
      },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({
      props: await this.#props(access),
    });
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
      props: { managerId: crypto.randomUUID(), token: crypto.randomUUID() },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({
      props: await this.#props(access),
    });
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
      props: { managerId: crypto.randomUUID(), token: crypto.randomUUID() },
    });
    const gatekeeperClass = workerExports.InspectableCustomGatekeeper({
      props: await this.#props(access),
    });
    const facetName = "fixture-action-ref-fingerprint-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    })) as unknown as FixtureGatekeeperProbe;
    return gatekeeper.probeActionRefFingerprintMismatch();
  }

  async runOutcomeFailureRecovery(outcomeMode: "failure" | InvalidInputMode = "failure"): Promise<{
    createInputs: unknown[];
    outcomeInputs: unknown[];
    outcome: unknown | null;
    errors: string[];
  }> {
    const { gatekeeper, access } = await this.#newBinding({
      managerId: crypto.randomUUID(),
      createMode: "throw_once",
      outcomeMode,
    });
    const target = new TestApprovalQueue();
    const queue = new RpcStub<ApprovalQueue>(target);
    const session = await gatekeeper.startSession(queue);
    const errors: string[] = [];
    let outcome: unknown | null = null;
    try {
      const proposal = (await session.proposeKnowledgeCreate({ displayName: "Team Notes" })) as {
        operationId: string;
      };
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
    page: Record<string, unknown>;
    observations: ObservationDescription[];
    boundInputs: string[];
  }> {
    const workerExports = this.#exports();
    const access = workerExports.TestKnowledgeAccess({
      props: { managerId, token: crypto.randomUUID(), d04ReaderMode: true },
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
    let page: Record<string, unknown> = {};
    try {
      page = (await (session as unknown as D04AgentReaderSession).list({
        offset: 0,
        limit: 16,
      })) as Record<string, unknown>;
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

  async runConcurrentAccountBinding(): Promise<{
    bindResults: Array<"fulfilled" | "rejected">;
    firstStored: string;
    afterRebind: string;
    foreignError: string | null;
    afterForeign: string;
  }> {
    const workerExports = this.#exports();
    const managerId = crypto.randomUUID();
    const firstToken = "parallel-bind-first";
    const secondToken = "parallel-bind-second";
    const first = workerExports.TestKnowledgeAccess({
      props: { managerId, token: firstToken, bindDelayMs: 15, d04ReaderMode: true },
    });
    const second = workerExports.TestKnowledgeAccess({
      props: { managerId, token: secondToken, bindDelayMs: 15, d04ReaderMode: true },
    });
    const store = workerExports.KnowledgeAccountAccess.getByName(managerId);
    const results = await Promise.allSettled([
      store.bind(managerId, first),
      store.bind(managerId, second),
    ]);
    const storedToken = async (): Promise<string> => {
      const capability = (await store.getAccess()) as {
        tokenForTest(): Promise<string>;
      };
      return capability.tokenForTest();
    };
    const firstStored = await storedToken();
    const laterCapability = firstStored === firstToken ? second : first;
    await store.bind(managerId, laterCapability);
    const afterRebind = await storedToken();

    const foreign = workerExports.TestKnowledgeAccess({
      props: {
        managerId: crypto.randomUUID(),
        token: "parallel-bind-foreign",
        d04ReaderMode: true,
      },
    });
    let foreignError: string | null = null;
    try {
      await store.bind(managerId, foreign);
    } catch (cause) {
      foreignError = messageOf(cause);
    }
    const afterForeign = await storedToken();
    return {
      bindResults: results.map((result) => result.status),
      firstStored,
      afterRebind,
      foreignError,
      afterForeign,
    };
  }

  async runAccountError(
    options: {
      requestedManagerId?: string;
      capabilityManagerId?: string;
      assertMode?: AssertMode;
      extraProps?: boolean;
    } = {},
  ): Promise<string | null> {
    const workerExports = this.#exports();
    const access = workerExports.TestKnowledgeAccess({
      props: {
        managerId: options.capabilityManagerId ?? MANAGER_ID,
        assertMode: options.assertMode,
      },
    });
    const capability = options.extraProps ? { access, unexpected: true } : access;
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
    void limit;
    const { gatekeeper } = await this.#newBinding({ managerId: crypto.randomUUID() });
    return { catalog: await gatekeeper.getAgentCatalog(), observations: [] };
  }

  async runObserverRejection(): Promise<string | null> {
    const { gatekeeper } = await this.#newBinding({ managerId: crypto.randomUUID() });
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

type NativeArticleSaveMode = "normal" | "commit_then_throw_once" | "forbidden_once";
type NativeArticleStored = {
  commandJson: string;
  payloadHash: string;
  articleId: string;
  revisionId: string;
  receiptId: string;
  committedAt: string;
};
type NativeArticleFixtureState = {
  managerId: string | null;
  saveMode: NativeArticleSaveMode;
  saveInputs: Array<{ commandJson: string; payloadHash: string }>;
  readInputs: Array<{ articleId: string; revisionId: string }>;
  articles: Record<string, NativeArticleStored>;
};

const newNativeArticleFixtureState = (): NativeArticleFixtureState => ({
  managerId: null,
  saveMode: "normal",
  saveInputs: [],
  readInputs: [],
  articles: {},
});

// Native approval tests use a Durable Object capability so a persisted Access stub has a stable
// DO owner and expected Core errors cross a normal RPC boundary instead of a WorkerEntrypoint
// callback wrapper.
export class NativeArticleAccess extends DurableObject<Cloudflare.Env> {
  async #readState(): Promise<NativeArticleFixtureState> {
    return (
      (await this.ctx.storage.get<NativeArticleFixtureState>("article-fixture")) ??
      newNativeArticleFixtureState()
    );
  }

  async #writeState(state: NativeArticleFixtureState): Promise<void> {
    await this.ctx.storage.put("article-fixture", state);
  }

  async initialize(managerId: string): Promise<void> {
    const state = await this.#readState();
    if (state.managerId !== null && state.managerId !== managerId) {
      throw new Error("Article fixture is already initialized for another Manager.");
    }
    state.managerId = managerId;
    await this.#writeState(state);
  }

  async clearFixture(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async assertBoundTo(managerId: string): Promise<"cybernest-knowledge-read-v1"> {
    const state = await this.#readState();
    if (state.managerId !== managerId) {
      throw new Error("Article fixture is bound to another Manager.");
    }
    return "cybernest-knowledge-read-v1";
  }

  async setArticleSaveMode(mode: NativeArticleSaveMode): Promise<void> {
    const state = await this.#readState();
    state.saveMode = mode;
    await this.#writeState(state);
  }

  async articleSnapshot(): Promise<{
    saveInputs: Array<{ commandJson: string; payloadHash: string }>;
    readInputs: Array<{ articleId: string; revisionId: string }>;
    articles: Array<NativeArticleStored & { operationId: string }>;
  }> {
    const state = await this.#readState();
    return structuredClone({
      saveInputs: state.saveInputs,
      readInputs: state.readInputs,
      articles: Object.entries(state.articles).map(([operationId, article]) => ({
        operationId,
        ...article,
      })),
    });
  }

  async saveArticle(input: unknown): Promise<unknown> {
    if (
      !isRecord(input) ||
      typeof input.commandJson !== "string" ||
      typeof input.payloadHash !== "string"
    ) {
      throw new TypeError("Invalid test Article save input.");
    }
    const state = await this.#readState();
    state.saveInputs.push({ commandJson: input.commandJson, payloadHash: input.payloadHash });
    let command: {
      operationId: string;
      actionRef: string;
      article: { sections: Array<{ text: string }> };
    };
    try {
      const parsed: unknown = JSON.parse(input.commandJson);
      if (
        !isRecord(parsed) ||
        typeof parsed.operationId !== "string" ||
        typeof parsed.actionRef !== "string" ||
        !isRecord(parsed.article) ||
        !Array.isArray(parsed.article.sections)
      ) {
        throw new TypeError("Invalid Article command.");
      }
      command = parsed as typeof command;
    } catch {
      await this.#writeState(state);
      return { _tag: "integrity_failure" };
    }

    if (state.saveMode === "forbidden_once") {
      state.saveMode = "normal";
      await this.#writeState(state);
      return { _tag: "forbidden" };
    }
    const existing = state.articles[command.operationId];
    if (existing !== undefined) {
      await this.#writeState(state);
      if (existing.payloadHash !== input.payloadHash) return { _tag: "operation_conflict" };
      return {
        _tag: "already_committed",
        receipt: {
          receiptId: existing.receiptId,
          operationId: command.operationId,
          actionRef: command.actionRef,
          payloadHash: input.payloadHash,
          articleId: existing.articleId,
          revisionId: existing.revisionId,
          revisionNumber: 1,
          knowledgeId: KNOWLEDGE_IDS[0],
          generation: 1,
          committedAt: existing.committedAt,
        },
      };
    }

    const saved: NativeArticleStored = {
      commandJson: input.commandJson,
      payloadHash: input.payloadHash,
      articleId: crypto.randomUUID(),
      revisionId: crypto.randomUUID(),
      receiptId: crypto.randomUUID(),
      committedAt: new Date().toISOString(),
    };
    state.articles[command.operationId] = saved;
    const result = {
      _tag: "committed",
      receipt: {
        receiptId: saved.receiptId,
        operationId: command.operationId,
        actionRef: command.actionRef,
        payloadHash: input.payloadHash,
        articleId: saved.articleId,
        revisionId: saved.revisionId,
        revisionNumber: 1,
        knowledgeId: KNOWLEDGE_IDS[0],
        generation: 1,
        committedAt: saved.committedAt,
      },
    };
    const loseResponse = state.saveMode === "commit_then_throw_once";
    if (loseResponse) state.saveMode = "normal";
    await this.#writeState(state);
    if (loseResponse) throw new Error("fixture response lost after Article commit");
    return result;
  }

  async readArticle(input: unknown): Promise<unknown> {
    if (
      !isRecord(input) ||
      typeof input.articleId !== "string" ||
      typeof input.revisionId !== "string"
    ) {
      throw new TypeError("Invalid test Article read input.");
    }
    const state = await this.#readState();
    state.readInputs.push({ articleId: input.articleId, revisionId: input.revisionId });
    const saved = Object.values(state.articles).find(
      (article) => article.articleId === input.articleId && article.revisionId === input.revisionId,
    );
    await this.#writeState(state);
    if (saved === undefined) return { _tag: "not_found" };
    const command = JSON.parse(saved.commandJson) as {
      operationId: string;
      actionRef: string;
      article: { sections: Array<{ text: string }>; sources: unknown[] };
    };
    return {
      _tag: "found",
      articleId: saved.articleId,
      revisionId: saved.revisionId,
      revisionNumber: 1,
      knowledgeId: KNOWLEDGE_IDS[0],
      generation: 1,
      committedAt: saved.committedAt,
      operationId: command.operationId,
      actionRef: command.actionRef,
      payloadHash: saved.payloadHash,
      article: command.article,
      body: command.article.sections.map((section) => section.text).join(""),
    };
  }
}

type NativeOwnerExports = {
  UserDurableObject: {
    idFromName(name: string): { toString(): string };
    get(id: unknown): {
      newGadget(id: string, title: string): Promise<void>;
      deleteGadget(id: string): Promise<void>;
    };
  };
  OverseerDurableObject: {
    newUniqueId(): { toString(): string };
    idFromString(id: string): unknown;
    get(id: unknown): {
      open(
        userId: string,
        profileId: string,
        notifyClosed: RpcStub<() => void>,
      ): Promise<CapnwebRpcStub<Overseer>>;
    };
  };
};

type NativeOwnerGatekeeper = CapnwebRpcStub<GatekeeperClient<KnowledgeSession>>;

// Every operation opens and closes a real pinned Overseer owner session inside this Durable
// Object event. That keeps the native notifyClosed callback alive until its completion is observed.
export class NativeApprovalOwner extends DurableObject<Cloudflare.Env> {
  #exports(): NativeOwnerExports {
    return this.ctx.exports as unknown as NativeOwnerExports;
  }

  async prepareWorkspace(managerId: string): Promise<string> {
    const workerExports = this.#exports();
    const userId = workerExports.UserDurableObject.idFromName(managerId);
    const workspaceId = workerExports.OverseerDurableObject.newUniqueId().toString();
    await workerExports.UserDurableObject.get(userId).newGadget(
      workspaceId,
      "A1 Article approval test",
    );
    await this.#withOwner(managerId, workspaceId, async () => {});
    return workspaceId;
  }

  async cleanupWorkspace(managerId: string, workspaceId: string): Promise<void> {
    const workerExports = this.#exports();
    const userId = workerExports.UserDurableObject.idFromName(managerId);
    await workerExports.UserDurableObject.get(userId).deleteGadget(workspaceId);
  }

  async #withOwner<T>(
    managerId: string,
    workspaceId: string,
    callback: (owner: CapnwebRpcStub<Overseer>) => Promise<T>,
  ): Promise<T> {
    const workerExports = this.#exports();
    const userId = workerExports.UserDurableObject.idFromName(managerId).toString();
    const overseerId = workerExports.OverseerDurableObject.idFromString(workspaceId);
    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const notifyClosed = new RpcStub<() => void>(() => resolveClosed?.());
    const owner = await workerExports.OverseerDurableObject.get(overseerId).open(
      userId,
      managerId,
      notifyClosed,
    );
    try {
      return await callback(owner);
    } finally {
      try {
        owner[Symbol.dispose]();
        await closed;
      } finally {
        notifyClosed[Symbol.dispose]();
      }
    }
  }

  async listActions(managerId: string, workspaceId: string): Promise<unknown[]> {
    const page = await this.#withOwner(managerId, workspaceId, (owner) => owner.listActions());
    return page.entries;
  }

  async proposeArticle(
    managerId: string,
    workspaceId: string,
    gatekeeperId: number,
    article: unknown,
  ): Promise<unknown> {
    return this.#withOwner(managerId, workspaceId, async (owner) => {
      const gatekeeper = (await owner.getGatekeeperById(
        gatekeeperId,
      )) as unknown as NativeOwnerGatekeeper;
      try {
        const session = await gatekeeper.openSession();
        try {
          return await session.proposeArticle({ article });
        } finally {
          session[Symbol.dispose]();
        }
      } finally {
        gatekeeper[Symbol.dispose]();
      }
    });
  }

  async proposeGoldJobControl(
    managerId: string,
    workspaceId: string,
    gatekeeperId: number,
    input: unknown,
  ): Promise<unknown> {
    return this.#withOwner(managerId, workspaceId, async (owner) => {
      const gatekeeper = (await owner.getGatekeeperById(
        gatekeeperId,
      )) as unknown as NativeOwnerGatekeeper;
      try {
        const session = await gatekeeper.openSession();
        try {
          try {
            return await session.proposeGoldJobControl(input);
          } catch (cause) {
            return { error: messageOf(cause) };
          }
        } finally {
          session[Symbol.dispose]();
        }
      } finally {
        gatekeeper[Symbol.dispose]();
      }
    });
  }

  async readArticleOutcome(
    managerId: string,
    workspaceId: string,
    gatekeeperId: number,
    operationId: string,
  ): Promise<unknown> {
    return this.#withOwner(managerId, workspaceId, async (owner) => {
      const gatekeeper = (await owner.getGatekeeperById(
        gatekeeperId,
      )) as unknown as NativeOwnerGatekeeper;
      try {
        const session = await gatekeeper.openSession();
        try {
          return await (
            session as typeof session & {
              readArticleOutcome(input: { operationId: string }): Promise<unknown>;
            }
          ).readArticleOutcome({ operationId });
        } finally {
          session[Symbol.dispose]();
        }
      } finally {
        gatekeeper[Symbol.dispose]();
      }
    });
  }

  async decideAction(
    managerId: string,
    workspaceId: string,
    actionId: number,
    decision: "approve" | "reject",
  ): Promise<{ error: string | null }> {
    return this.#withOwner(managerId, workspaceId, async (owner) => {
      try {
        if (decision === "approve") await owner.approveAction(actionId);
        else await owner.rejectAction(actionId);
        return { error: null };
      } catch (cause) {
        return { error: messageOf(cause) };
      }
    });
  }
}
