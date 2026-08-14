import {
  DurableObject,
  RpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc, validateStub } from "capnweb-validate";
import { boundAgentCatalog } from "@gadgets/workshop-shared/gatekeeper";
import type {
  AccountDescription,
  AgentCatalog,
  AgentCatalogRequest,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ObservationAuthorizer,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import TYPES_CODE from "./types-code.js";

const CUSTOM_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='currentColor' stroke-width='20'><path d='M52 72h152v112H52z'/><path d='m52 88 76 52 76-52'/></svg>",
    ),
};

const MANAGER_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type KnowledgeError = {
  code: string;
  revisionId?: string;
};

type KnowledgeReference = {
  revisionId: string;
  documentKey: string;
  contentHash: string;
};

type KnowledgePage = {
  items: KnowledgeReference[];
  nextCursor: string | null;
};

type KnowledgeSource = KnowledgeReference & {
  content: string;
};

type KnowledgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: KnowledgeError };

type KnowledgePageOptions = {
  cursor?: string;
  limit?: number;
};

type KnowledgeProposal = {
  revisionId: string;
  documentKey: string;
  baseSourceRevisionId: string | null;
  content: string;
};

type KnowledgeProposalInput = Omit<KnowledgeProposal, "revisionId">;

type ManagerKnowledgeAccessV1 = {
  assertBoundTo(managerId: string): Promise<void>;
  list(options?: KnowledgePageOptions): Promise<KnowledgeResult<KnowledgePage>>;
  search(
    query: string,
    options?: KnowledgePageOptions,
  ): Promise<KnowledgeResult<KnowledgePage>>;
  read(revisionId: string): Promise<KnowledgeResult<KnowledgeSource>>;
  applyProposal(input: KnowledgeProposal): Promise<KnowledgeResult<KnowledgeReference>>;
  cancelProposal(revisionId: string): Promise<KnowledgeResult<null>>;
};

export type KnowledgeAccountProps = {
  access: ManagerKnowledgeAccessV1;
};

type KnowledgeGatekeeperProps = KnowledgeAccountProps;

type KnowledgeBase = {
  list(options?: KnowledgePageOptions): Promise<KnowledgePage>;
  search(query: string, options?: KnowledgePageOptions): Promise<KnowledgePage>;
  read(revisionId: string): Promise<KnowledgeSource>;
  proposeUpdate(input: KnowledgeProposalInput): Promise<void>;
};

type ProposalQueue = Pick<ApprovalQueue, "authorizeObservation" | "submitAction"> &
  Partial<{ [Symbol.dispose](): void }>;

type PendingKnowledgeAction = {
  version: 1;
  state: "pending";
  revisionId: string;
  documentKey: string;
  baseSourceRevisionId: string | null;
  contentHash: string;
  body: ArrayBuffer;
};

type KnowledgeActionTombstone = {
  version: 1;
  state: "applied" | "rejected";
};

type KnowledgeActionRecord = PendingKnowledgeAction | KnowledgeActionTombstone;

type ProposalHandler = (input: KnowledgeProposalInput) => Promise<void>;

const ACTION_COUNTER_KEY = "knowledge:next-action-id";
const ACTION_KEY_PREFIX = "knowledge:action:";
const MAX_BODY_BYTES = 1_048_576;
const MAX_DOCUMENT_KEY_BYTES = 255;
const MAX_REVISION_ID_LENGTH = 36;
const MAX_SAFE_ACTION_ID = Number.MAX_SAFE_INTEGER;

const actionKey = (actionId: number) => ACTION_KEY_PREFIX + actionId;

const gatekeeperError = (code: string): Error =>
  new Error("Knowledge Base " + code + ".");

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isValidDocumentKey(value: string): boolean {
  return (
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_DOCUMENT_KEY_BYTES &&
    value.trim() === value &&
    !/\p{Cc}/u.test(value) &&
    !hasUnpairedSurrogate(value)
  );
}

