import {
  RpcStub,
  RpcTarget,
  WorkerEntrypoint,
  DurableObject,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc, validateStub } from "capnweb-validate";
import { boundAgentCatalog } from "@gadgets/workshop-shared/gatekeeper";
import type {
  AccountDescription,
  ActionDescription,
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
  SupportedResource,
  VendorDescription,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import TYPES_CODE from "./types-code.js";
const CUSTOM_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'><path d='M32 32h192v192H32z'/></svg>",
    ),
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_DOC = 65536;
const MAX_PAGE = 50;
type ListInput = { cursor?: string; limit?: number };
type BronzeInput = { sourceId: string; revisionId?: string };
type ArticleMeaning = "proposal" | "inference" | "explicit_decision" | "observed_result";
type ArticleSourceKind =
  | "conversation"
  | "tool_result"
  | "explicit_user_input"
  | "user_document"
  | "artifact";
type ArticleActorKind = "user" | "assistant" | "tool" | "system";
type ArticleSection = { text: string; meaning: ArticleMeaning; sourceIds: string[] };
type ArticleSource = {
  sourceId: string;
  kind: ArticleSourceKind;
  reference: string;
  version?: string;
  contentHash?: string;
  actor: { kind: ArticleActorKind; reference?: string };
  recordedAt: string;
  eventAt?: string;
  excerpt?: string;
};
type Article = { sections: ArticleSection[]; sources: ArticleSource[] };
type ArticleCommand = {
  protocolVersion: "activity-article/1";
  operationId: string;
  actionRef: string;
  article: Article;
};
type ArticleReceipt = {
  receiptId: string;
  knowledgeId: string;
  generation: 1;
  operationId: string;
  actionRef: string;
  payloadHash: string;
  articleId: string;
  revisionId: string;
  revisionNumber: 1;
  committedAt: string;
};
type ArticleTerminalFailure =
  | "service_not_ready"
  | "capacity_exceeded"
  | "forbidden"
  | "invalid_input"
  | "article_too_large"
  | "operation_conflict"
  | "integrity_failure";
type ArticleOutcome =
  | { operationId: string; status: "pending_approval" }
  | { operationId: string; status: "outcome_unknown"; reason: "outcome_unknown" }
  | { operationId: string; status: "failed"; reason: ArticleTerminalFailure }
  | {
      operationId: string;
      status: "applied";
      outcome: "committed" | "already_committed";
      receipt: ArticleReceipt;
    };
type BronzeProvenance = {
  sourceKind: "conversation" | "user_document" | "explicit_user_input";
  reference: string;
  capturedAt: string;
};
type BronzeAdoptionInput = {
  document: string;
  provenance: BronzeProvenance;
};
type BronzeIdentity = {
  knowledgeId: string;
  generation: 1;
};
type BronzeReceipt = {
  receiptId: string;
  knowledgeId: string;
  generation: 1;
  operationId: string;
  sourceId: string;
  revisionId: string;
  revisionNumber: 1;
  contentHash: string;
  committedAt: string;
};
type KnowledgeAdoptionOutcome =
  | { operationId: string; status: "pending_approval" }
  | { operationId: string; status: "outcome_unknown"; reason: "outcome_unknown" }
  | { operationId: string; status: "failed"; reason: BronzeTerminalFailure }
  | {
      operationId: string;
      status: "applied";
      outcome: "committed" | "already_committed";
      receipt: BronzeReceipt;
    };
export type KnowledgeAccess = {
  assertBoundTo(managerId: string): Promise<void>;
  list(input?: ListInput): Promise<unknown>;
  readBronze(
    input: { knowledgeId: string; generation: 1 } & BronzeInput,
  ): Promise<unknown>;
  createKnowledge(input: {
    operationId: string;
    actionRef: string;
    displayName: string;
  }): Promise<unknown>;
  readCreationOutcome(input: { operationId: string }): Promise<unknown>;
  adoptBronze(input: {
    operationId: string;
    actionRef: string;
    knowledgeId: string;
    generation: 1;
    document: string;
    contentHash: string;
    provenance: BronzeProvenance;
  }): Promise<unknown>;
  readAdoptionOutcome(input: {
    operationId: string;
    knowledgeId: string;
    generation: 1;
  }): Promise<unknown>;
  saveArticle(input: { commandJson: string; payloadHash: string }): Promise<unknown>;
  readArticle(input: { articleId: string; revisionId: string }): Promise<unknown>;
};
type Access = KnowledgeAccess;
type Summary = {
  knowledgeId: string;
  generation: 1;
  displayName: string;
  role: "initial" | "additional";
  state: "provisioning" | "ready" | "blocked";
  createdAt: string;
  updatedAt: string;
};
type Page = {
  items: Array<Summary & { access?: Knowledge }>;
  nextCursor: string | null;
};
type Revision = {
  knowledgeId: string;
  generation: 1;
  sourceId: string;
  revisionId: string;
  revisionNumber: 1;
  baseRevisionId: string | null;
  document: string;
  contentHash: string;
  type: "Source";
  title: string;
  description: string;
  provenance: {
    sourceKind: "conversation" | "user_document" | "explicit_user_input";
    reference: string;
    capturedAt: string;
  };
  committedAt: string;
};
export type KnowledgeAccountProps = { managerId: string };
const err = (tag: string) => new Error("Knowledge Base " + tag + ".");
const rec = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const prototype = Object.getPrototypeOf(v);
  return prototype === Object.prototype || prototype === null;
};
const exact = (v: Record<string, unknown>, k: readonly string[]) =>
  Object.keys(v).length === k.length &&
  k.every((x) => Object.prototype.hasOwnProperty.call(v, x));
const uuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const time = (v: unknown): v is string => {
  if (typeof v !== "string" || !TS.test(v)) return false;
  try {
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === v;
  } catch {
    return false;
  }
};
const text = (v: unknown, max: number, nonEmpty = true): v is string => {
  if (typeof v !== "string" || (nonEmpty && !v.length)) return false;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c >= 55296 && c <= 56319) {
      if (i + 1 >= v.length) return false;
      const n = v.charCodeAt(++i);
      if (n < 56320 || n > 57343) return false;
    } else if (c >= 56320 && c <= 57343) return false;
  }
  return new TextEncoder().encode(v).byteLength <= max;
};
const visible = (v: unknown, max: number): v is string =>
  text(v, max) &&
  v.trim() === v &&
  v.trim().length > 0 &&
  !/[\u0000-\u001F\u007F-\u009F\u2028\u2029\uFEFF]/u.test(v);
const boundedInvalidInputIssues = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length <= 16 &&
  value.every((issue) => text(issue, 128));
const validInvalidInputResult = (value: Record<string, unknown>): boolean =>
  exact(value, ["_tag"]) ||
  (exact(value, ["_tag", "issues"]) && boundedInvalidInputIssues(value.issues));
const projectionText = (v: unknown, max: number): v is string =>
  text(v, max) && v.trim().length > 0;
