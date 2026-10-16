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
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
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
const KNOWLEDGE_UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const KNOWLEDGE_RECEIPT_TTL = 3_600_000;
const KNOWLEDGE_BRONZE_ADMISSION_WINDOW_MS = 300_000;
const KNOWLEDGE_BRONZE_MAX_BODY_BYTES = 64 * 1024;
const KNOWLEDGE_BRONZE_MAX_ACTION_BYTES = 96 * 1024;
const KNOWLEDGE_BRONZE_MAX_METADATA_BYTES = 64 * 1024;
const KNOWLEDGE_BRONZE_MAX_STAGE_METADATA_BYTES = 32 * 1024;
export type KnowledgeListInput = { offset: number; limit: number };
export type KnowledgeSearchInput = { query: string; offset: number; limit: number };
export type KnowledgeReadInput = { path: string };
export type KnowledgeReadReceipt<A> = Readonly<{ value: A; expiresAt: number }>;
export const KNOWLEDGE_READ_CONTRACT = "cybernest-knowledge-read-v1" as const;
export type KnowledgeAccess = {
  /** Installation-only identity assertion. It is never part of the Agent session. */
  assertBoundTo(managerId: string): typeof KNOWLEDGE_READ_CONTRACT | Promise<typeof KNOWLEDGE_READ_CONTRACT>;
  list(input: KnowledgeListInput): Promise<unknown>;
  search(input: KnowledgeSearchInput): Promise<unknown>;
  read(input: KnowledgeReadInput): Promise<unknown>;
};
type Access = KnowledgeAccess;
export const KNOWLEDGE_BRONZE_WRITE_CONTRACT = "cybernest-knowledge-bronze-write-v1" as const;
export const KNOWLEDGE_SOURCE_READ_CONTRACT = "cybernest-knowledge-source-read-v1" as const;
export type KnowledgeBronzeWrite = {
  assertBoundTo(
    managerId: string,
  ): typeof KNOWLEDGE_BRONZE_WRITE_CONTRACT | Promise<typeof KNOWLEDGE_BRONZE_WRITE_CONTRACT>;
  apply(input: unknown): Promise<unknown>;
  cancel(input: unknown): Promise<unknown>;
};
export type KnowledgeSourceReader = {
  assertBoundTo(
    managerId: string,
  ): typeof KNOWLEDGE_SOURCE_READ_CONTRACT | Promise<typeof KNOWLEDGE_SOURCE_READ_CONTRACT>;
  verifySource(input: unknown): Promise<unknown>;
};
export type KnowledgeBronzeRoles = Readonly<{
  writer: "absent" | "installed" | "incompatible";
  sourceReader: "absent" | "installed" | "incompatible";
}>;
type KnowledgeBronzeCapabilities = Readonly<{
  writer: KnowledgeBronzeWrite;
  sourceReader: KnowledgeSourceReader;
}>;
type KnowledgeActionQueue = ApprovalQueue & {
  getWorkspaceId(): string | Promise<string>;
};
type KnowledgeSourceSelector =
  | Readonly<{ kind: "chat_message"; chatId: number; sequence: number }>
  | Readonly<{ kind: "os_observation"; actionId: number; gatekeeperId: number }>;
type KnowledgeArticleProposal =
  | Readonly<{
      kind: "adopt";
      body: string;
      sourceSelector: KnowledgeSourceSelector;
      observedTargetDescription: string;
      sourceRelationshipClaim: string;
      initialUsePolicy: "included" | "excluded";
      expectedCurrentRevision: null;
    }>
  | Readonly<{
      kind: "revise";
      articleId: string;
      body: string;
      sourceSelector: KnowledgeSourceSelector;
      observedTargetDescription: string;
      sourceRelationshipClaim: string;
      expectedCurrentRevision: string;
    }>;
type KnowledgeVerifiedSource =
  | Readonly<{
      version: "os-provenance-dto-v1";
      kind: "chat_message";
      chatId: number;
      sequence: number;
      timestampMs: number;
      author: Readonly<{ type: "user" | "agent" | "gadget"; id: string }>;
    }>
  | Readonly<{
      version: "os-provenance-dto-v1";
      kind: "os_observation";
      actionId: number;
      gatekeeperId: number;
      createdAtMs: number;
      title: string;
      resourceTitle: string;
    }>;
type KnowledgeProvenance = KnowledgeVerifiedSource & Readonly<{
  observedTargetDescription: string;
  sourceRelationshipClaim: string;
}>;
type KnowledgeBronzeNamespace = Readonly<{
  workspaceId: string;
  gatekeeperInstanceId: string;
  localActionId: number;
}>;
type KnowledgeBronzeStageSlot = Readonly<{
  status: "active" | "fenced";
  workspaceId: string;
  gatekeeperInstanceId: string;
  localActionId: number;
  operationId: string;
  operationDeadlineMs: number;
  retainedBytesReserved: number;
}>;
type KnowledgeSessionProposal = (input: unknown) => Promise<Readonly<{
  status: "pending_approval";
  operationId: string;
}>>;
type InspectableAccess = Omit<Access, "assertBoundTo"> & {
  assertBoundTo(
    managerId: string,
  ): void | typeof KNOWLEDGE_READ_CONTRACT |
      Promise<void | typeof KNOWLEDGE_READ_CONTRACT>;
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
const exactOptional = (
  v: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
) =>
  required.every((key) => Object.prototype.hasOwnProperty.call(v, key)) &&
  Object.keys(v).every((key) => required.includes(key) || optional.includes(key));
const boundedInt = (v: unknown, min: number, max: number): v is number =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const isNonEmptyBoundedText = (value: unknown, maxBytes: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  !hasLoneSurrogate(value) &&
  new TextEncoder().encode(value).byteLength <= maxBytes;
const sha256Hex = async (value: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const encodeLengthPrefixed = (fields: readonly string[]): Uint8Array => {
  const encoder = new TextEncoder();
  const encodedFields = fields.map((field) => encoder.encode(field));
  const output = new Uint8Array(encodedFields.reduce((sum, field) => sum + 4 + field.byteLength, 0));
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const field of encodedFields) {
    view.setUint32(offset, field.byteLength, false);
    offset += 4;
    output.set(field, offset);
    offset += field.byteLength;
  }
  return output;
};
const parseKnowledgeEnvelope = (value: unknown):
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; code: string }> => {
  if (!rec(value)) throw err("integrity_failure");
  if (exact(value, ["ok", "value"]) && value.ok === true)
    return { ok: true, value: value.value };
  if (
    exact(value, ["ok", "code"]) &&
    value.ok === false &&
    typeof value.code === "string" &&
    KNOWLEDGE_FAILURE_CODES.includes(value.code as (typeof KNOWLEDGE_FAILURE_CODES)[number])
  ) return { ok: false, code: value.code };
  throw err("integrity_failure");
};
type KnowledgeBronzeSavedReceipt = Readonly<{
  status: "saved";
  operationId: string;
  articleId: string;
  revisionId: string;
  bodyHash: string;
}>;
function parseBronzeSavedReceipt(value: unknown, operationId: string): KnowledgeBronzeSavedReceipt {
  if (
    !rec(value) ||
    !exact(value, ["status", "operationId", "articleId", "revisionId", "bodyHash"]) ||
    value.status !== "saved" ||
    value.operationId !== operationId ||
    typeof value.articleId !== "string" || !KNOWLEDGE_UUID.test(value.articleId) ||
    typeof value.revisionId !== "string" || !KNOWLEDGE_UUID.test(value.revisionId) ||
    !isHexDigest(value.bodyHash)
  ) throw err("integrity_failure");
  return {
    status: "saved",
    operationId,
    articleId: value.articleId,
    revisionId: value.revisionId,
    bodyHash: value.bodyHash,
  };
}
function parseStoredBronzeSavedReceipt(serialized: string | null, operationId: string): KnowledgeBronzeSavedReceipt {
  if (serialized === null) throw err("corrupt_state");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw err("corrupt_state");
  }
  return parseBronzeSavedReceipt(value, operationId);
}
function decodeKnowledgeArticleProposal(value: unknown): KnowledgeArticleProposal {
  if (!rec(value) || !exact(value, ["article"]) || !rec(value.article))
    throw err("invalid_input");
  const article = value.article;
  if (
    article.kind === "adopt" &&
    exact(article, [
      "kind",
      "body",
      "sourceSelector",
      "observedTargetDescription",
      "sourceRelationshipClaim",
      "initialUsePolicy",
      "expectedCurrentRevision",
    ]) &&
    article.expectedCurrentRevision === null &&
    (article.initialUsePolicy === "included" || article.initialUsePolicy === "excluded") &&
    isNonEmptyBoundedText(article.body, KNOWLEDGE_BRONZE_MAX_BODY_BYTES) &&
    isKnowledgeSourceSelector(article.sourceSelector) &&
    isNonEmptyBoundedText(article.observedTargetDescription, KNOWLEDGE_BRONZE_MAX_METADATA_BYTES) &&
    isNonEmptyBoundedText(article.sourceRelationshipClaim, KNOWLEDGE_BRONZE_MAX_METADATA_BYTES)
  ) {
    return {
      kind: "adopt",
      body: article.body,
      sourceSelector: article.sourceSelector,
      observedTargetDescription: article.observedTargetDescription,
      sourceRelationshipClaim: article.sourceRelationshipClaim,
      initialUsePolicy: article.initialUsePolicy,
      expectedCurrentRevision: null,
    };
  }
  if (
    article.kind === "revise" &&
    exact(article, [
      "kind",
      "articleId",
      "body",
      "sourceSelector",
      "observedTargetDescription",
      "sourceRelationshipClaim",
      "expectedCurrentRevision",
    ]) &&
    typeof article.articleId === "string" && KNOWLEDGE_UUID.test(article.articleId) &&
    typeof article.expectedCurrentRevision === "string" &&
    KNOWLEDGE_UUID.test(article.expectedCurrentRevision) &&
    isNonEmptyBoundedText(article.body, KNOWLEDGE_BRONZE_MAX_BODY_BYTES) &&
    isKnowledgeSourceSelector(article.sourceSelector) &&
    isNonEmptyBoundedText(article.observedTargetDescription, KNOWLEDGE_BRONZE_MAX_METADATA_BYTES) &&
    isNonEmptyBoundedText(article.sourceRelationshipClaim, KNOWLEDGE_BRONZE_MAX_METADATA_BYTES)
  ) {
    return {
      kind: "revise",
      articleId: article.articleId,
      body: article.body,
      sourceSelector: article.sourceSelector,
      observedTargetDescription: article.observedTargetDescription,
      sourceRelationshipClaim: article.sourceRelationshipClaim,
      expectedCurrentRevision: article.expectedCurrentRevision,
    };
  }
  throw err("invalid_input");
}
function isKnowledgeSourceSelector(value: unknown): value is KnowledgeSourceSelector {
  if (!rec(value)) return false;
  if (
    value.kind === "chat_message" &&
    exact(value, ["kind", "chatId", "sequence"]) &&
    boundedInt(value.chatId, 0, Number.MAX_SAFE_INTEGER) &&
    boundedInt(value.sequence, 0, Number.MAX_SAFE_INTEGER)
  ) return true;
  return value.kind === "os_observation" &&
    exact(value, ["kind", "actionId", "gatekeeperId"]) &&
    boundedInt(value.actionId, 0, Number.MAX_SAFE_INTEGER) &&
    boundedInt(value.gatekeeperId, 0, Number.MAX_SAFE_INTEGER);
}
function decodeVerifiedSource(
  value: unknown,
  selector: KnowledgeSourceSelector,
): KnowledgeVerifiedSource {
  if (!rec(value) || value.version !== "os-provenance-dto-v1") throw err("integrity_failure");
  if (
    selector.kind === "chat_message" &&
    value.kind === "chat_message" &&
    exact(value, ["version", "kind", "chatId", "sequence", "timestampMs", "author"]) &&
    value.chatId === selector.chatId &&
    value.sequence === selector.sequence &&
    boundedInt(value.timestampMs, 0, Number.MAX_SAFE_INTEGER) &&
    rec(value.author) &&
    exact(value.author, ["type", "id"]) &&
    (value.author.type === "user" || value.author.type === "agent" || value.author.type === "gadget") &&
    isNonEmptyBoundedText(value.author.id, KNOWLEDGE_BRONZE_MAX_METADATA_BYTES)
  ) {
    return {
      version: "os-provenance-dto-v1",
      kind: "chat_message",
      chatId: value.chatId as number,
      sequence: value.sequence as number,
      timestampMs: value.timestampMs,
      author: { type: value.author.type, id: value.author.id },
    };
  }
  if (
    selector.kind === "os_observation" &&
    value.kind === "os_observation" &&
    exact(value, ["version", "kind", "actionId", "gatekeeperId", "createdAtMs", "title", "resourceTitle"]) &&
    value.actionId === selector.actionId &&
    value.gatekeeperId === selector.gatekeeperId &&
    boundedInt(value.createdAtMs, 0, Number.MAX_SAFE_INTEGER) &&
    typeof value.title === "string" &&
    typeof value.resourceTitle === "string"
  ) {
    return {
      version: "os-provenance-dto-v1",
      kind: "os_observation",
      actionId: value.actionId as number,
      gatekeeperId: value.gatekeeperId as number,
      createdAtMs: value.createdAtMs,
      title: value.title,
      resourceTitle: value.resourceTitle,
    };
  }
  throw err("integrity_failure");
}
function articleClaims(article: KnowledgeArticleProposal): Pick<
  KnowledgeProvenance,
  "observedTargetDescription" | "sourceRelationshipClaim"