function assertProposalInput(input: KnowledgeProposalInput): void {
  if (
    !isRecord(input) ||
    Object.keys(input).length !== 3 ||
    !("documentKey" in input) ||
    !("baseSourceRevisionId" in input) ||
    !("content" in input)
  ) {
    throw gatekeeperError("invalid_input");
  }
  if (
    typeof input.documentKey !== "string" ||
    !isValidDocumentKey(input.documentKey)
  ) {
    throw gatekeeperError("invalid_input");
  }
  if (
    input.baseSourceRevisionId !== null &&
    (typeof input.baseSourceRevisionId !== "string" ||
      input.baseSourceRevisionId.length !== MAX_REVISION_ID_LENGTH ||
      !CANONICAL_UUID.test(input.baseSourceRevisionId))
  ) {
    throw gatekeeperError("invalid_input");
  }
  if (typeof input.content !== "string" || hasUnpairedSurrogate(input.content)) {
    throw gatekeeperError("invalid_input");
  }
  if (new TextEncoder().encode(input.content).byteLength > MAX_BODY_BYTES) {
    throw gatekeeperError("capacity_exceeded");
  }
}

const textBytes = (content: string): Uint8Array => new TextEncoder().encode(content);

const bytesToHash = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const bodyBytes = (body: unknown): Uint8Array | null => {
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof Uint8Array) return body;
  return null;
};

const preview = (content: string): string => Array.from(content).slice(0, 2_000).join("");

const literalBlock = (value: string): string =>
  value
    .split("\n")
    .map((line) => "    " + line)
    .join("\n");

const proposalDescription = (
  proposal: KnowledgeProposal,
  contentHash: string,
): string => {
  const operation = proposal.baseSourceRevisionId === null ? "create" : "replace";
  return [
    "Operation: " + operation,
    "Document key:\n" + literalBlock(proposal.documentKey),
    "Revision ID:\n" + literalBlock(proposal.revisionId),
    "Base revision:\n" +
      literalBlock(proposal.baseSourceRevisionId ?? "none"),
    "Content hash (SHA-256):\n" + literalBlock(contentHash),
    "Preview (first 2,000 Unicode code points):\n" +
      literalBlock(preview(proposal.content)),
  ].join("\n\n");
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertManagerId(managerId: string): void {
  if (!MANAGER_UUID.test(managerId)) {
    throw new TypeError("Manager ID must be a UUID.");
  }
}

function isLegacyAccountProps(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.keys(value).length === 0);
}

function validateKnowledgeAccountProps(value: unknown): KnowledgeAccountProps {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !("access" in value)) {
    throw new TypeError("Knowledge Account props must contain only access.");
  }

  const access = value.access;
  if ((typeof access !== "object" && typeof access !== "function") || access === null) {
    throw new TypeError("Knowledge Account access must be an RPC stub.");
  }

  return {
    access: validateStub<ManagerKnowledgeAccessV1>(access as object),
  };
}

function isKnowledgeReference(value: unknown): value is KnowledgeReference {
  return (
    isRecord(value) &&
    typeof value.revisionId === "string" &&
    typeof value.documentKey === "string" &&
    typeof value.contentHash === "string"
  );
}

function isKnowledgePage(value: unknown): value is KnowledgePage {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isKnowledgeReference) &&
    (typeof value.nextCursor === "string" || value.nextCursor === null)
  );
}

function isKnowledgeSource(value: unknown): value is KnowledgeSource {
  return (
    isRecord(value) &&
    typeof value.revisionId === "string" &&
    typeof value.documentKey === "string" &&
    typeof value.contentHash === "string" &&
    typeof value.content === "string"
  );
}

function unwrapKnowledgeResult<T>(
  result: unknown,
  isValue: (value: unknown) => value is T,
): T {
  if (!isRecord(result) || typeof result.ok !== "boolean") {
    throw new Error("Knowledge Base integrity_failure: malformed result.");
  }

  if (result.ok) {
    if (!isValue(result.value)) {
      throw new Error("Knowledge Base integrity_failure: malformed value.");
    }
    return result.value;
  }

  if (!isRecord(result.error) || typeof result.error.code !== "string") {
    throw new Error("Knowledge Base integrity_failure: malformed error.");
  }

  const revisionId =
    typeof result.error.revisionId === "string"
      ? " (" + result.error.revisionId + ")"
      : "";
  throw new Error("Knowledge Base " + result.error.code + revisionId + ".");
}