const documentText = (v: unknown, max: number): v is string => {
  if (!text(v, max)) return false;
  for (let i = 0; i < v.length; i += 1) {
    const code = v.charCodeAt(i);
    if (code === 0xfeff && i !== 0) return false;
    if ((code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f)
      return false;
    if (code >= 0xd800 && code <= 0xdbff) i += 1;
  }
  return true;
};

const LIST_FAILURE_TAGS = [
  "forbidden",
  "service_not_ready",
  "invalid_input",
  "integrity_failure",
  "deadline_exceeded",
  "dependency_unavailable",
] as const;
const BRONZE_FAILURE_TAGS = [
  "forbidden",
  "service_not_ready",
  "invalid_input",
  "integrity_failure",
  "deadline_exceeded",
  "dependency_unavailable",
  "provisioning",
  "blocked",
] as const;
const DEPENDENCIES = [
  "operator-authority",
  "knowledge-read",
  "manager-root",
  "knowledge-agent",
] as const;
const LIST_DEPENDENCIES = [
  "operator-authority",
  "knowledge-read",
  "manager-root",
] as const;
type FailureTag = (typeof LIST_FAILURE_TAGS)[number] | (typeof BRONZE_FAILURE_TAGS)[number];
const failure = (
  value: unknown,
  allowed: readonly string[],
  dependencies: readonly string[] = DEPENDENCIES,
): FailureTag | undefined => {
  if (!rec(value) || typeof value._tag !== "string") return;
  if (value._tag === "dependency_unavailable") {
    return exact(value, ["_tag", "dependency"]) &&
      typeof value.dependency === "string" &&
      dependencies.includes(value.dependency)
      ? (value._tag as FailureTag)
      : undefined;
  }
  return exact(value, ["_tag"]) && allowed.includes(value._tag)
    ? (value._tag as FailureTag)
    : undefined;
};
const observation = (title: string, description: string) => ({
  title,
  description,
  prohibitAllSharing: true,
});
const MAX_PENDING_PROPOSALS = 64;
const MAX_ARTICLE_BYTES = 65536;
const MAX_ARTICLE_COMMAND_BYTES = 1048576;
const ARTICLE_ACTION_KIND = "knowledge.activity-article";
const ACTION_KIND = "knowledge.create";
const BRONZE_ACTION_KIND = "knowledge.bronze.adopt";
const BRONZE_ADOPTION_FAILURE_TAGS = [
  "service_not_ready",
  "not_found",
  "provisioning",
  "blocked",
  "forbidden",
  "invalid_input",
  "payload_too_large",
  "operation_conflict",
  "integrity_failure",
  "deadline_exceeded",
  "outcome_unknown",
  "dependency_unavailable",
] as const;
type BronzeFailure = (typeof BRONZE_ADOPTION_FAILURE_TAGS)[number];
const BRONZE_ADOPTION_TERMINAL_FAILURE_TAGS = [
  "service_not_ready",
  "not_found",
  "provisioning",
  "blocked",
  "forbidden",
  "invalid_input",
  "payload_too_large",
  "operation_conflict",
] as const;
type BronzeTerminalFailure = (typeof BRONZE_ADOPTION_TERMINAL_FAILURE_TAGS)[number];
type ProposalResult = { operationId: string; status: "pending_approval" };
type CreationStatus =
  | "pending_approval"
  | "applying"
  | "applied"
  | "outcome_unknown"
  | "failed";
type CreationOutcome = {
  operationId: string;
  status: CreationStatus;
  outcome?: "ready" | "already_ready" | "provisioning" | "blocked";
  knowledge?: Summary;
  reason?: CreationTerminalFailure | "outcome_unknown";
};
type ProposalPort = {
  propose(displayName: string, queue: RpcStub<ApprovalQueue>): Promise<ProposalResult>;
  readOutcome(
    operationId: string,
    queue: RpcStub<ApprovalQueue>,
  ): Promise<CreationOutcome | null>;
  proposeBronze(
    input: BronzeAdoptionInput,
    identity: BronzeIdentity,
    displayName: string,
    queue: RpcStub<ApprovalQueue>,
  ): Promise<ProposalResult>;
  readBronzeOutcome(
    operationId: string,
    identity: BronzeIdentity,
    queue: RpcStub<ApprovalQueue>,
  ): Promise<KnowledgeAdoptionOutcome | null>;
  proposeArticle(article: Article, queue: RpcStub<ApprovalQueue>): Promise<ProposalResult>;
  readArticleOutcome(
    operationId: string,
    queue: RpcStub<ApprovalQueue>,
  ): Promise<ArticleOutcome | null>;
};
type StoredAction = {
  local_action_id: number;
  operation_id: string;
  action_ref: string;
  kind: string;
  display_name: string;
  status: "pending_approval" | "applying" | "applied" | "failed";
  payload_fingerprint: string;
  outcome_json: string | null;
};
type StoredArticleAction = {
  local_action_id: number;
  operation_id: string;
  action_ref: string;
  kind: string;
  command_json: string;
  payload_hash: string;
  status: "pending_approval" | "applying" | "applied" | "failed";
  outcome_json: string | null;
};
type StoredBronzeAction = {
  local_action_id: number;
  operation_id: string;
  action_ref: string;
  kind: string;
  knowledge_id: string;
  generation: 1;
  display_name: string;
  document: string | null;
  content_hash: string;
  source_kind: BronzeProvenance["sourceKind"];
  reference: string;
  captured_at: string;
  status: "pending_approval" | "applying" | "applied" | "failed";
  payload_fingerprint: string;
  outcome_json: string | null;
  outcome_observed: number;
};
const creationFailureTags = [
  "service_not_ready",
  "capacity_exceeded",
  "forbidden",
  "invalid_input",
  "operation_conflict",
  "integrity_failure",
  "deadline_exceeded",
  "outcome_unknown",
  "dependency_unavailable",
] as const;
type CreationFailure = (typeof creationFailureTags)[number];
const creationTerminalFailureTags = [
  "service_not_ready",
  "capacity_exceeded",
  "forbidden",
  "invalid_input",
  "operation_conflict",
  "integrity_failure",
] as const;
type CreationTerminalFailure = (typeof creationTerminalFailureTags)[number];
const creationStateForTag = (tag: "ready" | "provisioning" | "blocked"): Summary["state"] =>
  tag === "ready" ? "ready" : tag;
const creationSummary = (
  value: unknown,
  displayName: string,
  expectedState: Summary["state"],
): Summary | undefined => {
  const candidate = summary(value);
  return candidate !== undefined &&
    candidate.role === "additional" &&
    candidate.displayName === displayName &&
    candidate.state === expectedState
    ? candidate
    : undefined;
};
const creationResult = (
  value: unknown,
  operationId: string,
  displayName: string,
): { outcome: CreationOutcome } | { failure: CreationFailure } | undefined => {
  if (!rec(value) || typeof value._tag !== "string") return;
  if (value._tag === "ready") {
    if (
      !exact(value, ["_tag", "outcome", "operationId", "knowledge"]) ||
      value.operationId !== operationId ||
      !(value.outcome === "ready" || value.outcome === "already_ready")
    )
      return;
    const knowledge = creationSummary(value.knowledge, displayName, "ready");
    return knowledge
      ? { outcome: { operationId, status: "applied", outcome: value.outcome, knowledge } }
      : undefined;
  }
  if (value._tag === "provisioning" || value._tag === "blocked") {
    if (!exact(value, ["_tag", "outcome", "operationId", "knowledge"]) || value.operationId !== operationId || value.outcome !== value._tag)
      return;
    const knowledge = creationSummary(value.knowledge, displayName, creationStateForTag(value._tag));
    return knowledge
      ? { outcome: { operationId, status: "applied", outcome: value._tag, knowledge } }
      : undefined;
  }
  if (value._tag === "invalid_input") {
    return validInvalidInputResult(value) ? { failure: "invalid_input" } : undefined;
  }
  if (value._tag === "dependency_unavailable") {
    return exact(value, ["_tag", "dependency"]) && value.dependency === "knowledge-agent"
      ? { failure: "dependency_unavailable" }
      : undefined;
  }
  if (creationFailureTags.includes(value._tag as CreationFailure)) {
    return exact(value, ["_tag"]) ? { failure: value._tag as CreationFailure } : undefined;
  }
  return undefined;
};
const outcomeResult = (
  value: unknown,
  operationId: string,
  displayName: string,
): { outcome: CreationOutcome } | { failure: CreationFailure } | undefined => {
  if (!rec(value) || typeof value._tag !== "string") return;
  if (value._tag === "unobserved") {
    return exact(value, ["_tag", "operationId"]) && value.operationId === operationId
      ? { outcome: { operationId, status: "outcome_unknown", reason: "outcome_unknown" } }
      : undefined;
  }
  if (value._tag === "ready" || value._tag === "provisioning" || value._tag === "blocked") {
    if (!exact(value, ["_tag", "operationId", "knowledge"]) || value.operationId !== operationId)
      return;
    const knowledge = creationSummary(value.knowledge, displayName, creationStateForTag(value._tag));
    return knowledge
      ? { outcome: { operationId, status: "applied", outcome: value._tag, knowledge } }
      : undefined;
  }
  if (value._tag === "invalid_input") {
    return validInvalidInputResult(value) ? { failure: "invalid_input" } : undefined;
  }
  if (value._tag === "dependency_unavailable") {
    return exact(value, ["_tag", "dependency"]) && value.dependency === "knowledge-agent"
      ? { failure: "dependency_unavailable" }
      : undefined;
  }
  return creationFailureTags.includes(value._tag as CreationFailure) && exact(value, ["_tag"])
    ? { failure: value._tag as CreationFailure }
    : undefined;
};
const toFailureOutcome = (operationId: string, reason: CreationTerminalFailure): CreationOutcome => ({
  operationId,
  status: "failed",
  reason,
});
const storedOutcome = (
  value: string | null,
  operationId: string,
  displayName: string,
): CreationOutcome | undefined => {
  if (value === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return;
  }
  if (!rec(parsed) || parsed.operationId !== operationId || typeof parsed.status !== "string") return;
  if (parsed.status === "failed") {
    return exact(parsed, ["operationId", "status", "reason"]) &&
      creationTerminalFailureTags.includes(parsed.reason as CreationTerminalFailure)
      ? { operationId, status: "failed", reason: parsed.reason as CreationTerminalFailure }
      : undefined;
  }
  if (parsed.status !== "applied" || !exact(parsed, ["operationId", "status", "outcome", "knowledge"])) return;
  if (!(parsed.outcome === "ready" || parsed.outcome === "already_ready" || parsed.outcome === "provisioning" || parsed.outcome === "blocked")) return;
  const knowledge = creationSummary(
    parsed.knowledge,
    displayName,
    parsed.outcome === "ready" || parsed.outcome === "already_ready" ? "ready" : parsed.outcome,
  );
  return knowledge ? { operationId, status: "applied", outcome: parsed.outcome, knowledge } : undefined;
};
const payloadHash = async (
  operationId: string,
  actionRef: string,
  displayName: string,
): Promise<string> => {
  const value = JSON.stringify([1, ACTION_KIND, operationId, actionRef, displayName]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const documentHash = async (document: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(document),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const bronzeFingerprint = async (input: {
  operationId: string;
  actionRef: string;
  knowledgeId: string;
  generation: 1;
  displayName: string;
  contentHash: string;
  provenance: BronzeProvenance;
}): Promise<string> => {
  const canonical = JSON.stringify([
    1,
    BRONZE_ACTION_KIND,
    input.operationId,
    input.actionRef,
    input.knowledgeId,
    input.generation,
    input.displayName,
    input.contentHash,
    [
      input.provenance.sourceKind,
      input.provenance.reference,
      input.provenance.capturedAt,
    ],
  ]);
  return documentHash(canonical);
};

const validBronzeProvenance = (value: unknown): value is BronzeProvenance =>
  rec(value) &&
  exact(value, ["sourceKind", "reference", "capturedAt"]) &&
  (["conversation", "user_document", "explicit_user_input"] as unknown[]).includes(
    value.sourceKind,
  ) &&
  visible(value.reference, 512) &&
  time(value.capturedAt);

const validBronzeInput = (value: unknown): value is BronzeAdoptionInput =>
  rec(value) &&
  exact(value, ["document", "provenance"]) &&
  documentText(value.document, MAX_DOC) &&
  validBronzeProvenance(value.provenance);

const ARTICLE_MEANINGS = [
  "proposal",
  "inference",
  "explicit_decision",
  "observed_result",
] as const;
const ARTICLE_SOURCE_KINDS = [
  "conversation",
  "tool_result",
  "explicit_user_input",
  "user_document",
  "artifact",
] as const;
const ARTICLE_TRANSIENT_SOURCE_KINDS = [
  "conversation",
  "tool_result",
  "explicit_user_input",
] as const;
const ARTICLE_ACTOR_KINDS = ["user", "assistant", "tool", "system"] as const;
const hasOnlyRequiredAndOptional = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean =>
  required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const articleSourceId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
const articleContentText = (value: unknown): value is string =>
  text(value, MAX_ARTICLE_COMMAND_BYTES);
const validArticleSection = (value: unknown): value is ArticleSection =>
  rec(value) &&
  exact(value, ["text", "meaning", "sourceIds"]) &&
  articleContentText(value.text) &&
  (ARTICLE_MEANINGS as readonly unknown[]).includes(value.meaning) &&
  Array.isArray(value.sourceIds) &&
  value.sourceIds.length > 0 &&
  value.sourceIds.length <= 64 &&
  value.sourceIds.every(articleSourceId) &&
  new Set(value.sourceIds).size === value.sourceIds.length;
const validArticleSource = (value: unknown): value is ArticleSource => {
  if (
    !rec(value) ||
    !hasOnlyRequiredAndOptional(
      value,
      ["sourceId", "kind", "reference", "actor", "recordedAt"],
      ["version", "contentHash", "eventAt", "excerpt"],
    ) ||
    !articleSourceId(value.sourceId) ||
    !(ARTICLE_SOURCE_KINDS as readonly unknown[]).includes(value.kind) ||
    !visible(value.reference, 512) ||
    !rec(value.actor) ||
    !hasOnlyRequiredAndOptional(value.actor, ["kind"], ["reference"]) ||
    !(ARTICLE_ACTOR_KINDS as readonly unknown[]).includes(value.actor.kind) ||
    (Object.prototype.hasOwnProperty.call(value.actor, "reference") &&
      !visible(value.actor.reference, 256)) ||
    !time(value.recordedAt) ||
    (Object.prototype.hasOwnProperty.call(value, "eventAt") && !time(value.eventAt)) ||
    (Object.prototype.hasOwnProperty.call(value, "version") && !visible(value.version, 128)) ||
    (Object.prototype.hasOwnProperty.call(value, "contentHash") &&
      (typeof value.contentHash !== "string" || !/^[0-9a-f]{64}$/u.test(value.contentHash))) ||
    (Object.prototype.hasOwnProperty.call(value, "excerpt") && !articleContentText(value.excerpt))
  )
    return false;
  if (
    (ARTICLE_TRANSIENT_SOURCE_KINDS as readonly unknown[]).includes(value.kind)
      ? !Object.prototype.hasOwnProperty.call(value, "excerpt")
      : !Object.prototype.hasOwnProperty.call(value, "version") &&
        !Object.prototype.hasOwnProperty.call(value, "contentHash")
  )
    return false;
  return true;
};
const articleContentByteLength = (value: unknown): number | undefined => {
  if (!rec(value) || !Array.isArray(value.sections) || !Array.isArray(value.sources)) return;
  let bytes = 0;
  for (const section of value.sections) {
    if (!rec(section) || typeof section.text !== "string") return;
    bytes += new TextEncoder().encode(section.text).byteLength;
  }
  for (const source of value.sources) {
    if (!rec(source)) return;
    if (source.excerpt !== undefined) {
      if (typeof source.excerpt !== "string") return;
      bytes += new TextEncoder().encode(source.excerpt).byteLength;
    }
  }
  return bytes;
};
const validArticleShape = (value: unknown): value is Article => {
  if (
    !rec(value) ||
    !exact(value, ["sections", "sources"]) ||
    !Array.isArray(value.sections) ||
    value.sections.length === 0 ||
    value.sections.length > 64 ||
    !value.sections.every(validArticleSection) ||
    !Array.isArray(value.sources) ||
    value.sources.length === 0 ||
    value.sources.length > 64 ||
    !value.sources.every(validArticleSource)
  )
    return false;
  const sourceIds = new Set(value.sources.map((source) => source.sourceId));
  if (sourceIds.size !== value.sources.length) return false;
  const usedSourceIds = new Set(value.sections.flatMap((section) => section.sourceIds));
  if (
    usedSourceIds.size !== sourceIds.size ||
    [...usedSourceIds].some((sourceId) => !sourceIds.has(sourceId))
  )
    return false;
  return true;
};
const validArticle = (value: unknown): value is Article =>
  validArticleShape(value) &&
  (articleContentByteLength(value) ?? MAX_ARTICLE_BYTES + 1) <= MAX_ARTICLE_BYTES;
const articleBody = (article: Article): string =>
  article.sections.map((section) => section.text).join("");
const validArticleCommand = (value: unknown): value is ArticleCommand =>
  rec(value) &&
  exact(value, ["protocolVersion", "operationId", "actionRef", "article"]) &&
  value.protocolVersion === "activity-article/1" &&
  uuid(value.operationId) &&
  uuid(value.actionRef) &&
  validArticle(value.article);
const decodeArticleCommand = (commandJson: string): ArticleCommand | undefined => {
  if (new TextEncoder().encode(commandJson).byteLength > MAX_ARTICLE_COMMAND_BYTES) return;
  try {
    const parsed: unknown = JSON.parse(commandJson);
    return validArticleCommand(parsed) ? parsed : undefined;
  } catch {
    return;
  }
};
const sameArticle = (left: Article, right: Article): boolean =>
  left.sections.length === right.sections.length &&
  left.sources.length === right.sources.length &&
  left.sections.every((section, index) => {
    const other = right.sections[index];
    return other !== undefined &&
      section.text === other.text &&
      section.meaning === other.meaning &&
      section.sourceIds.length === other.sourceIds.length &&
      section.sourceIds.every((sourceId, sourceIndex) => sourceId === other.sourceIds[sourceIndex]);
  }) &&
  left.sources.every((source, index) => {
    const other = right.sources[index];
    return other !== undefined &&
      source.sourceId === other.sourceId &&
      source.kind === other.kind &&
      source.reference === other.reference &&
      source.version === other.version &&
      source.contentHash === other.contentHash &&
      source.actor.kind === other.actor.kind &&
      source.actor.reference === other.actor.reference &&
      source.recordedAt === other.recordedAt &&
      source.eventAt === other.eventAt &&
      source.excerpt === other.excerpt;
  });

const maxFenceRun = (value: string, character: string): number => {
  let max = 0;
  const pattern = new RegExp(
    character === String.fromCharCode(96)
      ? String.fromCharCode(96) + "+"
      : "~+",
    "gu",
  );
  for (const match of value.matchAll(pattern)) max = Math.max(max, match[0].length);
  return max;
};

const articleReviewDescription = (commandJson: string): string => {
  const command = decodeArticleCommand(commandJson);
  if (command === undefined) throw err("integrity_failure");
  const body = articleBody(command.article);
  const values = [
    body,
    ...command.article.sections.map((section) => section.text),
    ...command.article.sources.flatMap((source) => [
      source.reference,
      source.version ?? "",
      source.contentHash ?? "",
      source.actor.reference ?? "",
      source.excerpt ?? "",
    ]),
  ];
  const backticks = Math.max(
    ...values.map((value) => maxFenceRun(value, String.fromCharCode(96))),
    0,
  );
  const tildes = Math.max(...values.map((value) => maxFenceRun(value, "~")), 0);
  const backtickLength = Math.max(backticks, 2) + 1;
  const tildeLength = Math.max(tildes, 2) + 1;
  const fenceCharacter = backtickLength <= tildeLength ? String.fromCharCode(96) : "~";
  const fenceLength = fenceCharacter === String.fromCharCode(96) ? backtickLength : tildeLength;
  const fence = fenceCharacter.repeat(fenceLength);
  const lines = [
    "Review the complete Activity Article before saving it to Personal Knowledge.",
    "body (section text concatenated in order):",
    fence,
    body,
    fence,
    "sections:",
  ];
  command.article.sections.forEach((section, index) => {
    lines.push(
      `${index + 1}. meaning=${section.meaning}`,
      `sourceIds=${section.sourceIds.join(", ")}`,
      "text:",
      fence,
      section.text,
      fence,
    );
  });
  lines.push("sources:");
  command.article.sources.forEach((source, index) => {
    lines.push(
      `source ${index + 1} metadata:`,
      fence,
      `sourceId=${source.sourceId}`,
      `kind=${source.kind}`,
      `reference=${source.reference}`,
      `version=${source.version ?? "(not provided)"}`,
      `contentHash=${source.contentHash ?? "(not provided)"}`,
      `actor.kind=${source.actor.kind}`,
      `actor.reference=${source.actor.reference ?? "(not provided)"}`,
      `recordedAt=${source.recordedAt}`,
      `eventAt=${source.eventAt ?? "(not provided)"}`,
      fence,
    );
    if (source.excerpt !== undefined) {
      lines.push("source excerpt:", fence, source.excerpt, fence);
    } else {
      lines.push("source excerpt: (not provided)");
    }
    lines.push("");
  });
  return lines.join("\n");
};

const bronzeReviewDescription = (input: {
  displayName: string;
  document: string;
  contentHash: string;
  provenance: BronzeProvenance;
}): string => {
  const values = [
    input.displayName,
    input.provenance.sourceKind,
    input.provenance.reference,
    input.provenance.capturedAt,
    input.document,
  ];
  const backticks = Math.max(
    ...values.map((value) => maxFenceRun(value, String.fromCharCode(96))),
    0,
  );
  const tildes = Math.max(...values.map((value) => maxFenceRun(value, "~")), 0);
  const backtickLength = Math.max(backticks, 2) + 1;
  const tildeLength = Math.max(tildes, 2) + 1;
  const fenceCharacter = backtickLength <= tildeLength ? String.fromCharCode(96) : "~";
  const fenceLength = fenceCharacter === String.fromCharCode(96) ? backtickLength : tildeLength;
  const fence = fenceCharacter.repeat(fenceLength);
  return [
    "Review one create-only Knowledge Bronze adoption.",
    fence,
    "targetDisplayName=" + input.displayName,
    "sourceKind=" + input.provenance.sourceKind,
    "reference=" + input.provenance.reference,
    "capturedAt=" + input.provenance.capturedAt,
    "utf8Bytes=" + new TextEncoder().encode(input.document).byteLength,
    "contentHash=" + input.contentHash,
    "document:",
    input.document,
    fence,
  ].join("\n");
};

const validStoredAction = (row: StoredAction): boolean =>
  Number.isSafeInteger(row.local_action_id) &&
  row.local_action_id >= 1 &&
  uuid(row.operation_id) &&
  uuid(row.action_ref) &&
  row.kind === ACTION_KIND &&
  visible(row.display_name, 120) &&
  ["pending_approval", "applying", "applied", "failed"].includes(row.status) &&
  /^[0-9a-f]{64}$/u.test(row.payload_fingerprint);

const validStoredArticleAction = (row: StoredArticleAction): boolean =>
  Number.isSafeInteger(row.local_action_id) &&
  row.local_action_id >= 1 &&
  uuid(row.operation_id) &&
  uuid(row.action_ref) &&
  row.kind === ARTICLE_ACTION_KIND &&
  typeof row.command_json === "string" &&
  new TextEncoder().encode(row.command_json).byteLength <= MAX_ARTICLE_COMMAND_BYTES &&
  /^[0-9a-f]{64}$/u.test(row.payload_hash) &&
  ["pending_approval", "applying", "applied", "failed"].includes(row.status);

const articleReceipt = (
  value: unknown,
  row: StoredArticleAction,
  command: ArticleCommand,
): ArticleReceipt | undefined => {
  if (
    !rec(value) ||
    !exact(value, [
      "receiptId",
      "knowledgeId",
      "generation",
      "operationId",
      "actionRef",
      "payloadHash",
      "articleId",
      "revisionId",
      "revisionNumber",
      "committedAt",
    ]) ||
    !uuid(value.receiptId) ||
    !uuid(value.knowledgeId) ||
    value.generation !== 1 ||
    value.operationId !== row.operation_id ||
    value.operationId !== command.operationId ||
    value.actionRef !== row.action_ref ||
    value.actionRef !== command.actionRef ||
    value.payloadHash !== row.payload_hash ||
    !/^[0-9a-f]{64}$/u.test(String(value.payloadHash)) ||
    !uuid(value.articleId) ||
    !uuid(value.revisionId) ||
    value.revisionNumber !== 1 ||
    !time(value.committedAt)
  )
    return;
  return value as ArticleReceipt;
};

const storedArticleOutcome = (
  value: string | null,
  row: StoredArticleAction,
  command: ArticleCommand,
): ArticleOutcome | undefined => {
  if (value === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return;
  }
  if (!rec(parsed) || parsed.operationId !== row.operation_id) return;
  if (parsed.status === "failed") {
    return exact(parsed, ["operationId", "status", "reason"]) &&
      ARTICLE_TERMINAL_FAILURES.includes(parsed.reason as ArticleTerminalFailure)
      ? (parsed as ArticleOutcome)
      : undefined;
  }
  if (
    parsed.status !== "applied" ||
    !exact(parsed, ["operationId", "status", "outcome", "receipt"]) ||
    (parsed.outcome !== "committed" && parsed.outcome !== "already_committed")
  )
    return;
  const receipt = articleReceipt(parsed.receipt, row, command);
  return receipt === undefined ? undefined : (parsed as ArticleOutcome);
};

const ARTICLE_TERMINAL_FAILURES: readonly ArticleTerminalFailure[] = [
  "service_not_ready",
  "capacity_exceeded",
  "forbidden",
  "invalid_input",
  "article_too_large",
  "operation_conflict",
  "integrity_failure",
];
const articleSaveResult = (
  value: unknown,
  row: StoredArticleAction,
  command: ArticleCommand,
):
  | { outcome: "committed" | "already_committed"; receipt: ArticleReceipt }
  | { failure: ArticleTerminalFailure }
  | { uncertain: true }
  | undefined => {
  if (!rec(value) || typeof value._tag !== "string") return;
  if (value._tag === "committed" || value._tag === "already_committed") {
    if (!exact(value, ["_tag", "receipt"])) return;
    const receipt = articleReceipt(value.receipt, row, command);
    return receipt === undefined
      ? undefined
      : { outcome: value._tag, receipt };
  }
  if (value._tag === "dependency_unavailable") {
    return exact(value, ["_tag", "dependency"]) &&
      (value.dependency === "knowledge-control" || value.dependency === "knowledge-agent")
      ? { uncertain: true }
      : undefined;
  }
  if (
    value._tag === "deadline_exceeded" ||
    value._tag === "outcome_unknown" ||
    value._tag === "not_found"
  )
    return exact(value, ["_tag"]) ? { uncertain: true } : undefined;
  return ARTICLE_TERMINAL_FAILURES.includes(value._tag as ArticleTerminalFailure) &&
    exact(value, ["_tag"])
    ? { failure: value._tag as ArticleTerminalFailure }
    : undefined;
};

const exactArticleReadMatches = (
  value: unknown,
  row: StoredArticleAction,
  command: ArticleCommand,
  receipt: ArticleReceipt,
): boolean =>
  rec(value) &&
  exact(value, [
    "_tag",
    "knowledgeId",
    "generation",
    "articleId",
    "revisionId",
    "revisionNumber",
    "committedAt",
    "operationId",
    "actionRef",
    "payloadHash",
    "article",
    "body",
  ]) &&
  value._tag === "found" &&
  value.knowledgeId === receipt.knowledgeId &&
  value.generation === receipt.generation &&
  value.articleId === receipt.articleId &&
  value.revisionId === receipt.revisionId &&
  value.revisionNumber === receipt.revisionNumber &&
  value.committedAt === receipt.committedAt &&
  value.operationId === row.operation_id &&
  value.operationId === command.operationId &&
  value.actionRef === row.action_ref &&
  value.actionRef === command.actionRef &&
  value.payloadHash === row.payload_hash &&
  validArticle(value.article) &&
  sameArticle(value.article, command.article) &&
  typeof value.body === "string" &&
  value.body === articleBody(command.article);

const validStoredArticleCommand = (
  row: StoredArticleAction,
): ArticleCommand | undefined => {
  const command = decodeArticleCommand(row.command_json);
  if (
    command === undefined ||
    command.operationId !== row.operation_id ||
    command.actionRef !== row.action_ref
  )
    return;
  return command;
};

const validStoredBronzeAction = (row: StoredBronzeAction): boolean =>
  Number.isSafeInteger(row.local_action_id) &&
  row.local_action_id >= 1 &&
  uuid(row.operation_id) &&
  uuid(row.action_ref) &&
  row.kind === BRONZE_ACTION_KIND &&
  uuid(row.knowledge_id) &&
  row.generation === 1 &&
  visible(row.display_name, 120) &&
  (row.document === null || documentText(row.document, MAX_DOC)) &&
  /^[0-9a-f]{64}$/u.test(row.content_hash) &&
  (["conversation", "user_document", "explicit_user_input"] as unknown[]).includes(
    row.source_kind,
  ) &&
  visible(row.reference, 512) &&
  time(row.captured_at) &&
  ["pending_approval", "applying", "applied", "failed"].includes(row.status) &&
  /^[0-9a-f]{64}$/u.test(row.payload_fingerprint) &&
  (row.outcome_observed === 0 || row.outcome_observed === 1);

const bronzeIdentityMatches = (
  row: StoredBronzeAction,
  identity: BronzeIdentity,
): boolean => row.knowledge_id === identity.knowledgeId && row.generation === identity.generation;

const bronzeProvenanceFromRow = (row: StoredBronzeAction): BronzeProvenance => ({
  sourceKind: row.source_kind,
  reference: row.reference,
  capturedAt: row.captured_at,
});

const bronzeReceipt = (
  value: unknown,
  row: StoredBronzeAction,
): BronzeReceipt | undefined => {
  if (
    !rec(value) ||
    !exact(value, [
      "receiptId",
      "knowledgeId",
      "generation",
      "operationId",
      "sourceId",
      "revisionId",
      "revisionNumber",
      "contentHash",
      "committedAt",
    ]) ||
    !uuid(value.receiptId) ||
    value.knowledgeId !== row.knowledge_id ||
    value.generation !== row.generation ||
    value.operationId !== row.operation_id ||
    !uuid(value.sourceId) ||
    !uuid(value.revisionId) ||
    value.revisionNumber !== 1 ||
    value.contentHash !== row.content_hash ||
    !/^[0-9a-f]{64}$/u.test(value.contentHash) ||
    !time(value.committedAt)
  )
    return;
  return value as BronzeReceipt;
};

const adoptionResult = (
  value: unknown,
  row: StoredBronzeAction,
  readOnly = false,
): { outcome: KnowledgeAdoptionOutcome } | { failure: BronzeFailure } | undefined => {
  if (!rec(value) || typeof value._tag !== "string") return;
  if (value._tag === "committed" || value._tag === "already_committed") {
    if (
      readOnly
        ? !exact(value, ["_tag", "receipt"])
        : !exact(value, ["_tag", "outcome", "receipt"]) || value.outcome !== value._tag
    )
      return;
    const receipt = bronzeReceipt(value.receipt, row);
    return receipt === undefined
      ? undefined
      : {
          outcome: {
            operationId: row.operation_id,
            status: "applied",
            outcome: value._tag,
            receipt,
          },
        };
  }
  if (value._tag === "unobserved") {
    return exact(value, ["_tag"])
      ? {
          outcome: {
            operationId: row.operation_id,
            status: "outcome_unknown",
            reason: "outcome_unknown",
          },
        }
      : undefined;
  }
  if (value._tag === "invalid_input") {
    return validInvalidInputResult(value) ? { failure: "invalid_input" } : undefined;
  }
  if (value._tag === "dependency_unavailable") {
    return exact(value, ["_tag", "dependency"]) &&
      value.dependency === "knowledge-agent"
      ? { failure: "dependency_unavailable" }
      : undefined;
  }
  return BRONZE_ADOPTION_FAILURE_TAGS.includes(value._tag as BronzeFailure) &&
    exact(value, ["_tag"])
    ? { failure: value._tag as BronzeFailure }
    : undefined;
};

const storedBronzeOutcome = (
  value: string | null,
  row: StoredBronzeAction,
): KnowledgeAdoptionOutcome | undefined => {
  if (value === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return;
  }
  if (!rec(parsed) || parsed.operationId !== row.operation_id) return;
  if (parsed.status === "failed") {
    return exact(parsed, ["operationId", "status", "reason"]) &&
      BRONZE_ADOPTION_TERMINAL_FAILURE_TAGS.includes(
        parsed.reason as BronzeTerminalFailure,
      )
      ? (parsed as KnowledgeAdoptionOutcome)
      : undefined;
  }
  if (
    parsed.status !== "applied" ||
    !exact(parsed, ["operationId", "status", "outcome", "receipt"]) ||
    (parsed.outcome !== "committed" && parsed.outcome !== "already_committed")
  )
    return;
  const receipt = bronzeReceipt(parsed.receipt, row);
  return receipt === undefined
    ? undefined
    : (parsed as KnowledgeAdoptionOutcome);
};

const bronzeFailureOutcome = (
  operationId: string,
  reason: BronzeTerminalFailure,
): KnowledgeAdoptionOutcome => ({
  operationId,
  status: "failed",
  reason,
});
function summary(v: unknown): Summary | undefined {
  if (
    !rec(v) ||
    !exact(v, [
      "knowledgeId",
      "generation",
      "displayName",
      "role",
      "state",
      "createdAt",
      "updatedAt",
    ]) ||
    !uuid(v.knowledgeId) ||
    v.generation !== 1 ||
    !visible(v.displayName, 120) ||
    !(["initial", "additional"] as unknown[]).includes(v.role) ||
    !(["provisioning", "ready", "blocked"] as unknown[]).includes(v.state) ||
    !time(v.createdAt) ||
    !time(v.updatedAt)
  )
    return;
  return v as Summary;
}
function page(v: unknown, limit: number): Summary[] | undefined {
  if (
    !rec(v) ||
    !(
      exact(v, ["_tag", "items"]) || exact(v, ["_tag", "items", "nextCursor"])
    ) ||
    v._tag !== "page" ||
    !Array.isArray(v.items) ||
    v.items.length > Math.min(limit, MAX_PAGE) ||
    (Object.prototype.hasOwnProperty.call(v, "nextCursor") &&
      v.nextCursor !== null &&
      (typeof v.nextCursor !== "string" ||
        !v.nextCursor.length ||
        new TextEncoder().encode(v.nextCursor).byteLength > 256 ||
        !/^[A-Za-z0-9_-]+$/u.test(v.nextCursor)))
  )
    return;
  const out: Summary[] = [];
  for (const x of v.items) {
    const s = summary(x);
    if (!s) return;
    out.push(s);
  }
  return out;
}
function revision(
  v: unknown,
  e: { knowledgeId: string; sourceId: string; revisionId?: string },
): Revision | undefined {
  if (
    !rec(v) ||
    !exact(v, [
      "knowledgeId",
      "generation",
      "sourceId",
      "revisionId",
      "revisionNumber",
      "baseRevisionId",
      "document",
      "contentHash",
      "type",
      "title",
      "description",
      "provenance",
      "committedAt",
    ]) ||
    v.knowledgeId !== e.knowledgeId ||
    v.generation !== 1 ||
    v.sourceId !== e.sourceId ||
    (e.revisionId !== undefined && v.revisionId !== e.revisionId) ||
    !uuid(v.revisionId) ||
    v.revisionNumber !== 1 ||
    (v.baseRevisionId !== null && !uuid(v.baseRevisionId)) ||
    !documentText(v.document, MAX_DOC) ||
    typeof v.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(v.contentHash) ||
    v.type !== "Source" ||
    !projectionText(v.title, 256) ||
    !projectionText(v.description, 1024) ||
    !rec(v.provenance) ||
    !exact(v.provenance, ["sourceKind", "reference", "capturedAt"]) ||
    !(
      ["conversation", "user_document", "explicit_user_input"] as unknown[]
    ).includes(v.provenance.sourceKind) ||
    !visible(v.provenance.reference, 512) ||
    !time(v.provenance.capturedAt) ||
    !time(v.committedAt)
  )
    return;
  return v as Revision;
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
export class Knowledge extends RpcTarget {
  readonly #q: RpcStub<ApprovalQueue>;
  readonly #a: Access;
  readonly #id: string;
  readonly #g: 1;
  readonly #displayName: string;
  readonly #port: ProposalPort | undefined;
  #disposed = false;
  constructor(
    q: RpcStub<ApprovalQueue>,
    a: Access,
    id: string,
    g: 1,
    displayName: string,
    port?: ProposalPort,
  ) {
    super();
    this.#q = q;
    this.#a = a;
    this.#id = id;
    this.#g = g;
    this.#displayName = displayName;
    this.#port = port;
  }
  async proposeBronzeAdoption(i: unknown): Promise<ProposalResult> {
    if (!validBronzeInput(i)) throw err("invalid_input");
    if (this.#port === undefined) throw err("dependency_unavailable");
    return this.#port.proposeBronze(
      i,
      { knowledgeId: this.#id, generation: this.#g },
      this.#displayName,
      this.#q,
    );
  }
  async readAdoptionOutcome(i: unknown): Promise<KnowledgeAdoptionOutcome | null> {
    if (!rec(i) || !exact(i, ["operationId"]) || !uuid(i.operationId))
      throw err("invalid_input");
    if (this.#port === undefined) throw err("dependency_unavailable");
    return this.#port.readBronzeOutcome(
      i.operationId,
      { knowledgeId: this.#id, generation: this.#g },
      this.#q,
    );
  }
  async readBronze(i: BronzeInput): Promise<Revision | null> {
    if (
      !rec(i) ||
      !exact(
        i,
        i.revisionId === undefined ? ["sourceId"] : ["sourceId", "revisionId"],
      ) ||
      !uuid(i.sourceId) ||
      (i.revisionId !== undefined && !uuid(i.revisionId))
    )
      throw err("invalid_input");
    let raw: unknown;
    try {
      raw = await this.#a.readBronze({
        ...i,
        knowledgeId: this.#id,
        generation: this.#g,
      });
    } catch {
      throw err("dependency_unavailable");
    }
    if (!rec(raw)) throw err("integrity_failure");
    if (exact(raw, ["_tag"]) && raw._tag === "not_found") {
      await this.#q.authorizeObservation(
        observation(
          "Knowledge Bronze read",
          "Read returned no matching Bronze source.",
        ),
      );
      return null;
    }

    const failureTag = failure(raw, BRONZE_FAILURE_TAGS);
    if (failureTag !== undefined) {
      await this.#q.authorizeObservation(
        observation("Knowledge Bronze read", "Read returned a safe failure."),
      );
      throw err(failureTag);
    }
    if (!exact(raw, ["_tag", "revision"]) || raw._tag !== "found")
      throw err("integrity_failure");
    const r = revision(raw.revision, {
      knowledgeId: this.#id,
      sourceId: i.sourceId,
      revisionId: i.revisionId,
    });
    if (!r) throw err("integrity_failure");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(r.document),
    );
    const hash = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    if (hash !== r.contentHash) throw err("integrity_failure");
    await this.#q.authorizeObservation(
      observation("Knowledge Bronze read", "Read one Knowledge Bronze source."),
    );
    return r;
  }
  [Symbol.dispose]() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#q[Symbol.dispose]?.();
  }
}
@validateRpc()
export class KnowledgeSession extends RpcTarget {
  readonly #q: RpcStub<ApprovalQueue>;
  readonly #a: Access;
  readonly #port: ProposalPort | undefined;
  readonly #h = new Set<Knowledge>();
  #disposed = false;
  constructor(q: RpcStub<ApprovalQueue>, a: Access, port?: ProposalPort) {
    super();
    this.#q = q;
    this.#a = a;
    this.#port = port;
  }
  async proposeKnowledgeCreate(i: unknown): Promise<ProposalResult> {
    if (!rec(i) || !exact(i, ["displayName"]) || !visible(i.displayName, 120))
      throw err("invalid_input");
    if (!this.#port) throw err("dependency_unavailable");
    return this.#port.propose(i.displayName, this.#q);
  }
  async readCreationOutcome(i: unknown): Promise<CreationOutcome | null> {
    if (!rec(i) || !exact(i, ["operationId"]) || !uuid(i.operationId))
      throw err("invalid_input");
    if (!this.#port) throw err("dependency_unavailable");
    return this.#port.readOutcome(i.operationId, this.#q);
  }
  async proposeArticle(i: unknown): Promise<ProposalResult> {
    if (!rec(i) || !exact(i, ["article"])) throw err("invalid_input");
    if (!validArticleShape(i.article)) throw err("invalid_input");
    if ((articleContentByteLength(i.article) ?? MAX_ARTICLE_BYTES + 1) > MAX_ARTICLE_BYTES)
      throw err("article_too_large");
    if (!this.#port) throw err("dependency_unavailable");
    return this.#port.proposeArticle(i.article, this.#q);
  }
  async readArticleOutcome(i: unknown): Promise<ArticleOutcome | null> {
    if (!rec(i) || !exact(i, ["operationId"]) || !uuid(i.operationId))
      throw err("invalid_input");
    if (!this.#port) throw err("dependency_unavailable");
    return this.#port.readArticleOutcome(i.operationId, this.#q);
  }
  async list(o?: ListInput): Promise<Page> {
    if (
      o !== undefined &&
      (!rec(o) ||
        Object.keys(o).some((k) => k !== "cursor" && k !== "limit") ||
        (o.cursor !== undefined &&
          (typeof o.cursor !== "string" ||
            !/^[A-Za-z0-9_-]+$/u.test(o.cursor) ||
            new TextEncoder().encode(o.cursor).byteLength > 256)) ||
        (o.limit !== undefined &&
          (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > 50)))
    )
      throw err("invalid_input");
    const limit = o?.limit ?? 20;
    let raw: unknown;
    try {
      raw = await this.#a.list(o);
    } catch {
      throw err("dependency_unavailable");
    }
    if (!rec(raw)) throw err("integrity_failure");

    const failureTag = failure(raw, LIST_FAILURE_TAGS, LIST_DEPENDENCIES);
    if (failureTag !== undefined) {
      await this.#q.authorizeObservation(
        observation("Knowledge Base catalog", "Listed a safe Knowledge result."),
      );
      throw err(failureTag);
    }
    if (raw._tag !== "page") throw err("integrity_failure");
    const ss = page(raw, limit);
    if (!ss) throw err("integrity_failure");
    const items: Page["items"] = [];
    const created: Knowledge[] = [];
    for (const s of ss) {
      if (s.state === "ready") {
        let h: Knowledge;
        try {
          h = new Knowledge(
            this.#q.dup(),
            this.#a,
            s.knowledgeId,
            s.generation,
            s.displayName,
            this.#port,
          );
        } catch {
          for (const createdHandle of created) {
            this.#h.delete(createdHandle);
            try {
              createdHandle[Symbol.dispose]();
            } catch {
              // Preserve the capability error.
            }
          }
          throw err("dependency_unavailable");
        }
        this.#h.add(h);
        created.push(h);
        items.push({ ...s, access: h });
      } else items.push(s);
    }
    try {
      await this.#q.authorizeObservation(
        observation(
          "Knowledge Base catalog",
          "Listed " + items.length + " Knowledge summaries.",
        ),
      );
    } catch (cause) {
      for (const createdHandle of created) {
        this.#h.delete(createdHandle);
        try {
          createdHandle[Symbol.dispose]();
        } catch {
          // Preserve the authorization error.
        }
      }
      throw cause;
    }
    return {
      items,
      nextCursor: (raw.nextCursor as string | undefined) ?? null,
    };
  }
  [Symbol.dispose]() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const h of this.#h) {
      try {
        h[Symbol.dispose]();
      } catch {
        // Disposal is best effort after the session has ended.
      }
    }
    this.#h.clear();
    try {
      this.#q[Symbol.dispose]?.();
    } catch {
      // Disposal is best effort after the session has ended.
    }
  }
}
type Props = KnowledgeAccountProps;
function isManagerId(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}
function legacyProps(v: unknown): boolean {
  return v === undefined || (rec(v) && Object.keys(v).length === 0);
}
function validateProps(v: unknown): Props {
  if (!rec(v) || !exact(v, ["managerId"]) || !isManagerId(v.managerId))
    throw new TypeError("Knowledge Account props must contain only a valid managerId.");
  return { managerId: v.managerId };
}