> {
  return {
    observedTargetDescription: article.observedTargetDescription,
    sourceRelationshipClaim: article.sourceRelationshipClaim,
  };
}
function canonicalKnowledgeProvenance(value: KnowledgeProvenance): string {
  if (value.kind === "chat_message") {
    return JSON.stringify({
      version: value.version,
      kind: value.kind,
      chatId: value.chatId,
      sequence: value.sequence,
      timestampMs: value.timestampMs,
      author: { type: value.author.type, id: value.author.id },
      observedTargetDescription: value.observedTargetDescription,
      sourceRelationshipClaim: value.sourceRelationshipClaim,
    });
  }
  return JSON.stringify({
    version: value.version,
    kind: value.kind,
    actionId: value.actionId,
    gatekeeperId: value.gatekeeperId,
    createdAtMs: value.createdAtMs,
    title: value.title,
    resourceTitle: value.resourceTitle,
    observedTargetDescription: value.observedTargetDescription,
    sourceRelationshipClaim: value.sourceRelationshipClaim,
  });
}
async function computeKnowledgeBronzeIntentHash(input: Readonly<{
  intent: KnowledgeProposedIntent;
  operationId: string;
  managerId: string;
  namespace: KnowledgeBronzeNamespace;
  bodyBytes: Uint8Array;
}>): Promise<string> {
  const bodyHash = await sha256Hex(input.bodyBytes);
  const provenanceBytes = new TextEncoder().encode(canonicalKnowledgeProvenance(input.intent.provenance));
  const provenanceHash = await sha256Hex(provenanceBytes);
  const fields = [
    "knowledge-bronze-intent-v1",
    input.intent.kind,
    input.operationId,
    input.intent.articleId,
    input.intent.revisionId,
    input.intent.expectedCurrentRevision ?? "",
    bodyHash,
    String(input.bodyBytes.byteLength),
    input.intent.provenance.version,
    provenanceHash,
    input.intent.kind === "adopt" ? input.intent.initialUsePolicy : "",
    input.managerId,
    input.namespace.workspaceId,
    input.namespace.gatekeeperInstanceId,
    String(input.namespace.localActionId),
  ];
  return sha256Hex(encodeLengthPrefixed(fields));
}
type KnowledgeProposedIntent =
  | Readonly<{
      kind: "adopt";
      articleId: string;
      revisionId: string;
      expectedCurrentRevision: null;
      body: string;
      initialUsePolicy: "included" | "excluded";
      provenance: KnowledgeProvenance;
    }>
  | Readonly<{
      kind: "revise";
      articleId: string;
      revisionId: string;
      expectedCurrentRevision: string;
      body: string;
      provenance: KnowledgeProvenance;
    }>;
