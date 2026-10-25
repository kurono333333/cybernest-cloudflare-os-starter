import { RpcStub, RpcTarget, WorkerEntrypoint, DurableObject } from "cloudflare:workers";
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KNOWLEDGE_UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const KNOWLEDGE_RECEIPT_TTL = 3_600_000;
const KNOWLEDGE_BRONZE_ADMISSION_WINDOW_MS = 300_000;
const KNOWLEDGE_BRONZE_MAX_BODY_BYTES = 64 * 1024;
const KNOWLEDGE_BRONZE_MAX_ACTION_BYTES = 96 * 1024;
const KNOWLEDGE_BRONZE_MAX_METADATA_BYTES = 64 * 1024;
const KNOWLEDGE_BRONZE_MAX_STAGE_METADATA_BYTES = 32 * 1024;
const KNOWLEDGE_GOLD_PAGE_MAX_PATH_BYTES = 240;
const KNOWLEDGE_GOLD_PAGE_MAX_CONTENT_BYTES = 64 * 1024;
const KNOWLEDGE_READ_RESPONSE_MAX_BYTES = 256 * 1024;
const KNOWLEDGE_SAFE_CONTROL_MAX_TARGETS = 65;
const KNOWLEDGE_SAFE_CONTROL_MAX_ARTICLE_TARGETS = 64;
const KNOWLEDGE_SAFE_CONTROL_MAX_GOLD_TARGETS = 1;
const KNOWLEDGE_SAFE_CONTROL_MAX_BYTES_PER_TARGET = 4 * 1024;
export const KNOWLEDGE_GOLD_CONTROL_CONTRACT = "cybernest-knowledge-gold-job-control-v1" as const;
export const KNOWLEDGE_GOLD_PAGE_CONTROL_CONTRACT =
  "cybernest-knowledge-gold-page-control-v1" as const;
export type KnowledgeListInput = { offset: number; limit: number };
type KnowledgeComputerSearchInput = { query: string; offset: number; limit: number };
type KnowledgeArticleSearchInput = {
  kind: "articles";
  filters?: { type?: string; title?: string; description?: string; tag?: string };
  cursor?: string;
  limit: number;
};
type KnowledgeArticleLinksSearchInput = {
  kind: "article-links";
  articleId: string;
  direction: "links" | "backlinks";
  maxDepth: number;
  candidateBudget: number;
};
export type KnowledgeSearchInput =
  | KnowledgeComputerSearchInput
  | KnowledgeArticleSearchInput
  | KnowledgeArticleLinksSearchInput;