// Facet class props cannot contain capabilities on the deployed platform.
// This namespace is Worker-private and never handed to an Agent or HTTP caller.
export class KnowledgeAccountAccess extends DurableObject<Cloudflare.Env> {
  async bind(managerId: string, capability: Access): Promise<void> {
    if (!isManagerId(managerId) ||
        !this.ctx.id.equals(this.ctx.exports.KnowledgeAccountAccess.idFromName(managerId)))
      throw new TypeError("Knowledge access store is bound to another Manager.");
    await validateStub<Access>(capability as object).assertBoundTo(managerId);
    // Persist the native stub, not its validation Proxy.
    await this.ctx.storage.put("access", capability);
  }

  async getAccess(): Promise<Access> {
    const access = await this.ctx.storage.get<Access>("access");
    if (!access) throw new Error("Knowledge Account access is not initialized.");
    return access;
  }
}

@validateRpc()
export class CustomGatekeeper
  extends DurableObject<Cloudflare.Env, Props>
  implements Gatekeeper<KnowledgeBase>
{
  #articleApplyInFlight = new Map<number, Promise<void>>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS custom_gatekeeper_action_sequence (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          next_id INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO custom_gatekeeper_action_sequence (id, next_id) VALUES (1, 1);
        CREATE TABLE IF NOT EXISTS custom_gatekeeper_staged_actions (
          local_action_id INTEGER PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          action_ref TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL,
          display_name TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_fingerprint TEXT NOT NULL,
          outcome_json TEXT
        );
        CREATE TABLE IF NOT EXISTS custom_gatekeeper_article_actions (
          local_action_id INTEGER PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          action_ref TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL,
          command_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          outcome_json TEXT
        );
        CREATE TABLE IF NOT EXISTS custom_gatekeeper_bronze_adoptions (
          local_action_id INTEGER PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          action_ref TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL,
          knowledge_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          display_name TEXT NOT NULL,
          document TEXT,
          content_hash TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          reference TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_fingerprint TEXT NOT NULL,
          outcome_json TEXT,
          outcome_observed INTEGER NOT NULL DEFAULT 0
        );
      `);
    });
  }
  async #access(): Promise<Access> {
    const p = validateProps(this.ctx.props);
    const access = await this.ctx.exports.KnowledgeAccountAccess.getByName(p.managerId).getAccess();
    return validateStub<Access>(access);
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
  async startSession(q: RpcStub<ApprovalQueue>) {
    const access = await this.#access();
    const queue = q.dup();
    try {
      const port: ProposalPort = {
        propose: (displayName, approvalQueue) => this.#propose(displayName, approvalQueue),
        readOutcome: (operationId, approvalQueue) => this.#readOutcome(operationId, approvalQueue),
        proposeBronze: (input, identity, displayName, approvalQueue) =>
          this.#proposeBronze(input, identity, displayName, approvalQueue),
        readBronzeOutcome: (operationId, identity, approvalQueue) =>
          this.#readBronzeOutcome(operationId, identity, approvalQueue),
        proposeArticle: (article, approvalQueue) =>
          this.#proposeArticle(article, approvalQueue),
        readArticleOutcome: (operationId, approvalQueue) =>
          this.#readArticleOutcome(operationId, approvalQueue),
      };
      return new KnowledgeSession(queue, access, port);
    } catch (cause) {
      try {
        queue[Symbol.dispose]?.();
      } catch {
        // Preserve the constructor failure while still attempting ownership cleanup.
      }
      throw cause;
    }
  }
  async #propose(displayName: string, queue: RpcStub<ApprovalQueue>): Promise<ProposalResult> {
    const operationId = crypto.randomUUID();
    const actionRef = crypto.randomUUID();
    const fingerprint = await payloadHash(operationId, actionRef, displayName);
    const pending = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM (SELECT status FROM custom_gatekeeper_staged_actions UNION ALL SELECT status FROM custom_gatekeeper_bronze_adoptions UNION ALL SELECT status FROM custom_gatekeeper_article_actions) WHERE status IN ('pending_approval', 'applying')",
      )
      .one().count;
    if (pending >= MAX_PENDING_PROPOSALS) throw err("capacity_exceeded");
    const next = this.ctx.storage.sql
      .exec<{ next_id: number }>("SELECT next_id FROM custom_gatekeeper_action_sequence WHERE id = 1")
      .one().next_id;
    this.ctx.storage.sql.exec("UPDATE custom_gatekeeper_action_sequence SET next_id = next_id + 1 WHERE id = 1");
    this.ctx.storage.sql.exec(
      "INSERT INTO custom_gatekeeper_staged_actions (local_action_id, operation_id, action_ref, kind, display_name, status, payload_fingerprint, outcome_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      next,
      operationId,
      actionRef,
      ACTION_KIND,
      displayName,
      "pending_approval",
      fingerprint,
      null,
    );
    const description: ActionDescription = {
      title: `Create Knowledge "${displayName}"`,
      description: `Create one additional Knowledge named "${displayName}".`,
      implementsRevert: false,
      awaitDecision: true,
    };
    try {
      await queue.submitAction(next, description);
    } catch {
      this.ctx.storage.sql.exec("DELETE FROM custom_gatekeeper_staged_actions WHERE local_action_id = ? AND operation_id = ?", next, operationId);
      throw err("dependency_unavailable");
    }
    return { operationId, status: "pending_approval" };
  }
  async #proposeBronze(
    input: BronzeAdoptionInput,
    identity: BronzeIdentity,
    displayName: string,
    queue: RpcStub<ApprovalQueue>,
  ): Promise<ProposalResult> {
    const operationId = crypto.randomUUID();
    const actionRef = crypto.randomUUID();
    const contentHash = await documentHash(input.document);
    const fingerprint = await bronzeFingerprint({
      operationId,
      actionRef,
      knowledgeId: identity.knowledgeId,
      generation: identity.generation,
      displayName,
      contentHash,
      provenance: input.provenance,
    });
    const pending = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM (SELECT status FROM custom_gatekeeper_staged_actions UNION ALL SELECT status FROM custom_gatekeeper_bronze_adoptions UNION ALL SELECT status FROM custom_gatekeeper_article_actions) WHERE status IN ('pending_approval', 'applying')",
      )
      .one().count;
    if (pending >= MAX_PENDING_PROPOSALS) throw err("capacity_exceeded");
    const next = this.ctx.storage.sql
      .exec<{ next_id: number }>(
        "SELECT next_id FROM custom_gatekeeper_action_sequence WHERE id = 1",
      )
      .one().next_id;
    this.ctx.storage.sql.exec(
      "UPDATE custom_gatekeeper_action_sequence SET next_id = next_id + 1 WHERE id = 1",
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO custom_gatekeeper_bronze_adoptions (local_action_id, operation_id, action_ref, kind, knowledge_id, generation, display_name, document, content_hash, source_kind, reference, captured_at, status, payload_fingerprint, outcome_json, outcome_observed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      next,
      operationId,
      actionRef,
      BRONZE_ACTION_KIND,
      identity.knowledgeId,
      identity.generation,
      displayName,
      input.document,
      contentHash,
      input.provenance.sourceKind,
      input.provenance.reference,
      input.provenance.capturedAt,
      "pending_approval",
      fingerprint,
      null,
      0,
    );
    const description: ActionDescription = {
      title: "Review Knowledge Bronze adoption",
      description: bronzeReviewDescription({
        displayName,
        document: input.document,
        contentHash,
        provenance: input.provenance,
      }),
      implementsRevert: false,
      awaitDecision: true,
    };
    try {
      await queue.submitAction(next, description);
    } catch {
      this.ctx.storage.sql.exec(
        "DELETE FROM custom_gatekeeper_bronze_adoptions WHERE local_action_id = ? AND operation_id = ?",
        next,
        operationId,
      );
      throw err("dependency_unavailable");
    }
    return { operationId, status: "pending_approval" };
  }

  async #proposeArticle(
    article: Article,
    queue: RpcStub<ApprovalQueue>,
  ): Promise<ProposalResult> {
    if (!validArticleShape(article)) throw err("invalid_input");
    if ((articleContentByteLength(article) ?? MAX_ARTICLE_BYTES + 1) > MAX_ARTICLE_BYTES)
      throw err("article_too_large");
    const operationId = crypto.randomUUID();
    const actionRef = crypto.randomUUID();
    const command: ArticleCommand = {
      protocolVersion: "activity-article/1",
      operationId,
      actionRef,
      article: structuredClone(article),
    };
    let commandJson: string;
    try {
      commandJson = JSON.stringify(command);
    } catch {
      throw err("invalid_input");
    }
    if (new TextEncoder().encode(commandJson).byteLength > MAX_ARTICLE_COMMAND_BYTES)
      throw err("article_too_large");
    const payloadHash = await documentHash(commandJson);
    const pending = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM (SELECT status FROM custom_gatekeeper_staged_actions UNION ALL SELECT status FROM custom_gatekeeper_bronze_adoptions UNION ALL SELECT status FROM custom_gatekeeper_article_actions) WHERE status IN ('pending_approval', 'applying')",
      )
      .one().count;
    if (pending >= MAX_PENDING_PROPOSALS) throw err("capacity_exceeded");
    const next = this.ctx.storage.sql
      .exec<{ next_id: number }>(
        "SELECT next_id FROM custom_gatekeeper_action_sequence WHERE id = 1",
      )
      .one().next_id;
    this.ctx.storage.sql.exec(
      "UPDATE custom_gatekeeper_action_sequence SET next_id = next_id + 1 WHERE id = 1",
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO custom_gatekeeper_article_actions (local_action_id, operation_id, action_ref, kind, command_json, payload_hash, status, outcome_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      next,
      operationId,
      actionRef,
      ARTICLE_ACTION_KIND,
      commandJson,
      payloadHash,
      "pending_approval",
      null,
    );
    const description: ActionDescription = {
      title: "Review Article for Personal Knowledge",
      description: articleReviewDescription(commandJson),
      implementsRevert: false,
      awaitDecision: true,
      autoApprovable: false,
    };
    try {
      await queue.submitAction(next, description);
    } catch {
      this.ctx.storage.sql.exec(
        "DELETE FROM custom_gatekeeper_article_actions WHERE local_action_id = ? AND operation_id = ?",
        next,
        operationId,
      );
      throw err("dependency_unavailable");
    }
    return { operationId, status: "pending_approval" };
  }

  async #readArticleOutcome(
    operationId: string,
    queue: RpcStub<ApprovalQueue>,
  ): Promise<ArticleOutcome | null> {
    const readRow = (): StoredArticleAction | undefined =>
      this.ctx.storage.sql
        .exec<StoredArticleAction>(
          "SELECT local_action_id, operation_id, action_ref, kind, command_json, payload_hash, status, outcome_json FROM custom_gatekeeper_article_actions WHERE operation_id = ?",
          operationId,
        )
        .toArray()[0];
    const observe = () =>
      queue.authorizeObservation(
        observation(
          "Activity Article approval outcome",
          "Read the approval and verified save receipt for one Activity Article.",
        ),
      );
    let row = readRow();
    if (row === undefined) return null;
    if (!validStoredArticleAction(row)) throw err("integrity_failure");
    const command = validStoredArticleCommand(row);
    const expectedHash = await documentHash(row.command_json);
    row = readRow();
    if (
      row === undefined ||
      !validStoredArticleAction(row) ||
      row.payload_hash !== expectedHash ||
      row.operation_id !== operationId
    )
      throw err("integrity_failure");
    const checkedCommand = validStoredArticleCommand(row);
    if (checkedCommand === undefined || command === undefined ||
        checkedCommand.actionRef !== command.actionRef)
      throw err("integrity_failure");
    if (row.status === "pending_approval") {
      await observe();
      return { operationId, status: "pending_approval" };
    }
    if (row.status === "applying") {
      await observe();
      return { operationId, status: "outcome_unknown", reason: "outcome_unknown" };
    }
    if (row.status === "failed") {
      const result = storedArticleOutcome(row.outcome_json, row, checkedCommand);
      if (result === undefined || result.status !== "failed")
        throw err("integrity_failure");
      await observe();
      return result;
    }
    if (row.status === "applied") {
      const result = storedArticleOutcome(row.outcome_json, row, checkedCommand);
      if (result === undefined || result.status !== "applied")
        throw err("integrity_failure");
      await observe();
      return result;
    }
    throw err("integrity_failure");
  }

  async #readBronzeOutcome(
    operationId: string,
    identity: BronzeIdentity,
    queue: RpcStub<ApprovalQueue>,
  ): Promise<KnowledgeAdoptionOutcome | null> {
    const readRow = (): StoredBronzeAction | undefined =>
      this.ctx.storage.sql
        .exec<StoredBronzeAction>(
          "SELECT local_action_id, operation_id, action_ref, kind, knowledge_id, generation, display_name, document, content_hash, source_kind, reference, captured_at, status, payload_fingerprint, outcome_json, outcome_observed FROM custom_gatekeeper_bronze_adoptions WHERE operation_id = ?",
          operationId,
        )
        .toArray()[0];
    const unknown = (): KnowledgeAdoptionOutcome => ({
      operationId,
      status: "outcome_unknown",
      reason: "outcome_unknown",
    });
    let row = readRow();
    if (row === undefined) return null;
    if (!validStoredBronzeAction(row)) throw err("integrity_failure");
    if (!bronzeIdentityMatches(row, identity)) throw err("integrity_failure");
    const expectedFingerprint = await bronzeFingerprint({
      operationId: row.operation_id,
      actionRef: row.action_ref,
      knowledgeId: row.knowledge_id,
      generation: row.generation,
      displayName: row.display_name,
      contentHash: row.content_hash,
      provenance: bronzeProvenanceFromRow(row),
    });
    row = readRow();
    if (row === undefined) return null;
    if (
      !validStoredBronzeAction(row) ||
      !bronzeIdentityMatches(row, identity) ||
      row.payload_fingerprint !== expectedFingerprint
    )
      throw err("integrity_failure");
    if (row.status === "pending_approval") {
      const result: KnowledgeAdoptionOutcome = {
        operationId,
        status: "pending_approval",
      };
      await queue.authorizeObservation(
        observation(
          "Knowledge Bronze adoption outcome",
          "Read a bounded Knowledge Bronze adoption outcome.",
        ),
      );
      return result;
    }
    if (row.status === "failed") {
      const result = storedBronzeOutcome(row.outcome_json, row);
      if (result === undefined || result.status !== "failed")
        throw err("integrity_failure");
      await queue.authorizeObservation(
        observation(
          "Knowledge Bronze adoption outcome",
          "Read a bounded Knowledge Bronze adoption outcome.",
        ),
      );
      return result;
    }
    if (row.status === "applied") {
      const cached = storedBronzeOutcome(row.outcome_json, row);
      if (cached === undefined || cached.status !== "applied")
        throw err("integrity_failure");
      let raw: unknown;
      try {
        raw = await (await this.#access()).readAdoptionOutcome({
          operationId: row.operation_id,
          knowledgeId: row.knowledge_id,
          generation: row.generation,
        });
      } catch {
        await queue.authorizeObservation(
          observation(
            "Knowledge Bronze adoption outcome",
            "Read a bounded Knowledge Bronze adoption outcome.",
          ),
        );
        return unknown();
      }
      const observed = adoptionResult(raw, row, true);
      if (observed === undefined) throw err("integrity_failure");
      if ("failure" in observed) {
        if (observed.failure === "outcome_unknown") {
          await queue.authorizeObservation(
            observation(
              "Knowledge Bronze adoption outcome",
              "Read a bounded Knowledge Bronze adoption outcome.",
            ),
          );
          return unknown();
        }
        throw err(observed.failure);
      }
      if (observed.outcome.status === "outcome_unknown") {
        await queue.authorizeObservation(
          observation(
            "Knowledge Bronze adoption outcome",
            "Read a bounded Knowledge Bronze adoption outcome.",
          ),
        );
        return observed.outcome;
      }
      if (observed.outcome.status !== "applied") throw err("integrity_failure");
      const result = observed.outcome;
      this.ctx.storage.sql.exec(
        "UPDATE custom_gatekeeper_bronze_adoptions SET outcome_json = ?, outcome_observed = 1 WHERE local_action_id = ? AND status = 'applied'",
        JSON.stringify(result),
        row.local_action_id,
      );
      await queue.authorizeObservation(
        observation(
          "Knowledge Bronze adoption outcome",
          "Read a bounded Knowledge Bronze adoption outcome.",
        ),
      );
      return result;
    }
    if (row.status !== "applying") throw err("integrity_failure");

    let raw: unknown;
    try {
      const access = await this.#access();
      raw = await access.readAdoptionOutcome({
        operationId: row.operation_id,
        knowledgeId: row.knowledge_id,
        generation: row.generation,
      });
    } catch {
      await queue.authorizeObservation(
        observation(
          "Knowledge Bronze adoption outcome",
          "Read a bounded Knowledge Bronze adoption outcome.",
        ),
      );
      return unknown();
    }
    const decoded = adoptionResult(raw, row, true);
    if (decoded === undefined) {
      await queue.authorizeObservation(
        observation(
          "Knowledge Bronze adoption outcome",
          "Read a bounded Knowledge Bronze adoption outcome.",
        ),
      );
      return unknown();
    }
    if ("outcome" in decoded) {
      if (decoded.outcome.status === "outcome_unknown") {
        await queue.authorizeObservation(
          observation(
            "Knowledge Bronze adoption outcome",
            "Read a bounded Knowledge Bronze adoption outcome.",
          ),
        );
        return decoded.outcome;
      }
      this.ctx.storage.sql.exec(
        "UPDATE custom_gatekeeper_bronze_adoptions SET status = 'applied', outcome_json = ?, outcome_observed = 1 WHERE local_action_id = ? AND status = 'applying'",
        JSON.stringify(decoded.outcome),
        row.local_action_id,
      );
      await queue.authorizeObservation(
        observation(
          "Knowledge Bronze adoption outcome",
          "Read a bounded Knowledge Bronze adoption outcome.",
        ),
      );
      return decoded.outcome;
    }
    await queue.authorizeObservation(
      observation(
        "Knowledge Bronze adoption outcome",
        "Read a bounded Knowledge Bronze adoption outcome.",
      ),
    );
    return unknown();
  }

  async #readOutcome(operationId: string, queue: RpcStub<ApprovalQueue>): Promise<CreationOutcome | null> {
    const readRow = (): StoredAction | undefined => this.ctx.storage.sql
      .exec<StoredAction>("SELECT local_action_id, operation_id, action_ref, kind, display_name, status, payload_fingerprint, outcome_json FROM custom_gatekeeper_staged_actions WHERE operation_id = ?", operationId)
      .toArray()[0];
    const unknown = (): CreationOutcome => ({ operationId, status: "outcome_unknown", reason: "outcome_unknown" });
    let row = readRow();
    if (!row) return null;
    if (!validStoredAction(row)) throw err("integrity_failure");
    const expectedFingerprint = await payloadHash(row.operation_id, row.action_ref, row.display_name);
    row = readRow();
    if (!row) return null;
    if (!validStoredAction(row) || row.payload_fingerprint !== expectedFingerprint)
      throw err("integrity_failure");
    if (row.status === "pending_approval") {
      const result: CreationOutcome = { operationId, status: "pending_approval" };
      await queue.authorizeObservation(observation("Knowledge creation outcome", "Read a bounded Knowledge creation outcome."));
      return result;
    }
    if (row.status === "failed") {
      const result = storedOutcome(row.outcome_json, operationId, row.display_name);
      if (!result || result.status !== "failed") throw err("integrity_failure");
      await queue.authorizeObservation(observation("Knowledge creation outcome", "Read a bounded Knowledge creation outcome."));
      return result;
    }
    if (row.status !== "applying" && row.status !== "applied") throw err("integrity_failure");
    if (row.status === "applied" && !storedOutcome(row.outcome_json, operationId, row.display_name))
      throw err("integrity_failure");

    let raw: unknown;
    try {
      const access = await this.#access();
      raw = await access.readCreationOutcome({ operationId });
    } catch (cause) {
      if (row.status === "applying") {
        const result = unknown();
        await queue.authorizeObservation(observation("Knowledge creation outcome", "Read a bounded Knowledge creation outcome."));
        return result;
      }
      throw err("dependency_unavailable");
    }
    const decoded = outcomeResult(raw, operationId, row.display_name);
    if (!decoded) throw err("integrity_failure");
    if ("outcome" in decoded) {
      if (decoded.outcome.status === "outcome_unknown") {
        if (row.status === "applying") {
          await queue.authorizeObservation(observation("Knowledge creation outcome", "Read a bounded Knowledge creation outcome."));
          return decoded.outcome;
        }
        throw err("outcome_unknown");
      }
      if (row.status === "applying") {
        this.ctx.storage.sql.exec(
          "UPDATE custom_gatekeeper_staged_actions SET status = 'applied', outcome_json = ? WHERE local_action_id = ? AND status = 'applying'",
          JSON.stringify(decoded.outcome),
          row.local_action_id,
        );
      }
      await queue.authorizeObservation(observation("Knowledge creation outcome", "Read a bounded Knowledge creation outcome."));
      return decoded.outcome;
    }
    if (row.status === "applying") {
      const result = unknown();
      await queue.authorizeObservation(observation("Knowledge creation outcome", "Read a bounded Knowledge creation outcome."));
      return result;
    }
    throw err(decoded.failure);
  }
  async applyAction(actionId: number): Promise<void> {
    if (!Number.isSafeInteger(actionId) || actionId < 1)
      throw err("invalid_input");
    const createRows = this.ctx.storage.sql
      .exec<{ local_action_id: number }>(
        "SELECT local_action_id FROM custom_gatekeeper_staged_actions WHERE local_action_id = ?",
        actionId,
      )
      .toArray();
    const bronzeRows = this.ctx.storage.sql
      .exec<{ local_action_id: number }>(
        "SELECT local_action_id FROM custom_gatekeeper_bronze_adoptions WHERE local_action_id = ?",
        actionId,
      )
      .toArray();
    const articleRows = this.ctx.storage.sql
      .exec<{ local_action_id: number }>(
        "SELECT local_action_id FROM custom_gatekeeper_article_actions WHERE local_action_id = ?",
        actionId,
      )
      .toArray();
    if ([createRows, bronzeRows, articleRows].filter((rows) => rows.length > 0).length > 1)
      throw err("integrity_failure");
    if (createRows.length > 0) return this.#applyCreationAction(actionId);
    if (bronzeRows.length > 0) return this.#applyBronzeAction(actionId);
    if (articleRows.length > 0) return this.#applyArticleAction(actionId);
    throw err("invalid_input");
  }

  async #applyArticleAction(actionId: number): Promise<void> {
    const inFlight = this.#articleApplyInFlight.get(actionId);
    if (inFlight !== undefined) return inFlight;

    const applying = this.#applyArticleActionOnce(actionId);
    this.#articleApplyInFlight.set(actionId, applying);
    try {
      await applying;
    } finally {
      if (this.#articleApplyInFlight.get(actionId) === applying)
        this.#articleApplyInFlight.delete(actionId);
    }
  }

  async #applyArticleActionOnce(actionId: number): Promise<void> {
    const readRow = (): StoredArticleAction | undefined =>
      this.ctx.storage.sql
        .exec<StoredArticleAction>(
          "SELECT local_action_id, operation_id, action_ref, kind, command_json, payload_hash, status, outcome_json FROM custom_gatekeeper_article_actions WHERE local_action_id = ?",
          actionId,
        )
        .toArray()[0];
    let row = readRow();
    if (row === undefined) throw err("invalid_input");
    if (!validStoredArticleAction(row)) throw err("integrity_failure");
    const expectedPayloadHash = await documentHash(row.command_json);
    let command = validStoredArticleCommand(row);
    row = readRow();
    if (
      row === undefined ||
      !validStoredArticleAction(row) ||
      row.payload_hash !== expectedPayloadHash ||
      (command = validStoredArticleCommand(row)) === undefined
    )
      throw err(row === undefined ? "invalid_input" : "integrity_failure");
    if (row.status === "applied") {
      const result = storedArticleOutcome(row.outcome_json, row, command);
      if (result === undefined || result.status !== "applied") throw err("integrity_failure");
      return;
    }
    if (row.status === "failed") {
      const result = storedArticleOutcome(row.outcome_json, row, command);
      if (result === undefined || result.status !== "failed") throw err("integrity_failure");
      throw err(result.reason);
    }
    if (row.status !== "pending_approval" && row.status !== "applying")
      throw err("integrity_failure");
    let outcomeMayAlreadyExist = row.status === "applying";

    let access: Access;
    try {
      access = await this.#access();
    } catch {
      if (row.status === "applying") throw err("outcome_unknown");
      throw err("dependency_unavailable");
    }
    if (row.status === "pending_approval") {
      const transition = this.ctx.storage.sql.exec(
        "UPDATE custom_gatekeeper_article_actions SET status = 'applying' WHERE local_action_id = ? AND status = 'pending_approval'",
        actionId,
      );
      row = readRow();
      if (
        row === undefined ||
        !validStoredArticleAction(row) ||
        row.payload_hash !== expectedPayloadHash ||
        (command = validStoredArticleCommand(row)) === undefined
      )
        throw err(row === undefined ? "invalid_input" : "integrity_failure");
      if (row.status !== "applying") {
        if (row.status === "applied") {
          const result = storedArticleOutcome(row.outcome_json, row, command);
          if (result === undefined || result.status !== "applied") throw err("integrity_failure");
          return;
        }
        if (row.status === "failed") {
          const result = storedArticleOutcome(row.outcome_json, row, command);
          if (result === undefined || result.status !== "failed") throw err("integrity_failure");
          throw err(result.reason);
        }
        throw err("integrity_failure");
      }
      if (transition.rowsWritten !== 1) outcomeMayAlreadyExist = true;
    }

    let saveRaw: unknown;
    try {
      saveRaw = await access.saveArticle({
        commandJson: row.command_json,
        payloadHash: row.payload_hash,
      });
    } catch {
      throw err("outcome_unknown");
    }
    const saved = articleSaveResult(saveRaw, row, command);
    if (saved === undefined || "uncertain" in saved) throw err("outcome_unknown");
    if ("failure" in saved) {
      // Core can reject an unusable receipt after a commit. Preserve applying so reads/retries
      // resolve the outcome instead of turning a possibly committed write into a rejection.
      if (outcomeMayAlreadyExist) throw err("outcome_unknown");
      if (saved.failure === "integrity_failure") throw err("integrity_failure");
      const outcome: ArticleOutcome = {
        operationId: row.operation_id,
        status: "failed",
        reason: saved.failure,
      };
      this.ctx.storage.sql.exec(
        "UPDATE custom_gatekeeper_article_actions SET status = 'failed', outcome_json = ? WHERE local_action_id = ? AND status = 'applying'",
        JSON.stringify(outcome),
        actionId,
      );
      throw err(saved.failure);
    }

    let readRaw: unknown;
    try {
      readRaw = await access.readArticle({
        articleId: saved.receipt.articleId,
        revisionId: saved.receipt.revisionId,
      });
    } catch {
      throw err("outcome_unknown");
    }
    if (!exactArticleReadMatches(readRaw, row, command, saved.receipt)) {
      if (rec(readRaw) && readRaw._tag === "found") throw err("integrity_failure");
      throw err("outcome_unknown");
    }

    const outcome: ArticleOutcome = {
      operationId: row.operation_id,
      status: "applied",
      outcome: saved.outcome,
      receipt: saved.receipt,
    };
    const transition = this.ctx.storage.sql.exec(
      "UPDATE custom_gatekeeper_article_actions SET status = 'applied', outcome_json = ? WHERE local_action_id = ? AND status = 'applying'",
      JSON.stringify(outcome),
      actionId,
    );
    if (transition.rowsWritten !== 1) {
      const current = readRow();
      if (
        current !== undefined &&
        validStoredArticleAction(current) &&
        current.status === "applied" &&
        storedArticleOutcome(current.outcome_json, current, command)?.status === "applied"
      )
        return;
      throw err("outcome_unknown");
    }
  }

  async #applyBronzeAction(actionId: number): Promise<void> {
    const readRow = (): StoredBronzeAction | undefined =>
      this.ctx.storage.sql
        .exec<StoredBronzeAction>(
          "SELECT local_action_id, operation_id, action_ref, kind, knowledge_id, generation, display_name, document, content_hash, source_kind, reference, captured_at, status, payload_fingerprint, outcome_json, outcome_observed FROM custom_gatekeeper_bronze_adoptions WHERE local_action_id = ?",
          actionId,
        )
        .toArray()[0];
    const readApplyingOutcome = async (
      current: StoredBronzeAction,
    ): Promise<"applied" | "outcome_unknown"> => {
      let raw: unknown;
      try {
        raw = await (await this.#access()).readAdoptionOutcome({
          operationId: current.operation_id,
          knowledgeId: current.knowledge_id,
          generation: current.generation,
        });
      } catch {
        return "outcome_unknown";
      }
      const decoded = adoptionResult(raw, current, true);
      if (decoded === undefined || !("outcome" in decoded))
        return "outcome_unknown";
      if (decoded.outcome.status === "outcome_unknown") return "outcome_unknown";
      this.ctx.storage.sql.exec(
        "UPDATE custom_gatekeeper_bronze_adoptions SET status = 'applied', outcome_json = ?, outcome_observed = 1 WHERE local_action_id = ? AND status = 'applying'",
        JSON.stringify(decoded.outcome),
        current.local_action_id,
      );
      return "applied";
    };
    let row = readRow();
    if (row === undefined) throw err("invalid_input");
    if (!validStoredBronzeAction(row)) throw err("integrity_failure");
    const expectedFingerprint = await bronzeFingerprint({
      operationId: row.operation_id,
      actionRef: row.action_ref,
      knowledgeId: row.knowledge_id,
      generation: row.generation,
      displayName: row.display_name,
      contentHash: row.content_hash,
      provenance: bronzeProvenanceFromRow(row),
    });
    row = readRow();
    if (
      row === undefined ||
      !validStoredBronzeAction(row) ||
      row.payload_fingerprint !== expectedFingerprint
    )
      throw err(row === undefined ? "invalid_input" : "integrity_failure");
    if (row.status === "applied") {
      if (storedBronzeOutcome(row.outcome_json, row) === undefined)
        throw err("integrity_failure");
      return;
    }
    if (row.status === "failed") {
      const result = storedBronzeOutcome(row.outcome_json, row);
      if (result === undefined || result.status !== "failed")
        throw err("integrity_failure");
      throw err(result.reason);
    }
    if (row.status === "applying") {
      const observed = await readApplyingOutcome(row);
      if (observed === "applied") return;
      throw err("outcome_unknown");
    }
    if (row.status !== "pending_approval") throw err("integrity_failure");
    if (row.document === null || (await documentHash(row.document)) !== row.content_hash)
      throw err("integrity_failure");

    const transition = this.ctx.storage.sql.exec(
      "UPDATE custom_gatekeeper_bronze_adoptions SET status = 'applying' WHERE local_action_id = ? AND status = 'pending_approval'",
      actionId,
    );
    row = readRow();
    if (
      row === undefined ||
      !validStoredBronzeAction(row) ||
      row.payload_fingerprint !== expectedFingerprint
    )
      throw err(row === undefined ? "invalid_input" : "integrity_failure");
    if (transition.rowsWritten !== 1) {
      if (row.status === "applied") {
        if (storedBronzeOutcome(row.outcome_json, row) === undefined)
          throw err("integrity_failure");
        return;
      }
      if (row.status === "failed") {
        const result = storedBronzeOutcome(row.outcome_json, row);
        if (result === undefined || result.status !== "failed")
          throw err("integrity_failure");
        throw err(result.reason);
      }
      if (row.status !== "applying") throw err("integrity_failure");
      const observed = await readApplyingOutcome(row);
      if (observed === "applied") return;
      throw err("outcome_unknown");
    }
    if (row.document === null || (await documentHash(row.document)) !== row.content_hash)
      throw err("integrity_failure");

    const rollbackApplying = () => {
      this.ctx.storage.sql.exec(
        "UPDATE custom_gatekeeper_bronze_adoptions SET status = 'pending_approval' WHERE local_action_id = ? AND status = 'applying'",
        actionId,
      );
    };
    let call: Promise<unknown>;
    try {
      call = (await this.#access()).adoptBronze({
        operationId: row.operation_id,
        actionRef: row.action_ref,
        knowledgeId: row.knowledge_id,
        generation: row.generation,
        document: row.document,
        contentHash: row.content_hash,
        provenance: bronzeProvenanceFromRow(row),
      });
    } catch {
      rollbackApplying();
      throw err("dependency_unavailable");
    }
    this.ctx.storage.sql.exec(
      "UPDATE custom_gatekeeper_bronze_adoptions SET document = NULL WHERE local_action_id = ? AND status = 'applying'",
      actionId,
    );
    let raw: unknown;
    try {
      raw = await call;
    } catch {
      throw err("outcome_unknown");
    }
    const decoded = adoptionResult(raw, row);
    if (decoded === undefined) throw err("outcome_unknown");
    if ("failure" in decoded) {
      if (!BRONZE_ADOPTION_TERMINAL_FAILURE_TAGS.includes(decoded.failure as BronzeTerminalFailure))
        throw err(decoded.failure);
      const outcome = bronzeFailureOutcome(row.operation_id, decoded.failure as BronzeTerminalFailure);
      this.ctx.storage.sql.exec(
        "UPDATE custom_gatekeeper_bronze_adoptions SET status = 'failed', outcome_json = ? WHERE local_action_id = ? AND status = 'applying'",
        JSON.stringify(outcome),
        actionId,
      );
      throw err(decoded.failure);
    }
    this.ctx.storage.sql.exec(
      "UPDATE custom_gatekeeper_bronze_adoptions SET status = 'applied', outcome_json = ?, outcome_observed = 0 WHERE local_action_id = ? AND status = 'applying'",
      JSON.stringify(decoded.outcome),
      actionId,
    );
  }

  async #applyCreationAction(actionId: number): Promise<void> {
    if (!Number.isSafeInteger(actionId) || actionId < 1) throw err("invalid_input");
    const readRow = (): StoredAction | undefined => this.ctx.storage.sql
      .exec<StoredAction>("SELECT local_action_id, operation_id, action_ref, kind, display_name, status, payload_fingerprint, outcome_json FROM custom_gatekeeper_staged_actions WHERE local_action_id = ?", actionId)
      .toArray()[0];
    const readApplyingOutcome = async (current: StoredAction): Promise<"applied" | "outcome_unknown"> => {
      let raw: unknown;
      try {
        const access = await this.#access();
        raw = await access.readCreationOutcome({ operationId: current.operation_id });
      } catch {
        return "outcome_unknown";
      }
      const decoded = outcomeResult(raw, current.operation_id, current.display_name);
      if (!decoded) throw err("integrity_failure");
      if (!("outcome" in decoded) || decoded.outcome.status === "outcome_unknown") return "outcome_unknown";
      this.ctx.storage.sql.exec(
        "UPDATE custom_gatekeeper_staged_actions SET status = 'applied', outcome_json = ? WHERE local_action_id = ? AND status = 'applying'",
        JSON.stringify(decoded.outcome),
        current.local_action_id,
      );
      return "applied";
    };
    let row = readRow();
    if (!row) throw err("invalid_input");
    if (!validStoredAction(row)) throw err("integrity_failure");
    const expectedFingerprint = await payloadHash(row.operation_id, row.action_ref, row.display_name);
    row = readRow();
    if (!row) throw err("invalid_input");
    if (!validStoredAction(row) || row.payload_fingerprint !== expectedFingerprint)
      throw err("integrity_failure");
    if (row.status === "applied") {
      if (!storedOutcome(row.outcome_json, row.operation_id, row.display_name)) throw err("integrity_failure");
      return;
    }
    if (row.status === "failed") {
      const result = storedOutcome(row.outcome_json, row.operation_id, row.display_name);
      if (!result || result.status !== "failed") throw err("integrity_failure");
      throw err(result.reason ?? "integrity_failure");
    }
    if (row.status === "applying") {
      const observed = await readApplyingOutcome(row);
      if (observed === "applied") return;
      throw err("outcome_unknown");
    }
    if (row.status !== "pending_approval") throw err("integrity_failure");

    // Only the callback that wins this synchronous CAS may issue the create RPC.
    const transition = this.ctx.storage.sql.exec(
      "UPDATE custom_gatekeeper_staged_actions SET status = 'applying' WHERE local_action_id = ? AND status = 'pending_approval'",
      actionId,
    );
    row = readRow();
    if (!row) throw err("invalid_input");
    if (!validStoredAction(row) || row.payload_fingerprint !== expectedFingerprint)
      throw err("integrity_failure");
    if (transition.rowsWritten !== 1) {
      if (row.status === "applied") {
        if (!storedOutcome(row.outcome_json, row.operation_id, row.display_name)) throw err("integrity_failure");
        return;
      }
      if (row.status === "failed") {
        const result = storedOutcome(row.outcome_json, row.operation_id, row.display_name);
        if (!result || result.status !== "failed") throw err("integrity_failure");
        throw err(result.reason ?? "integrity_failure");
      }
      if (row.status !== "applying") throw err("integrity_failure");
      const observed = await readApplyingOutcome(row);
      if (observed === "applied") return;
      throw err("outcome_unknown");
    }
    if (row.status !== "applying") throw err("integrity_failure");

    const rollbackApplying = () => {
      this.ctx.storage.sql.exec(
        "UPDATE custom_gatekeeper_staged_actions SET status = 'pending_approval' WHERE local_action_id = ? AND status = 'applying'",
        actionId,
      );
    };
    let access: Access;
    try {
      access = await this.#access();
    } catch {
      rollbackApplying();
      throw err("dependency_unavailable");
    }
    let call: Promise<unknown>;
    try {
      call = access.createKnowledge({
        operationId: row.operation_id,
        actionRef: row.action_ref,
        displayName: row.display_name,
      });
    } catch {
      rollbackApplying();
      throw err("dependency_unavailable");
    }
    let raw: unknown;
    try {
      raw = await call;
    } catch {
      // The mutation may have committed even though its response was lost.
      throw err("outcome_unknown");
    }
    const decoded = creationResult(raw, row.operation_id, row.display_name);
    if (!decoded) throw err("integrity_failure");
    if ("failure" in decoded) {
      if (
        decoded.failure === "outcome_unknown" ||
        decoded.failure === "dependency_unavailable" ||
        decoded.failure === "deadline_exceeded"
      )
        throw err(decoded.failure);
      const outcome = toFailureOutcome(row.operation_id, decoded.failure);
      this.ctx.storage.sql.exec("UPDATE custom_gatekeeper_staged_actions SET status = 'failed', outcome_json = ? WHERE local_action_id = ? AND status = 'applying'", JSON.stringify(outcome), actionId);
      throw err(decoded.failure);
    }
    this.ctx.storage.sql.exec("UPDATE custom_gatekeeper_staged_actions SET status = 'applied', outcome_json = ? WHERE local_action_id = ? AND status = 'applying'", JSON.stringify(decoded.outcome), actionId);
  }
  async rejectAction(actionId: number): Promise<void> {
    if (!Number.isSafeInteger(actionId) || actionId < 1) return;
    const createRows = this.ctx.storage.sql
      .exec<{ local_action_id: number }>(
        "SELECT local_action_id FROM custom_gatekeeper_staged_actions WHERE local_action_id = ?",
        actionId,
      )
      .toArray();
    const bronzeRows = this.ctx.storage.sql
      .exec<{ local_action_id: number }>(
        "SELECT local_action_id FROM custom_gatekeeper_bronze_adoptions WHERE local_action_id = ?",
        actionId,
      )
      .toArray();
    const articleRows = this.ctx.storage.sql
      .exec<{ local_action_id: number }>(
        "SELECT local_action_id FROM custom_gatekeeper_article_actions WHERE local_action_id = ?",
        actionId,
      )
      .toArray();
    if ([createRows, bronzeRows, articleRows].filter((rows) => rows.length > 0).length > 1)
      throw err("integrity_failure");
    if (createRows.length > 0) {
      this.ctx.storage.sql.exec(
        "DELETE FROM custom_gatekeeper_staged_actions WHERE local_action_id = ? AND status = 'pending_approval'",
        actionId,
      );
      return;
    }
    if (bronzeRows.length > 0) {
      this.ctx.storage.sql.exec(
        "DELETE FROM custom_gatekeeper_bronze_adoptions WHERE local_action_id = ? AND status = 'pending_approval'",
        actionId,
      );
      return;
    }
    if (articleRows.length > 0) {
      const row = this.ctx.storage.sql
        .exec<Pick<StoredArticleAction, "status">>(
          "SELECT status FROM custom_gatekeeper_article_actions WHERE local_action_id = ?",
          actionId,
        )
        .toArray()[0];
      if (row?.status === "pending_approval") {
        this.ctx.storage.sql.exec(
          "DELETE FROM custom_gatekeeper_article_actions WHERE local_action_id = ? AND status = 'pending_approval'",
          actionId,
        );
        return;
      }
      if (row?.status === "applying" || row?.status === "applied")
        throw err("outcome_unknown");
      if (row === undefined) throw err("invalid_input");
      if (row.status === "failed") return;
      throw err("integrity_failure");
    }
  }
  async getAgentCatalog(
    r: AgentCatalogRequest,
    a: RpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog> {
    const c = boundAgentCatalog(
      [
        {
          id: "knowledge-base",
          title: "Knowledge Base",
          description:
            "Available. Use list to inspect current Knowledge summaries.",
        },
      ],
      r,
    );
    await a.authorizeObservation(
      observation(
        "Knowledge Base catalog",
        "Listed " + c.entries.length + " Knowledge Base catalog entries.",
      ),
    );
    return c;
  }
  async addObserver(
    _observerId: string,
    _user: Fetcher<GatekeeperUserVerifier>,
  ) {
    throw new Error("Knowledge Base is private to its Manager.");
  }
  async removeObserver() {}
  async revertAction() {
    throw err("invalid_input");
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
  async inspectManagerBinding(
    managerIdValue: string,
  ): Promise<"legacy" | "bound"> {
    if (!isManagerId(managerIdValue))
      throw new TypeError("Manager ID must be a UUID.");
    if (legacyProps(this.ctx.props)) return "legacy";
    const previous = this.ctx.props;
    if (rec(previous) && exact(previous, ["access"]) && previous.access) {
      // The OS atomically replaces legacy accounts. Validate the old binding first.
      await validateStub<Access>(previous.access as object).assertBoundTo(managerIdValue);
      return "legacy";
    }
    const p = validateProps(this.ctx.props);
    if (p.managerId !== managerIdValue)
      throw new TypeError("Knowledge Account is bound to another Manager.");
    const access = await this.ctx.exports.KnowledgeAccountAccess.getByName(p.managerId).getAccess();
    await access.assertBoundTo(managerIdValue);
    return "bound";
  }
  async getSingletonGatekeeperClass(): Promise<
    DurableObjectClass<Gatekeeper<KnowledgeBase>>
  > {
    return this.ctx.exports.CustomGatekeeper({ props: validateProps(this.ctx.props) });
  }
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }
  getGatekeeperClassFor(): never {
    throw new Error("Knowledge Base has no URL-addressed resources.");
  }
  startResourceConfigurator(): Promise<ResourceConfiguratorFrame> {
    throw new Error("Knowledge Base has no URL-addressed resources.");
  }
  async ensureResources() {
    return {};
  }
  async revoke() {}
  reconnect(): Promise<{ url: string }> {
    throw new Error("Knowledge Base has no credentials to reconnect.");
  }
  async getAuthenticatedEmail() {
    return null;
  }
  @skipRpcValidation() async getVerifier(): Promise<
    Fetcher<GatekeeperUserVerifier>
  > {
    return this.ctx.exports.CustomVerifier({});
  }
}
@validateRpc()
export class CustomVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUserVerifier
{
  verify() {}
}
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe() {
    return describeCustomVendor();
  }
  @skipRpcValidation() async createManagerAccount(
    managerId: string,
    capability: Access,
  ): Promise<Fetcher<GatekeeperUser>> {
    if (!isManagerId(managerId))
      throw new TypeError("Manager ID must be a UUID.");
    await this.ctx.exports.KnowledgeAccountAccess.getByName(managerId).bind(managerId, capability);
    return this.ctx.exports.CustomAccount({ props: { managerId } });
  }
  connectAccount(
    _c: Fetcher<GatekeeperConnectCallback>,
    _o?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error(
      "Knowledge Base is installed by the Manager runtime and has no connect flow.",
    );
  }
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
export type KnowledgeBase = {
  list(options?: { cursor?: string; limit?: number }): Promise<Page>;
  proposeArticle(input: { article: Article }): Promise<ProposalResult>;
  readArticleOutcome(input: { operationId: string }): Promise<ArticleOutcome | null>;
  proposeKnowledgeCreate(input: { displayName: string }): Promise<ProposalResult>;
  readCreationOutcome(input: { operationId: string }): Promise<CreationOutcome | null>;
};