type KnowledgeStagedCommand = Readonly<{
  kind: "staged";
  namespace: KnowledgeBronzeNamespace;
  operationId: string;
  attemptFencingToken: number;
  operationDeadlineMs: number;
  fullIntentHash: string;
  intent: KnowledgeProposedIntent;
}>;
async function decodeStoredBronzeStage(
  serialized: string,
  actionId: number,
  gatekeeperInstanceId: string,
  managerId: string,
): Promise<KnowledgeStagedCommand> {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw err("corrupt_state");
  }
  if (
    !rec(value) ||
    !exact(value, [
      "kind", "namespace", "operationId", "attemptFencingToken",
      "operationDeadlineMs", "fullIntentHash", "intent",
    ]) ||
    value.kind !== "staged" ||
    !rec(value.namespace) ||
    !exact(value.namespace, ["workspaceId", "gatekeeperInstanceId", "localActionId"]) ||
    !isNonEmptyBoundedText(value.namespace.workspaceId, 512) ||
    value.namespace.gatekeeperInstanceId !== gatekeeperInstanceId ||
    !boundedInt(value.namespace.localActionId, 0, Number.MAX_SAFE_INTEGER) ||
    value.namespace.localActionId !== actionId ||
    typeof value.operationId !== "string" || !UUID.test(value.operationId) ||
    !boundedInt(value.attemptFencingToken, 1, Number.MAX_SAFE_INTEGER) ||
    !boundedInt(value.operationDeadlineMs, 0, Number.MAX_SAFE_INTEGER) ||
    !isHexDigest(value.fullIntentHash) ||
    !rec(value.intent)
  ) throw err("corrupt_state");

  const rawIntent = value.intent;
  const rawProvenance = rawIntent.provenance;
  if (!rec(rawProvenance)) throw err("corrupt_state");
  let selector: KnowledgeSourceSelector;
  let verifiedRaw: Record<string, unknown>;
  if (rawProvenance.kind === "chat_message") {
    selector = {
      kind: "chat_message",
      chatId: rawProvenance.chatId as number,
      sequence: rawProvenance.sequence as number,
    };
    if (!exact(rawProvenance, [
      "version", "kind", "chatId", "sequence", "timestampMs", "author",
      "observedTargetDescription", "sourceRelationshipClaim",
    ])) throw err("corrupt_state");
    verifiedRaw = {
      version: rawProvenance.version,
      kind: rawProvenance.kind,
      chatId: rawProvenance.chatId,
      sequence: rawProvenance.sequence,
      timestampMs: rawProvenance.timestampMs,
      author: rawProvenance.author,
    };
  } else if (rawProvenance.kind === "os_observation") {
    selector = {
      kind: "os_observation",
      actionId: rawProvenance.actionId as number,
      gatekeeperId: rawProvenance.gatekeeperId as number,
    };
    if (!exact(rawProvenance, [
      "version", "kind", "actionId", "gatekeeperId", "createdAtMs", "title",
      "resourceTitle", "observedTargetDescription", "sourceRelationshipClaim",
    ])) throw err("corrupt_state");
    verifiedRaw = {
      version: rawProvenance.version,
      kind: rawProvenance.kind,
      actionId: rawProvenance.actionId,
      gatekeeperId: rawProvenance.gatekeeperId,
      createdAtMs: rawProvenance.createdAtMs,
      title: rawProvenance.title,
      resourceTitle: rawProvenance.resourceTitle,
    };
  } else {
    throw err("corrupt_state");
  }
  if (!isKnowledgeSourceSelector(selector)) throw err("corrupt_state");
  const verified = decodeVerifiedSource(verifiedRaw, selector);
  if (
    !isNonEmptyBoundedText(rawProvenance.observedTargetDescription, KNOWLEDGE_BRONZE_MAX_METADATA_BYTES) ||
    !isNonEmptyBoundedText(rawProvenance.sourceRelationshipClaim, KNOWLEDGE_BRONZE_MAX_METADATA_BYTES)
  ) throw err("corrupt_state");
  const provenance: KnowledgeProvenance = {
    ...verified,
    observedTargetDescription: rawProvenance.observedTargetDescription,
    sourceRelationshipClaim: rawProvenance.sourceRelationshipClaim,
  };
  let intent: KnowledgeProposedIntent;
  if (
    rawIntent.kind === "adopt" &&
    exact(rawIntent, [
      "kind", "articleId", "revisionId", "expectedCurrentRevision", "body",
      "initialUsePolicy", "provenance",
    ]) &&
    typeof rawIntent.articleId === "string" && KNOWLEDGE_UUID.test(rawIntent.articleId) &&
    typeof rawIntent.revisionId === "string" && KNOWLEDGE_UUID.test(rawIntent.revisionId) &&
    rawIntent.expectedCurrentRevision === null &&
    (rawIntent.initialUsePolicy === "included" || rawIntent.initialUsePolicy === "excluded") &&
    isNonEmptyBoundedText(rawIntent.body, KNOWLEDGE_BRONZE_MAX_BODY_BYTES)
  ) {
    intent = {
      kind: "adopt",
      articleId: rawIntent.articleId,
      revisionId: rawIntent.revisionId,
      expectedCurrentRevision: null,
      body: rawIntent.body,
      initialUsePolicy: rawIntent.initialUsePolicy,
      provenance,
    };
  } else if (
    rawIntent.kind === "revise" &&
    exact(rawIntent, [
      "kind", "articleId", "revisionId", "expectedCurrentRevision", "body", "provenance",
    ]) &&
    typeof rawIntent.articleId === "string" && KNOWLEDGE_UUID.test(rawIntent.articleId) &&
    typeof rawIntent.revisionId === "string" && KNOWLEDGE_UUID.test(rawIntent.revisionId) &&
    typeof rawIntent.expectedCurrentRevision === "string" &&
    KNOWLEDGE_UUID.test(rawIntent.expectedCurrentRevision) &&
    isNonEmptyBoundedText(rawIntent.body, KNOWLEDGE_BRONZE_MAX_BODY_BYTES)
  ) {
    intent = {
      kind: "revise",
      articleId: rawIntent.articleId,
      revisionId: rawIntent.revisionId,
      expectedCurrentRevision: rawIntent.expectedCurrentRevision,
      body: rawIntent.body,
      provenance,
    };
  } else {
    throw err("corrupt_state");
  }
  const namespace: KnowledgeBronzeNamespace = {
    workspaceId: value.namespace.workspaceId,
    gatekeeperInstanceId,
    localActionId: actionId,
  };
  const command: KnowledgeStagedCommand = {
    kind: "staged",
    namespace,
    operationId: value.operationId,
    attemptFencingToken: value.attemptFencingToken,
    operationDeadlineMs: value.operationDeadlineMs,
    fullIntentHash: value.fullIntentHash,
    intent,
  };
  const actualHash = await computeKnowledgeBronzeIntentHash({
    intent,
    operationId: command.operationId,
    managerId,
    namespace,
    bodyBytes: new TextEncoder().encode(intent.body),
  });
  if (actualHash !== command.fullIntentHash) throw err("corrupt_state");
  return command;
}
const hasLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};
const isHexDigest = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{64}$/u.test(v);
const isCanonicalMarkdownPath = (v: unknown): v is string =>
  typeof v === "string" &&
  !hasLoneSurrogate(v) &&
  new TextEncoder().encode(v).byteLength <= 240 &&
  v.length > 0 &&
  !/[\u0000-\u001f]/u.test(v) &&
  !v.includes("\\") &&
  !v.startsWith("/") &&
  !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(v) &&
  v.endsWith(".md") &&
  v.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
const isJsonValue = (v: unknown): boolean => {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isJsonValue);
  if (!rec(v)) return false;
  return Object.values(v).every(isJsonValue);
};
const validListResult = (v: unknown): v is KnowledgeListResult =>
  rec(v) &&
  exactOptional(v, ["bundleId", "versionId", "items"], ["nextOffset"]) &&
  isHexDigest(v.bundleId) &&
  knowledgeUuid(v.versionId) &&
  Array.isArray(v.items) &&
  v.items.length <= 16 &&
  v.items.every(
    (item) =>
      rec(item) && exact(item, ["path"]) && isCanonicalMarkdownPath(item.path),
  ) &&
  (!Object.prototype.hasOwnProperty.call(v, "nextOffset") ||
    boundedInt(v.nextOffset, 0, 64));
const validSearchResult = (v: unknown): v is KnowledgeSearchResult =>
  rec(v) &&
  exactOptional(v, ["bundleId", "versionId", "hits"], ["nextOffset"]) &&
  isHexDigest(v.bundleId) &&
  knowledgeUuid(v.versionId) &&
  Array.isArray(v.hits) &&
  v.hits.length <= 16 &&
  v.hits.every(
    (hit) =>
      rec(hit) &&
      exact(hit, ["path", "line", "snippet"]) &&
      isCanonicalMarkdownPath(hit.path) &&
      boundedInt(hit.line, 1, Number.MAX_SAFE_INTEGER) &&
      typeof hit.snippet === "string" &&
      new TextEncoder().encode(hit.snippet).byteLength <= 240,
  ) &&
  (!Object.prototype.hasOwnProperty.call(v, "nextOffset") ||
    boundedInt(v.nextOffset, 0, 1_048_576));
const validReadResult = (v: unknown): v is KnowledgeReadResult =>
  rec(v) &&
  exact(v, ["bundleId", "versionId", "path", "sourceMarkdown", "metadata"]) &&
  isHexDigest(v.bundleId) &&
  knowledgeUuid(v.versionId) &&
  isCanonicalMarkdownPath(v.path) &&
  typeof v.sourceMarkdown === "string" &&
  rec(v.metadata) &&
  isJsonValue(v.metadata);
const uuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const knowledgeUuid = (v: unknown): v is string =>
  typeof v === "string" && KNOWLEDGE_UUID.test(v);
const observation = (title: string, description: string) => ({
  title,
  description,
  containsRestrictedData: true,
  ownerInvitesOnly: true,
});
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
const KNOWLEDGE_FAILURE_CODES = [
  "permission_denied",
  "wiki_not_ready",
  "page_not_found",
  "invalid_input",
  "input_too_large",
  "response_too_large",
  "read_deadline_exceeded",
  "capacity_exceeded",
  "admission_expired",
  "corrupt_bundle",
  "dependency_unavailable",
  "not_found",
  "conflict",
  "result_unknown",
  "corrupt_state",
] as const;
const privateReadCauses = new WeakMap<Error, unknown>();
const privateDependencyFailure = (cause: unknown): Error => {
  const error = new Error("Knowledge Base read failed.");
  privateReadCauses.set(error, cause);
  return error;
};

@validateRpc()
export class KnowledgeSession extends RpcTarget {
  readonly #q: RpcStub<KnowledgeActionQueue>;
  readonly #a: KnowledgeAccess;
  readonly #propose: KnowledgeSessionProposal;
  #disposed = false;

  constructor(
    q: RpcStub<KnowledgeActionQueue>,
    a: KnowledgeAccess,
    propose: KnowledgeSessionProposal,
  ) {
    super();
    this.#q = q;
    this.#a = a;
    this.#propose = propose;
  }

  async proposeArticle(input: unknown): Promise<Readonly<{
    status: "pending_approval";
    operationId: string;
  }>> {
    if (this.#disposed) throw err("invalid_input");
    return this.#propose(input);
  }

  async #read<T>(
    title: string,
    description: string,
    operation: () => Promise<unknown>,
    validate: (value: unknown) => value is T,
  ): Promise<T> {
    let raw: unknown;
    try {
      raw = await operation();
    } catch (cause) {
      // Keep an unexpected transport/defect/interrupt opaque without relabeling it as a typed
      // Knowledge envelope failure. The raw cause remains private to this Worker.
      throw privateDependencyFailure(cause);
    }
    if (!rec(raw)) throw err("integrity_failure");
    if (exact(raw, ["ok", "code"]) && raw.ok === false) {
      if (!(KNOWLEDGE_FAILURE_CODES as readonly unknown[]).includes(raw.code))
        throw err("integrity_failure");
      throw err(raw.code as string);
    }
    if (!exact(raw, ["ok", "value"]) || raw.ok !== true || !rec(raw.value))
      throw err("integrity_failure");
    const receipt = raw.value;
    const receivedAt = Date.now();
    if (
      !Number.isSafeInteger(receivedAt) ||
      receivedAt < 0 ||
      !exact(receipt, ["value", "expiresAt"]) ||
      !Number.isSafeInteger(receipt.expiresAt) ||
      (receipt.expiresAt as number) < 0 ||
      !Number.isSafeInteger(receivedAt + KNOWLEDGE_RECEIPT_TTL) ||
      (receipt.expiresAt as number) > receivedAt + KNOWLEDGE_RECEIPT_TTL
    )
      throw err("integrity_failure");
    const expiresAt = receipt.expiresAt as number;
    if (expiresAt <= receivedAt) throw err("permission_denied");
    if (!validate(receipt.value)) throw err("integrity_failure");

    await this.#q.authorizeObservation(observation(title, description));

    // The receipt is immutable for this read. A later read may have a newer expiry, but cannot
    // extend the authorization window for the payload currently held across observation.
    const authorizedAt = Date.now();
    if (
      !Number.isSafeInteger(authorizedAt) ||
      authorizedAt < 0 ||
      expiresAt <= authorizedAt
    )
      throw err("permission_denied");
    return receipt.value;
  }