export type KnowledgeReadInput = { path: string };
export type KnowledgeReadReceipt<A> = Readonly<{ value: A; expiresAt: number }>;
export const KNOWLEDGE_READ_CONTRACT = "cybernest-knowledge-read-v1" as const;
export type KnowledgeAccess = {
  /** Installation-only identity assertion. It is never part of the Agent session. */
  assertBoundTo(
    managerId: string,
  ): typeof KNOWLEDGE_READ_CONTRACT | Promise<typeof KNOWLEDGE_READ_CONTRACT>;
  list(input: KnowledgeListInput): Promise<unknown>;
  search(input: KnowledgeSearchInput): Promise<unknown>;
  read(input: KnowledgeReadInput): Promise<unknown>;
};
type Access = KnowledgeAccess;
export const KNOWLEDGE_BRONZE_WRITE_CONTRACT = "cybernest-knowledge-bronze-write-v2" as const;
export const KNOWLEDGE_SOURCE_READ_CONTRACT = "cybernest-knowledge-source-read-v1" as const;
export type KnowledgeBronzeWrite = {
  assertBoundTo(
    managerId: string,
  ): typeof KNOWLEDGE_BRONZE_WRITE_CONTRACT | Promise<typeof KNOWLEDGE_BRONZE_WRITE_CONTRACT>;
  validateCandidate(input: unknown): Promise<unknown>;
  apply(input: unknown): Promise<unknown>;
  cancel(input: unknown): Promise<unknown>;
};
type KnowledgeGoldRoles = "absent" | "installed" | "incompatible";
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
type KnowledgeProvenance = KnowledgeVerifiedSource &
  Readonly<{
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
type KnowledgeSilverPolicyIntent = Readonly<{
  articleId: string;
  usePolicy: "included" | "excluded";
  expectedMetadataRevision: number;
}>;
type KnowledgeSilverPolicyCommand = Readonly<{
  kind: "silver_policy";
  namespace: KnowledgeBronzeNamespace;
  operationId: string;
  operationDeadlineMs: number;
  intent: KnowledgeSilverPolicyIntent;
}>;
type KnowledgeSilverPolicyFenceCommand = Readonly<{
  kind: "silver_policy_fence";
  namespace: KnowledgeBronzeNamespace;
  operationId: string;
  operationDeadlineMs: number;
  intent: KnowledgeSilverPolicyIntent;
}>;
type KnowledgeSilverPolicySavedResult = Readonly<{
  status: "saved";
  operationId: string;
  articleId: string;
  usePolicy: "included" | "excluded";
  metadataRevision: number;
}>;
type KnowledgeGoldControlIntent = Readonly<{
  operation: "stop" | "resume";
  jobId: string;
  expectedJobState: string;
  expectedJobFence: number;
  expectedControlRevision: number;
  system1Recovery?: Readonly<{
    decisionKeyHash: string;
    expectedRequestId: string;
    additionalMaxMicroUsd: 5_000;
  }>;
}>;
type KnowledgeGoldJobControlCommand = Readonly<{
  kind: "gold_job_control";
  namespace: KnowledgeBronzeNamespace;
  operationId: string;
  operationDeadlineMs: number;
  intent: KnowledgeGoldControlIntent;
  system1RecoveryNextRequestId?: string;
}>;
type KnowledgeGoldJobControlSavedResult = Readonly<{
  status: "saved";
  operationId: string;
  jobId: string;
  state: string;
  fence: number;
  controlRevision: number;
}>;
type KnowledgeGoldControlHead = Readonly<{
  mode: string;
  controlRevision: number;
  job: Readonly<{
    jobId: string;
    state: string;
    fence: number;
  }> | null;
}>;
type KnowledgeGoldController = {
  assertBoundTo(
    managerId: string,
  ): typeof KNOWLEDGE_GOLD_CONTROL_CONTRACT | Promise<typeof KNOWLEDGE_GOLD_CONTROL_CONTRACT>;
  inspect(): Promise<unknown>;
  apply(input: unknown): Promise<unknown>;
};
type KnowledgeGoldPageController = {
  assertBoundTo(
    managerId: string,
  ):
    | typeof KNOWLEDGE_GOLD_PAGE_CONTROL_CONTRACT
    | Promise<typeof KNOWLEDGE_GOLD_PAGE_CONTROL_CONTRACT>;
  inspectPage(input: unknown): Promise<unknown>;
  admitPageAction(input: unknown): Promise<unknown>;
  editPage(input: unknown): Promise<unknown>;
  requestProtectionReleaseAndCleanReplacement(input: unknown): Promise<unknown>;
};
type KnowledgeGoldPageSourceContextEntry = Readonly<{
  articleId: string;
  revisionId: string;
  bodyHash: string;
  metadataRevision: number;
  projectionVersions: Readonly<{
    projectionRuleVersion: string;
    processedVersion: string;
    relationVersion: string;
  }>;
}>;
export type KnowledgeGoldPageActionIntent = Readonly<{
  path: string;
  pageId: string;
  expectedPageVersion: number;
  expectedProtectionVersion: number;
  expectedControlRevision: number;
  sourceContext: readonly KnowledgeGoldPageSourceContextEntry[];
}>;
export type KnowledgeGoldPageEditIntent = KnowledgeGoldPageActionIntent &
  Readonly<{ content: string }>;
type KnowledgeGoldPageEditCommand = Readonly<{
  kind: "gold_page_edit";
  namespace: KnowledgeBronzeNamespace;
  operationId: string;
  operationDeadlineMs: number;
  intent: KnowledgeGoldPageEditIntent;
}>;
type KnowledgeGoldCleanRequestCommand = Readonly<{
  kind: "gold_page_clean_request";
  namespace: KnowledgeBronzeNamespace;
  operationId: string;
  operationDeadlineMs: number;
  intent: KnowledgeGoldPageActionIntent;
}>;
type KnowledgeGoldPageActionCommand =
  | KnowledgeGoldPageEditCommand
  | KnowledgeGoldCleanRequestCommand;
type KnowledgeGoldPageActionSavedResult = Readonly<{
  status: "saved";
  operation: "edit" | "clean_replacement";
  operationId: string;
  pageId: string;
  pageVersion: number;
  protectionVersion: number;
  controlRevision: number;
}>;
type KnowledgeSafeControlTarget =
  | Readonly<{ kind: "article"; id: string }>
  | Readonly<{ kind: "gold_job"; id: string }>;
type KnowledgeSafeControlBase = Readonly<{
  workspaceId: string;
  gatekeeperInstanceId: string;
  localActionId: number;
  operationId: string;
  operationDeadlineMs: number;
  retainedBytesReserved: number;
}>;
type KnowledgeSafeControlReservation = KnowledgeSafeControlBase &
  Readonly<{
    target: KnowledgeSafeControlTarget;
    expectedJobFence?: number;
    expectedControlRevision?: number;
  }>;
type LegacyKnowledgeSilverSafeControlReservation = Readonly<{
  articleId: string;
  workspaceId: string;
  gatekeeperInstanceId: string;
  localActionId: number;
  operationId: string;
  operationDeadlineMs: number;
  retainedBytesReserved: number;
}>;
type KnowledgeArticleActionRow = Readonly<{
  operation_id: string;
  workspace_id: string | null;
  operation_deadline_ms: number | null;
  command_json: string;
  payload_hash: string;
  status: string;
  outcome_json: string | null;
}>;
type KnowledgeSessionProposal = (input: unknown) => Promise<
  Readonly<{
    status: "pending_approval";
    operationId: string;
  }>
>;
type KnowledgeSessionPolicyProposal = KnowledgeSessionProposal;
type KnowledgeSessionGoldPageEditProposal = KnowledgeSessionProposal;
type KnowledgeSessionGoldCleanRequestProposal = KnowledgeSessionProposal;
type InspectableAccess = Omit<Access, "assertBoundTo"> & {
  assertBoundTo(
    managerId: string,
  ): void | typeof KNOWLEDGE_READ_CONTRACT | Promise<void | typeof KNOWLEDGE_READ_CONTRACT>;
};
export type KnowledgeAccountProps = { managerId: string };
const err = (tag: string, cause?: unknown) => {
  const error = new Error("Knowledge Base " + tag + ".");
  if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause });
  return error;
};
const rec = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const prototype = Object.getPrototypeOf(v);
  return prototype === Object.prototype || prototype === null;
};
const exact = (v: Record<string, unknown>, k: readonly string[]) =>
  Object.keys(v).length === k.length && k.every((x) => Object.prototype.hasOwnProperty.call(v, x));
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
  const output = new Uint8Array(
    encodedFields.reduce((sum, field) => sum + 4 + field.byteLength, 0),
  );
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
const parseKnowledgeEnvelope = (
  value: unknown,
): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; code: string }> => {
  if (!rec(value)) throw err("integrity_failure");
  if (exact(value, ["ok", "value"]) && value.ok === true) return { ok: true, value: value.value };
  if (
    exact(value, ["ok", "code"]) &&
    value.ok === false &&
    typeof value.code === "string" &&
    KNOWLEDGE_FAILURE_CODES.includes(value.code as (typeof KNOWLEDGE_FAILURE_CODES)[number])
  )
    return { ok: false, code: value.code };
  throw err("integrity_failure");
};
type KnowledgeCandidateValidation = Readonly<{ bodyHash: string; profileId: string }>;
async function validateKnowledgeCandidate(
  writer: KnowledgeBronzeWrite,
  body: string,
): Promise<KnowledgeCandidateValidation> {
  let raw: unknown;
  try {
    raw = await writer.validateCandidate({ body });
  } catch (cause) {
    throw err("dependency_unavailable", cause);
  }
  let envelope: ReturnType<typeof parseKnowledgeEnvelope>;
  try {
    envelope = parseKnowledgeEnvelope(raw);
  } catch (cause) {
    throw err("permission_denied", cause);
  }
  if (!envelope.ok) {
    if (
      ["invalid_input", "input_too_large", "permission_denied", "dependency_unavailable"].includes(
        envelope.code,
      )
    )
      throw err(envelope.code);
    throw err("permission_denied");
  }
  if (
    !rec(envelope.value) ||
    !exact(envelope.value, ["bodyHash", "profileId"]) ||
    !isHexDigest(envelope.value.bodyHash) ||
    !isNonEmptyBoundedText(envelope.value.profileId, KNOWLEDGE_BRONZE_MAX_STAGE_METADATA_BYTES)
  )
    throw err("permission_denied");
  const bodyHash = await sha256Hex(new TextEncoder().encode(body));
  if (envelope.value.bodyHash !== bodyHash) throw err("permission_denied");
  return { bodyHash, profileId: envelope.value.profileId };
}
async function assertLegacyBronzeAdmissionExists(
  writer: KnowledgeBronzeWrite,
  namespace: KnowledgeBronzeNamespace,
): Promise<void> {
  let raw: unknown;
  try {
    raw = await writer.cancel({ kind: "lookup", namespace });
  } catch (cause) {
    throw err("dependency_unavailable", cause);
  }
  let envelope: ReturnType<typeof parseKnowledgeEnvelope>;
  try {
    envelope = parseKnowledgeEnvelope(raw);
  } catch (cause) {
    throw err("permission_denied", cause);
  }
  if (!envelope.ok) {
    if (envelope.code === "result_unknown" || envelope.code === "conflict") return;
    throw err(envelope.code);
  }
  if (rec(envelope.value) && exact(envelope.value, ["status"]) && envelope.value.status === "clear")
    throw err("conflict");
  if (
    rec(envelope.value) &&
    exact(envelope.value, ["status", "operationId"]) &&
    envelope.value.status === "fenced"
  )
    throw err("conflict");
  throw err("permission_denied");
}
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
    typeof value.articleId !== "string" ||
    !KNOWLEDGE_UUID.test(value.articleId) ||
    typeof value.revisionId !== "string" ||
    !KNOWLEDGE_UUID.test(value.revisionId) ||
    !isHexDigest(value.bodyHash)
  )
    throw err("integrity_failure");
  return {
    status: "saved",
    operationId,
    articleId: value.articleId,
    revisionId: value.revisionId,
    bodyHash: value.bodyHash,
  };
}
function parseStoredBronzeSavedReceipt(
  serialized: string | null,
  operationId: string,
): KnowledgeBronzeSavedReceipt {
  if (serialized === null) throw err("corrupt_state");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw err("corrupt_state");
  }
  return parseBronzeSavedReceipt(value, operationId);
}
function decodeKnowledgeSilverPolicyProposal(value: unknown): KnowledgeSilverPolicyIntent {
  if (
    !rec(value) ||
    !exact(value, ["articleId", "usePolicy", "expectedMetadataRevision"]) ||
    !isNonEmptyBoundedText(value.articleId, KNOWLEDGE_SAFE_CONTROL_MAX_BYTES_PER_TARGET) ||
    (value.usePolicy !== "included" && value.usePolicy !== "excluded") ||
    !boundedInt(value.expectedMetadataRevision, 0, Number.MAX_SAFE_INTEGER)
  )
    throw err("invalid_input");
  return {
    articleId: value.articleId,
    usePolicy: value.usePolicy,
    expectedMetadataRevision: value.expectedMetadataRevision,
  };
}
function decodeStoredSilverPolicyStage(
  serialized: string,
  actionId: number,
  gatekeeperInstanceId: string,
): KnowledgeSilverPolicyCommand {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw err("corrupt_state");
  }
  if (
    !rec(value) ||
    !exact(value, ["kind", "namespace", "operationId", "operationDeadlineMs", "intent"]) ||
    value.kind !== "silver_policy" ||
    !rec(value.namespace) ||
    !exact(value.namespace, ["workspaceId", "gatekeeperInstanceId", "localActionId"]) ||
    !isNonEmptyBoundedText(value.namespace.workspaceId, 512) ||
    value.namespace.gatekeeperInstanceId !== gatekeeperInstanceId ||
    !boundedInt(value.namespace.localActionId, 0, Number.MAX_SAFE_INTEGER) ||
    value.namespace.localActionId !== actionId ||
    typeof value.operationId !== "string" ||
    !UUID.test(value.operationId) ||
    !boundedInt(value.operationDeadlineMs, 0, Number.MAX_SAFE_INTEGER) ||
    !rec(value.intent)
  )
    throw err("corrupt_state");
  let intent: KnowledgeSilverPolicyIntent;
  try {
    intent = decodeKnowledgeSilverPolicyProposal(value.intent);
  } catch {
    throw err("corrupt_state");
  }
  return {
    kind: "silver_policy",
    namespace: {
      workspaceId: value.namespace.workspaceId,
      gatekeeperInstanceId,
      localActionId: actionId,
    },
    operationId: value.operationId,
    operationDeadlineMs: value.operationDeadlineMs,
    intent,
  };
}
async function computeSilverPolicyPayloadHash(
  command: KnowledgeSilverPolicyCommand,
): Promise<string> {
  return sha256Hex(
    encodeLengthPrefixed([
      "knowledge-silver-policy-native-v1",
      command.operationId,
      command.namespace.workspaceId,
      command.namespace.gatekeeperInstanceId,
      String(command.namespace.localActionId),
      command.intent.articleId,
      command.intent.usePolicy,
      String(command.intent.expectedMetadataRevision),
    ]),
  );
}
function parseSilverPolicySavedResult(
  value: unknown,
  command: KnowledgeSilverPolicyCommand,
): KnowledgeSilverPolicySavedResult {
  if (
    !rec(value) ||
    !exact(value, ["status", "operationId", "articleId", "usePolicy", "metadataRevision"]) ||
    value.status !== "saved" ||
    value.operationId !== command.operationId ||
    value.articleId !== command.intent.articleId ||
    value.usePolicy !== command.intent.usePolicy ||
    !boundedInt(value.metadataRevision, 1, Number.MAX_SAFE_INTEGER) ||
    value.metadataRevision !== command.intent.expectedMetadataRevision + 1
  )
    throw err("integrity_failure");
  return {
    status: "saved",
    operationId: command.operationId,
    articleId: command.intent.articleId,
    usePolicy: command.intent.usePolicy,
    metadataRevision: value.metadataRevision,
  };
}
function decodeKnowledgeGoldControlIntent(value: unknown): KnowledgeGoldControlIntent {
  if (
    !rec(value) ||
    !exactOptional(
      value,
      ["operation", "jobId", "expectedJobState", "expectedJobFence", "expectedControlRevision"],
      ["system1Recovery"],
    ) ||
    (value.operation !== "stop" && value.operation !== "resume") ||
    typeof value.jobId !== "string" ||
    !KNOWLEDGE_UUID.test(value.jobId) ||
    !isNonEmptyBoundedText(value.expectedJobState, 128) ||
    !boundedInt(value.expectedJobFence, 0, Number.MAX_SAFE_INTEGER) ||
    !boundedInt(value.expectedControlRevision, 0, Number.MAX_SAFE_INTEGER)
  )
    throw err("invalid_input");
  let system1Recovery: KnowledgeGoldControlIntent["system1Recovery"];
  if (Object.prototype.hasOwnProperty.call(value, "system1Recovery")) {
    const recovery = value.system1Recovery;
    if (
      value.operation !== "resume" ||
      !rec(recovery) ||
      !exact(recovery, ["decisionKeyHash", "expectedRequestId", "additionalMaxMicroUsd"]) ||
      typeof recovery.decisionKeyHash !== "string" ||
      !/^[0-9a-f]{64}$/u.test(recovery.decisionKeyHash) ||
      typeof recovery.expectedRequestId !== "string" ||
      !KNOWLEDGE_UUID.test(recovery.expectedRequestId) ||
      recovery.additionalMaxMicroUsd !== 5_000
    )
      throw err("invalid_input");
    system1Recovery = {
      decisionKeyHash: recovery.decisionKeyHash,
      expectedRequestId: recovery.expectedRequestId,
      additionalMaxMicroUsd: 5_000,
    };
  }
  return {
    operation: value.operation,
    jobId: value.jobId,
    expectedJobState: value.expectedJobState,
    expectedJobFence: value.expectedJobFence,
    expectedControlRevision: value.expectedControlRevision,
    ...(system1Recovery === undefined ? {} : { system1Recovery }),
  };
}
function decodeStoredGoldJobControlStage(
  serialized: string,
  actionId: number,
  gatekeeperInstanceId: string,
): KnowledgeGoldJobControlCommand {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw err("corrupt_state");
  }
  if (
    !rec(value) ||
    !exactOptional(
      value,
      ["kind", "namespace", "operationId", "operationDeadlineMs", "intent"],
      ["system1RecoveryNextRequestId"],
    ) ||
    value.kind !== "gold_job_control" ||
    !rec(value.namespace) ||
    !exact(value.namespace, ["workspaceId", "gatekeeperInstanceId", "localActionId"]) ||
    !isNonEmptyBoundedText(value.namespace.workspaceId, 512) ||
    value.namespace.gatekeeperInstanceId !== gatekeeperInstanceId ||
    !boundedInt(value.namespace.localActionId, 0, Number.MAX_SAFE_INTEGER) ||
    value.namespace.localActionId !== actionId ||
    typeof value.operationId !== "string" ||
    !UUID.test(value.operationId) ||
    !boundedInt(value.operationDeadlineMs, 0, Number.MAX_SAFE_INTEGER)
  )
    throw err("corrupt_state");
  let intent: KnowledgeGoldControlIntent;
  try {
    intent = decodeKnowledgeGoldControlIntent(value.intent);
  } catch {
    throw err("corrupt_state");
  }
  let system1RecoveryNextRequestId: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value, "system1RecoveryNextRequestId")) {
    if (
      typeof value.system1RecoveryNextRequestId !== "string" ||
      !KNOWLEDGE_UUID.test(value.system1RecoveryNextRequestId)
    )
      throw err("corrupt_state");
    system1RecoveryNextRequestId = value.system1RecoveryNextRequestId;
  }
  if (
    (intent.system1Recovery === undefined && system1RecoveryNextRequestId !== undefined) ||
    (intent.system1Recovery !== undefined &&
      (system1RecoveryNextRequestId === undefined ||
        system1RecoveryNextRequestId === intent.system1Recovery.expectedRequestId))
  )
    throw err("corrupt_state");
  return {
    kind: "gold_job_control",
    namespace: {
      workspaceId: value.namespace.workspaceId,
      gatekeeperInstanceId,
      localActionId: actionId,
    },
    operationId: value.operationId,
    operationDeadlineMs: value.operationDeadlineMs,
    intent,
    ...(system1RecoveryNextRequestId === undefined ? {} : { system1RecoveryNextRequestId }),
  };
}
type GoldPageActionKind = KnowledgeGoldPageActionCommand["kind"];
const isCanonicalGoldPagePath = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    hasLoneSurrogate(value) ||
    new TextEncoder().encode(value).byteLength > KNOWLEDGE_GOLD_PAGE_MAX_PATH_BYTES ||
    // oxlint-disable-next-line no-control-regex -- Reject C0 controls from canonical Gold page paths.
    /[\u0000-\u001f]/u.test(value) ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ||
    !value.endsWith(".md")
  )
    return false;
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
};
function decodeGoldPageActionIntent(
  value: unknown,
  kind: "gold_page_edit",
  failureTag: "invalid_input" | "corrupt_state",
): KnowledgeGoldPageEditIntent;
function decodeGoldPageActionIntent(
  value: unknown,
  kind: "gold_page_clean_request",
  failureTag: "invalid_input" | "corrupt_state",
): KnowledgeGoldPageActionIntent;
function decodeGoldPageActionIntent(
  value: unknown,
  kind: GoldPageActionKind,
  failureTag: "invalid_input" | "corrupt_state",
): KnowledgeGoldPageActionCommand["intent"] {
  const hasContent = kind === "gold_page_edit";
  const intentKeys = [
    "path",
    "pageId",
    "expectedPageVersion",
    "expectedProtectionVersion",
    "expectedControlRevision",
    "sourceContext",
    ...(hasContent ? ["content"] : []),
  ];
  if (
    !rec(value) ||
    !exact(value, intentKeys) ||
    !isCanonicalGoldPagePath(value.path) ||
    !isNonEmptyBoundedText(value.pageId, 512) ||
    !boundedInt(
      value.expectedPageVersion,
      0,
      kind === "gold_page_edit" ? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER,
    ) ||
    !boundedInt(value.expectedProtectionVersion, 0, Number.MAX_SAFE_INTEGER) ||
    !boundedInt(value.expectedControlRevision, 0, Number.MAX_SAFE_INTEGER - 1) ||
    !Array.isArray(value.sourceContext) ||
    value.sourceContext.length > 64 ||
    (kind === "gold_page_clean_request" && value.sourceContext.length === 0)
  )
    throw err(failureTag);

  const sourceContext: KnowledgeGoldPageSourceContextEntry[] = [];
  for (const rawSource of value.sourceContext) {
    if (
      !rec(rawSource) ||
      !exact(rawSource, [
        "articleId",
        "revisionId",
        "bodyHash",
        "metadataRevision",
        "projectionVersions",
      ]) ||
      !isNonEmptyBoundedText(rawSource.articleId, 512) ||
      !isNonEmptyBoundedText(rawSource.revisionId, 512) ||
      !isHexDigest(rawSource.bodyHash) ||
      !boundedInt(rawSource.metadataRevision, 0, Number.MAX_SAFE_INTEGER) ||
      !rec(rawSource.projectionVersions) ||
      !exact(rawSource.projectionVersions, [
        "projectionRuleVersion",
        "processedVersion",
        "relationVersion",
      ]) ||
      !isNonEmptyBoundedText(rawSource.projectionVersions.projectionRuleVersion, 256) ||
      !isHexDigest(rawSource.projectionVersions.processedVersion) ||
      !isHexDigest(rawSource.projectionVersions.relationVersion)
    )
      throw err(failureTag);
    sourceContext.push({
      articleId: rawSource.articleId,
      revisionId: rawSource.revisionId,
      bodyHash: rawSource.bodyHash,
      metadataRevision: rawSource.metadataRevision,
      projectionVersions: {
        projectionRuleVersion: rawSource.projectionVersions.projectionRuleVersion,
        processedVersion: rawSource.projectionVersions.processedVersion,
        relationVersion: rawSource.projectionVersions.relationVersion,
      },
    });
  }

  const base = {
    path: value.path,
    pageId: value.pageId,
    expectedPageVersion: value.expectedPageVersion,
    expectedProtectionVersion: value.expectedProtectionVersion,
    expectedControlRevision: value.expectedControlRevision,
    sourceContext,
  };
  if (!hasContent) return base;
  if (
    typeof value.content !== "string" ||
    value.content.length === 0 ||
    value.content.startsWith("\uFEFF") ||
    // oxlint-disable-next-line no-control-regex -- Reject disallowed C0 controls from submitted Markdown.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value.content)
  )
    throw err(failureTag);
  const contentBytes = new TextEncoder().encode(value.content);
  if (
    contentBytes.byteLength > KNOWLEDGE_GOLD_PAGE_MAX_CONTENT_BYTES ||
    new TextDecoder().decode(contentBytes) !== value.content
  )
    throw err(failureTag);
  return { ...base, content: value.content };
}
function decodeGoldPageEditProposal(value: unknown): KnowledgeGoldPageEditIntent {
  if (!rec(value) || !exact(value, ["intent"])) throw err("invalid_input");
  return decodeGoldPageActionIntent(value.intent, "gold_page_edit", "invalid_input");
}
function decodeGoldPageCleanReplacementProposal(value: unknown): KnowledgeGoldPageActionIntent {
  if (!rec(value) || !exact(value, ["intent"])) throw err("invalid_input");
  return decodeGoldPageActionIntent(value.intent, "gold_page_clean_request", "invalid_input");
}
function decodeStoredGoldPageActionStage(
  serialized: string,
  actionId: number,
  gatekeeperInstanceId: string,
  expectedKind: GoldPageActionKind,
): KnowledgeGoldPageActionCommand {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw err("corrupt_state");
  }
  if (
    !rec(value) ||
    !exact(value, ["kind", "namespace", "operationId", "operationDeadlineMs", "intent"]) ||
    value.kind !== expectedKind ||
    !rec(value.namespace) ||
    !exact(value.namespace, ["workspaceId", "gatekeeperInstanceId", "localActionId"]) ||
    !isNonEmptyBoundedText(value.namespace.workspaceId, 512) ||
    value.namespace.gatekeeperInstanceId !== gatekeeperInstanceId ||
    !boundedInt(value.namespace.localActionId, 0, Number.MAX_SAFE_INTEGER) ||
    value.namespace.localActionId !== actionId ||
    typeof value.operationId !== "string" ||
    !UUID.test(value.operationId) ||
    !boundedInt(value.operationDeadlineMs, 0, Number.MAX_SAFE_INTEGER)
  )
    throw err("corrupt_state");
  const namespace = {
    workspaceId: value.namespace.workspaceId,
    gatekeeperInstanceId,
    localActionId: actionId,
  };
  if (expectedKind === "gold_page_edit")
    return {
      kind: expectedKind,
      namespace,
      operationId: value.operationId,
      operationDeadlineMs: value.operationDeadlineMs,
      intent: decodeGoldPageActionIntent(value.intent, expectedKind, "corrupt_state"),
    };
  return {
    kind: expectedKind,
    namespace,
    operationId: value.operationId,
    operationDeadlineMs: value.operationDeadlineMs,
    intent: decodeGoldPageActionIntent(value.intent, expectedKind, "corrupt_state"),
  };
}
async function computeGoldPageActionPayloadHash(
  managerId: string,
  command: KnowledgeGoldPageActionCommand,
): Promise<string> {
  return sha256Hex(
    encodeLengthPrefixed([
      "knowledge-gold-page-action-native-v1",
      managerId,
      JSON.stringify(command),
    ]),
  );
}
function parseGoldPageActionSavedResult(
  value: unknown,
  command: KnowledgeGoldPageActionCommand,
): KnowledgeGoldPageActionSavedResult {
  const operation = command.kind === "gold_page_edit" ? "edit" : "clean_replacement";
  const pageVersion =
    command.kind === "gold_page_edit"
      ? command.intent.expectedPageVersion + 1
      : command.intent.expectedPageVersion;
  if (
    !rec(value) ||
    !exact(value, [
      "status",
      "operation",
      "operationId",
      "pageId",
      "pageVersion",
      "protectionVersion",
      "controlRevision",
    ]) ||
    value.status !== "saved" ||
    value.operation !== operation ||
    value.operationId !== command.operationId ||
    value.pageId !== command.intent.pageId ||
    value.pageVersion !== pageVersion ||
    !boundedInt(
      value.protectionVersion,
      command.intent.expectedProtectionVersion,
      command.kind === "gold_page_edit" &&
        command.intent.expectedProtectionVersion < Number.MAX_SAFE_INTEGER
        ? command.intent.expectedProtectionVersion + 1
        : command.intent.expectedProtectionVersion,
    ) ||
    value.controlRevision !== command.intent.expectedControlRevision + 1
  )
    throw err("integrity_failure");
  return {
    status: "saved",
    operation,
    operationId: command.operationId,
    pageId: command.intent.pageId,
    pageVersion,
    protectionVersion: value.protectionVersion,
    controlRevision: command.intent.expectedControlRevision + 1,
  };
}
function parseStoredGoldPageActionSavedResult(
  serialized: string | null,
  operationId: string,
  kind: GoldPageActionKind,
): KnowledgeGoldPageActionSavedResult {
  if (serialized === null) throw err("corrupt_state");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw err("corrupt_state");
  }
  const operation = kind === "gold_page_edit" ? "edit" : "clean_replacement";
  if (
    !rec(value) ||
    !exact(value, [
      "status",
      "operation",
      "operationId",
      "pageId",
      "pageVersion",
      "protectionVersion",
      "controlRevision",
    ]) ||
    value.status !== "saved" ||
    value.operation !== operation ||
    value.operationId !== operationId ||
    !isNonEmptyBoundedText(value.pageId, 512) ||
    !boundedInt(value.pageVersion, 0, Number.MAX_SAFE_INTEGER) ||
    !boundedInt(value.protectionVersion, 0, Number.MAX_SAFE_INTEGER) ||
    !boundedInt(value.controlRevision, 1, Number.MAX_SAFE_INTEGER)
  )
    throw err("corrupt_state");
  return {
    status: "saved",
    operation,
    operationId,
    pageId: value.pageId,
    pageVersion: value.pageVersion,
    protectionVersion: value.protectionVersion,
    controlRevision: value.controlRevision,
  };
}
async function computeGoldJobControlPayloadHash(
  managerId: string,
  command: KnowledgeGoldJobControlCommand,
): Promise<string> {
  const fields = [
    "knowledge-gold-job-control-native-v1",
    managerId,
    command.operationId,
    command.namespace.workspaceId,
    command.namespace.gatekeeperInstanceId,
    String(command.namespace.localActionId),
    String(command.operationDeadlineMs),
    command.intent.operation,
    command.intent.jobId,
    command.intent.expectedJobState,
    String(command.intent.expectedJobFence),
    String(command.intent.expectedControlRevision),
  ];
  const recovery = command.intent.system1Recovery;
  if (recovery !== undefined) {
    const nextRequestId = command.system1RecoveryNextRequestId;
    if (nextRequestId === undefined || nextRequestId === recovery.expectedRequestId)
      throw err("corrupt_state");
    fields.push(
      "system1-recovery-v1",
      recovery.decisionKeyHash,
      recovery.expectedRequestId,
      nextRequestId,
      String(recovery.additionalMaxMicroUsd),
    );
  }
  return sha256Hex(encodeLengthPrefixed(fields));
}
function readKnowledgeGoldControlHead(value: unknown): KnowledgeGoldControlHead {
  if (
    !rec(value) ||
    !isNonEmptyBoundedText(value.mode, 32) ||
    !Object.prototype.hasOwnProperty.call(value, "controlRevision") ||
    !Object.prototype.hasOwnProperty.call(value, "job") ||
    !boundedInt(value.controlRevision, 0, Number.MAX_SAFE_INTEGER)
  )
    throw err("integrity_failure");
  if (value.job === null)
    return {
      mode: value.mode,
      controlRevision: value.controlRevision,
      job: null,
    };
  if (
    !rec(value.job) ||
    typeof value.job.jobId !== "string" ||
    !KNOWLEDGE_UUID.test(value.job.jobId) ||
    !isNonEmptyBoundedText(value.job.state, 128) ||
    !boundedInt(value.job.fence, 0, Number.MAX_SAFE_INTEGER)
  )
    throw err("integrity_failure");
  return {
    mode: value.mode,
    controlRevision: value.controlRevision,
    job: {
      jobId: value.job.jobId,
      state: value.job.state,
      fence: value.job.fence,
    },
  };
}
function parseGoldJobControlSavedResult(
  value: unknown,
  command: KnowledgeGoldJobControlCommand,
): KnowledgeGoldJobControlSavedResult {
  const recovery = command.intent.system1Recovery !== undefined;
  const nextState = recovery
    ? command.intent.expectedJobState
    : command.intent.operation === "stop"
      ? "paused_user"
      : "dirty";
  const nextFence = recovery
    ? command.intent.expectedJobFence
    : command.intent.expectedJobFence + 1;
  const nextControlRevision = recovery
    ? command.intent.expectedControlRevision
    : command.intent.expectedControlRevision + 1;
  if (
    !rec(value) ||
    !exact(value, ["status", "operationId", "jobId", "state", "fence", "controlRevision"]) ||
    value.status !== "saved" ||
    value.operationId !== command.operationId ||
    value.jobId !== command.intent.jobId ||
    value.state !== nextState ||
    !boundedInt(value.fence, 1, Number.MAX_SAFE_INTEGER) ||
    value.fence !== nextFence ||
    !boundedInt(value.controlRevision, recovery ? 0 : 1, Number.MAX_SAFE_INTEGER) ||
    value.controlRevision !== nextControlRevision
  )
    throw err("integrity_failure");
  return {
    status: "saved",
    operationId: command.operationId,
    jobId: command.intent.jobId,
    state: nextState,
    fence: value.fence,
    controlRevision: value.controlRevision,
  };
}
function parseStoredGoldJobControlSavedResult(
  serialized: string | null,
  operationId: string,
): KnowledgeGoldJobControlSavedResult {
  // The applied Action no longer retains its command; its saved result follows the shared nonnegative schema.
  if (typeof serialized !== "string") throw err("corrupt_state");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw err("corrupt_state");
  }
  if (
    !rec(value) ||
    !exact(value, ["status", "operationId", "jobId", "state", "fence", "controlRevision"]) ||
    value.status !== "saved" ||
    value.operationId !== operationId ||
    typeof value.jobId !== "string" ||
    !KNOWLEDGE_UUID.test(value.jobId) ||
    !isNonEmptyBoundedText(value.state, 128) ||
    !boundedInt(value.fence, 1, Number.MAX_SAFE_INTEGER) ||
    !boundedInt(value.controlRevision, 0, Number.MAX_SAFE_INTEGER)
  )
    throw err("corrupt_state");
  return {
    status: "saved",
    operationId,
    jobId: value.jobId,
    state: value.state,
    fence: value.fence,
    controlRevision: value.controlRevision,
  };
}
function parseStoredSilverPolicySavedResult(
  serialized: string | null,
  operationId: string,
): KnowledgeSilverPolicySavedResult {
  if (serialized === null) throw err("corrupt_state");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw err("corrupt_state");
  }
  if (
    !rec(value) ||
    !exact(value, ["status", "operationId", "articleId", "usePolicy", "metadataRevision"]) ||
    value.status !== "saved" ||
    value.operationId !== operationId ||
    !isNonEmptyBoundedText(value.articleId, KNOWLEDGE_SAFE_CONTROL_MAX_BYTES_PER_TARGET) ||
    (value.usePolicy !== "included" && value.usePolicy !== "excluded") ||
    !boundedInt(value.metadataRevision, 1, Number.MAX_SAFE_INTEGER)
  )
    throw err("corrupt_state");
  return {
    status: "saved",
    operationId,
    articleId: value.articleId,
    usePolicy: value.usePolicy,
    metadataRevision: value.metadataRevision,
  };
}
function decodeKnowledgeArticleProposal(value: unknown): KnowledgeArticleProposal {
  if (!rec(value) || !exact(value, ["article"]) || !rec(value.article)) throw err("invalid_input");
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
    typeof article.articleId === "string" &&
    KNOWLEDGE_UUID.test(article.articleId) &&
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
  )
    return true;
  return (
    value.kind === "os_observation" &&
    exact(value, ["kind", "actionId", "gatekeeperId"]) &&
    boundedInt(value.actionId, 0, Number.MAX_SAFE_INTEGER) &&
    boundedInt(value.gatekeeperId, 0, Number.MAX_SAFE_INTEGER)
  );
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
    (value.author.type === "user" ||
      value.author.type === "agent" ||
      value.author.type === "gadget") &&
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
    exact(value, [
      "version",
      "kind",
      "actionId",
      "gatekeeperId",
      "createdAtMs",
      "title",
      "resourceTitle",
    ]) &&
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
function articleClaims(
  article: KnowledgeArticleProposal,
): Pick<KnowledgeProvenance, "observedTargetDescription" | "sourceRelationshipClaim"> {
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
async function computeKnowledgeBronzeIntentHash(
  input: Readonly<{
    intent: KnowledgeProposedIntent;
    operationId: string;
    managerId: string;
    namespace: KnowledgeBronzeNamespace;
    bodyBytes: Uint8Array;
    profileId?: string;
  }>,
): Promise<string> {
  const bodyHash = await sha256Hex(input.bodyBytes);
  const provenanceBytes = new TextEncoder().encode(
    canonicalKnowledgeProvenance(input.intent.provenance),
  );
  const provenanceHash = await sha256Hex(provenanceBytes);
  const fields = [
    input.profileId === undefined ? "knowledge-bronze-intent-v1" : "knowledge-bronze-intent-v2",
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
  if (input.profileId !== undefined) fields.push(input.profileId);
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
type KnowledgeStagedCommandBase = Readonly<{
  kind: "staged";
  namespace: KnowledgeBronzeNamespace;
  operationId: string;
  attemptFencingToken: number;
  operationDeadlineMs: number;
  fullIntentHash: string;
  intent: KnowledgeProposedIntent;
}>;
type KnowledgeStagedCommand = KnowledgeStagedCommandBase &
  (
    | Readonly<{ profileId?: never; bodyHash?: never }>
    | Readonly<{ profileId: string; bodyHash: string }>
  );
const isV2KnowledgeStagedCommand = (
  command: KnowledgeStagedCommand,
): command is KnowledgeStagedCommandBase & Readonly<{ profileId: string; bodyHash: string }> =>
  typeof command.profileId === "string" && typeof command.bodyHash === "string";
function knowledgeStagedFenceCommand(command: KnowledgeStagedCommand) {
  const base = {
    kind: "staged_fence" as const,
    namespace: command.namespace,
    operationId: command.operationId,
    attemptFencingToken: command.attemptFencingToken,
    operationDeadlineMs: command.operationDeadlineMs,
    fullIntentHash: command.fullIntentHash,
    intent: command.intent,
  };
  return isV2KnowledgeStagedCommand(command)
    ? { ...base, profileId: command.profileId, bodyHash: command.bodyHash }
    : base;
}
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
  const v1Fields = [
    "kind",
    "namespace",
    "operationId",
    "attemptFencingToken",
    "operationDeadlineMs",
    "fullIntentHash",
    "intent",
  ];
  const v2Fields = [
    "kind",
    "namespace",
    "operationId",
    "attemptFencingToken",
    "operationDeadlineMs",
    "fullIntentHash",
    "profileId",
    "bodyHash",
    "intent",
  ];
  if (
    !rec(value) ||
    (!exact(value, v1Fields) && !exact(value, v2Fields)) ||
    value.kind !== "staged" ||
    !rec(value.namespace) ||
    !exact(value.namespace, ["workspaceId", "gatekeeperInstanceId", "localActionId"]) ||
    !isNonEmptyBoundedText(value.namespace.workspaceId, 512) ||
    value.namespace.gatekeeperInstanceId !== gatekeeperInstanceId ||
    !boundedInt(value.namespace.localActionId, 0, Number.MAX_SAFE_INTEGER) ||
    value.namespace.localActionId !== actionId ||
    typeof value.operationId !== "string" ||
    !UUID.test(value.operationId) ||
    !boundedInt(value.attemptFencingToken, 1, Number.MAX_SAFE_INTEGER) ||
    !boundedInt(value.operationDeadlineMs, 0, Number.MAX_SAFE_INTEGER) ||
    !isHexDigest(value.fullIntentHash) ||
    !rec(value.intent)
  )
    throw err("corrupt_state");

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
    if (
      !exact(rawProvenance, [
        "version",
        "kind",
        "chatId",
        "sequence",
        "timestampMs",
        "author",
        "observedTargetDescription",
        "sourceRelationshipClaim",
      ])
    )
      throw err("corrupt_state");
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
    if (
      !exact(rawProvenance, [
        "version",
        "kind",
        "actionId",
        "gatekeeperId",
        "createdAtMs",
        "title",
        "resourceTitle",
        "observedTargetDescription",
        "sourceRelationshipClaim",
      ])
    )
      throw err("corrupt_state");
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
    !isNonEmptyBoundedText(
      rawProvenance.observedTargetDescription,
      KNOWLEDGE_BRONZE_MAX_METADATA_BYTES,
    ) ||
    !isNonEmptyBoundedText(
      rawProvenance.sourceRelationshipClaim,
      KNOWLEDGE_BRONZE_MAX_METADATA_BYTES,
    )
  )
    throw err("corrupt_state");
  const provenance: KnowledgeProvenance = {
    ...verified,
    observedTargetDescription: rawProvenance.observedTargetDescription,
    sourceRelationshipClaim: rawProvenance.sourceRelationshipClaim,
  };
  let intent: KnowledgeProposedIntent;
  if (
    rawIntent.kind === "adopt" &&
    exact(rawIntent, [
      "kind",
      "articleId",
      "revisionId",
      "expectedCurrentRevision",
      "body",
      "initialUsePolicy",
      "provenance",
    ]) &&
    typeof rawIntent.articleId === "string" &&
    KNOWLEDGE_UUID.test(rawIntent.articleId) &&
    typeof rawIntent.revisionId === "string" &&
    KNOWLEDGE_UUID.test(rawIntent.revisionId) &&
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
      "kind",
      "articleId",
      "revisionId",
      "expectedCurrentRevision",
      "body",
      "provenance",
    ]) &&
    typeof rawIntent.articleId === "string" &&
    KNOWLEDGE_UUID.test(rawIntent.articleId) &&
    typeof rawIntent.revisionId === "string" &&
    KNOWLEDGE_UUID.test(rawIntent.revisionId) &&
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
  const commandBase: KnowledgeStagedCommandBase = {
    kind: "staged",
    namespace,
    operationId: value.operationId,
    attemptFencingToken: value.attemptFencingToken,
    operationDeadlineMs: value.operationDeadlineMs,
    fullIntentHash: value.fullIntentHash,
    intent,
  };
  const bodyBytes = new TextEncoder().encode(intent.body);
  if (Object.prototype.hasOwnProperty.call(value, "profileId")) {
    if (
      !isNonEmptyBoundedText(value.profileId, KNOWLEDGE_BRONZE_MAX_STAGE_METADATA_BYTES) ||
      !isHexDigest(value.bodyHash) ||
      value.bodyHash !== (await sha256Hex(bodyBytes))
    )
      throw err("corrupt_state");
    const command: KnowledgeStagedCommand = {
      ...commandBase,
      profileId: value.profileId,
      bodyHash: value.bodyHash,
    };
    const actualHash = await computeKnowledgeBronzeIntentHash({
      intent,
      operationId: command.operationId,
      managerId,
      namespace,
      bodyBytes,
      profileId: command.profileId,
    });
    if (actualHash !== command.fullIntentHash) throw err("corrupt_state");
    return command;
  }
  const command: KnowledgeStagedCommand = commandBase;
  const actualHash = await computeKnowledgeBronzeIntentHash({
    intent,
    operationId: command.operationId,
    managerId,
    namespace,
    bodyBytes,
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
const isHexDigest = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/u.test(v);
const isCanonicalMarkdownPath = (v: unknown): v is string =>
  typeof v === "string" &&
  !hasLoneSurrogate(v) &&
  new TextEncoder().encode(v).byteLength <= 240 &&
  v.length > 0 &&
  // oxlint-disable-next-line no-control-regex -- Reject C0 controls from canonical virtual paths.
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
    (item) => rec(item) && exact(item, ["path"]) && isCanonicalMarkdownPath(item.path),
  ) &&
  (!Object.prototype.hasOwnProperty.call(v, "nextOffset") || boundedInt(v.nextOffset, 0, 64));
const validComputerSearchResult = (v: unknown): v is KnowledgeComputerSearchResult =>
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
const denseArray = (v: unknown): v is unknown[] =>
  Array.isArray(v) && Object.keys(v).length === v.length;
const validSilverFacetCoverage = (v: unknown): v is KnowledgeSilverFacetCoverage =>
  rec(v) &&
  exact(v, ["status", "reasons"]) &&
  (v.status === "complete" || v.status === "partial") &&
  denseArray(v.reasons) &&
  v.reasons.every((reason) => typeof reason === "string");
const validSilverSearchCoverage = (v: unknown): v is KnowledgeSilverSearchCoverage =>
  rec(v) &&
  exact(v, ["metadata", "internalLinks", "sources"]) &&
  validSilverFacetCoverage(v.metadata) &&
  validSilverFacetCoverage(v.internalLinks) &&
  validSilverFacetCoverage(v.sources);
const validSilverProjectionLink = (v: unknown): v is KnowledgeSilverProjectionLink => {
  if (
    !rec(v) ||
    typeof v.rawDestination !== "string" ||
    typeof v.targetPath !== "string" ||
    (v.fragment !== null && typeof v.fragment !== "string")
  )
    return false;
  if (v.resolution === "resolved_current")
    return (
      exact(v, ["rawDestination", "targetPath", "fragment", "resolution", "targetArticleId"]) &&
      typeof v.targetArticleId === "string" &&
      v.targetArticleId.length > 0
    );
  if (v.resolution === "resolved_exact")
    return (
      exact(v, [
        "rawDestination",
        "targetPath",
        "fragment",
        "resolution",
        "targetArticleId",
        "targetRevisionId",
        "targetBodyHash",
      ]) &&
      typeof v.targetArticleId === "string" &&
      v.targetArticleId.length > 0 &&
      typeof v.targetRevisionId === "string" &&
      v.targetRevisionId.length > 0 &&
      isHexDigest(v.targetBodyHash)
    );
  return (
    (v.resolution === "unresolved" || v.resolution === "external_or_scope") &&
    exact(v, ["rawDestination", "targetPath", "fragment", "resolution"])
  );
};
const validSilverProjectionSource = (v: unknown): v is KnowledgeSilverProjectionSource => {
  if (
    !rec(v) ||
    !Object.prototype.hasOwnProperty.call(v, "descriptor") ||
    !isJsonValue(v.descriptor)
  )
    return false;
  if (v.resolution === "resolved_current")
    return (
      exact(v, ["descriptor", "resolution", "targetArticleId"]) &&
      typeof v.targetArticleId === "string" &&
      v.targetArticleId.length > 0
    );
  if (v.resolution === "resolved_exact")
    return (
      exact(v, [
        "descriptor",
        "resolution",
        "targetArticleId",
        "targetRevisionId",
        "targetBodyHash",
      ]) &&
      typeof v.targetArticleId === "string" &&
      v.targetArticleId.length > 0 &&
      typeof v.targetRevisionId === "string" &&
      v.targetRevisionId.length > 0 &&
      isHexDigest(v.targetBodyHash)
    );
  return (
    (v.resolution === "unresolved" || v.resolution === "external_or_scope") &&
    exact(v, ["descriptor", "resolution"])
  );
};
const validSilverProjectionBacklink = (v: unknown): boolean =>
  rec(v) &&
  exact(v, ["sourceArticleId", "sourceRevisionId", "targetRevisionId", "targetBodyHash"]) &&
  typeof v.sourceArticleId === "string" &&
  v.sourceArticleId.length > 0 &&
  typeof v.sourceRevisionId === "string" &&
  v.sourceRevisionId.length > 0 &&
  (v.targetRevisionId === null ||
    (typeof v.targetRevisionId === "string" && v.targetRevisionId.length > 0)) &&
  (v.targetBodyHash === null || isHexDigest(v.targetBodyHash));
const validSilverProjection = (v: unknown): v is KnowledgeSilverProjectionResult =>
  rec(v) &&
  exact(v, [
    "articleId",
    "inputRevisionId",
    "projectionRuleVersion",
    "processedVersion",
    "relationVersion",
    "metadata",
    "literalLinks",
    "backlinks",
    "sources",
    "coverage",
  ]) &&
  typeof v.articleId === "string" &&
  v.articleId.length > 0 &&
  typeof v.inputRevisionId === "string" &&
  v.inputRevisionId.length > 0 &&
  typeof v.projectionRuleVersion === "string" &&
  v.projectionRuleVersion.length > 0 &&
  isHexDigest(v.processedVersion) &&
  isHexDigest(v.relationVersion) &&
  (v.metadata === null || (rec(v.metadata) && isJsonValue(v.metadata))) &&
  denseArray(v.literalLinks) &&
  v.literalLinks.every(validSilverProjectionLink) &&
  denseArray(v.backlinks) &&
  v.backlinks.every(validSilverProjectionBacklink) &&
  denseArray(v.sources) &&
  v.sources.every(validSilverProjectionSource) &&
  validSilverSearchCoverage(v.coverage);
const encodeArticlePathSegment = (value: string): string | undefined => {
  if (value.length === 0 || hasLoneSurrogate(value)) return undefined;
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x4000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};
const articlePathSegmentLength = (byteLength: number): number => Math.ceil((byteLength * 4) / 3);
const articleVirtualPathsMatch = (
  articleId: string,
  revisionId: string,
  currentPath: string,
  exactRevisionPath: string,
): boolean => {
  if (articleId.length === 0 || revisionId.length === 0) return false;
  const encoder = new TextEncoder();
  const articleBytes = encoder.encode(articleId);
  const revisionBytes = encoder.encode(revisionId);
  if (hasLoneSurrogate(articleId) || hasLoneSurrogate(revisionId)) return false;
  if (
    12 + articlePathSegmentLength(articleBytes.byteLength) > 240 ||
    23 +
      articlePathSegmentLength(articleBytes.byteLength) +
      articlePathSegmentLength(revisionBytes.byteLength) >
      240
  )
    return false;
  const encodedArticleId = encodeArticlePathSegment(articleId);
  const encodedRevisionId = encodeArticlePathSegment(revisionId);
  return (
    encodedArticleId !== undefined &&
    encodedRevisionId !== undefined &&
    currentPath === `articles/${encodedArticleId}.md` &&
    exactRevisionPath === `articles/${encodedArticleId}/revisions/${encodedRevisionId}.md`
  );
};
const validSilverArticleSearchItem = (v: unknown): v is KnowledgeArticleSearchItem => {
  if (
    !rec(v) ||
    typeof v.articleId !== "string" ||
    v.articleId.length === 0 ||
    typeof v.currentRevisionId !== "string" ||
    v.currentRevisionId.length === 0 ||
    v.usePolicy !== "included" ||
    !isCanonicalMarkdownPath(v.currentPath) ||
    !isCanonicalMarkdownPath(v.exactRevisionPath) ||
    !articleVirtualPathsMatch(
      v.articleId,
      v.currentRevisionId,
      v.currentPath,
      v.exactRevisionPath,
    ) ||
    !isHexDigest(v.bodyHash) ||
    !validSilverSearchCoverage(v.coverage)
  )
    return false;
  const common = [
    "articleId",
    "currentRevisionId",
    "usePolicy",
    "currentPath",
    "exactRevisionPath",
    "bodyHash",
    "coverage",
    "state",
    "projection",
  ];
  if (v.state === "pending") return exact(v, common) && v.projection === null;
  if (v.state !== "indexed" && v.state !== "metadata_unknown") return false;
  if (
    !exact(v, common) ||
    !validSilverProjection(v.projection) ||
    v.projection.articleId !== v.articleId ||
    v.projection.inputRevisionId !== v.currentRevisionId
  )
    return false;
  return v.state !== "metadata_unknown" || v.coverage.metadata.status === "partial";
};
const compareUtf8Bytes = (left: string, right: string): number => {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const sharedLength = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
};
const validArticleSearchResult = (
  v: unknown,
  input: KnowledgeArticleSearchInput,
): v is Extract<KnowledgeSearchResult, { kind: "articles" }> => {
  if (
    !rec(v) ||
    !exactOptional(v, ["kind", "items", "coverage"], ["nextCursor"]) ||
    v.kind !== "articles" ||
    !denseArray(v.items) ||
    v.items.length > input.limit ||
    !v.items.every(validSilverArticleSearchItem) ||
    !validSilverSearchCoverage(v.coverage) ||
    (Object.prototype.hasOwnProperty.call(v, "nextCursor") &&
      (typeof v.nextCursor !== "string" || v.nextCursor.length === 0))
  )
    return false;
  let previousId = input.cursor;
  for (const item of v.items) {
    if (previousId !== undefined && compareUtf8Bytes(item.articleId, previousId) <= 0) return false;
    previousId = item.articleId;
  }
  if (Object.prototype.hasOwnProperty.call(v, "nextCursor")) {
    const lastItem = v.items[v.items.length - 1];
    if (lastItem === undefined || v.nextCursor !== lastItem.articleId) return false;
  }
  return true;
};
const validArticleLinksSearchResult = (
  v: unknown,
  input: KnowledgeArticleLinksSearchInput,
): v is Extract<KnowledgeSearchResult, { kind: "article-links" }> =>
  rec(v) &&
  exact(v, ["kind", "items", "coverage"]) &&
  v.kind === "article-links" &&
  denseArray(v.items) &&
  v.items.length <= input.candidateBudget &&
  v.items.every(
    (entry) =>
      rec(entry) &&
      exact(entry, ["depth", "item"]) &&
      boundedInt(entry.depth, 0, input.maxDepth) &&
      validSilverArticleSearchItem(entry.item),
  ) &&
  validSilverSearchCoverage(v.coverage);
const validSearchResult = (v: unknown, input: KnowledgeSearchInput): v is KnowledgeSearchResult => {
  if (!("kind" in input))
    return (
      validComputerSearchResult(v) &&
      new TextEncoder().encode(JSON.stringify(v)).byteLength <= KNOWLEDGE_READ_RESPONSE_MAX_BYTES
    );
  const valid =
    input.kind === "articles"
      ? validArticleSearchResult(v, input)
      : validArticleLinksSearchResult(v, input);
  if (!valid) return false;
  const serialized = JSON.stringify(v);
  return (
    typeof serialized === "string" &&
    new TextEncoder().encode(serialized).byteLength <= KNOWLEDGE_READ_RESPONSE_MAX_BYTES
  );
};
const validSearchInput = (v: unknown): v is KnowledgeSearchInput => {
  if (!rec(v)) return false;
  if (!Object.prototype.hasOwnProperty.call(v, "kind"))
    return (
      exact(v, ["query", "offset", "limit"]) &&
      typeof v.query === "string" &&
      v.query.length > 0 &&
      !hasLoneSurrogate(v.query) &&
      new TextEncoder().encode(v.query).byteLength <= 120 &&
      !v.query.includes("\n") &&
      !v.query.includes("\r") &&
      // oxlint-disable-next-line no-control-regex -- preserve the Computer search contract.
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v.query) &&
      boundedInt(v.offset, 0, 1_048_576) &&
      boundedInt(v.limit, 1, 16)
    );
  if (v.kind === "articles") {
    if (
      !exactOptional(v, ["kind", "limit"], ["filters", "cursor"]) ||
      !boundedInt(v.limit, 1, 16) ||
      (Object.prototype.hasOwnProperty.call(v, "cursor") &&
        (typeof v.cursor !== "string" || v.cursor.length === 0))
    )
      return false;
    if (!Object.prototype.hasOwnProperty.call(v, "filters")) return true;
    const filters = v.filters;
    return (
      rec(filters) &&
      exactOptional(filters, [], ["type", "title", "description", "tag"]) &&
      ["type", "title", "description", "tag"].every(
        (key) =>
          !Object.prototype.hasOwnProperty.call(filters, key) || typeof filters[key] === "string",
      )
    );
  }
  return (
    v.kind === "article-links" &&
    exact(v, ["kind", "articleId", "direction", "maxDepth", "candidateBudget"]) &&
    typeof v.articleId === "string" &&
    v.articleId.length > 0 &&
    (v.direction === "links" || v.direction === "backlinks") &&
    boundedInt(v.maxDepth, 0, 4) &&
    boundedInt(v.candidateBudget, 1, 32)
  );
};
const validReadResult = (v: unknown): v is KnowledgeReadResult => {
  if (!rec(v)) return false;
  const navigation =
    exact(v, ["kind", "path", "sourceMarkdown", "goldStatus"]) &&
    v.kind === "navigation" &&
    (v.path === "articles" || v.path === "index.md") &&
    (v.goldStatus === "disabled" || v.goldStatus === "enabled" || v.goldStatus === "paused");
  const canonicalMarkdownPath = isCanonicalMarkdownPath(v.path);
  const computer =
    canonicalMarkdownPath &&
    exact(v, ["bundleId", "versionId", "path", "sourceMarkdown", "metadata"]) &&
    isHexDigest(v.bundleId) &&
    knowledgeUuid(v.versionId);
  const article =
    canonicalMarkdownPath &&
    exact(v, [
      "kind",
      "articleId",
      "revisionId",
      "bodyHash",
      "path",
      "sourceMarkdown",
      "metadata",
    ]) &&
    v.kind === "article" &&
    isNonEmptyBoundedText(v.articleId, KNOWLEDGE_READ_RESPONSE_MAX_BYTES) &&
    isNonEmptyBoundedText(v.revisionId, KNOWLEDGE_READ_RESPONSE_MAX_BYTES) &&
    isHexDigest(v.bodyHash);
  if (
    (!navigation && !computer && !article) ||
    typeof v.sourceMarkdown !== "string" ||
    (!navigation && (!rec(v.metadata) || !isJsonValue(v.metadata)))
  )
    return false;
  const serialized = JSON.stringify(v);
  return (
    typeof serialized === "string" &&
    new TextEncoder().encode(serialized).byteLength <= KNOWLEDGE_READ_RESPONSE_MAX_BYTES
  );
};
const knowledgeUuid = (v: unknown): v is string => typeof v === "string" && KNOWLEDGE_UUID.test(v);
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
  readonly #proposePolicy: KnowledgeSessionPolicyProposal;
  readonly #proposeGoldJobControl: KnowledgeSessionProposal;
  readonly #proposeGoldPageEdit: KnowledgeSessionGoldPageEditProposal;
  readonly #proposeGoldCleanRequest: KnowledgeSessionGoldCleanRequestProposal;
  #disposed = false;

  constructor(
    q: RpcStub<KnowledgeActionQueue>,
    a: KnowledgeAccess,
    propose: KnowledgeSessionProposal,
    proposePolicy: KnowledgeSessionPolicyProposal,
    proposeGoldJobControl: KnowledgeSessionProposal,
    proposeGoldPageEdit: KnowledgeSessionGoldPageEditProposal,
    proposeGoldCleanRequest: KnowledgeSessionGoldCleanRequestProposal,
  ) {
    super();
    this.#q = q;
    this.#a = a;
    this.#propose = propose;
    this.#proposePolicy = proposePolicy;
    this.#proposeGoldJobControl = proposeGoldJobControl;
    this.#proposeGoldPageEdit = proposeGoldPageEdit;
    this.#proposeGoldCleanRequest = proposeGoldCleanRequest;
  }

  async proposeArticle(input: unknown): Promise<
    Readonly<{
      status: "pending_approval";
      operationId: string;
    }>
  > {
    if (this.#disposed) throw err("invalid_input");
    return this.#propose(input);
  }

  async proposeArticlePolicy(input: unknown): Promise<
    Readonly<{
      status: "pending_approval";
      operationId: string;
    }>
  > {
    if (this.#disposed) throw err("invalid_input");
    return this.#proposePolicy(input);
  }

  async proposeGoldJobControl(
    input: unknown,
  ): Promise<Readonly<{ status: "pending_approval"; operationId: string }>> {
    if (this.#disposed) throw err("invalid_input");
    return this.#proposeGoldJobControl(input);
  }

  async proposeGoldPageEdit(
    input: unknown,
  ): Promise<Readonly<{ status: "pending_approval"; operationId: string }>> {
    if (this.#disposed) throw err("invalid_input");
    return this.#proposeGoldPageEdit(input);
  }

  async proposeGoldCleanReplacement(
    input: unknown,
  ): Promise<Readonly<{ status: "pending_approval"; operationId: string }>> {
    if (this.#disposed) throw err("invalid_input");
    return this.#proposeGoldCleanRequest(input);
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
    if (!Number.isSafeInteger(authorizedAt) || authorizedAt < 0 || expiresAt <= authorizedAt)
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
    if (!validSearchInput(input)) throw err("invalid_input");
    return this.#read(
      "Knowledge Base search",
      "Search private Knowledge pages for this Manager.",
      () => this.#a.search(input),
      (value): value is KnowledgeSearchResult => validSearchResult(value, input),
    );
  }

  async read(input: KnowledgeReadInput): Promise<KnowledgeReadResult> {
    if (
      !rec(input) ||
      !exact(input, ["path"]) ||
      (input.path !== "articles" && !isCanonicalMarkdownPath(input.path))
    )
      throw err("invalid_input");
    return this.#read(
      "Knowledge Base read",
      "Read a private Knowledge page for this Manager.",
      () => this.#a.read(input),
      (value): value is KnowledgeReadResult => validReadResult(value) && value.path === input.path,
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
  return (
    rec(value) &&
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
    )
  );
}
function sameBronzeReservation(
  slot: KnowledgeBronzeStageSlot,
  binding: KnowledgeBronzeReservationBinding,
): boolean {
  return (
    slot.workspaceId === binding.workspaceId &&
    slot.gatekeeperInstanceId === binding.gatekeeperInstanceId &&
    slot.localActionId === binding.localActionId &&
    slot.operationId === binding.operationId &&
    slot.operationDeadlineMs === binding.operationDeadlineMs
  );
}
type KnowledgeSafeControlBinding = Omit<KnowledgeSafeControlReservation, "retainedBytesReserved">;
const safeControlTargetKey = (target: KnowledgeSafeControlTarget): string =>
  `${target.kind}:${target.id}`;
function isKnowledgeSafeControlTarget(value: unknown): value is KnowledgeSafeControlTarget {
  return (
    rec(value) &&
    exact(value, ["kind", "id"]) &&
    (value.kind === "article" || value.kind === "gold_job") &&
    isNonEmptyBoundedText(value.id, KNOWLEDGE_SAFE_CONTROL_MAX_BYTES_PER_TARGET)
  );
}
function isKnowledgeSafeControlReservation(
  value: unknown,
): value is KnowledgeSafeControlReservation {
  if (
    !rec(value) ||
    !rec(value.target) ||
    !isKnowledgeSafeControlTarget(value.target) ||
    !isNonEmptyBoundedText(value.workspaceId, 512) ||
    !isNonEmptyBoundedText(value.gatekeeperInstanceId, 512) ||
    !boundedInt(value.localActionId, 0, Number.MAX_SAFE_INTEGER) ||
    typeof value.operationId !== "string" ||
    !UUID.test(value.operationId) ||
    !boundedInt(value.operationDeadlineMs, 0, Number.MAX_SAFE_INTEGER) ||
    !boundedInt(value.retainedBytesReserved, 1, KNOWLEDGE_SAFE_CONTROL_MAX_BYTES_PER_TARGET)
  )
    return false;
  if (value.target.kind === "article") {
    return exact(value, [
      "target",
      "workspaceId",
      "gatekeeperInstanceId",
      "localActionId",
      "operationId",
      "operationDeadlineMs",
      "retainedBytesReserved",
    ]);
  }
  return (
    exact(value, [
      "target",
      "workspaceId",
      "gatekeeperInstanceId",
      "localActionId",
      "operationId",
      "operationDeadlineMs",
      "retainedBytesReserved",
      "expectedJobFence",
      "expectedControlRevision",
    ]) &&
    boundedInt(value.expectedJobFence, 0, Number.MAX_SAFE_INTEGER) &&
    boundedInt(value.expectedControlRevision, 0, Number.MAX_SAFE_INTEGER)
  );
}
function isLegacyKnowledgeSilverSafeControlReservation(
  value: unknown,
): value is LegacyKnowledgeSilverSafeControlReservation {
  return (
    rec(value) &&
    exact(value, [
      "articleId",
      "workspaceId",
      "gatekeeperInstanceId",
      "localActionId",
      "operationId",
      "operationDeadlineMs",
      "retainedBytesReserved",
    ]) &&
    isNonEmptyBoundedText(value.articleId, KNOWLEDGE_SAFE_CONTROL_MAX_BYTES_PER_TARGET) &&
    isNonEmptyBoundedText(value.workspaceId, 512) &&
    isNonEmptyBoundedText(value.gatekeeperInstanceId, 512) &&
    boundedInt(value.localActionId, 0, Number.MAX_SAFE_INTEGER) &&
    typeof value.operationId === "string" &&
    UUID.test(value.operationId) &&
    boundedInt(value.operationDeadlineMs, 0, Number.MAX_SAFE_INTEGER) &&
    boundedInt(value.retainedBytesReserved, 1, KNOWLEDGE_SAFE_CONTROL_MAX_BYTES_PER_TARGET)
  );
}
function normalizeKnowledgeSafeControlReservation(
  value: unknown,
): KnowledgeSafeControlReservation | undefined {
  if (isKnowledgeSafeControlReservation(value)) return value;
  if (!isLegacyKnowledgeSilverSafeControlReservation(value)) return undefined;
  return {
    target: { kind: "article", id: value.articleId },
    workspaceId: value.workspaceId,
    gatekeeperInstanceId: value.gatekeeperInstanceId,
    localActionId: value.localActionId,
    operationId: value.operationId,
    operationDeadlineMs: value.operationDeadlineMs,
    retainedBytesReserved: value.retainedBytesReserved,
  };
}
function readKnowledgeSafeControlReservationList(
  value: unknown,
): readonly KnowledgeSafeControlReservation[] | undefined {
  if (!Array.isArray(value) || value.length > KNOWLEDGE_SAFE_CONTROL_MAX_TARGETS) return undefined;
  const reservations = value.map(normalizeKnowledgeSafeControlReservation);
  if (reservations.some((item) => item === undefined)) return undefined;
  const current = reservations as KnowledgeSafeControlReservation[];
  const keys = current.map((slot) => safeControlTargetKey(slot.target));
  const articleCount = current.filter((slot) => slot.target.kind === "article").length;
  const goldCount = current.length - articleCount;
  if (
    new Set(keys).size !== current.length ||
    articleCount > KNOWLEDGE_SAFE_CONTROL_MAX_ARTICLE_TARGETS ||
    goldCount > KNOWLEDGE_SAFE_CONTROL_MAX_GOLD_TARGETS ||
    current.reduce((sum, slot) => sum + slot.retainedBytesReserved, 0) >
      KNOWLEDGE_SAFE_CONTROL_MAX_TARGETS * KNOWLEDGE_SAFE_CONTROL_MAX_BYTES_PER_TARGET
  )
    return undefined;
  return current;
}
function sameKnowledgeSafeControlBinding(
  slot: KnowledgeSafeControlReservation,
  binding: KnowledgeSafeControlBinding,
): boolean {
  const sameBase =
    slot.target.kind === binding.target.kind &&
    slot.target.id === binding.target.id &&
    slot.workspaceId === binding.workspaceId &&
    slot.gatekeeperInstanceId === binding.gatekeeperInstanceId &&
    slot.localActionId === binding.localActionId &&
    slot.operationId === binding.operationId &&
    slot.operationDeadlineMs === binding.operationDeadlineMs;
  return (
    sameBase &&
    (slot.target.kind === "article" ||
      (slot.expectedJobFence === binding.expectedJobFence &&
        slot.expectedControlRevision === binding.expectedControlRevision))
  );
}

/**
 * Facet class props cannot contain capabilities on the deployed platform.
 * This namespace is Worker-private and never handed to an Agent or HTTP caller.
 */
export class KnowledgeAccountAccess extends DurableObject<Cloudflare.Env> {
  async bind(managerId: string, capability: KnowledgeAccess): Promise<void> {
    if (
      !isManagerId(managerId) ||
      !this.ctx.id.equals(this.ctx.exports.KnowledgeAccountAccess.idFromName(managerId))
    )
      throw new TypeError("Knowledge access store is bound to another Manager.");
    const contract = await validateStub<KnowledgeAccess>(capability).assertBoundTo(managerId);
    if (contract !== KNOWLEDGE_READ_CONTRACT) throw err("incompatible_reader_contract");
    const stored = await this.ctx.storage.get<KnowledgeAccess>("access");
    if (stored !== undefined) {
      const storedContract = await validateStub<InspectableAccess>(stored).assertBoundTo(managerId);
      if (storedContract !== KNOWLEDGE_READ_CONTRACT) throw err("incompatible_reader_contract");
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
      const racedContract =
        await validateStub<InspectableAccess>(racedBinding).assertBoundTo(managerId);
      if (racedContract !== KNOWLEDGE_READ_CONTRACT) throw err("incompatible_reader_contract");
    }
  }

  async getAccess(): Promise<Access> {
    const access = await this.ctx.storage.get<KnowledgeAccess>("access");
    if (!access) throw new Error("Knowledge Account access is not initialized.");
    // Return the native service-binding stub; its validator proxy is local-only and cannot be
    // serialized through the Durable Object RPC boundary.
    return access;
  }

  async bindGoldController(managerId: string, controller: KnowledgeGoldController): Promise<void> {
    this.#assertManager(managerId);
    const contract =
      await validateStub<KnowledgeGoldController>(controller).assertBoundTo(managerId);
    if (contract !== KNOWLEDGE_GOLD_CONTROL_CONTRACT) throw err("incompatible_gold_role_contract");
    const stored = await this.ctx.storage.get<KnowledgeGoldController>("goldController");
    if (stored !== undefined) {
      const storedContract =
        await validateStub<KnowledgeGoldController>(stored).assertBoundTo(managerId);
      if (storedContract !== KNOWLEDGE_GOLD_CONTROL_CONTRACT)
        throw err("incompatible_gold_role_contract");
      return;
    }
    const raced = await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.get<KnowledgeGoldController>("goldController");
      if (current !== undefined) return current;
      await this.ctx.storage.put("goldController", controller);
      return undefined;
    });
    if (raced !== undefined) {
      const racedContract =
        await validateStub<KnowledgeGoldController>(raced).assertBoundTo(managerId);
      if (racedContract !== KNOWLEDGE_GOLD_CONTROL_CONTRACT)
        throw err("incompatible_gold_role_contract");
    }
  }

  async inspectGoldRole(managerId: string): Promise<KnowledgeGoldRoles> {
    this.#assertManager(managerId);
    const controller = await this.ctx.storage.get<KnowledgeGoldController>("goldController");
    if (controller === undefined) return "absent";
    try {
      const contract =
        await validateStub<KnowledgeGoldController>(controller).assertBoundTo(managerId);
      return contract === KNOWLEDGE_GOLD_CONTROL_CONTRACT ? "installed" : "incompatible";
    } catch {
      return "incompatible";
    }
  }

  async getGoldController(managerId: string): Promise<KnowledgeGoldController> {
    this.#assertManager(managerId);
    const controller = await this.ctx.storage.get<KnowledgeGoldController>("goldController");
    if (controller === undefined) throw err("dependency_unavailable");
    try {
      const contract =
        await validateStub<KnowledgeGoldController>(controller).assertBoundTo(managerId);
      if (contract !== KNOWLEDGE_GOLD_CONTROL_CONTRACT) throw err("permission_denied");
    } catch (cause) {
      if (cause instanceof Error && cause.message === "Knowledge Base permission_denied.")
        throw cause;
      throw err("permission_denied", cause);
    }
    return controller;
  }

  async bindGoldPageController(
    managerId: string,
    controller: KnowledgeGoldPageController,
  ): Promise<void> {
    this.#assertManager(managerId);
    const contract =
      await validateStub<KnowledgeGoldPageController>(controller).assertBoundTo(managerId);
    if (contract !== KNOWLEDGE_GOLD_PAGE_CONTROL_CONTRACT)
      throw err("incompatible_gold_page_role_contract");
    const stored = await this.ctx.storage.get<KnowledgeGoldPageController>("goldPageController");
    if (stored !== undefined) {
      const storedContract =
        await validateStub<KnowledgeGoldPageController>(stored).assertBoundTo(managerId);
      if (storedContract !== KNOWLEDGE_GOLD_PAGE_CONTROL_CONTRACT)
        throw err("incompatible_gold_page_role_contract");
      return;
    }
    const raced = await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.get<KnowledgeGoldPageController>("goldPageController");
      if (current !== undefined) return current;
      await this.ctx.storage.put("goldPageController", controller);
      return undefined;
    });
    if (raced !== undefined) {
      const racedContract =
        await validateStub<KnowledgeGoldPageController>(raced).assertBoundTo(managerId);
      if (racedContract !== KNOWLEDGE_GOLD_PAGE_CONTROL_CONTRACT)
        throw err("incompatible_gold_page_role_contract");
    }
  }

  async inspectGoldPageRole(managerId: string): Promise<KnowledgeGoldRoles> {
    this.#assertManager(managerId);
    const controller =
      await this.ctx.storage.get<KnowledgeGoldPageController>("goldPageController");
    if (controller === undefined) return "absent";
    try {
      const contract =
        await validateStub<KnowledgeGoldPageController>(controller).assertBoundTo(managerId);
      return contract === KNOWLEDGE_GOLD_PAGE_CONTROL_CONTRACT ? "installed" : "incompatible";
    } catch {
      return "incompatible";
    }
  }

  async getGoldPageController(managerId: string): Promise<KnowledgeGoldPageController> {
    this.#assertManager(managerId);
    const controller =
      await this.ctx.storage.get<KnowledgeGoldPageController>("goldPageController");
    if (controller === undefined) throw err("dependency_unavailable");
    try {
      const contract =
        await validateStub<KnowledgeGoldPageController>(controller).assertBoundTo(managerId);
      if (contract !== KNOWLEDGE_GOLD_PAGE_CONTROL_CONTRACT) throw err("permission_denied");
    } catch (cause) {
      if (cause instanceof Error && cause.message === "Knowledge Base permission_denied.")
        throw cause;
      throw err("permission_denied", cause);
    }
    return controller;
  }

  async bindBronzeRoles(
    managerId: string,
    writer: KnowledgeBronzeWrite,
    sourceReader: KnowledgeSourceReader,
  ): Promise<void> {
    if (
      !isManagerId(managerId) ||
      !this.ctx.id.equals(this.ctx.exports.KnowledgeAccountAccess.idFromName(managerId))
    )
      throw new TypeError("Knowledge Bronze role store is bound to another Manager.");

    const writerContract =
      await validateStub<KnowledgeBronzeWrite>(writer).assertBoundTo(managerId);
    const sourceContract =
      await validateStub<KnowledgeSourceReader>(sourceReader).assertBoundTo(managerId);
    if (
      writerContract !== KNOWLEDGE_BRONZE_WRITE_CONTRACT ||
      sourceContract !== KNOWLEDGE_SOURCE_READ_CONTRACT
    )
      throw err("incompatible_bronze_role_contract");

    const currentWriter = await this.ctx.storage.get<KnowledgeBronzeWrite>("bronzeWriter");
    const currentSourceReader = await this.ctx.storage.get<KnowledgeSourceReader>("sourceReader");
    if (currentWriter !== undefined) {
      const currentContract =
        await validateStub<KnowledgeBronzeWrite>(currentWriter).assertBoundTo(managerId);
      if (currentContract !== KNOWLEDGE_BRONZE_WRITE_CONTRACT)
        throw err("incompatible_bronze_role_contract");
    }
    if (currentSourceReader !== undefined) {
      const currentContract =
        await validateStub<KnowledgeSourceReader>(currentSourceReader).assertBoundTo(managerId);
      if (currentContract !== KNOWLEDGE_SOURCE_READ_CONTRACT)
        throw err("incompatible_bronze_role_contract");
    }

    const raced = await this.ctx.blockConcurrencyWhile(async () => {
      const writerAtCommit = await this.ctx.storage.get<KnowledgeBronzeWrite>("bronzeWriter");
      const sourceReaderAtCommit =
        await this.ctx.storage.get<KnowledgeSourceReader>("sourceReader");
      // A single bounded account slot owns each role. Existing valid stubs are retained so a
      // repeated ensure does not replace a live capability underneath a session.
      if (writerAtCommit === undefined) await this.ctx.storage.put("bronzeWriter", writer);
      if (sourceReaderAtCommit === undefined)
        await this.ctx.storage.put("sourceReader", sourceReader);
      return {
        writer: writerAtCommit,
        sourceReader: sourceReaderAtCommit,
      };
    });
    // Another bind may have filled a missing slot while the candidate stubs were being checked.
    // Revalidate those winning immutable values after leaving the local gate.
    if (raced.writer !== undefined) {
      const currentContract = await validateStub<KnowledgeBronzeWrite>(raced.writer).assertBoundTo(
        managerId,
      );
      if (currentContract !== KNOWLEDGE_BRONZE_WRITE_CONTRACT)
        throw err("incompatible_bronze_role_contract");
    }
    if (raced.sourceReader !== undefined) {
      const currentContract = await validateStub<KnowledgeSourceReader>(
        raced.sourceReader,
      ).assertBoundTo(managerId);
      if (currentContract !== KNOWLEDGE_SOURCE_READ_CONTRACT)
        throw err("incompatible_bronze_role_contract");
    }
  }

  async inspectBronzeRoles(managerId: string): Promise<KnowledgeBronzeRoles> {
    if (
      !isManagerId(managerId) ||
      !this.ctx.id.equals(this.ctx.exports.KnowledgeAccountAccess.idFromName(managerId))
    )
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
    if (
      !isManagerId(managerId) ||
      !this.ctx.id.equals(this.ctx.exports.KnowledgeAccountAccess.idFromName(managerId))
    )
      throw new TypeError("Knowledge Bronze role store is bound to another Manager.");
    const writer = await this.ctx.storage.get<KnowledgeBronzeWrite>("bronzeWriter");
    const sourceReader = await this.ctx.storage.get<KnowledgeSourceReader>("sourceReader");
    if (writer === undefined || sourceReader === undefined) throw err("dependency_unavailable");
    let writerContract: string;
    let sourceContract: string;
    try {
      [writerContract, sourceContract] = await Promise.all([
        validateStub<KnowledgeBronzeWrite>(writer).assertBoundTo(managerId),
        validateStub<KnowledgeSourceReader>(sourceReader).assertBoundTo(managerId),
      ]);
    } catch (cause) {
      throw err("permission_denied", cause);
    }
    if (
      writerContract !== KNOWLEDGE_BRONZE_WRITE_CONTRACT ||
      sourceContract !== KNOWLEDGE_SOURCE_READ_CONTRACT
    )
      throw err("permission_denied");
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
    )
      return undefined;
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
      !boundedInt(
        reservation.retainedBytesReserved,
        1,
        KNOWLEDGE_BRONZE_MAX_ACTION_BYTES + KNOWLEDGE_BRONZE_MAX_METADATA_BYTES,
      )
    )
      throw err("invalid_input");

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
    reservation: Omit<
      KnowledgeBronzeStageSlot,
      "status" | "operationDeadlineMs" | "retainedBytesReserved"
    >,
    operationDeadlineMs: number,
  ): Promise<void> {
    this.#assertManager(managerId);
    if (!boundedInt(operationDeadlineMs, 1, Number.MAX_SAFE_INTEGER)) throw err("invalid_input");
    const gateError = await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.get<unknown>("bronzeActionReservation");
      if (
        !isKnowledgeBronzeStageSlot(current) ||
        current.workspaceId !== reservation.workspaceId ||
        current.gatekeeperInstanceId !== reservation.gatekeeperInstanceId ||
        current.localActionId !== reservation.localActionId ||
        current.operationId !== reservation.operationId ||
        current.status !== "active"
      )
        return err("result_unknown");
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

  async findKnowledgeSafeControlReservation(
    managerId: string,
    target: KnowledgeSafeControlTarget,
  ): Promise<KnowledgeSafeControlReservation | undefined> {
    this.#assertManager(managerId);
    if (!isKnowledgeSafeControlTarget(target)) throw err("invalid_input");
    const stored = await this.ctx.storage.get<unknown>("silverSafeControlReservations");
    if (stored === undefined) return undefined;
    const current = readKnowledgeSafeControlReservationList(stored);
    if (current === undefined) throw err("corrupt_state");
    return current.find(
      (slot) => safeControlTargetKey(slot.target) === safeControlTargetKey(target),
    );
  }

  async reserveKnowledgeSafeControl(
    managerId: string,
    reservation: KnowledgeSafeControlReservation,
  ): Promise<void> {
    this.#assertManager(managerId);
    if (!isKnowledgeSafeControlReservation(reservation)) throw err("invalid_input");
    const gateError = await this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<unknown>("silverSafeControlReservations");
      const current = stored === undefined ? [] : readKnowledgeSafeControlReservationList(stored);
      if (current === undefined) return err("corrupt_state");
      const targetReservation = current.find(
        (slot) => safeControlTargetKey(slot.target) === safeControlTargetKey(reservation.target),
      );
      if (targetReservation !== undefined) {
        if (
          sameKnowledgeSafeControlBinding(targetReservation, reservation) &&
          targetReservation.retainedBytesReserved === reservation.retainedBytesReserved
        )
          return undefined;
        return err("capacity_exceeded");
      }
      const articleCount = current.filter((slot) => slot.target.kind === "article").length;
      const goldCount = current.length - articleCount;
      if (
        current.length >= KNOWLEDGE_SAFE_CONTROL_MAX_TARGETS ||
        (reservation.target.kind === "article" &&
          articleCount >= KNOWLEDGE_SAFE_CONTROL_MAX_ARTICLE_TARGETS) ||
        (reservation.target.kind === "gold_job" &&
          goldCount >= KNOWLEDGE_SAFE_CONTROL_MAX_GOLD_TARGETS)
      )
        return err("capacity_exceeded");
      const totalBytes = current.reduce((sum, slot) => sum + slot.retainedBytesReserved, 0);
      if (
        totalBytes + reservation.retainedBytesReserved >
        KNOWLEDGE_SAFE_CONTROL_MAX_TARGETS * KNOWLEDGE_SAFE_CONTROL_MAX_BYTES_PER_TARGET
      )
        return err("capacity_exceeded");
      await this.ctx.storage.put("silverSafeControlReservations", [...current, reservation]);
      return undefined;
    });
    if (gateError !== undefined) throw gateError;
  }

  async activateKnowledgeSafeControl(
    managerId: string,
    reservation: Omit<KnowledgeSafeControlBinding, "operationDeadlineMs">,
    operationDeadlineMs: number,
  ): Promise<void> {
    this.#assertManager(managerId);
    if (!boundedInt(operationDeadlineMs, 1, Number.MAX_SAFE_INTEGER)) throw err("invalid_input");
    const gateError = await this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<unknown>("silverSafeControlReservations");
      const current =
        stored === undefined ? undefined : readKnowledgeSafeControlReservationList(stored);
      if (current === undefined)
        return err(stored === undefined ? "result_unknown" : "corrupt_state");
      const index = current.findIndex(
        (slot) =>
          slot.target.kind === reservation.target.kind &&
          slot.target.id === reservation.target.id &&
          slot.workspaceId === reservation.workspaceId &&
          slot.gatekeeperInstanceId === reservation.gatekeeperInstanceId &&
          slot.localActionId === reservation.localActionId &&
          slot.operationId === reservation.operationId &&
          (slot.target.kind === "article" ||
            (slot.expectedJobFence === reservation.expectedJobFence &&
              slot.expectedControlRevision === reservation.expectedControlRevision)),
      );
      if (index < 0) return err("result_unknown");
      const slot = current[index]!;
      if (slot.operationDeadlineMs === operationDeadlineMs) return undefined;
      if (slot.operationDeadlineMs !== 0) return err("integrity_failure");
      const next = [...current];
      next[index] = { ...slot, operationDeadlineMs };
      await this.ctx.storage.put("silverSafeControlReservations", next);
      return undefined;
    });
    if (gateError !== undefined) throw gateError;
  }

  async clearKnowledgeSafeControl(
    managerId: string,
    reservation: KnowledgeSafeControlBinding,
  ): Promise<void> {
    this.#assertManager(managerId);
    const gateError = await this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<unknown>("silverSafeControlReservations");
      if (stored === undefined) return undefined;
      const current = readKnowledgeSafeControlReservationList(stored);
      if (current === undefined) return err("corrupt_state");
      const targetReservation = current.find(
        (slot) => safeControlTargetKey(slot.target) === safeControlTargetKey(reservation.target),
      );
      if (
        targetReservation === undefined ||
        !sameKnowledgeSafeControlBinding(targetReservation, reservation)
      )
        return undefined;
      await this.ctx.storage.put(
        "silverSafeControlReservations",
        current.filter((slot) => slot !== targetReservation),
      );
      return undefined;
    });
    if (gateError !== undefined) throw gateError;
  }

  #assertManager(managerId: string): void {
    if (
      !isManagerId(managerId) ||
      !this.ctx.id.equals(this.ctx.exports.KnowledgeAccountAccess.idFromName(managerId))
    )
      throw new TypeError("Knowledge Bronze role store is bound to another Manager.");
  }

  async #inspectRole(
    capability: KnowledgeBronzeWrite | KnowledgeSourceReader | undefined,
    managerId: string,
    role: "writer" | "sourceReader",
  ): Promise<KnowledgeBronzeRoles["writer"]> {
    if (capability === undefined) return "absent";
    const contract =
      role === "writer"
        ? await validateStub<KnowledgeBronzeWrite>(
            capability as KnowledgeBronzeWrite,
          ).assertBoundTo(managerId)
        : await validateStub<KnowledgeSourceReader>(
            capability as KnowledgeSourceReader,
          ).assertBoundTo(managerId);
    const expected =
      role === "writer" ? KNOWLEDGE_BRONZE_WRITE_CONTRACT : KNOWLEDGE_SOURCE_READ_CONTRACT;
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
        .exec<{
          local_action_id: number;
          workspace_id: string | null;
          operation_deadline_ms: number | null;
          command_json: string;
        }>(
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
  #accountAccess(): DurableObjectStub<KnowledgeAccountAccess> {
    const p = validateProps(this.ctx.props);
    return this.ctx.exports.KnowledgeAccountAccess.getByName(p.managerId);
  }

  #nextActionId(): number {
    const rows = this.ctx.storage.sql
      .exec<{ next_id: number }>(
        "SELECT next_id FROM custom_gatekeeper_action_sequence WHERE id = 1",
      )
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
    if (
      !isNonEmptyBoundedText(workspaceId, 512) ||
      !isNonEmptyBoundedText(gatekeeperInstanceId, 512)
    )
      throw err("permission_denied");

    const capabilities = await account.getBronzeCapabilities(managerId);
    const rawSource = await capabilities.sourceReader.verifySource({
      workspaceId,
      selector: article.sourceSelector,
    });
    const verified = decodeVerifiedSource(rawSource, article.sourceSelector);
    const candidate = await validateKnowledgeCandidate(capabilities.writer, article.body);
    const provenance = { ...verified, ...articleClaims(article) };
    const namespace: KnowledgeBronzeNamespace = {
      workspaceId,
      gatekeeperInstanceId,
      localActionId: this.#nextActionId(),
    };
    const operationId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const intent =
      article.kind === "adopt"
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
      profileId: candidate.profileId,
    });
    const command = {
      kind: "staged" as const,
      namespace,
      operationId,
      attemptFencingToken: 1,
      operationDeadlineMs,
      fullIntentHash,
      profileId: candidate.profileId,
      bodyHash: candidate.bodyHash,
      intent,
    };
    const description: ActionDescription = {
      title:
        article.kind === "adopt" ? "Propose a Knowledge article" : "Revise a Knowledge article",
      description:
        "The exact Markdown body and its owner-verified source metadata are shown below. Approval saves this article to the Manager's Knowledge Base.",
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
    if (
      new TextEncoder().encode(JSON.stringify(description)).byteLength >
      KNOWLEDGE_BRONZE_MAX_ACTION_BYTES
    )
      throw err("capacity_exceeded");

    const metadataForReservation =
      article.kind === "adopt"
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
            profileId: candidate.profileId,
            bodyHash: candidate.bodyHash,
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
            profileId: candidate.profileId,
            bodyHash: candidate.bodyHash,
            namespace,
          };
    const stageMetadataBytes = new TextEncoder().encode(
      JSON.stringify(metadataForReservation),
    ).byteLength;
    const retainedBytesReserved = bodyBytes.byteLength + stageMetadataBytes;
    if (stageMetadataBytes > KNOWLEDGE_BRONZE_MAX_STAGE_METADATA_BYTES)
      throw err("capacity_exceeded");
    if (
      retainedBytesReserved >
      KNOWLEDGE_BRONZE_MAX_ACTION_BYTES + KNOWLEDGE_BRONZE_MAX_METADATA_BYTES
    )
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
  async #proposeArticlePolicy(
    queue: RpcStub<KnowledgeActionQueue>,
    account: DurableObjectStub<KnowledgeAccountAccess>,
    managerId: string,
    input: unknown,
  ): Promise<Readonly<{ status: "pending_approval"; operationId: string }>> {
    const intent = decodeKnowledgeSilverPolicyProposal(input);
    const workspaceId = await queue.getWorkspaceId();
    const gatekeeperInstanceId = this.ctx.id.toString();
    if (
      !isNonEmptyBoundedText(workspaceId, 512) ||
      !isNonEmptyBoundedText(gatekeeperInstanceId, 512)
    )
      throw err("permission_denied");

    // Policy changes use the same installed Bronze writer/source-reader pair and native
    // owner Action boundary. Knowledge decides gate state, target existence and metadata CAS
    // only when the owner dispatches this exact staged command.
    await account.getBronzeCapabilities(managerId);
    const namespace: KnowledgeBronzeNamespace = {
      workspaceId,
      gatekeeperInstanceId,
      localActionId: this.#nextActionId(),
    };
    const operationId = crypto.randomUUID();
    const command: KnowledgeSilverPolicyCommand = {
      kind: "silver_policy",
      namespace,
      operationId,
      operationDeadlineMs: 0,
      intent,
    };
    const description: ActionDescription = {
      title: "Change Knowledge article policy",
      description:
        "The exact article policy update is shown below. Approval applies it to the Manager's Knowledge Base.",
      fields: [
        {
          label: "Article policy update",
          kind: "json",
          value: JSON.stringify(intent),
        },
      ],
      descriptionIsComplete: true,
      autoApprovable: false,
      awaitDecision: true,
      implementsRevert: false,
    };
    const retainedBytesReserved =
      new TextEncoder().encode(JSON.stringify(command)).byteLength +
      new TextEncoder().encode(JSON.stringify(description)).byteLength;
    if (retainedBytesReserved > KNOWLEDGE_SAFE_CONTROL_MAX_BYTES_PER_TARGET)
      throw err("capacity_exceeded");

    const payloadHash = await computeSilverPolicyPayloadHash(command);
    const reservation: KnowledgeSafeControlReservation = {
      target: { kind: "article", id: intent.articleId },
      ...namespace,
      operationId,
      operationDeadlineMs: 0,
      retainedBytesReserved,
    };
    if (intent.usePolicy === "excluded") {
      await account.reserveKnowledgeSafeControl(managerId, reservation);
    } else {
      await account.reserveBronzeAction(managerId, {
        ...namespace,
        operationId,
        operationDeadlineMs: 0,
        retainedBytesReserved,
      });
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO custom_gatekeeper_article_actions
       (local_action_id, operation_id, action_ref, kind, workspace_id, operation_deadline_ms, command_json, payload_hash, status, outcome_json)
       VALUES (?, ?, ?, 'silver_policy', ?, 0, ?, ?, 'pending_approval', NULL)`,
      namespace.localActionId,
      operationId,
      `knowledge-silver-policy:${operationId}`,
      workspaceId,
      JSON.stringify(command),
      payloadHash,
    );
    await queue.submitAction(namespace.localActionId, description);
    return { status: "pending_approval", operationId };
  }
  async #proposeGoldJobControl(
    queue: RpcStub<KnowledgeActionQueue>,
    account: DurableObjectStub<KnowledgeAccountAccess>,
    managerId: string,
    input: unknown,
  ): Promise<Readonly<{ status: "pending_approval"; operationId: string }>> {
    if (!rec(input) || !exact(input, ["intent"])) throw err("invalid_input");
    const intent = decodeKnowledgeGoldControlIntent(input.intent);
    const workspaceId = await queue.getWorkspaceId();
    const gatekeeperInstanceId = this.ctx.id.toString();
    if (
      !isNonEmptyBoundedText(workspaceId, 512) ||
      !isNonEmptyBoundedText(gatekeeperInstanceId, 512)
    )
      throw err("permission_denied");

    const controller = await account.getGoldController(managerId);
    const target = { kind: "gold_job", id: intent.jobId } as const;
    const initialInspection = parseKnowledgeEnvelope(await controller.inspect());
    if (!initialInspection.ok) throw err(initialInspection.code);
    const initialHead = readKnowledgeGoldControlHead(initialInspection.value);
    if (
      initialHead.job === null ||
      initialHead.job.jobId !== intent.jobId ||
      initialHead.job.state !== intent.expectedJobState ||
      initialHead.job.fence !== intent.expectedJobFence ||
      initialHead.controlRevision !== intent.expectedControlRevision
    )
      throw err("conflict");
    const recovery = intent.system1Recovery !== undefined;
    const supportedTransition = recovery
      ? intent.operation === "resume" &&
        initialHead.mode === "enabled" &&
        (initialHead.job.state === "published" || initialHead.job.state === "partial")
      : (intent.operation === "stop" &&
          initialHead.mode === "enabled" &&
          [
            "clean",
            "dirty",
            "running",
            "candidate",
            "partial",
            "published",
            "retry_wait",
            "budget_wait",
            "needs_reconciliation",
          ].includes(initialHead.job.state)) ||
        (intent.operation === "resume" &&
          initialHead.mode === "paused" &&
          (initialHead.job.state === "paused_user" ||
            initialHead.job.state === "paused_deterministic"));
    if (!supportedTransition) throw err("conflict");
    const previous = recovery
      ? undefined
      : await account.findKnowledgeSafeControlReservation(managerId, target);
    const namespace: KnowledgeBronzeNamespace = {
      workspaceId,
      gatekeeperInstanceId,
      localActionId: this.#nextActionId(),
    };
    const operationId = crypto.randomUUID();
    const system1RecoveryNextRequestId = recovery ? crypto.randomUUID().toLowerCase() : undefined;
    const command: KnowledgeGoldJobControlCommand = {
      kind: "gold_job_control",
      namespace,
      operationId,
      operationDeadlineMs: 0,
      intent,
      ...(system1RecoveryNextRequestId === undefined ? {} : { system1RecoveryNextRequestId }),
    };
    const description: ActionDescription = {
      title: recovery
        ? "Retry a Knowledge System 1 decision"
        : intent.operation === "stop"
          ? "Stop Knowledge Gold job"
          : "Resume Knowledge Gold job",
      description: recovery
        ? "The original System 1 request may already have executed. Approval starts another attempt and may cause a double charge or effect; additional spend is capped at 5,000 micro-USD."
        : "The exact Gold job control request is shown below. Approval applies it to the Manager's Knowledge Base.",
      fields: [{ label: "Gold job control", kind: "json", value: JSON.stringify(intent) }],
      descriptionIsComplete: true,
      autoApprovable: false,
      awaitDecision: true,
      implementsRevert: false,
    };
    const retainedBytesReserved =
      new TextEncoder().encode(JSON.stringify(command)).byteLength +
      new TextEncoder().encode(JSON.stringify(description)).byteLength;
    if (
      retainedBytesReserved >
      (recovery
        ? KNOWLEDGE_BRONZE_MAX_ACTION_BYTES + KNOWLEDGE_BRONZE_MAX_METADATA_BYTES
        : KNOWLEDGE_SAFE_CONTROL_MAX_BYTES_PER_TARGET)
    )
      throw err("capacity_exceeded");
    const payloadHash = await computeGoldJobControlPayloadHash(managerId, command);
    const reservation: KnowledgeSafeControlReservation | undefined = recovery
      ? undefined
      : {
          target,
          ...namespace,
          operationId,
          operationDeadlineMs: 0,
          retainedBytesReserved,
          expectedJobFence: intent.expectedJobFence,
          expectedControlRevision: intent.expectedControlRevision,
        };
    if (!recovery && previous !== undefined) {
      if (
        previous.target.kind !== "gold_job" ||
        previous.expectedJobFence === undefined ||
        previous.expectedControlRevision === undefined
      )
        throw err("corrupt_state");
      if (
        initialHead.job.jobId === intent.jobId &&
        initialHead.controlRevision > previous.expectedControlRevision &&
        initialHead.job.fence > previous.expectedJobFence
      ) {
        const { retainedBytesReserved: _retainedBytes, ...oldBinding } = previous;
        await account.clearKnowledgeSafeControl(managerId, oldBinding);
      }
    }
    if (recovery) {
      await account.reserveBronzeAction(managerId, {
        ...namespace,
        operationId,
        operationDeadlineMs: 0,
        retainedBytesReserved,
      });
    } else if (reservation !== undefined) {
      await account.reserveKnowledgeSafeControl(managerId, reservation);
    }
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO custom_gatekeeper_article_actions
         (local_action_id, operation_id, action_ref, kind, workspace_id, operation_deadline_ms, command_json, payload_hash, status, outcome_json)
         VALUES (?, ?, ?, 'gold_job_control', ?, 0, ?, ?, 'pending_approval', NULL)`,
        namespace.localActionId,
        operationId,
        `knowledge-gold-job-control:${operationId}`,
        workspaceId,
        JSON.stringify(command),
        payloadHash,
      );
    } catch (insertCause) {
      let localActionExists: boolean;
      try {
        localActionExists =
          this.ctx.storage.sql
            .exec(
              `SELECT 1 AS present FROM custom_gatekeeper_article_actions WHERE local_action_id = ?`,
              namespace.localActionId,
            )
            .toArray().length > 0;
      } catch (readbackCause) {
        // oxlint cannot see ErrorOptions on AggregateError; the primary cause is attached below.
        // oxlint-disable-next-line eslint/preserve-caught-error -- AggregateError options preserve insertCause.
        throw new AggregateError(
          [insertCause, readbackCause],
          "Knowledge Gold action insert result could not be determined.",
          { cause: insertCause },
        );
      }
      if (!localActionExists) {
        try {
          if (recovery) {
            await account.clearBronzeAction(managerId, {
              ...namespace,
              operationId,
              operationDeadlineMs: 0,
            });
          } else if (reservation !== undefined) {
            await account.clearKnowledgeSafeControl(managerId, reservation);
          }
        } catch (clearCause) {
          // oxlint cannot see ErrorOptions on AggregateError; the primary cause is attached below.
          // oxlint-disable-next-line eslint/preserve-caught-error -- AggregateError options preserve insertCause.
          throw new AggregateError(
            [insertCause, clearCause],
            "Knowledge Gold action insert failed and its exact safe-control reservation could not be cleared.",
            { cause: insertCause },
          );
        }
      }
      throw insertCause;
    }
    try {
      await queue.submitAction(namespace.localActionId, description);
    } catch (cause) {
      // The workspace may have persisted the Action before its RPC acknowledgement was lost.
      // Keep the exact staged row and reservation for native approval/retry; never blind-resubmit.
      throw err("result_unknown", cause);
    }
    return { status: "pending_approval", operationId };
  }
  async #proposeGoldPageEdit(
    queue: RpcStub<KnowledgeActionQueue>,
    account: DurableObjectStub<KnowledgeAccountAccess>,
    managerId: string,
    input: unknown,
  ): Promise<Readonly<{ status: "pending_approval"; operationId: string }>> {
    return this.#proposeGoldPageAction(queue, account, managerId, {
      kind: "gold_page_edit",
      intent: decodeGoldPageEditProposal(input),
    });
  }
  async #proposeGoldCleanReplacement(
    queue: RpcStub<KnowledgeActionQueue>,
    account: DurableObjectStub<KnowledgeAccountAccess>,
    managerId: string,
    input: unknown,
  ): Promise<Readonly<{ status: "pending_approval"; operationId: string }>> {
    return this.#proposeGoldPageAction(queue, account, managerId, {
      kind: "gold_page_clean_request",
      intent: decodeGoldPageCleanReplacementProposal(input),
    });
  }
  async #proposeGoldPageAction(
    queue: RpcStub<KnowledgeActionQueue>,
    account: DurableObjectStub<KnowledgeAccountAccess>,
    managerId: string,
    proposal:
      | Readonly<{ kind: "gold_page_edit"; intent: KnowledgeGoldPageEditIntent }>
      | Readonly<{ kind: "gold_page_clean_request"; intent: KnowledgeGoldPageActionIntent }>,
  ): Promise<Readonly<{ status: "pending_approval"; operationId: string }>> {
    const workspaceId = await queue.getWorkspaceId();
    const gatekeeperInstanceId = this.ctx.id.toString();
    if (
      !isNonEmptyBoundedText(workspaceId, 512) ||
      !isNonEmptyBoundedText(gatekeeperInstanceId, 512)
    )
      throw err("permission_denied");

    const controller = await account.getGoldPageController(managerId);
    const initialInspection = parseKnowledgeEnvelope(
      await controller.inspectPage({ path: proposal.intent.path }),
    );
    if (!initialInspection.ok) throw err(initialInspection.code);
    if (
      !rec(initialInspection.value) ||
      !isNonEmptyBoundedText(initialInspection.value.pageId, 512) ||
      !isCanonicalGoldPagePath(initialInspection.value.path) ||
      !boundedInt(initialInspection.value.pageVersion, 0, Number.MAX_SAFE_INTEGER) ||
      !boundedInt(initialInspection.value.protectionVersion, 0, Number.MAX_SAFE_INTEGER)
    )
      throw err("integrity_failure");
    if (
      initialInspection.value.pageId !== proposal.intent.pageId ||
      initialInspection.value.path !== proposal.intent.path ||
      initialInspection.value.pageVersion !== proposal.intent.expectedPageVersion ||
      initialInspection.value.protectionVersion !== proposal.intent.expectedProtectionVersion
    )
      throw err("conflict");

    const namespace: KnowledgeBronzeNamespace = {
      workspaceId,
      gatekeeperInstanceId,
      localActionId: this.#nextActionId(),
    };
    const operationId = crypto.randomUUID();
    const admissionDeadlineMs = Date.now() + KNOWLEDGE_BRONZE_ADMISSION_WINDOW_MS;
    if (!Number.isSafeInteger(admissionDeadlineMs) || admissionDeadlineMs < 1)
      throw err("invalid_input");
    const command: KnowledgeGoldPageActionCommand =
      proposal.kind === "gold_page_edit"
        ? {
            kind: proposal.kind,
            namespace,
            operationId,
            operationDeadlineMs: admissionDeadlineMs,
            intent: proposal.intent,
          }
        : {
            kind: proposal.kind,
            namespace,
            operationId,
            operationDeadlineMs: admissionDeadlineMs,
            intent: proposal.intent,
          };
    const admission = parseKnowledgeEnvelope(await controller.admitPageAction(command));
    if (!admission.ok) throw err(admission.code);
    if (
      !rec(admission.value) ||
      !exact(admission.value, ["status", "pageId"]) ||
      admission.value.status !== "admitted" ||
      admission.value.pageId !== command.intent.pageId
    )
      throw err("integrity_failure");

    // Like other owner-reviewed Actions, the finite execution window starts when approval is
    // first dispatched. Admission uses a short-lived command only to register its baseline.
    const stagedCommand: KnowledgeGoldPageActionCommand = {
      ...command,
      operationDeadlineMs: 0,
    };

    const description: ActionDescription = {
      title:
        proposal.kind === "gold_page_edit"
          ? "Edit a Knowledge Gold page"
          : "Request clean replacement of a Knowledge Gold page",
      description:
        proposal.kind === "gold_page_edit"
          ? "The exact page edit is shown below. Approval applies it to the Manager's Knowledge Base."
          : "The exact clean replacement request is shown below. Approval records the request for the Manager's Knowledge Base; it does not include replacement body text.",
      fields: [
        {
          label:
            proposal.kind === "gold_page_edit" ? "Gold page edit" : "Gold page clean replacement",
          kind: "json",
          value: JSON.stringify(proposal.intent),
        },
      ],
      descriptionIsComplete: true,
      autoApprovable: false,
      awaitDecision: true,
      implementsRevert: false,
    };
    const descriptionBytes = new TextEncoder().encode(JSON.stringify(description)).byteLength;
    if (descriptionBytes > KNOWLEDGE_BRONZE_MAX_ACTION_BYTES) throw err("capacity_exceeded");
    const stageMetadata = {
      kind: proposal.kind,
      namespace,
      operationId,
      operationDeadlineMs: stagedCommand.operationDeadlineMs,
      intent: {
        ...proposal.intent,
        ...(proposal.kind === "gold_page_edit" ? { content: undefined } : {}),
      },
    };
    const stageMetadataBytes = new TextEncoder().encode(JSON.stringify(stageMetadata)).byteLength;
    const bodyBytes =
      proposal.kind === "gold_page_edit"
        ? new TextEncoder().encode(proposal.intent.content).byteLength
        : 0;
    const retainedBytesReserved = bodyBytes + stageMetadataBytes;
    if (stageMetadataBytes > KNOWLEDGE_BRONZE_MAX_STAGE_METADATA_BYTES)
      throw err("capacity_exceeded");
    if (
      retainedBytesReserved >
      KNOWLEDGE_BRONZE_MAX_ACTION_BYTES + KNOWLEDGE_BRONZE_MAX_METADATA_BYTES
    )
      throw err("capacity_exceeded");

    const reservation = {
      ...namespace,
      operationId,
      operationDeadlineMs: stagedCommand.operationDeadlineMs,
    };
    await account.reserveBronzeAction(managerId, { ...reservation, retainedBytesReserved });
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO custom_gatekeeper_article_actions
         (local_action_id, operation_id, action_ref, kind, workspace_id, operation_deadline_ms, command_json, payload_hash, status, outcome_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', NULL)`,
        namespace.localActionId,
        operationId,
        `knowledge-gold-page:${operationId}`,
        command.kind,
        workspaceId,
        stagedCommand.operationDeadlineMs,
        JSON.stringify(stagedCommand),
        await computeGoldPageActionPayloadHash(managerId, stagedCommand),
      );
    } catch (insertCause) {
      let localActionExists: boolean;
      try {
        localActionExists =
          this.ctx.storage.sql
            .exec(
              "SELECT 1 AS present FROM custom_gatekeeper_article_actions WHERE local_action_id = ?",
              namespace.localActionId,
            )
            .toArray().length > 0;
      } catch (readbackCause) {
        // oxlint cannot see ErrorOptions on AggregateError; the primary cause is attached below.
        // oxlint-disable-next-line eslint/preserve-caught-error -- AggregateError options preserve insertCause.
        throw new AggregateError(
          [insertCause, readbackCause],
          "Knowledge Gold page Action insert result could not be determined.",
          { cause: insertCause },
        );
      }
      if (!localActionExists) {
        try {
          await account.clearBronzeAction(managerId, reservation);
        } catch (clearCause) {
          // oxlint cannot see ErrorOptions on AggregateError; the primary cause is attached below.
          // oxlint-disable-next-line eslint/preserve-caught-error -- AggregateError options preserve insertCause.
          throw new AggregateError(
            [insertCause, clearCause],
            "Knowledge Gold page Action insert failed and its exact reservation could not be cleared.",
            { cause: insertCause },
          );
        }
      }
      throw insertCause;
    }
    try {
      await queue.submitAction(namespace.localActionId, description);
    } catch (cause) {
      throw err("result_unknown", cause);
    }
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
        (input) => this.#proposeArticlePolicy(queue, account, managerId, input),
        (input) => this.#proposeGoldJobControl(queue, account, managerId, input),
        (input) => this.#proposeGoldPageEdit(queue, account, managerId, input),
        (input) => this.#proposeGoldCleanReplacement(queue, account, managerId, input),
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
      if (this.#bronzeApplies.get(actionId) === applying) this.#bronzeApplies.delete(actionId);
    }
  }

  async #activateSilverPolicyReservation(
    account: DurableObjectStub<KnowledgeAccountAccess>,
    managerId: string,
    command: KnowledgeSilverPolicyCommand,
  ): Promise<void> {
    if (command.intent.usePolicy === "excluded") {
      await account.activateKnowledgeSafeControl(
        managerId,
        {
          target: { kind: "article", id: command.intent.articleId },
          ...command.namespace,
          operationId: command.operationId,
        },
        command.operationDeadlineMs,
      );
      return;
    }
    await account.activateBronzeAction(
      managerId,
      {
        ...command.namespace,
        operationId: command.operationId,
      },
      command.operationDeadlineMs,
    );
  }

  async #clearSilverPolicyReservation(
    account: DurableObjectStub<KnowledgeAccountAccess>,
    managerId: string,
    command: KnowledgeSilverPolicyCommand,
  ): Promise<void> {
    if (command.intent.usePolicy === "excluded") {
      await account.clearKnowledgeSafeControl(managerId, {
        target: { kind: "article", id: command.intent.articleId },
        ...command.namespace,
        operationId: command.operationId,
        operationDeadlineMs: command.operationDeadlineMs,
      });
      return;
    }
    await account.clearBronzeAction(managerId, {
      ...command.namespace,
      operationId: command.operationId,
      operationDeadlineMs: command.operationDeadlineMs,
    });
  }

  #goldSafeControlBinding(command: KnowledgeGoldJobControlCommand) {
    return {
      target: { kind: "gold_job" as const, id: command.intent.jobId },
      ...command.namespace,
      operationId: command.operationId,
      operationDeadlineMs: command.operationDeadlineMs,
      expectedJobFence: command.intent.expectedJobFence,
      expectedControlRevision: command.intent.expectedControlRevision,
    };
  }

  async #validateGoldJobControlStage(
    row: KnowledgeArticleActionRow,
    actionId: number,
    gatekeeperInstanceId: string,
    managerId: string,
  ): Promise<KnowledgeGoldJobControlCommand> {
    if (!isNonEmptyBoundedText(row.workspace_id, 512)) throw err("corrupt_state");
    const command = decodeStoredGoldJobControlStage(
      row.command_json,
      actionId,
      gatekeeperInstanceId,
    );
    if (
      row.operation_id !== command.operationId ||
      row.workspace_id !== command.namespace.workspaceId ||
      row.operation_deadline_ms !== command.operationDeadlineMs ||
      row.payload_hash !== (await computeGoldJobControlPayloadHash(managerId, command))
    )
      throw err("corrupt_state");
    return command;
  }

  async #validateGoldPageActionStage(
    row: KnowledgeArticleActionRow,
    actionId: number,
    gatekeeperInstanceId: string,
    managerId: string,
    kind: GoldPageActionKind,
  ): Promise<KnowledgeGoldPageActionCommand> {
    if (!isNonEmptyBoundedText(row.workspace_id, 512)) throw err("corrupt_state");
    const command = decodeStoredGoldPageActionStage(
      row.command_json,
      actionId,
      gatekeeperInstanceId,
      kind,
    );
    if (
      row.operation_id !== command.operationId ||
      row.workspace_id !== command.namespace.workspaceId ||
      row.operation_deadline_ms !== command.operationDeadlineMs ||
      row.payload_hash !== (await computeGoldPageActionPayloadHash(managerId, command))
    )
      throw err("corrupt_state");
    return command;
  }

  async #applyGoldPageAction(
    actionId: number,
    row: KnowledgeArticleActionRow,
    kind: GoldPageActionKind,
  ): Promise<void> {
    const managerId = validateProps(this.ctx.props).managerId;
    if (!isNonEmptyBoundedText(row.workspace_id, 512)) throw err("corrupt_state");
    const namespace: KnowledgeBronzeNamespace = {
      workspaceId: row.workspace_id,
      gatekeeperInstanceId: this.ctx.id.toString(),
      localActionId: actionId,
    };
    const account = this.#accountAccess();
    if (row.status === "rejected") throw err("conflict");
    if (row.status === "applied") {
      const result = parseStoredGoldPageActionSavedResult(row.outcome_json, row.operation_id, kind);
      if (!boundedInt(row.operation_deadline_ms, 1, Number.MAX_SAFE_INTEGER))
        throw err("corrupt_state");
      await account.clearBronzeAction(managerId, {
        ...namespace,
        operationId: result.operationId,
        operationDeadlineMs: row.operation_deadline_ms,
      });
      return;
    }
    if (row.status !== "pending_approval" && row.status !== "applying")
      throw err(row.status === "rejecting" ? "result_unknown" : "invalid_input");
    if (typeof row.command_json !== "string" || row.command_json.length === 0)
      throw err("corrupt_state");
    let command = await this.#validateGoldPageActionStage(
      row,
      actionId,
      namespace.gatekeeperInstanceId,
      managerId,
      kind,
    );
    const controller = await account.getGoldPageController(managerId);
    if (row.status === "pending_approval") {
      const operationDeadlineMs =
        command.operationDeadlineMs === 0
          ? Date.now() + KNOWLEDGE_BRONZE_ADMISSION_WINDOW_MS
          : command.operationDeadlineMs;
      if (!Number.isSafeInteger(operationDeadlineMs) || operationDeadlineMs < 1)
        throw err("invalid_input");
      command = { ...command, operationDeadlineMs };
      const payloadHash = await computeGoldPageActionPayloadHash(managerId, command);
      const started = this.ctx.storage.sql.exec(
        `UPDATE custom_gatekeeper_article_actions
         SET status = 'applying', operation_deadline_ms = ?, command_json = ?, payload_hash = ?
         WHERE local_action_id = ? AND status = 'pending_approval'`,
        operationDeadlineMs,
        JSON.stringify(command),
        payloadHash,
        actionId,
      );
      if (started.rowsWritten !== 1) throw err("result_unknown");
    } else if (
      !boundedInt(command.operationDeadlineMs, 1, Number.MAX_SAFE_INTEGER) ||
      row.operation_deadline_ms !== command.operationDeadlineMs
    ) {
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
    let rawEnvelope: unknown;
    try {
      rawEnvelope =
        command.kind === "gold_page_edit"
          ? await controller.editPage(command)
          : await controller.requestProtectionReleaseAndCleanReplacement(command);
    } catch (cause) {
      throw err("result_unknown", cause);
    }
    const envelope = parseKnowledgeEnvelope(rawEnvelope);
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
    const result = parseGoldPageActionSavedResult(envelope.value, command);
    const completed = this.ctx.storage.sql.exec(
      `UPDATE custom_gatekeeper_article_actions
       SET status = 'applied', command_json = '', outcome_json = ?
       WHERE local_action_id = ? AND status = 'applying'`,
      JSON.stringify(result),
      actionId,
    );
    if (completed.rowsWritten !== 1) throw err("result_unknown");
    await account.clearBronzeAction(managerId, {
      ...command.namespace,
      operationId: command.operationId,
      operationDeadlineMs: command.operationDeadlineMs,
    });
  }

  async #rejectGoldPageAction(
    actionId: number,
    row: KnowledgeArticleActionRow,
    kind: GoldPageActionKind,
  ): Promise<void> {
    if (row.status === "rejected") return;
    if (row.status === "applied") {
      await this.#applyGoldPageAction(actionId, row, kind);
      throw err("conflict");
    }
    if (row.status === "applying") throw err("result_unknown");
    if (row.status !== "pending_approval" && row.status !== "rejecting") throw err("corrupt_state");
    if (typeof row.command_json !== "string" || row.command_json.length === 0)
      throw err("corrupt_state");
    const managerId = validateProps(this.ctx.props).managerId;
    const command = await this.#validateGoldPageActionStage(
      row,
      actionId,
      this.ctx.id.toString(),
      managerId,
      kind,
    );
    const account = this.#accountAccess();
    if (row.status === "pending_approval") {
      const claimed = this.ctx.storage.sql.exec(
        `UPDATE custom_gatekeeper_article_actions SET status = 'rejecting'
         WHERE local_action_id = ? AND status = 'pending_approval'`,
        actionId,
      );
      if (claimed.rowsWritten !== 1) return this.rejectAction(actionId);
    }
    await account.clearBronzeAction(managerId, {
      ...command.namespace,
      operationId: command.operationId,
      operationDeadlineMs: command.operationDeadlineMs,
    });
    const rejected = this.ctx.storage.sql.exec(
      `UPDATE custom_gatekeeper_article_actions
       SET status = 'rejected', command_json = '', outcome_json = ?
       WHERE local_action_id = ? AND status = 'rejecting'`,
      JSON.stringify({ status: "rejected", operationId: command.operationId }),
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
  }

  async #applyGoldJobControlAction(
    actionId: number,
    row: KnowledgeArticleActionRow,
  ): Promise<void> {
    const managerId = validateProps(this.ctx.props).managerId;
    if (!isNonEmptyBoundedText(row.workspace_id, 512)) throw err("corrupt_state");
    const namespace: KnowledgeBronzeNamespace = {
      workspaceId: row.workspace_id,
      gatekeeperInstanceId: this.ctx.id.toString(),
      localActionId: actionId,
    };
    const account = this.#accountAccess();
    const controller = await account.getGoldController(managerId);
    if (row.status === "rejected") throw err("conflict");
    if (row.status === "applied") {
      const result = parseStoredGoldJobControlSavedResult(row.outcome_json, row.operation_id);
      if (!boundedInt(row.operation_deadline_ms, 1, Number.MAX_SAFE_INTEGER))
        throw err("corrupt_state");
      const reservation = await account.findKnowledgeSafeControlReservation(managerId, {
        kind: "gold_job",
        id: result.jobId,
      });
      if (
        reservation !== undefined &&
        reservation.target.kind === "gold_job" &&
        reservation.target.id === result.jobId &&
        reservation.workspaceId === row.workspace_id &&
        reservation.gatekeeperInstanceId === namespace.gatekeeperInstanceId &&
        reservation.localActionId === actionId &&
        reservation.operationId === row.operation_id &&
        reservation.operationDeadlineMs === row.operation_deadline_ms
      ) {
        const { retainedBytesReserved: _retainedBytes, ...binding } = reservation;
        await account.clearKnowledgeSafeControl(managerId, binding);
      }
      await account.clearBronzeAction(managerId, {
        workspaceId: row.workspace_id,
        gatekeeperInstanceId: namespace.gatekeeperInstanceId,
        localActionId: actionId,
        operationId: row.operation_id,
        operationDeadlineMs: row.operation_deadline_ms,
      });
      // A retry after the local applied write repairs only its exact leftover slot. A newer
      // same-target reservation has a different Action or operation ID and stays untouched.
      return;
    }
    if (row.status !== "pending_approval" && row.status !== "applying")
      throw err(row.status === "rejecting" ? "result_unknown" : "invalid_input");
    if (typeof row.command_json !== "string" || row.command_json.length === 0)
      throw err("corrupt_state");
    let command = await this.#validateGoldJobControlStage(
      row,
      actionId,
      this.ctx.id.toString(),
      managerId,
    );
    if (row.status === "pending_approval") {
      const operationDeadlineMs =
        command.operationDeadlineMs === 0
          ? Date.now() + KNOWLEDGE_BRONZE_ADMISSION_WINDOW_MS
          : command.operationDeadlineMs;
      if (!Number.isSafeInteger(operationDeadlineMs) || operationDeadlineMs < 1)
        throw err("invalid_input");
      command = { ...command, operationDeadlineMs };
      const payloadHash = await computeGoldJobControlPayloadHash(managerId, command);
      const started = this.ctx.storage.sql.exec(
        `UPDATE custom_gatekeeper_article_actions
         SET status = 'applying', operation_deadline_ms = ?, command_json = ?, payload_hash = ?
         WHERE local_action_id = ? AND status = 'pending_approval'`,
        operationDeadlineMs,
        JSON.stringify(command),
        payloadHash,
        actionId,
      );
      if (started.rowsWritten !== 1) throw err("result_unknown");
    } else if (
      !boundedInt(command.operationDeadlineMs, 1, Number.MAX_SAFE_INTEGER) ||
      row.operation_deadline_ms !== command.operationDeadlineMs
    ) {
      throw err("corrupt_state");
    }

    const system1Recovery = command.intent.system1Recovery !== undefined;
    if (system1Recovery) {
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
    } else {
      const binding = this.#goldSafeControlBinding(command);
      const currentReservation = await account.findKnowledgeSafeControlReservation(
        managerId,
        binding.target,
      );
      if (
        currentReservation !== undefined &&
        sameKnowledgeSafeControlBinding(currentReservation, {
          ...binding,
          operationDeadlineMs: currentReservation.operationDeadlineMs,
        }) &&
        (currentReservation.operationDeadlineMs === 0 ||
          currentReservation.operationDeadlineMs === command.operationDeadlineMs)
      ) {
        await account.activateKnowledgeSafeControl(
          managerId,
          {
            target: binding.target,
            workspaceId: binding.workspaceId,
            gatekeeperInstanceId: binding.gatekeeperInstanceId,
            localActionId: binding.localActionId,
            operationId: binding.operationId,
            expectedJobFence: binding.expectedJobFence,
            expectedControlRevision: binding.expectedControlRevision,
          },
          command.operationDeadlineMs,
        );
      } else {
        // A later saved control may have already reconciled an Action whose response was lost.
        // Only a trusted current snapshot for this exact job can prove that the old reservation is
        // obsolete; in that case let Knowledge classify the old command as conflict without
        // recreating or clearing any reservation, including a newer operation's slot.
        const inspection = parseKnowledgeEnvelope(await controller.inspect());
        if (!inspection.ok) throw err(inspection.code);
        const current = readKnowledgeGoldControlHead(inspection.value);
        if (
          current.job === null ||
          current.job.jobId !== command.intent.jobId ||
          current.controlRevision <= command.intent.expectedControlRevision ||
          current.job.fence <= command.intent.expectedJobFence
        )
          throw err("result_unknown");
      }
    }
    let rawEnvelope: unknown;
    try {
      rawEnvelope = await controller.apply(command);
    } catch (cause) {
      throw err("result_unknown", cause);
    }
    const envelope = parseKnowledgeEnvelope(rawEnvelope);
    if (!envelope.ok) {
      // A typed conflict is definitive and deliberately leaves the native Action pending. A
      // later exact retry can prove the saved receipt, or a trusted inspect can reconcile a
      // superseded reservation before a new proposal; caller versions never clear the slot.
      if (system1Recovery && envelope.code === "conflict") {
        this.ctx.storage.sql.exec(
          `UPDATE custom_gatekeeper_article_actions SET status = 'pending_approval'
           WHERE local_action_id = ? AND status = 'applying'`,
          actionId,
        );
      } else if (
        envelope.code !== "result_unknown" &&
        envelope.code !== "corrupt_state" &&
        envelope.code !== "conflict"
      ) {
        this.ctx.storage.sql.exec(
          `UPDATE custom_gatekeeper_article_actions SET status = 'pending_approval'
           WHERE local_action_id = ? AND status = 'applying'`,
          actionId,
        );
      }
      throw err(envelope.code);
    }
    const result = parseGoldJobControlSavedResult(envelope.value, command);
    const completed = this.ctx.storage.sql.exec(
      `UPDATE custom_gatekeeper_article_actions
       SET status = 'applied', command_json = '', outcome_json = ?
       WHERE local_action_id = ? AND status = 'applying'`,
      JSON.stringify(result),
      actionId,
    );
    if (completed.rowsWritten !== 1) throw err("result_unknown");
    if (system1Recovery) {
      await account.clearBronzeAction(managerId, {
        ...command.namespace,
        operationId: command.operationId,
        operationDeadlineMs: command.operationDeadlineMs,
      });
    } else {
      await account.clearKnowledgeSafeControl(managerId, this.#goldSafeControlBinding(command));
    }
  }

  async #rejectGoldJobControlAction(
    actionId: number,
    row: KnowledgeArticleActionRow,
  ): Promise<void> {
    if (row.status === "rejected") return;
    if (row.status === "applied") {
      await this.#applyGoldJobControlAction(actionId, row);
      throw err("conflict");
    }
    if (
      row.status !== "pending_approval" &&
      row.status !== "applying" &&
      row.status !== "rejecting"
    )
      throw err("corrupt_state");
    if (typeof row.command_json !== "string" || row.command_json.length === 0)
      throw err("corrupt_state");
    const command = await this.#validateGoldJobControlStage(
      row,
      actionId,
      this.ctx.id.toString(),
      validateProps(this.ctx.props).managerId,
    );
    const system1Recovery = command.intent.system1Recovery !== undefined;
    if (
      (!system1Recovery && command.operationDeadlineMs !== 0) ||
      (system1Recovery && row.status === "applying")
    )
      throw err("result_unknown");
    const managerId = validateProps(this.ctx.props).managerId;
    const claimed = this.ctx.storage.sql.exec(
      `UPDATE custom_gatekeeper_article_actions SET status = 'rejecting'
       WHERE local_action_id = ? AND status = ?`,
      actionId,
      row.status,
    );
    if (claimed.rowsWritten !== 1) throw err("result_unknown");
    if (system1Recovery) {
      await this.#accountAccess().clearBronzeAction(managerId, {
        ...command.namespace,
        operationId: command.operationId,
        operationDeadlineMs: command.operationDeadlineMs,
      });
    } else {
      await this.#accountAccess().clearKnowledgeSafeControl(
        managerId,
        this.#goldSafeControlBinding(command),
      );
    }
    const rejected = this.ctx.storage.sql.exec(
      `UPDATE custom_gatekeeper_article_actions
       SET status = 'rejected', command_json = '', outcome_json = ?
       WHERE local_action_id = ? AND status = 'rejecting'`,
      JSON.stringify({ status: "rejected", operationId: command.operationId }),
      actionId,
    );
    if (rejected.rowsWritten !== 1) throw err("result_unknown");
  }

  async #validateSilverPolicyStage(
    row: KnowledgeArticleActionRow,
    actionId: number,
    gatekeeperInstanceId: string,
  ): Promise<KnowledgeSilverPolicyCommand> {
    if (!isNonEmptyBoundedText(row.workspace_id, 512)) throw err("corrupt_state");
    const command = decodeStoredSilverPolicyStage(row.command_json, actionId, gatekeeperInstanceId);
    if (
      row.operation_id !== command.operationId ||
      row.workspace_id !== command.namespace.workspaceId ||
      row.operation_deadline_ms !== command.operationDeadlineMs ||
      row.payload_hash !== (await computeSilverPolicyPayloadHash(command))
    )
      throw err("corrupt_state");
    return command;
  }

  async #applySilverPolicyAction(actionId: number, row: KnowledgeArticleActionRow): Promise<void> {
    const managerId = validateProps(this.ctx.props).managerId;
    if (!isNonEmptyBoundedText(row.workspace_id, 512)) throw err("corrupt_state");
    const namespace: KnowledgeBronzeNamespace = {
      workspaceId: row.workspace_id,
      gatekeeperInstanceId: this.ctx.id.toString(),
      localActionId: actionId,
    };
    const account = this.#accountAccess();
    const { writer } = await account.getBronzeCapabilities(managerId);
    if (row.status === "rejected") throw err("conflict");

    if (row.status === "applied") {
      if (!boundedInt(row.operation_deadline_ms, 1, Number.MAX_SAFE_INTEGER))
        throw err("corrupt_state");
      const result = parseStoredSilverPolicySavedResult(row.outcome_json, row.operation_id);
      const command: KnowledgeSilverPolicyCommand = {
        kind: "silver_policy",
        namespace,
        operationId: row.operation_id,
        operationDeadlineMs: row.operation_deadline_ms,
        intent: {
          articleId: result.articleId,
          usePolicy: result.usePolicy,
          expectedMetadataRevision: result.metadataRevision - 1,
        },
      };
      if (row.payload_hash !== (await computeSilverPolicyPayloadHash(command)))
        throw err("corrupt_state");
      const envelope = parseKnowledgeEnvelope(await writer.apply(command));
      if (!envelope.ok) throw err(envelope.code);
      const latest = parseSilverPolicySavedResult(envelope.value, command);
      if (JSON.stringify(latest) !== JSON.stringify(result)) throw err("integrity_failure");
      await this.#clearSilverPolicyReservation(account, managerId, command);
      return;
    }
    if (row.status !== "pending_approval" && row.status !== "applying")
      throw err(row.status === "rejecting" ? "result_unknown" : "invalid_input");
    if (typeof row.command_json !== "string" || row.command_json.length === 0)
      throw err("corrupt_state");
    let command = await this.#validateSilverPolicyStage(row, actionId, this.ctx.id.toString());
    if (row.status === "pending_approval") {
      const operationDeadlineMs =
        command.operationDeadlineMs === 0
          ? Date.now() + KNOWLEDGE_BRONZE_ADMISSION_WINDOW_MS
          : command.operationDeadlineMs;
      if (!Number.isSafeInteger(operationDeadlineMs) || operationDeadlineMs < 1)
        throw err("invalid_input");
      command = { ...command, operationDeadlineMs };
      const started = this.ctx.storage.sql.exec(
        `UPDATE custom_gatekeeper_article_actions
         SET status = 'applying', operation_deadline_ms = ?, command_json = ?
         WHERE local_action_id = ? AND status = 'pending_approval'`,
        operationDeadlineMs,
        JSON.stringify(command),
        actionId,
      );
      if (started.rowsWritten !== 1) throw err("result_unknown");
    } else if (
      !boundedInt(command.operationDeadlineMs, 1, Number.MAX_SAFE_INTEGER) ||
      row.operation_deadline_ms !== command.operationDeadlineMs
    ) {
      throw err("corrupt_state");
    }

    await this.#activateSilverPolicyReservation(account, managerId, command);
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
    const result = parseSilverPolicySavedResult(envelope.value, command);
    const completed = this.ctx.storage.sql.exec(
      `UPDATE custom_gatekeeper_article_actions
       SET status = 'applied', command_json = '', outcome_json = ?
       WHERE local_action_id = ? AND status = 'applying'`,
      JSON.stringify(result),
      actionId,
    );
    if (completed.rowsWritten !== 1) throw err("result_unknown");
    await this.#clearSilverPolicyReservation(account, managerId, command);
  }

  async #applyBronzeAction(actionId: number): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<{
        kind: string;
        operation_id: string;
        workspace_id: string | null;
        operation_deadline_ms: number | null;
        command_json: string;
        payload_hash: string;
        status: string;
        outcome_json: string | null;
      }>(
        `SELECT kind, operation_id, workspace_id, operation_deadline_ms, command_json, payload_hash, status, outcome_json
         FROM custom_gatekeeper_article_actions WHERE local_action_id = ?`,
        actionId,
      )
      .toArray();
    if (rows.length === 0) throw err("invalid_input");
    if (rows.length !== 1) throw err("corrupt_state");
    const row = rows[0]!;
    if (row.kind === "silver_policy") return this.#applySilverPolicyAction(actionId, row);
    if (row.kind === "gold_job_control") return this.#applyGoldJobControlAction(actionId, row);
    if (row.kind === "gold_page_edit" || row.kind === "gold_page_clean_request")
      return this.#applyGoldPageAction(actionId, row, row.kind);
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
      const envelope = parseKnowledgeEnvelope(
        await writer.apply({ kind: "saved_retry", namespace }),
      );
      if (!envelope.ok) throw err(envelope.code);
      const receipt = parseBronzeSavedReceipt(envelope.value, row.operation_id);
      const recorded = parseStoredBronzeSavedReceipt(row.outcome_json, row.operation_id);
      if (
        receipt.articleId !== recorded.articleId ||
        receipt.revisionId !== recorded.revisionId ||
        receipt.bodyHash !== recorded.bodyHash
      )
        throw err("integrity_failure");
      if (!boundedInt(row.operation_deadline_ms, 1, Number.MAX_SAFE_INTEGER))
        throw err("corrupt_state");
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
      if (!isV2KnowledgeStagedCommand(command)) {
        await assertLegacyBronzeAdmissionExists(writer, namespace);
      }
      const operationDeadlineMs =
        command.operationDeadlineMs === 0
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
    } else if (
      !boundedInt(command.operationDeadlineMs, 1, Number.MAX_SAFE_INTEGER) ||
      row.operation_deadline_ms !== command.operationDeadlineMs
    ) {
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
      receipt.bodyHash !== (await sha256Hex(new TextEncoder().encode(command.intent.body)))
    )
      throw err("integrity_failure");
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

  async #rejectSilverPolicyAction(actionId: number, row: KnowledgeArticleActionRow): Promise<void> {
    if (row.status === "rejected") return;
    if (row.status === "applied") {
      await this.#applySilverPolicyAction(actionId, row);
      throw err("conflict");
    }
    if (
      row.status !== "pending_approval" &&
      row.status !== "applying" &&
      row.status !== "rejecting"
    )
      throw err("corrupt_state");
    if (typeof row.command_json !== "string" || row.command_json.length === 0)
      throw err("corrupt_state");

    if (row.status === "pending_approval" || row.status === "applying") {
      const claimed = this.ctx.storage.sql.exec(
        `UPDATE custom_gatekeeper_article_actions SET status = 'rejecting'
         WHERE local_action_id = ? AND status = ?`,
        actionId,
        row.status,
      );
      if (claimed.rowsWritten !== 1) return this.rejectAction(actionId);
    }

    const command = await this.#validateSilverPolicyStage(row, actionId, this.ctx.id.toString());
    const managerId = validateProps(this.ctx.props).managerId;
    const account = this.#accountAccess();

    if (command.operationDeadlineMs === 0) {
      // The deadline-zero sentinel proves no Knowledge callback was dispatched. Close the
      // exact native reservation without creating a Knowledge fence or receipt.
      await this.#clearSilverPolicyReservation(account, managerId, command);
      const rejected = this.ctx.storage.sql.exec(
        `UPDATE custom_gatekeeper_article_actions
         SET status = 'rejected', command_json = '', outcome_json = ?
         WHERE local_action_id = ? AND status = 'rejecting'`,
        JSON.stringify({ status: "rejected", operationId: command.operationId }),
        actionId,
      );
      if (rejected.rowsWritten !== 1) throw err("result_unknown");
      return;
    }

    const { writer } = await account.getBronzeCapabilities(managerId);
    if (Date.now() >= command.operationDeadlineMs) {
      // The fixed callback window is over. Recheck the same full command: an exact saved
      // receipt is an applied operation, while a typed conflict proves this operation can no
      // longer commit. Unknown and dependency failures retain the Action and its reservation.
      const envelope = parseKnowledgeEnvelope(await writer.apply(command));
      if (envelope.ok) {
        const result = parseSilverPolicySavedResult(envelope.value, command);
        const completed = this.ctx.storage.sql.exec(
          `UPDATE custom_gatekeeper_article_actions
           SET status = 'applied', command_json = '', outcome_json = ?
           WHERE local_action_id = ? AND status = 'rejecting'`,
          JSON.stringify(result),
          actionId,
        );
        if (completed.rowsWritten !== 1) throw err("result_unknown");
        await this.#clearSilverPolicyReservation(account, managerId, command);
        // A native reject must not make a saved exact policy update appear discarded.
        throw err("conflict");
      }
      if (envelope.code !== "conflict") throw err(envelope.code);
      await this.#clearSilverPolicyReservation(account, managerId, command);
      const rejected = this.ctx.storage.sql.exec(
        `UPDATE custom_gatekeeper_article_actions
         SET status = 'rejected', command_json = '', outcome_json = ?
         WHERE local_action_id = ? AND status = 'rejecting'`,
        JSON.stringify({ status: "rejected", operationId: command.operationId }),
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

    const fenceCommand: KnowledgeSilverPolicyFenceCommand = {
      ...command,
      kind: "silver_policy_fence",
    };
    const envelope = parseKnowledgeEnvelope(await writer.cancel(fenceCommand));
    if (!envelope.ok) {
      if (envelope.code === "conflict") {
        this.ctx.storage.sql.exec(
          `UPDATE custom_gatekeeper_article_actions SET status = 'applying'
           WHERE local_action_id = ? AND status = 'rejecting'`,
          actionId,
        );
      }
      throw err(envelope.code);
    }
    if (
      !rec(envelope.value) ||
      !exact(envelope.value, ["status", "operationId"]) ||
      envelope.value.status !== "fenced" ||
      envelope.value.operationId !== command.operationId
    )
      throw err("integrity_failure");
    await this.#clearSilverPolicyReservation(account, managerId, command);
    const rejected = this.ctx.storage.sql.exec(
      `UPDATE custom_gatekeeper_article_actions
       SET status = 'rejected', command_json = '', outcome_json = ?
       WHERE local_action_id = ? AND status = 'rejecting'`,
      JSON.stringify(envelope.value),
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
  }

  async rejectAction(actionId: number): Promise<void> {
    if (!boundedInt(actionId, 0, Number.MAX_SAFE_INTEGER)) throw err("invalid_input");
    const bronzeRows = this.ctx.storage.sql
      .exec<{
        kind: string;
        operation_id: string;
        workspace_id: string | null;
        operation_deadline_ms: number | null;
        command_json: string;
        payload_hash: string;
        status: string;
        outcome_json: string | null;
      }>(
        `SELECT kind, operation_id, workspace_id, operation_deadline_ms, command_json, payload_hash, status, outcome_json
         FROM custom_gatekeeper_article_actions WHERE local_action_id = ?`,
        actionId,
      )
      .toArray();
    if (bronzeRows.length > 1) throw err("corrupt_state");
    const bronze = bronzeRows[0];
    if (bronze?.kind === "silver_policy") return this.#rejectSilverPolicyAction(actionId, bronze);
    if (bronze?.kind === "gold_job_control")
      return this.#rejectGoldJobControlAction(actionId, bronze);
    if (bronze?.kind === "gold_page_edit" || bronze?.kind === "gold_page_clean_request")
      return this.#rejectGoldPageAction(actionId, bronze, bronze.kind);
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
        if (
          rec(envelope.value) &&
          exact(envelope.value, ["status"]) &&
          envelope.value.status === "clear"
        )
          return;
        if (
          rec(envelope.value) &&
          exact(envelope.value, ["status", "operationId"]) &&
          envelope.value.status === "fenced" &&
          envelope.value.operationId === bronze.operation_id
        )
          return;
        throw err("integrity_failure");
      }
      if (
        bronze.status !== "pending_approval" &&
        bronze.status !== "applying" &&
        bronze.status !== "rejecting"
      )
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
      if (
        command.operationId !== bronze.operation_id ||
        command.namespace.workspaceId !== namespace.workspaceId
      )
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
        const matchingActiveReservation =
          accountReservation !== undefined &&
          accountReservation.status === "active" &&
          accountReservation.workspaceId === binding.workspaceId &&
          accountReservation.gatekeeperInstanceId === binding.gatekeeperInstanceId &&
          accountReservation.localActionId === binding.localActionId &&
          accountReservation.operationId === binding.operationId &&
          (accountReservation.operationDeadlineMs === binding.operationDeadlineMs ||
            accountReservation.operationDeadlineMs === 0);
        if (
          accountReservation !== undefined &&
          accountReservation.status === "fenced" &&
          sameBronzeReservation(accountReservation, binding)
        ) {
          if (Date.now() >= command.operationDeadlineMs) {
            const lookup = parseKnowledgeEnvelope(
              await writer.cancel({ kind: "lookup", namespace }),
            );
            if (!lookup.ok) throw err(lookup.code);
            if (
              !(
                rec(lookup.value) &&
                exact(lookup.value, ["status"]) &&
                lookup.value.status === "clear"
              )
            )
              throw err("result_unknown");
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
          envelope = parseKnowledgeEnvelope(
            await writer.cancel(knowledgeStagedFenceCommand(command)),
          );
        } else {
          const lookup = parseKnowledgeEnvelope(await writer.cancel({ kind: "lookup", namespace }));
          if (!lookup.ok) throw err(lookup.code);
          if (
            rec(lookup.value) &&
            exact(lookup.value, ["status"]) &&
            lookup.value.status === "clear" &&
            Date.now() >= command.operationDeadlineMs
          ) {
            // After expiry a trusted clear lookup proves Knowledge has no saved or active write.
            // clearBronzeAction is conditional under the Account gate, so an unrelated newer slot
            // remains untouched while this old native action can finish as rejected.
            envelope = lookup;
          } else if (
            rec(lookup.value) &&
            exact(lookup.value, ["status"]) &&
            lookup.value.status === "clear"
          ) {
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
            envelope = parseKnowledgeEnvelope(
              await writer.cancel(knowledgeStagedFenceCommand(command)),
            );
          } else if (
            rec(lookup.value) &&
            exact(lookup.value, ["status", "operationId"]) &&
            lookup.value.status === "fenced" &&
            lookup.value.operationId === command.operationId
          ) {
            envelope = lookup;
            durableFenceProof = true;
          } else {
            throw err("result_unknown");
          }
        }
      } else {
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
        envelope = parseKnowledgeEnvelope(
          await writer.cancel(knowledgeStagedFenceCommand(command)),
        );
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
        rec(envelope.value) &&
        exact(envelope.value, ["status", "operationId"]) &&
        envelope.value.status === "fenced" &&
        envelope.value.operationId === command.operationId
      ) {
        outcome = envelope.value;
        if (command.operationDeadlineMs > 0 && !durableFenceProof) {
          await account.fenceBronzeAction(managerId, {
            ...command.namespace,
            operationId: command.operationId,
            operationDeadlineMs: command.operationDeadlineMs,
          });
        }
      } else if (
        rec(envelope.value) &&
        exact(envelope.value, ["status"]) &&
        envelope.value.status === "clear"
      ) {
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
    if (matches.filter((rows) => rows.length > 0).length > 1) throw err("integrity_failure");
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
      if (
        rec(envelope.value) &&
        exact(envelope.value, ["status"]) &&
        envelope.value.status === "clear"
      ) {
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
        rec(envelope.value) &&
        exact(envelope.value, ["status", "operationId"]) &&
        envelope.value.status === "fenced" &&
        envelope.value.operationId === reservation.operationId
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
    if (row.status === "applying" || row.status === "applied") throw err("outcome_unknown");
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
        description:
          "Available. Use list, search, and read to inspect Knowledge pages, or proposeArticle to request an owner-reviewed article save.",
      },
    ]);
  }
  async addObserver(_observerId: string, _user: Fetcher<GatekeeperUserVerifier>) {
    throw new Error("Knowledge Base is private to its Manager.");
  }
  async removeObserver() {}
  async revertAction() {
    throw err("invalid_input");
  }
}
@validateRpc()
export class CustomAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return describeCustomAccount();
  }

  async commitReconnect(_stageId: string): Promise<void> {
    throw new Error("Knowledge Base accounts do not have a reconnect flow.");
  }
  async inspectManagerBinding(
    managerIdValue: string,
  ): Promise<"legacy" | "bound" | "incompatible"> {
    if (!isManagerId(managerIdValue)) throw new TypeError("Manager ID must be a UUID.");
    if (legacyProps(this.ctx.props)) return "legacy";
    const previous = this.ctx.props;
    if (rec(previous) && exact(previous, ["access"]) && previous.access) {
      // The OS atomically replaces legacy accounts. Validate the old binding first.
      await validateStub<InspectableAccess>(previous.access as object).assertBoundTo(
        managerIdValue,
      );
      return "legacy";
    }
    const p = validateProps(this.ctx.props);
    if (p.managerId !== managerIdValue)
      throw new TypeError("Knowledge Account is bound to another Manager.");
    const access = await this.ctx.exports.KnowledgeAccountAccess.getByName(p.managerId).getAccess();
    const contract = await validateStub<InspectableAccess>(access as object).assertBoundTo(
      managerIdValue,
    );
    return contract === KNOWLEDGE_READ_CONTRACT ? "bound" : "incompatible";
  }
  @skipRpcValidation() async inspectBronzeRoles(
    managerIdValue: string,
  ): Promise<KnowledgeBronzeRoles> {
    const p = validateProps(this.ctx.props);
    if (!isManagerId(managerIdValue) || p.managerId !== managerIdValue)
      throw new TypeError("Knowledge account is bound to another Manager.");
    return this.ctx.exports.KnowledgeAccountAccess.getByName(managerIdValue).inspectBronzeRoles(
      managerIdValue,
    );
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
  /** Returns the stored Manager-bound Gold callback slot state for Core preflight. */
  @skipRpcValidation() async inspectGoldRole(managerIdValue: string): Promise<KnowledgeGoldRoles> {
    const p = validateProps(this.ctx.props);
    if (!isManagerId(managerIdValue) || p.managerId !== managerIdValue)
      throw new TypeError("Knowledge account is bound to another Manager.");
    return this.ctx.exports.KnowledgeAccountAccess.getByName(managerIdValue).inspectGoldRole(
      managerIdValue,
    );
  }
  /** Installs the opaque Gold callback in the Manager's single bounded Account slot. */
  @skipRpcValidation() async installGoldRole(
    managerIdValue: string,
    controller: KnowledgeGoldController,
  ): Promise<void> {
    const p = validateProps(this.ctx.props);
    if (!isManagerId(managerIdValue) || p.managerId !== managerIdValue)
      throw new TypeError("Knowledge account is bound to another Manager.");
    const access = this.ctx.exports.KnowledgeAccountAccess.getByName(managerIdValue);
    await access.bindGoldController(managerIdValue, controller);
  }
  @skipRpcValidation() async inspectGoldPageRole(
    managerIdValue: string,
  ): Promise<KnowledgeGoldRoles> {
    const p = validateProps(this.ctx.props);
    if (!isManagerId(managerIdValue) || p.managerId !== managerIdValue)
      throw new TypeError("Knowledge account is bound to another Manager.");
    return this.ctx.exports.KnowledgeAccountAccess.getByName(managerIdValue).inspectGoldPageRole(
      managerIdValue,
    );
  }
  @skipRpcValidation() async installGoldPageRole(
    managerIdValue: string,
    controller: KnowledgeGoldPageController,
  ): Promise<void> {
    const p = validateProps(this.ctx.props);
    if (!isManagerId(managerIdValue) || p.managerId !== managerIdValue)
      throw new TypeError("Knowledge account is bound to another Manager.");
    const access = this.ctx.exports.KnowledgeAccountAccess.getByName(managerIdValue);
    await access.bindGoldPageController(managerIdValue, controller);
  }
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<KnowledgeBase>>> {
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
  @skipRpcValidation() async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
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
    if (!isManagerId(managerId)) throw new TypeError("Manager ID must be a UUID.");
    await this.ctx.exports.KnowledgeAccountAccess.getByName(managerId).bind(managerId, capability);
    return this.ctx.exports.CustomAccount({ props: { managerId } });
  }
  connectAccount(
    _c: Fetcher<GatekeeperConnectCallback>,
    _o?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Knowledge Base is installed by the Manager runtime and has no connect flow.");
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
  proposeArticlePolicy(input: {
    articleId: string;
    usePolicy: "included" | "excluded";
    expectedMetadataRevision: number;
  }): Promise<{
    status: "pending_approval";
    operationId: string;
  }>;
  proposeGoldPageEdit(input: { intent: KnowledgeGoldPageEditIntent }): Promise<{
    status: "pending_approval";
    operationId: string;
  }>;
  proposeGoldCleanReplacement(input: { intent: KnowledgeGoldPageActionIntent }): Promise<{
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
type KnowledgeSilverFacetCoverage = {
  status: "complete" | "partial";
  reasons: string[];
};
type KnowledgeSilverSearchCoverage = {
  metadata: KnowledgeSilverFacetCoverage;
  internalLinks: KnowledgeSilverFacetCoverage;
  sources: KnowledgeSilverFacetCoverage;
};
type KnowledgeSilverMetadataUnknownCoverage = KnowledgeSilverSearchCoverage & {
  metadata: { status: "partial"; reasons: string[] };
};
type KnowledgeSilverProjectionLink =
  | {
      rawDestination: string;
      targetPath: string;
      fragment: string | null;
      resolution: "resolved_current";
      targetArticleId: string;
    }
  | {
      rawDestination: string;
      targetPath: string;
      fragment: string | null;
      resolution: "resolved_exact";
      targetArticleId: string;
      targetRevisionId: string;
      targetBodyHash: string;
    }
  | {
      rawDestination: string;
      targetPath: string;
      fragment: string | null;
      resolution: "unresolved" | "external_or_scope";
    };
type KnowledgeSilverProjectionSource =
  | { descriptor: unknown; resolution: "resolved_current"; targetArticleId: string }
  | {
      descriptor: unknown;
      resolution: "resolved_exact";
      targetArticleId: string;
      targetRevisionId: string;
      targetBodyHash: string;
    }
  | { descriptor: unknown; resolution: "unresolved" | "external_or_scope" };
type KnowledgeSilverProjectionResult = {
  articleId: string;
  inputRevisionId: string;
  projectionRuleVersion: string;
  processedVersion: string;
  relationVersion: string;
  metadata: Record<string, unknown> | null;
  literalLinks: KnowledgeSilverProjectionLink[];
  backlinks: Array<{
    sourceArticleId: string;
    sourceRevisionId: string;
    targetRevisionId: string | null;
    targetBodyHash: string | null;
  }>;
  sources: KnowledgeSilverProjectionSource[];
  coverage: KnowledgeSilverSearchCoverage;
};
type KnowledgeArticleSearchItemCommon = {
  articleId: string;
  currentRevisionId: string;
  usePolicy: "included";
  currentPath: string;
  exactRevisionPath: string;
  bodyHash: string;
  coverage: KnowledgeSilverSearchCoverage;
};
type KnowledgeArticleSearchItem =
  | (KnowledgeArticleSearchItemCommon & {
      state: "indexed";
      projection: KnowledgeSilverProjectionResult;
    })
  | (Omit<KnowledgeArticleSearchItemCommon, "coverage"> & {
      state: "metadata_unknown";
      projection: KnowledgeSilverProjectionResult;
      coverage: KnowledgeSilverMetadataUnknownCoverage;
    })
  | (KnowledgeArticleSearchItemCommon & { state: "pending"; projection: null });
type KnowledgeComputerSearchResult = {
  bundleId: string;
  versionId: string;
  hits: Array<{ path: string; line: number; snippet: string }>;
  nextOffset?: number;
};
export type KnowledgeSearchResult =
  | KnowledgeComputerSearchResult
  | {
      kind: "articles";
      items: KnowledgeArticleSearchItem[];
      nextCursor?: string;
      coverage: KnowledgeSilverSearchCoverage;
    }
  | {
      kind: "article-links";
      items: Array<{ depth: number; item: KnowledgeArticleSearchItem }>;
      coverage: KnowledgeSilverSearchCoverage;
    };
export type KnowledgeReadResult =
  | {
      kind: "navigation";
      path: "articles" | "index.md";
      sourceMarkdown: string;
      goldStatus: "disabled" | "enabled" | "paused";
    }
  | {
      bundleId: string;
      versionId: string;
      path: string;
      sourceMarkdown: string;
      metadata: Record<string, unknown>;
    }
  | {
      kind: "article";
      articleId: string;
      revisionId: string;
      bodyHash: string;
      path: string;
      sourceMarkdown: string;
      metadata: Record<string, unknown>;
    };