function normalizedQuery(query: string): string {
  return query.normalize("NFKC").trim().toLowerCase();
}

export function describeCustomVendor(): VendorDescription {
  return {
    displayName: "Custom Gatekeeper",
    url: "https://github.com/cloudflare/cloudflare-os-starter",
    logo: CUSTOM_ICON,
    color: "#e8f2ff",
    tagline: "Manager knowledge available to the CloudflareOS agent",
    description:
      "A private Manager-scoped Knowledge Base exposed through the native CloudflareOS agent runtime.",
    providesAuth: false,
  };
}

export function describeCustomAccount(): AccountDescription {
  return {
    displayName: "Knowledge Base",
    avatar: CUSTOM_ICON,
    singleton: { tsType: "KnowledgeBase" },
  };
}

@validateRpc()
export class KnowledgeSession extends RpcTarget implements KnowledgeBase {
  readonly #approvalQueue: ProposalQueue;
  readonly #access: ManagerKnowledgeAccessV1;
  readonly #propose: ProposalHandler | undefined;

  constructor(
    approvalQueue: ProposalQueue,
    access: ManagerKnowledgeAccessV1,
    propose?: ProposalHandler,
  ) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#access = access;
    this.#propose = propose;
  }

  async list(options?: KnowledgePageOptions): Promise<KnowledgePage> {
    const page = unwrapKnowledgeResult(
      await this.#access.list(options),
      isKnowledgePage,
    );
    await this.#approvalQueue.authorizeObservation({
      title: "Knowledge Base list",
      description: "Listed " + page.items.length + " current Knowledge Base source(s).",
    });
    return page;
  }

  async search(query: string, options?: KnowledgePageOptions): Promise<KnowledgePage> {
    const page = unwrapKnowledgeResult(
      await this.#access.search(query, options),
      isKnowledgePage,
    );
    await this.#approvalQueue.authorizeObservation({
      title: "Knowledge Base search",
      description:
        "Searched the Knowledge Base for " +
        normalizedQuery(query) +
        ". Returned " +
        page.items.length +
        " current source(s).",
    });
    return page;
  }

  async read(revisionId: string): Promise<KnowledgeSource> {
    const source = unwrapKnowledgeResult(
      await this.#access.read(revisionId),
      isKnowledgeSource,
    );
    await this.#approvalQueue.authorizeObservation({
      title: "Knowledge Base read",
      description:
        "Read current Knowledge Base source " +
        source.documentKey +
        " (" +
        source.revisionId +
        ").",
    });
    return source;
  }

  async proposeUpdate(input: KnowledgeProposalInput): Promise<void> {
    if (this.#propose === undefined) {
      throw gatekeeperError("integrity_failure");
    }
    return this.#propose(input);
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]?.();
  }
}