  async list(input: KnowledgeListInput): Promise<KnowledgeListResult> {
    if (
      !rec(input) ||
      !exact(input, ["offset", "limit"]) ||
      !boundedInt(input.offset, 0, 64) ||
      !boundedInt(input.limit, 1, 16)
    )
      throw err("invalid_input");
    return this.#read(
      "Knowledge Base list",
      "List private Knowledge pages for this Manager.",
      () => this.#a.list(input),
      validListResult,
    );
  }

  async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult> {
    if (
      !rec(input) ||
      !exact(input, ["query", "offset", "limit"]) ||
      typeof input.query !== "string" ||
      input.query.length === 0 ||
      hasLoneSurrogate(input.query) ||
      new TextEncoder().encode(input.query).byteLength > 120 ||
      input.query.includes("\n") ||
      input.query.includes("\r") ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(input.query) ||
      !boundedInt(input.offset, 0, 1_048_576) ||
      !boundedInt(input.limit, 1, 16)
    )
      throw err("invalid_input");
    return this.#read(
      "Knowledge Base search",
      "Search private Knowledge pages for this Manager.",
      () => this.#a.search(input),
      validSearchResult,
    );
  }

  async read(input: KnowledgeReadInput): Promise<KnowledgeReadResult> {
    if (
      !rec(input) ||
      !exact(input, ["path"]) ||
      !isCanonicalMarkdownPath(input.path)
    )
      throw err("invalid_input");
    return this.#read(
      "Knowledge Base read",
      "Read a private Knowledge page for this Manager.",
      () => this.#a.read(input),
      (value): value is KnowledgeReadResult =>
        validReadResult(value) && value.path === input.path,
    );
  }

  [Symbol.dispose]() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#q[Symbol.dispose]?.();
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
type KnowledgeBronzeReservationBinding = Pick<
  KnowledgeBronzeStageSlot,
  "workspaceId" | "gatekeeperInstanceId" | "localActionId" | "operationId" | "operationDeadlineMs"
>;
function isKnowledgeBronzeStageSlot(value: unknown): value is KnowledgeBronzeStageSlot {
  return rec(value) &&
    exact(value, [
      "status",
      "workspaceId",
      "gatekeeperInstanceId",
      "localActionId",
      "operationId",
      "operationDeadlineMs",
      "retainedBytesReserved",
    ]) &&
    (value.status === "active" || value.status === "fenced") &&
    isNonEmptyBoundedText(value.workspaceId, 512) &&
    isNonEmptyBoundedText(value.gatekeeperInstanceId, 512) &&
    boundedInt(value.localActionId, 0, Number.MAX_SAFE_INTEGER) &&
    UUID.test(String(value.operationId)) &&
    boundedInt(value.operationDeadlineMs, 0, Number.MAX_SAFE_INTEGER) &&
    boundedInt(
      value.retainedBytesReserved,
      1,
      KNOWLEDGE_BRONZE_MAX_ACTION_BYTES + KNOWLEDGE_BRONZE_MAX_METADATA_BYTES,
    );
}
function sameBronzeReservation(
  slot: KnowledgeBronzeStageSlot,
  binding: KnowledgeBronzeReservationBinding,
): boolean {
  return slot.workspaceId === binding.workspaceId &&
    slot.gatekeeperInstanceId === binding.gatekeeperInstanceId &&
    slot.localActionId === binding.localActionId &&
    slot.operationId === binding.operationId &&
    slot.operationDeadlineMs === binding.operationDeadlineMs;
}

