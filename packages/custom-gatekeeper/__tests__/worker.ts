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

type FixtureAccessProps = {
  managerId: string;
  token?: string;
  states?: KnowledgeState[];
  listMode?: ListMode;
  bronzeMode?: BronzeMode;
  nextCursor?: NextCursorMode;
  assertMode?: AssertMode;
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
};

type FixtureKnowledge = {
  readBronze(input: { sourceId: string; revisionId?: string }): Promise<unknown>;
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
  [Symbol.dispose](): void;
};

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
};

type FixtureGatekeeperProbe = {
  probeMalformedSession(): Promise<{ duplicateCount: number; error: string | null }>;
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
};

const accessLogs = new Map<string, AccessLog>();
const accessLog = (props: FixtureAccessProps): AccessLog => {
  const key = props.token ?? props.managerId;
  const existing = accessLogs.get(key);
  if (existing !== undefined) return existing;
  const created: AccessLog = { readInputs: [], boundInputs: [] };
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

const makeSummary = (index: number, state: KnowledgeState): FixtureSummary => ({
  knowledgeId: KNOWLEDGE_IDS[index] ?? KNOWLEDGE_IDS[0],
  generation: 1,
  displayName: index === 0 ? "Initial Knowledge" : "Additional Knowledge",
  role: index === 0 ? "initial" : "additional",
  state,
  createdAt: NOW,
  updatedAt: NOW,
});

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class TestKnowledgeAccess extends WorkerEntrypoint<
  Cloudflare.Env,
  FixtureAccessProps
> {
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
      .map((state, index) => makeSummary(index, state));
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

  async readInputLog(): Promise<unknown[]> {
    return accessLog(this.ctx.props).readInputs.map((input) => ({ ...input }));
  }

  async boundInputLog(): Promise<string[]> {
    return [...accessLog(this.ctx.props).boundInputs];
  }
}

class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  readonly observations: ObservationDescription[] = [];
  #calls = 0;
  #disposals = 0;

  constructor(private readonly rejectAt: number | null = null) {
    super();
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.#calls += 1;
    this.observations.push({ ...description });
    if (this.rejectAt !== null && this.#calls === this.rejectAt) {
      throw new Error("fixture observation denied");
    }
  }

  async submitAction(): Promise<void> {}

  snapshot(): { calls: number; observations: ObservationDescription[]; disposals: number } {
    return {
      calls: this.#calls,
      observations: this.observations.map((observation) => ({ ...observation })),
      disposals: this.#disposals,
    };
  }

  [Symbol.dispose](): void {
    this.#disposals += 1;
  }
}

export class InspectableCustomGatekeeper extends DurableObject {
  readonly #gatekeeper: CustomGatekeeper;

  constructor(
    state: ConstructorParameters<typeof CustomGatekeeper>[0],
    env: ConstructorParameters<typeof CustomGatekeeper>[1],
  ) {
    super(state, env);
    this.#gatekeeper = new CustomGatekeeper(state, env);
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