@validateRpc()
export class CustomGatekeeper
  extends DurableObject<Cloudflare.Env, KnowledgeGatekeeperProps>
  implements Gatekeeper<KnowledgeBase>
{
  readonly #actionTails = new Map<number, Promise<void>>();

  #access(): ManagerKnowledgeAccessV1 {
    return validateKnowledgeAccountProps(this.ctx.props as unknown).access;
  }

  #readActionRecord(actionId: number): KnowledgeActionRecord {
    const value = this.ctx.storage.kv.get<unknown>(actionKey(actionId));
    if (!isRecord(value) || value.version !== 1 || typeof value.state !== "string") {
      throw gatekeeperError("integrity_failure");
    }

    if (value.state === "applied" || value.state === "rejected") {
      if (Object.keys(value).length !== 2) throw gatekeeperError("integrity_failure");
      return value as KnowledgeActionTombstone;
    }

    if (
      value.state !== "pending" ||
      typeof value.revisionId !== "string" ||
      !CANONICAL_UUID.test(value.revisionId) ||
      typeof value.documentKey !== "string" ||
      !isValidDocumentKey(value.documentKey) ||
      typeof value.contentHash !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.contentHash) ||
      (value.baseSourceRevisionId !== null &&
        (typeof value.baseSourceRevisionId !== "string" ||
          !CANONICAL_UUID.test(value.baseSourceRevisionId))) ||
      bodyBytes(value.body) === null
    ) {
      throw gatekeeperError("integrity_failure");
    }

    return value as unknown as PendingKnowledgeAction;
  }

  #stageAction(
    proposal: KnowledgeProposal,
    contentHash: string,
    body: Uint8Array,
  ): number {
    const storedBody = body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer;

    return this.ctx.storage.transactionSync(() => {
      const storedNext = this.ctx.storage.kv.get<unknown>(ACTION_COUNTER_KEY);
      let nextActionId: number;
      if (storedNext === undefined) {
        nextActionId = 1;
      } else if (
        typeof storedNext !== "number" ||
        !Number.isSafeInteger(storedNext) ||
        storedNext <= 0
      ) {
        throw gatekeeperError("integrity_failure");
      } else {
        nextActionId = storedNext;
      }

      if (nextActionId >= MAX_SAFE_ACTION_ID) {
        throw gatekeeperError("capacity_exceeded");
      }

      this.ctx.storage.kv.put<PendingKnowledgeAction>(actionKey(nextActionId), {
        version: 1,
        state: "pending",
        revisionId: proposal.revisionId,
        documentKey: proposal.documentKey,
        baseSourceRevisionId: proposal.baseSourceRevisionId,
        contentHash,
        body: storedBody,
      });
      this.ctx.storage.kv.put(ACTION_COUNTER_KEY, nextActionId + 1);
      return nextActionId;
    });
  }

  async #proposeUpdate(
    approvalQueue: Pick<ApprovalQueue, "submitAction">,
    input: KnowledgeProposalInput,
  ): Promise<void> {
    assertProposalInput(input);
    const body = textBytes(input.content);
    const proposal: KnowledgeProposal = {
      revisionId: crypto.randomUUID(),
      ...input,
    };
    const contentHash = await bytesToHash(body);
    const actionId = this.#stageAction(proposal, contentHash, body);

    try {
      await approvalQueue.submitAction(actionId, {
        title: "Knowledge Base update",
        description: proposalDescription(proposal, contentHash),
        awaitDecision: true,
        autoApprovable: false,
        implementsRevert: false,
      });
    } catch (error) {
      this.ctx.storage.kv.delete(actionKey(actionId));
      throw error;
    }
  }

  #serializeAction(
    actionId: number,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.#actionTails.get(actionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.#actionTails.set(actionId, current);
    return current.finally(() => {
      if (this.#actionTails.get(actionId) === current) {
        this.#actionTails.delete(actionId);
      }
    });
  }

  async #applyActionNow(actionId: number): Promise<void> {
    const record = this.#readActionRecord(actionId);
    if (record.state === "applied") return;
    if (record.state === "rejected") throw gatekeeperError("integrity_failure");
    if (record.state !== "pending") throw gatekeeperError("integrity_failure");

    const body = bodyBytes(record.body);
    if (body === null || body.byteLength > MAX_BODY_BYTES) {
      throw gatekeeperError("integrity_failure");
    }
    const contentHash = await bytesToHash(body);
    if (contentHash !== record.contentHash) {
      throw gatekeeperError("integrity_failure");
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
    } catch {
      throw gatekeeperError("integrity_failure");
    }

    const reference = unwrapKnowledgeResult(
      await this.#access().applyProposal({
        revisionId: record.revisionId,
        documentKey: record.documentKey,
        baseSourceRevisionId: record.baseSourceRevisionId,
        content,
      }),
      isKnowledgeReference,
    );
    if (
      reference.revisionId !== record.revisionId ||
      reference.documentKey !== record.documentKey ||
      reference.contentHash !== record.contentHash
    ) {
      throw gatekeeperError("integrity_failure");
    }

    this.ctx.storage.kv.put<KnowledgeActionTombstone>(actionKey(actionId), {
      version: 1,
      state: "applied",
    });
  }

  async #rejectActionNow(actionId: number): Promise<void> {
    const record = this.#readActionRecord(actionId);
    if (record.state === "rejected") return;
    if (record.state === "applied") throw gatekeeperError("integrity_failure");
    if (record.state !== "pending") throw gatekeeperError("integrity_failure");

    unwrapKnowledgeResult(
      await this.#access().cancelProposal(record.revisionId),
      (value): value is null => value === null,
    );
    this.ctx.storage.kv.put<KnowledgeActionTombstone>(actionKey(actionId), {
      version: 1,
      state: "rejected",
    });
  }

  async describe(): Promise<ResourceDescription> {
    return {
      url: "knowledge://current",
      title: "Knowledge Base",
      snippet: "Current long-term knowledge available to this Manager.",
      suggestedBindingName: "KNOWLEDGE",
      tsType: "KnowledgeBase",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<KnowledgeSession> {
    const queue = approvalQueue.dup();
    return new KnowledgeSession(
      queue,
      this.#access(),
      (input) => this.#proposeUpdate(queue, input),
    );
  }

  async getAgentCatalog(
    request: AgentCatalogRequest,
    authorizer: RpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog> {
    const catalog = boundAgentCatalog(
      [
        {
          id: "knowledge-base",
          title: "Knowledge Base",
          description: "Available. Use list, search, and read when you need current knowledge.",
        },
      ],
      request,
    );
    await authorizer.authorizeObservation({
      title: "Knowledge Base catalog",
      description:
        "Listed " +
        catalog.entries.length +
        " Knowledge Base catalog entr" +
        (catalog.entries.length === 1 ? "y." : "ies."),
    });
    return catalog;
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error("Knowledge Base is private to its Manager.");
  }

  async removeObserver(_id: string): Promise<void> {}

  async applyAction(action: number): Promise<void> {
    if (!Number.isSafeInteger(action) || action <= 0) {
      throw gatekeeperError("integrity_failure");
    }
    return this.#serializeAction(action, () => this.#applyActionNow(action));
  }

  async rejectAction(action: number): Promise<void> {
    if (!Number.isSafeInteger(action) || action <= 0) {
      throw gatekeeperError("integrity_failure");
    }
    return this.#serializeAction(action, () => this.#rejectActionNow(action));
  }

  async revertAction(_action: number): Promise<void> {
    throw new Error("Knowledge Base requires a new proposal to change a previous update.");
  }
}

@validateRpc()
export class CustomAccount
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUser
{
  async describe(): Promise<AccountDescription> {
    return describeCustomAccount();
  }

  async inspectManagerBinding(managerId: string): Promise<"legacy" | "bound"> {
    assertManagerId(managerId);
    if (isLegacyAccountProps(this.ctx.props)) return "legacy";
    const props = validateKnowledgeAccountProps(this.ctx.props as unknown);
    await props.access.assertBoundTo(managerId);
    return "bound";
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<KnowledgeBase>>> {
    const props = validateKnowledgeAccountProps(this.ctx.props as unknown);
    return this.ctx.exports.CustomGatekeeper({ props });
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("Knowledge Base has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Knowledge Base has no URL-addressed resources.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("Knowledge Base has no credentials to reconnect.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.CustomVerifier({});
  }
}

@validateRpc()
export class CustomVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return describeCustomVendor();
  }

  @skipRpcValidation()
  async createManagerAccount(
    managerId: string,
    capability: ManagerKnowledgeAccessV1,
  ): Promise<Fetcher<GatekeeperUser>> {
    assertManagerId(managerId);
    const access = validateStub<ManagerKnowledgeAccessV1>(capability as object);
    await access.assertBoundTo(managerId);
    return this.ctx.exports.CustomAccount({ props: { access: capability } });
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Knowledge Base is installed by the Manager runtime and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