// Facet class props cannot contain capabilities on the deployed platform.
// This namespace is Worker-private and never handed to an Agent or HTTP caller.
export class KnowledgeAccountAccess extends DurableObject<Cloudflare.Env> {
  async bind(managerId: string, capability: KnowledgeAccess): Promise<void> {
    if (!isManagerId(managerId) ||
        !this.ctx.id.equals(this.ctx.exports.KnowledgeAccountAccess.idFromName(managerId)))
      throw new TypeError("Knowledge access store is bound to another Manager.");
    const contract = await validateStub<KnowledgeAccess>(capability).assertBoundTo(managerId);
    if (contract !== KNOWLEDGE_READ_CONTRACT)
      throw err("incompatible_reader_contract");
    const stored = await this.ctx.storage.get<KnowledgeAccess>("access");
    if (stored !== undefined) {
      const storedContract = await validateStub<InspectableAccess>(stored)
        .assertBoundTo(managerId);
      if (storedContract !== KNOWLEDGE_READ_CONTRACT)
        throw err("incompatible_reader_contract");
      return;
    }
    // Serialize the check-and-first-write locally. The RPC assertions remain outside this gate.
    const racedBinding = await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.get<KnowledgeAccess>("access");
      if (current !== undefined) return current;
      // Persist the native stub, not its validation Proxy.
      await this.ctx.storage.put("access", capability);
      return undefined;
    });
    if (racedBinding !== undefined) {
      const racedContract = await validateStub<InspectableAccess>(racedBinding)
        .assertBoundTo(managerId);
      if (racedContract !== KNOWLEDGE_READ_CONTRACT)
        throw err("incompatible_reader_contract");
    }
  }

  async getAccess(): Promise<Access> {
    const access = await this.ctx.storage.get<KnowledgeAccess>("access");
    if (!access) throw new Error("Knowledge Account access is not initialized.");
    // Return the native service-binding stub; its validator proxy is local-only and cannot be
    // serialized through the Durable Object RPC boundary.
    return access;
  }

  async bindBronzeRoles(
    managerId: string,
    writer: KnowledgeBronzeWrite,
    sourceReader: KnowledgeSourceReader,
  ): Promise<void> {
    if (!isManagerId(managerId) ||
        !this.ctx.id.equals(this.ctx.exports.KnowledgeAccountAccess.idFromName(managerId)))
      throw new TypeError("Knowledge Bronze role store is bound to another Manager.");

    const writerContract = await validateStub<KnowledgeBronzeWrite>(writer)
      .assertBoundTo(managerId);
    const sourceContract = await validateStub<KnowledgeSourceReader>(sourceReader)
      .assertBoundTo(managerId);
    if (writerContract !== KNOWLEDGE_BRONZE_WRITE_CONTRACT ||
        sourceContract !== KNOWLEDGE_SOURCE_READ_CONTRACT)
      throw err("incompatible_bronze_role_contract");

    const currentWriter = await this.ctx.storage.get<KnowledgeBronzeWrite>("bronzeWriter");
    const currentSourceReader = await this.ctx.storage.get<KnowledgeSourceReader>("sourceReader");
    if (currentWriter !== undefined) {
      const currentContract = await validateStub<KnowledgeBronzeWrite>(currentWriter)
        .assertBoundTo(managerId);
      if (currentContract !== KNOWLEDGE_BRONZE_WRITE_CONTRACT)
        throw err("incompatible_bronze_role_contract");
    }
    if (currentSourceReader !== undefined) {
      const currentContract = await validateStub<KnowledgeSourceReader>(currentSourceReader)
        .assertBoundTo(managerId);
      if (currentContract !== KNOWLEDGE_SOURCE_READ_CONTRACT)
        throw err("incompatible_bronze_role_contract");
    }

    const raced = await this.ctx.blockConcurrencyWhile(async () => {
      const currentWriter = await this.ctx.storage.get<KnowledgeBronzeWrite>("bronzeWriter");
      const currentSourceReader = await this.ctx.storage.get<KnowledgeSourceReader>("sourceReader");
      // A single bounded account slot owns each role. Existing valid stubs are retained so a
      // repeated ensure does not replace a live capability underneath a session.
      if (currentWriter === undefined) await this.ctx.storage.put("bronzeWriter", writer);
      if (currentSourceReader === undefined)
        await this.ctx.storage.put("sourceReader", sourceReader);
      return {
        writer: currentWriter,
        sourceReader: currentSourceReader,
      };
    });
    // Another bind may have filled a missing slot while the candidate stubs were being checked.
    // Revalidate those winning immutable values after leaving the local gate.
    if (raced.writer !== undefined) {
      const currentContract = await validateStub<KnowledgeBronzeWrite>(raced.writer)
        .assertBoundTo(managerId);
      if (currentContract !== KNOWLEDGE_BRONZE_WRITE_CONTRACT)
        throw err("incompatible_bronze_role_contract");
    }
    if (raced.sourceReader !== undefined) {
      const currentContract = await validateStub<KnowledgeSourceReader>(raced.sourceReader)
        .assertBoundTo(managerId);
      if (currentContract !== KNOWLEDGE_SOURCE_READ_CONTRACT)
        throw err("incompatible_bronze_role_contract");
    }
  }

  async inspectBronzeRoles(managerId: string): Promise<KnowledgeBronzeRoles> {
    if (!isManagerId(managerId) ||
        !this.ctx.id.equals(this.ctx.exports.KnowledgeAccountAccess.idFromName(managerId)))
      throw new TypeError("Knowledge Bronze role store is bound to another Manager.");
    const writer = await this.ctx.storage.get<KnowledgeBronzeWrite>("bronzeWriter");
    const sourceReader = await this.ctx.storage.get<KnowledgeSourceReader>("sourceReader");
    const [writerState, sourceReaderState] = await Promise.all([
      this.#inspectRole(writer, managerId, "writer"),
      this.#inspectRole(sourceReader, managerId, "sourceReader"),
    ]);
    return { writer: writerState, sourceReader: sourceReaderState };
  }

  async getBronzeCapabilities(managerId: string): Promise<KnowledgeBronzeCapabilities> {
    if (!isManagerId(managerId) ||
        !this.ctx.id.equals(this.ctx.exports.KnowledgeAccountAccess.idFromName(managerId)))
      throw new TypeError("Knowledge Bronze role store is bound to another Manager.");
    const writer = await this.ctx.storage.get<KnowledgeBronzeWrite>("bronzeWriter");
    const sourceReader = await this.ctx.storage.get<KnowledgeSourceReader>("sourceReader");
    if (writer === undefined || sourceReader === undefined)
      throw err("dependency_unavailable");
    const [writerContract, sourceContract] = await Promise.all([
      validateStub<KnowledgeBronzeWrite>(writer).assertBoundTo(managerId),
      validateStub<KnowledgeSourceReader>(sourceReader).assertBoundTo(managerId),
    ]);
    if (writerContract !== KNOWLEDGE_BRONZE_WRITE_CONTRACT ||
        sourceContract !== KNOWLEDGE_SOURCE_READ_CONTRACT)
      throw err("incompatible_bronze_role_contract");
    return { writer, sourceReader };
  }

  async findBronzeActionReservation(
    managerId: string,
    gatekeeperInstanceId: string,
    localActionId: number,
  ): Promise<KnowledgeBronzeStageSlot | undefined> {
    this.#assertManager(managerId);
    const current = await this.ctx.storage.get<unknown>("bronzeActionReservation");
    if (current === undefined) return undefined;
    if (!isKnowledgeBronzeStageSlot(current)) throw err("corrupt_state");
    if (
      current.gatekeeperInstanceId !== gatekeeperInstanceId ||
      current.localActionId !== localActionId
    ) return undefined;
    return current;
  }

  async reserveBronzeAction(
    managerId: string,
    reservation: Omit<KnowledgeBronzeStageSlot, "status">,
  ): Promise<void> {
    this.#assertManager(managerId);
    if (
      !rec(reservation) ||
      !exact(reservation, [
        "workspaceId",
        "gatekeeperInstanceId",
        "localActionId",
        "operationId",
        "operationDeadlineMs",
        "retainedBytesReserved",
      ]) ||
      !isNonEmptyBoundedText(reservation.workspaceId, 512) ||
      !isNonEmptyBoundedText(reservation.gatekeeperInstanceId, 512) ||
      !boundedInt(reservation.localActionId, 0, Number.MAX_SAFE_INTEGER) ||
      !UUID.test(reservation.operationId) ||
      !boundedInt(reservation.operationDeadlineMs, 0, Number.MAX_SAFE_INTEGER) ||
      !boundedInt(reservation.retainedBytesReserved, 1, KNOWLEDGE_BRONZE_MAX_ACTION_BYTES + KNOWLEDGE_BRONZE_MAX_METADATA_BYTES)
    ) throw err("invalid_input");

    const gateError = await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.get<unknown>("bronzeActionReservation");
      if (current !== undefined) {
        if (!isKnowledgeBronzeStageSlot(current)) return err("corrupt_state");
        if (current.status === "fenced" && Date.now() >= current.operationDeadlineMs) {
          await this.ctx.storage.delete("bronzeActionReservation");
        } else if (sameBronzeReservation(current, reservation)) {
          return undefined;
        } else {
          return err("capacity_exceeded");
        }
      }
      await this.ctx.storage.put("bronzeActionReservation", { ...reservation, status: "active" });
      return undefined;
    });
    if (gateError !== undefined) throw gateError;
  }

  async activateBronzeAction(
    managerId: string,
    reservation: Omit<KnowledgeBronzeStageSlot, "status" | "operationDeadlineMs" | "retainedBytesReserved">,
    operationDeadlineMs: number,
  ): Promise<void> {
    this.#assertManager(managerId);
    if (!boundedInt(operationDeadlineMs, 1, Number.MAX_SAFE_INTEGER)) throw err("invalid_input");
    const gateError = await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.get<unknown>("bronzeActionReservation");
      if (!isKnowledgeBronzeStageSlot(current) ||
          current.workspaceId !== reservation.workspaceId ||
          current.gatekeeperInstanceId !== reservation.gatekeeperInstanceId ||
          current.localActionId !== reservation.localActionId ||
          current.operationId !== reservation.operationId ||
          current.status !== "active") return err("result_unknown");
      if (current.operationDeadlineMs === operationDeadlineMs) return undefined;
      if (current.operationDeadlineMs !== 0) return err("integrity_failure");
      await this.ctx.storage.put("bronzeActionReservation", {
        ...current,
        operationDeadlineMs,
      });
      return undefined;
    });
    if (gateError !== undefined) throw gateError;
  }

  async fenceBronzeAction(
    managerId: string,
    reservation: Omit<KnowledgeBronzeStageSlot, "status" | "retainedBytesReserved">,
  ): Promise<void> {
    this.#assertManager(managerId);
    const gateError = await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.get<unknown>("bronzeActionReservation");
      if (!isKnowledgeBronzeStageSlot(current) || !sameBronzeReservation(current, reservation))
        return err("result_unknown");
      await this.ctx.storage.put("bronzeActionReservation", { ...current, status: "fenced" });
      return undefined;
    });
    if (gateError !== undefined) throw gateError;
  }

  async clearBronzeAction(
    managerId: string,
    reservation: Omit<KnowledgeBronzeStageSlot, "status" | "retainedBytesReserved">,
  ): Promise<void> {
    this.#assertManager(managerId);
    const gateError = await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.get<unknown>("bronzeActionReservation");
      // A saved Knowledge receipt is authoritative before this private callback is invoked.
      // Missing means a prior retry already cleared the same slot; a different slot must never
      // be deleted to make this operation appear complete.
      if (current === undefined) return undefined;
      if (!isKnowledgeBronzeStageSlot(current)) return err("corrupt_state");
      // A receipt or a trusted clear lookup may finish an old operation after a new proposal
      // has already replaced its Account slot. Never let that stale cleanup remove the new slot.
      if (!sameBronzeReservation(current, reservation)) return undefined;
      await this.ctx.storage.delete("bronzeActionReservation");
      return undefined;
    });
    if (gateError !== undefined) throw gateError;
  }

  #assertManager(managerId: string): void {
    if (
      !isManagerId(managerId) ||
      !this.ctx.id.equals(this.ctx.exports.KnowledgeAccountAccess.idFromName(managerId))
    ) throw new TypeError("Knowledge Bronze role store is bound to another Manager.");
  }

  async #inspectRole(
    capability: KnowledgeBronzeWrite | KnowledgeSourceReader | undefined,
    managerId: string,
    role: "writer" | "sourceReader",
  ): Promise<KnowledgeBronzeRoles["writer"]> {
    if (capability === undefined) return "absent";
    const contract = role === "writer"
      ? await validateStub<KnowledgeBronzeWrite>(capability as KnowledgeBronzeWrite)
        .assertBoundTo(managerId)
      : await validateStub<KnowledgeSourceReader>(capability as KnowledgeSourceReader)
        .assertBoundTo(managerId);
    const expected = role === "writer"
      ? KNOWLEDGE_BRONZE_WRITE_CONTRACT
      : KNOWLEDGE_SOURCE_READ_CONTRACT;
    return contract === expected ? "installed" : "incompatible";
  }
}

@validateRpc()
export class CustomGatekeeper
  extends DurableObject<Cloudflare.Env, Props>
  implements Gatekeeper<KnowledgeBase>
{
  readonly #bronzeApplies = new Map<number, Promise<void>>();

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
          workspace_id TEXT,
          operation_deadline_ms INTEGER,
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
      const articleActionColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(custom_gatekeeper_article_actions)")
        .toArray();
      if (!articleActionColumns.some(({ name }) => name === "workspace_id")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE custom_gatekeeper_article_actions ADD COLUMN workspace_id TEXT",
        );
      }
      if (!articleActionColumns.some(({ name }) => name === "operation_deadline_ms")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE custom_gatekeeper_article_actions ADD COLUMN operation_deadline_ms INTEGER",
        );
      }
      const unstampedActions = this.ctx.storage.sql
        .exec<{ local_action_id: number; workspace_id: string | null; operation_deadline_ms: number | null; command_json: string }>(
          `SELECT local_action_id, workspace_id, operation_deadline_ms, command_json
           FROM custom_gatekeeper_article_actions
           WHERE workspace_id IS NULL OR operation_deadline_ms IS NULL`,
        )
        .toArray();
      const managerId = validateProps(this.ctx.props).managerId;
      for (const action of unstampedActions) {
        const command = await decodeStoredBronzeStage(
          action.command_json,
          action.local_action_id,
          this.ctx.id.toString(),
          managerId,
        );
        this.ctx.storage.sql.exec(
          `UPDATE custom_gatekeeper_article_actions
           SET workspace_id = COALESCE(workspace_id, ?),
               operation_deadline_ms = COALESCE(operation_deadline_ms, ?)
           WHERE local_action_id = ?`,
          command.namespace.workspaceId,
          command.operationDeadlineMs,
          action.local_action_id,
        );
      }
    });
  }
  async #access(): Promise<Access> {
    const p = validateProps(this.ctx.props);
    const access = await this.ctx.exports.KnowledgeAccountAccess.getByName(p.managerId).getAccess();
    return validateStub<Access>(access);
  }
  #accountAccess(): DurableObjectStub<KnowledgeAccountAccess> {
    const p = validateProps(this.ctx.props);
    return this.ctx.exports.KnowledgeAccountAccess.getByName(p.managerId);
  }

  #nextActionId(): number {
    const rows = this.ctx.storage.sql
      .exec<{ next_id: number }>("SELECT next_id FROM custom_gatekeeper_action_sequence WHERE id = 1")
      .toArray();
    const nextId = rows[0]?.next_id;
    if (!Number.isSafeInteger(nextId) || nextId < 1 || nextId >= Number.MAX_SAFE_INTEGER)
      throw err("corrupt_state");
    this.ctx.storage.sql.exec(
      "UPDATE custom_gatekeeper_action_sequence SET next_id = ? WHERE id = 1",
      nextId + 1,
    );
    return nextId;
  }

  async #proposeArticle(
    queue: RpcStub<KnowledgeActionQueue>,
    account: DurableObjectStub<KnowledgeAccountAccess>,
    managerId: string,
    input: unknown,
  ): Promise<Readonly<{ status: "pending_approval"; operationId: string }>> {
    const article = decodeKnowledgeArticleProposal(input);
    const workspaceId = await queue.getWorkspaceId();
    const gatekeeperInstanceId = this.ctx.id.toString();
    if (!isNonEmptyBoundedText(workspaceId, 512) || !isNonEmptyBoundedText(gatekeeperInstanceId, 512))
      throw err("permission_denied");

    const capabilities = await account.getBronzeCapabilities(managerId);
    const rawSource = await capabilities.sourceReader.verifySource({
      workspaceId,
      selector: article.sourceSelector,
    });
    const verified = decodeVerifiedSource(rawSource, article.sourceSelector);
    const provenance = { ...verified, ...articleClaims(article) };
    const namespace: KnowledgeBronzeNamespace = {
      workspaceId,
      gatekeeperInstanceId,
      localActionId: this.#nextActionId(),
    };
    const operationId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const intent = article.kind === "adopt"
      ? {
          kind: "adopt" as const,
          articleId: crypto.randomUUID(),
          revisionId,
          expectedCurrentRevision: null,
          body: article.body,
          initialUsePolicy: article.initialUsePolicy,
          provenance,
        }
      : {
          kind: "revise" as const,
          articleId: article.articleId,
          revisionId,
          expectedCurrentRevision: article.expectedCurrentRevision,
          body: article.body,
          provenance,
        };
    // The finite admission window starts at the first owner approval dispatch, not while the
    // native action waits for a human decision. Zero is the durable, undispatched sentinel.
    const operationDeadlineMs = 0;
    const bodyBytes = new TextEncoder().encode(article.body);
    const fullIntentHash = await computeKnowledgeBronzeIntentHash({
      intent,
      operationId,
      managerId,
      namespace,
      bodyBytes,
    });
    const command = {
      kind: "staged" as const,
      namespace,
      operationId,
      attemptFencingToken: 1,
      operationDeadlineMs,
      fullIntentHash,
      intent,
    };
    const description: ActionDescription = {
      title: article.kind === "adopt" ? "Propose a Knowledge article" : "Revise a Knowledge article",
      description: "The exact Markdown body and its owner-verified source metadata are shown below. Approval saves this article to the Manager's Knowledge Base.",
      fields: [
        { label: "Article body", kind: "text", syntax: "markdown", value: article.body },
        {
          label: "Article intent and verified source",
          kind: "json",
          value: JSON.stringify({ ...intent, body: undefined }),
        },
      ],
      descriptionIsComplete: true,
      autoApprovable: false,
      awaitDecision: true,
      implementsRevert: false,
    };
    if (new TextEncoder().encode(JSON.stringify(description)).byteLength > KNOWLEDGE_BRONZE_MAX_ACTION_BYTES)
      throw err("capacity_exceeded");

    const metadataForReservation = article.kind === "adopt"
      ? {
          kind: intent.kind,
          articleId: intent.articleId,
          revisionId: intent.revisionId,
          expectedCurrentRevision: intent.expectedCurrentRevision,
          initialUsePolicy: intent.initialUsePolicy,
          provenance: intent.provenance,
          operationId,
          operationDeadlineMs,
          fullIntentHash,
          namespace,
        }
      : {
          kind: intent.kind,
          articleId: intent.articleId,
          revisionId: intent.revisionId,
          expectedCurrentRevision: intent.expectedCurrentRevision,
          provenance: intent.provenance,
          operationId,
          operationDeadlineMs,
          fullIntentHash,
          namespace,
        };
    const stageMetadataBytes = new TextEncoder().encode(JSON.stringify(metadataForReservation)).byteLength;
    const retainedBytesReserved = bodyBytes.byteLength + stageMetadataBytes;
    if (stageMetadataBytes > KNOWLEDGE_BRONZE_MAX_STAGE_METADATA_BYTES)
      throw err("capacity_exceeded");
    if (retainedBytesReserved > KNOWLEDGE_BRONZE_MAX_ACTION_BYTES + KNOWLEDGE_BRONZE_MAX_METADATA_BYTES)
      throw err("capacity_exceeded");

    await account.reserveBronzeAction(managerId, {
      workspaceId,
      gatekeeperInstanceId,
      localActionId: namespace.localActionId,
      operationId,
      operationDeadlineMs,
      retainedBytesReserved,
    });
    this.ctx.storage.sql.exec(
      `INSERT INTO custom_gatekeeper_article_actions
       (local_action_id, operation_id, action_ref, kind, workspace_id, operation_deadline_ms, command_json, payload_hash, status, outcome_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', NULL)`,
      namespace.localActionId,
      operationId,
      `knowledge-bronze:${operationId}`,
      intent.kind,
      workspaceId,
      operationDeadlineMs,
      JSON.stringify(command),
      fullIntentHash,
    );
    // A submit failure can be ambiguous at the native queue boundary. Keep the durable action
    // and Manager-wide reservation so an unknown dispatch cannot be reused as a second proposal.
    await queue.submitAction(namespace.localActionId, description);
    return { status: "pending_approval", operationId };
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
    const account = this.#accountAccess();
    const access = validateStub<Access>(await account.getAccess());
    const queue = q.dup() as RpcStub<KnowledgeActionQueue>;
    const managerId = validateProps(this.ctx.props).managerId;
    try {
      return new KnowledgeSession(
        queue,
        access,
        (input) => this.#proposeArticle(queue, account, managerId, input),
      );
    } catch (cause) {
      try {
        queue[Symbol.dispose]?.();
      } catch {
        // Preserve the constructor failure while still attempting ownership cleanup.
      }
      throw cause;
    }
  }
  async applyAction(actionId: number): Promise<void> {
    if (!boundedInt(actionId, 0, Number.MAX_SAFE_INTEGER)) throw err("invalid_input");
    const inFlight = this.#bronzeApplies.get(actionId);
    if (inFlight) return inFlight;
    const applying = this.#applyBronzeAction(actionId);
    this.#bronzeApplies.set(actionId, applying);
    try {
      await applying;
    } finally {
      if (this.#bronzeApplies.get(actionId) === applying)
        this.#bronzeApplies.delete(actionId);
    }
  }

  async #applyBronzeAction(actionId: number): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<{
        operation_id: string;
        workspace_id: string | null;
        operation_deadline_ms: number | null;
        command_json: string;
        status: string;
        outcome_json: string | null;
      }>(
        `SELECT operation_id, workspace_id, operation_deadline_ms, command_json, status, outcome_json
         FROM custom_gatekeeper_article_actions WHERE local_action_id = ?`,
        actionId,
      )
      .toArray();
    if (rows.length === 0) throw err("invalid_input");
    if (rows.length !== 1) throw err("corrupt_state");
    const row = rows[0]!;
    const managerId = validateProps(this.ctx.props).managerId;
    if (!isNonEmptyBoundedText(row.workspace_id, 512)) throw err("corrupt_state");
    const namespace: KnowledgeBronzeNamespace = {
      workspaceId: row.workspace_id,
      gatekeeperInstanceId: this.ctx.id.toString(),
      localActionId: actionId,
    };
    const account = this.#accountAccess();
    const { writer } = await account.getBronzeCapabilities(managerId);
    if (row.status === "applied") {
      const envelope = parseKnowledgeEnvelope(await writer.apply({ kind: "saved_retry", namespace }));
      if (!envelope.ok) throw err(envelope.code);
      const receipt = parseBronzeSavedReceipt(envelope.value, row.operation_id);
      const recorded = parseStoredBronzeSavedReceipt(row.outcome_json, row.operation_id);
      if (
        receipt.articleId !== recorded.articleId ||
        receipt.revisionId !== recorded.revisionId ||
        receipt.bodyHash !== recorded.bodyHash
      ) throw err("integrity_failure");
      if (!boundedInt(row.operation_deadline_ms, 1, Number.MAX_SAFE_INTEGER)) throw err("corrupt_state");
      await account.clearBronzeAction(managerId, {
        ...namespace,
        operationId: row.operation_id,
        operationDeadlineMs: row.operation_deadline_ms,
      });
      return;
    }
    if (row.status !== "pending_approval" && row.status !== "applying")
      throw err(row.status === "rejecting" ? "result_unknown" : "invalid_input");
    if (typeof row.command_json !== "string" || row.command_json.length === 0)
      throw err("corrupt_state");
    let command = await decodeStoredBronzeStage(
      row.command_json,
      actionId,
      this.ctx.id.toString(),
      managerId,
    );
    if (command.namespace.workspaceId !== namespace.workspaceId) throw err("corrupt_state");
    if (row.status === "pending_approval") {
      if (row.operation_deadline_ms !== command.operationDeadlineMs) throw err("corrupt_state");
      const operationDeadlineMs = command.operationDeadlineMs === 0
        ? Date.now() + KNOWLEDGE_BRONZE_ADMISSION_WINDOW_MS
        : command.operationDeadlineMs;
      if (!Number.isSafeInteger(operationDeadlineMs) || operationDeadlineMs < 1)
        throw err("invalid_input");
      command = { ...command, operationDeadlineMs };
      const started = this.ctx.storage.sql.exec(
        `UPDATE custom_gatekeeper_article_actions SET status = 'applying', operation_deadline_ms = ?, command_json = ?
         WHERE local_action_id = ? AND status = 'pending_approval'`,
        operationDeadlineMs,
        JSON.stringify(command),
        actionId,
      );
      if (started.rowsWritten !== 1) throw err("result_unknown");
    } else if (!boundedInt(command.operationDeadlineMs, 1, Number.MAX_SAFE_INTEGER) ||
        row.operation_deadline_ms !== command.operationDeadlineMs) {
      throw err("corrupt_state");
    }
    await account.activateBronzeAction(
      managerId,
      {
        workspaceId: command.namespace.workspaceId,
        gatekeeperInstanceId: command.namespace.gatekeeperInstanceId,
        localActionId: command.namespace.localActionId,
        operationId: command.operationId,
      },
      command.operationDeadlineMs,
    );
    const envelope = parseKnowledgeEnvelope(await writer.apply(command));
    if (!envelope.ok) {
      if (envelope.code !== "result_unknown" && envelope.code !== "corrupt_state") {
        this.ctx.storage.sql.exec(
          `UPDATE custom_gatekeeper_article_actions SET status = 'pending_approval'
           WHERE local_action_id = ? AND status = 'applying'`,
          actionId,
        );
      }
      throw err(envelope.code);
    }
    const receipt = parseBronzeSavedReceipt(envelope.value, command.operationId);
    if (
      receipt.articleId !== command.intent.articleId ||
      receipt.revisionId !== command.intent.revisionId ||
      receipt.bodyHash !== await sha256Hex(new TextEncoder().encode(command.intent.body))
    ) throw err("integrity_failure");
    const completed = this.ctx.storage.sql.exec(
      `UPDATE custom_gatekeeper_article_actions SET status = 'applied', command_json = '', outcome_json = ?
       WHERE local_action_id = ? AND status = 'applying'`,
      JSON.stringify(receipt),
      actionId,
    );
    if (completed.rowsWritten !== 1) throw err("result_unknown");
    await account.clearBronzeAction(managerId, {
      ...command.namespace,
      operationId: command.operationId,
      operationDeadlineMs: command.operationDeadlineMs,
    });
  }
  async rejectAction(actionId: number): Promise<void> {
    if (!boundedInt(actionId, 0, Number.MAX_SAFE_INTEGER)) throw err("invalid_input");
    const bronzeRows = this.ctx.storage.sql
      .exec<{
        operation_id: string;
        workspace_id: string | null;
        operation_deadline_ms: number | null;
        command_json: string;
        status: string;
        outcome_json: string | null;
      }>(
        `SELECT operation_id, workspace_id, operation_deadline_ms, command_json, status, outcome_json
         FROM custom_gatekeeper_article_actions WHERE local_action_id = ?`,
        actionId,
      )
      .toArray();
    if (bronzeRows.length > 1) throw err("corrupt_state");
    const bronze = bronzeRows[0];
    if (bronze !== undefined) {
      const managerId = validateProps(this.ctx.props).managerId;
      if (!isNonEmptyBoundedText(bronze.workspace_id, 512)) throw err("corrupt_state");
      const namespace: KnowledgeBronzeNamespace = {
        workspaceId: bronze.workspace_id,
        gatekeeperInstanceId: this.ctx.id.toString(),
        localActionId: actionId,
      };
      if (bronze.status === "applied") {
        const account = this.#accountAccess();
        const { writer } = await account.getBronzeCapabilities(managerId);
        const envelope = parseKnowledgeEnvelope(await writer.cancel({ kind: "lookup", namespace }));
        if (!envelope.ok) throw err(envelope.code);
        throw err("integrity_failure");
      }
      if (bronze.status === "rejected") {
        const account = this.#accountAccess();
        const { writer } = await account.getBronzeCapabilities(managerId);
        const envelope = parseKnowledgeEnvelope(await writer.cancel({ kind: "lookup", namespace }));
        if (!envelope.ok) throw err(envelope.code);
        if (rec(envelope.value) && exact(envelope.value, ["status"]) && envelope.value.status === "clear") return;
        if (
          rec(envelope.value) && exact(envelope.value, ["status", "operationId"]) &&
          envelope.value.status === "fenced" && envelope.value.operationId === bronze.operation_id
        ) return;
        throw err("integrity_failure");
      }
      if (bronze.status !== "pending_approval" && bronze.status !== "applying" && bronze.status !== "rejecting")
        throw err("integrity_failure");

      // Claim cancellation synchronously before any RPC/await. An approval callback that read
      // the old pending row must lose its pending->applying CAS and never dispatch stale intent.
      if (bronze.status === "pending_approval" || bronze.status === "applying") {
        const claimed = this.ctx.storage.sql.exec(
          `UPDATE custom_gatekeeper_article_actions SET status = 'rejecting'
           WHERE local_action_id = ? AND status = ?`,
          actionId,
          bronze.status,
        );
        if (claimed.rowsWritten !== 1) return this.rejectAction(actionId);
      }
      if (typeof bronze.command_json !== "string" || bronze.command_json.length === 0)
        throw err("corrupt_state");
      const command = await decodeStoredBronzeStage(
        bronze.command_json,
        actionId,
        this.ctx.id.toString(),
        managerId,
      );
      if (command.operationId !== bronze.operation_id || command.namespace.workspaceId !== namespace.workspaceId)
        throw err("corrupt_state");
      if (bronze.operation_deadline_ms !== command.operationDeadlineMs) throw err("corrupt_state");
      const account = this.#accountAccess();
      const { writer } = await account.getBronzeCapabilities(managerId);
      let envelope: ReturnType<typeof parseKnowledgeEnvelope> | undefined;
      let durableFenceProof = false;
      if (command.operationDeadlineMs === 0) {
      // `bronze` is the pre-CAS snapshot. A first rejection reaches this branch with
      // `pending_approval`; the durable row is already `rejecting` after the synchronous claim.
      if (bronze.status !== "pending_approval" && bronze.status !== "rejecting")
        throw err("corrupt_state");
        envelope = parseKnowledgeEnvelope(await writer.cancel({ kind: "lookup", namespace }));
      } else if (bronze.status === "rejecting") {
        // A prior cancellation may have committed its Knowledge fence but lost the callback
        // acknowledgement before this native row became terminal. Resolve that durable state
        // before trying to reactivate an Account slot that is already fenced.
        const accountReservation = await account.findBronzeActionReservation(
          managerId,
          command.namespace.gatekeeperInstanceId,
          command.namespace.localActionId,
        );
        const binding = {
          ...command.namespace,
          operationId: command.operationId,
          operationDeadlineMs: command.operationDeadlineMs,
        };
        const matchingActiveReservation = accountReservation !== undefined &&
          accountReservation.status === "active" &&
          accountReservation.workspaceId === binding.workspaceId &&
          accountReservation.gatekeeperInstanceId === binding.gatekeeperInstanceId &&
          accountReservation.localActionId === binding.localActionId &&
          accountReservation.operationId === binding.operationId &&
          (accountReservation.operationDeadlineMs === binding.operationDeadlineMs ||
            accountReservation.operationDeadlineMs === 0);
        if (
          accountReservation !== undefined && accountReservation.status === "fenced" &&
          sameBronzeReservation(accountReservation, binding)
        ) {
          if (Date.now() >= command.operationDeadlineMs) {
            const lookup = parseKnowledgeEnvelope(await writer.cancel({ kind: "lookup", namespace }));
            if (!lookup.ok) throw err(lookup.code);
            if (!(
              rec(lookup.value) && exact(lookup.value, ["status"]) && lookup.value.status === "clear"
            )) throw err("result_unknown");
          }
          // Account's fenced state is written only after the trusted writer confirms its
          // durable Knowledge fence. At expiry, the trusted clear lookup above also releases
          // Knowledge's marker after confirming no saved or active write remains.
          envelope = { ok: true, value: { status: "fenced", operationId: command.operationId } };
          durableFenceProof = true;
        } else if (matchingActiveReservation) {
          // The earlier attempt may have committed Account activation but lost its response
          // before sending staged_fence. Re-send the same trusted fence command directly;
          // Knowledge resolves object_unknown durably, and the fence operation is idempotent.
          await account.activateBronzeAction(managerId, {
            workspaceId: command.namespace.workspaceId,
            gatekeeperInstanceId: command.namespace.gatekeeperInstanceId,
            localActionId: command.namespace.localActionId,
            operationId: command.operationId,
          }, command.operationDeadlineMs);
          envelope = parseKnowledgeEnvelope(await writer.cancel({
            kind: "staged_fence",
            namespace: command.namespace,
            operationId: command.operationId,
            attemptFencingToken: command.attemptFencingToken,
            operationDeadlineMs: command.operationDeadlineMs,
            fullIntentHash: command.fullIntentHash,
            intent: command.intent,
          }));
        } else {
          const lookup = parseKnowledgeEnvelope(await writer.cancel({ kind: "lookup", namespace }));
          if (!lookup.ok) throw err(lookup.code);
          if (
            rec(lookup.value) && exact(lookup.value, ["status"]) && lookup.value.status === "clear" &&
            Date.now() >= command.operationDeadlineMs
          ) {
            // After expiry a trusted clear lookup proves Knowledge has no saved or active write.
            // clearBronzeAction is conditional under the Account gate, so an unrelated newer slot
            // remains untouched while this old native action can finish as rejected.
            envelope = lookup;
          } else if (
            rec(lookup.value) && exact(lookup.value, ["status"]) && lookup.value.status === "clear"
          ) {
            await account.activateBronzeAction(managerId, {
              workspaceId: command.namespace.workspaceId,
              gatekeeperInstanceId: command.namespace.gatekeeperInstanceId,
              localActionId: command.namespace.localActionId,
              operationId: command.operationId,
            }, command.operationDeadlineMs);
            envelope = parseKnowledgeEnvelope(await writer.cancel({
              kind: "staged_fence",
              namespace: command.namespace,
              operationId: command.operationId,
              attemptFencingToken: command.attemptFencingToken,
              operationDeadlineMs: command.operationDeadlineMs,
              fullIntentHash: command.fullIntentHash,
              intent: command.intent,
            }));
          } else if (
            rec(lookup.value) && exact(lookup.value, ["status", "operationId"]) &&
            lookup.value.status === "fenced" && lookup.value.operationId === command.operationId
          ) {
            envelope = lookup;
            durableFenceProof = true;
          } else {
            throw err("result_unknown");
          }
        }
      } else {
        await account.activateBronzeAction(managerId, {
          workspaceId: command.namespace.workspaceId,
          gatekeeperInstanceId: command.namespace.gatekeeperInstanceId,
          localActionId: command.namespace.localActionId,
          operationId: command.operationId,
        }, command.operationDeadlineMs);
        envelope = parseKnowledgeEnvelope(await writer.cancel({
          kind: "staged_fence",
          namespace: command.namespace,
          operationId: command.operationId,
          attemptFencingToken: command.attemptFencingToken,
          operationDeadlineMs: command.operationDeadlineMs,
          fullIntentHash: command.fullIntentHash,
          intent: command.intent,
        }));
      }
      if (envelope === undefined) throw err("integrity_failure");
      if (!envelope.ok) {
        if (envelope.code === "conflict") {
          this.ctx.storage.sql.exec(
            `UPDATE custom_gatekeeper_article_actions SET status = 'applying'
             WHERE local_action_id = ? AND status = 'rejecting' AND operation_deadline_ms > 0`,
            actionId,
          );
        }
        throw err(envelope.code);
      }
      let outcome: unknown;
      if (
        rec(envelope.value) && exact(envelope.value, ["status", "operationId"]) &&
        envelope.value.status === "fenced" && envelope.value.operationId === command.operationId
      ) {
        outcome = envelope.value;
        if (command.operationDeadlineMs > 0 && !durableFenceProof) {
          await account.fenceBronzeAction(managerId, {
            ...command.namespace,
            operationId: command.operationId,
            operationDeadlineMs: command.operationDeadlineMs,
          });
        }
      } else if (rec(envelope.value) && exact(envelope.value, ["status"]) && envelope.value.status === "clear") {
        outcome = envelope.value;
        await account.clearBronzeAction(managerId, {
          ...command.namespace,
          operationId: command.operationId,
          operationDeadlineMs: command.operationDeadlineMs,
        });
      } else {
        throw err("integrity_failure");
      }
      const rejected = this.ctx.storage.sql.exec(
        `UPDATE custom_gatekeeper_article_actions SET status = 'rejected', command_json = '', outcome_json = ?
         WHERE local_action_id = ? AND status = 'rejecting'`,
        JSON.stringify(outcome),
        actionId,
      );
      if (rejected.rowsWritten !== 1) {
        const current = this.ctx.storage.sql
          .exec<{ status: string }>(
            `SELECT status FROM custom_gatekeeper_article_actions WHERE local_action_id = ?`,
            actionId,
          )
          .toArray();
        if (current.length === 1 && current[0]!.status === "rejected") return;
        throw err("result_unknown");
      }
      return;
    }
    const tables = [
      "custom_gatekeeper_staged_actions",
      "custom_gatekeeper_bronze_adoptions",
    ] as const;
    const matches = tables.map((table) =>
      this.ctx.storage.sql
        .exec<{ local_action_id: number; status: string }>(
          `SELECT local_action_id, status FROM ${table} WHERE local_action_id = ?`,
          actionId,
        )
        .toArray(),
    );
    if (matches.filter((rows) => rows.length > 0).length > 1)
      throw err("integrity_failure");
    const [rows] = matches.filter((found) => found.length > 0);
    const row = rows?.[0];
    if (row === undefined) {
      const managerId = validateProps(this.ctx.props).managerId;
      const account = this.#accountAccess();
      const reservation = await account.findBronzeActionReservation(
        managerId,
        this.ctx.id.toString(),
        actionId,
      );
      if (reservation === undefined) throw err("invalid_input");
      const { writer } = await account.getBronzeCapabilities(managerId);
      const namespace: KnowledgeBronzeNamespace = {
        workspaceId: reservation.workspaceId,
        gatekeeperInstanceId: reservation.gatekeeperInstanceId,
        localActionId: reservation.localActionId,
      };
      const envelope = parseKnowledgeEnvelope(await writer.cancel({ kind: "lookup", namespace }));
      if (!envelope.ok) throw err(envelope.code);
      if (rec(envelope.value) && exact(envelope.value, ["status"]) && envelope.value.status === "clear") {
        if (reservation.status === "active") {
          await account.clearBronzeAction(managerId, {
            ...namespace,
            operationId: reservation.operationId,
            operationDeadlineMs: reservation.operationDeadlineMs,
          });
        }
        return;
      }
      if (
        rec(envelope.value) && exact(envelope.value, ["status", "operationId"]) &&
        envelope.value.status === "fenced" && envelope.value.operationId === reservation.operationId
      ) {
        if (reservation.status === "active") {
          await account.fenceBronzeAction(managerId, {
            ...namespace,
            operationId: reservation.operationId,
            operationDeadlineMs: reservation.operationDeadlineMs,
          });
        }
        return;
      }
      throw err("integrity_failure");
    }
    if (row.status === "pending_approval") {
      const table = tables[matches.findIndex((found) => found.length > 0)];
      this.ctx.storage.sql.exec(
        `DELETE FROM ${table} WHERE local_action_id = ? AND status = 'pending_approval'`,
        actionId,
      );
      return;
    }
    if (row.status === "applying" || row.status === "applied")
      throw err("outcome_unknown");
    if (row.status === "failed") return;
    throw err("integrity_failure");
  }
  async getAgentCatalog(): Promise<AgentCatalog> {
    // Catalogs are included in every chat prompt and cannot carry manager-private metadata that
    // would require observer authorization. The singleton name and generic list hint are safe;
    // actual Knowledge summaries remain behind the session's authorized read operations.
    return boundAgentCatalog([
      {
        id: "knowledge-base",
        title: "Knowledge Base",
        description: "Available. Use list, search, and read to inspect Knowledge pages, or proposeArticle to request an owner-reviewed article save.",
      },
    ]);
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

  async commitReconnect(_stageId: string): Promise<void> {
    throw new Error("Knowledge Base accounts do not have a reconnect flow.");
  }
  async inspectManagerBinding(
    managerIdValue: string,
  ): Promise<"legacy" | "bound" | "incompatible"> {
    if (!isManagerId(managerIdValue))
      throw new TypeError("Manager ID must be a UUID.");
    if (legacyProps(this.ctx.props)) return "legacy";
    const previous = this.ctx.props;
    if (rec(previous) && exact(previous, ["access"]) && previous.access) {
      // The OS atomically replaces legacy accounts. Validate the old binding first.
      await validateStub<InspectableAccess>(previous.access as object)
        .assertBoundTo(managerIdValue);
      return "legacy";
    }
    const p = validateProps(this.ctx.props);
    if (p.managerId !== managerIdValue)
      throw new TypeError("Knowledge Account is bound to another Manager.");
    const access = await this.ctx.exports.KnowledgeAccountAccess.getByName(p.managerId).getAccess();
    const contract = await validateStub<InspectableAccess>(access as object)
      .assertBoundTo(managerIdValue);
    return contract === KNOWLEDGE_READ_CONTRACT ? "bound" : "incompatible";
  }
  @skipRpcValidation() async inspectBronzeRoles(
    managerIdValue: string,
  ): Promise<KnowledgeBronzeRoles> {
    const p = validateProps(this.ctx.props);
    if (!isManagerId(managerIdValue) || p.managerId !== managerIdValue)
      throw new TypeError("Knowledge account is bound to another Manager.");
    return this.ctx.exports.KnowledgeAccountAccess.getByName(managerIdValue)
      .inspectBronzeRoles(managerIdValue);
  }
  @skipRpcValidation() async installBronzeRoles(
    managerIdValue: string,
    writer: KnowledgeBronzeWrite,
    sourceReader: KnowledgeSourceReader,
  ): Promise<void> {
    const p = validateProps(this.ctx.props);
    if (!isManagerId(managerIdValue) || p.managerId !== managerIdValue)
      throw new TypeError("Knowledge account is bound to another Manager.");
    const access = this.ctx.exports.KnowledgeAccountAccess.getByName(managerIdValue);
    await access.bindBronzeRoles(managerIdValue, writer, sourceReader);
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
    capability: KnowledgeAccess,
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
  list(input: KnowledgeListInput): Promise<KnowledgeListResult>;
  search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult>;
  read(input: KnowledgeReadInput): Promise<KnowledgeReadResult>;
  proposeArticle(input: { article: KnowledgeArticleProposal }): Promise<{
    status: "pending_approval";
    operationId: string;
  }>;
};
export type KnowledgeListResult = {
  bundleId: string;
  versionId: string;
  items: Array<{ path: string }>;
  nextOffset?: number;
};
export type KnowledgeSearchResult = {
  bundleId: string;
  versionId: string;
  hits: Array<{ path: string; line: number; snippet: string }>;
  nextOffset?: number;
};
export type KnowledgeReadResult = {
  bundleId: string;
  versionId: string;
  path: string;
  sourceMarkdown: string;
  metadata: Record<string, unknown>;
};
