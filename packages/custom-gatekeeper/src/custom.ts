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
type Access = {
  assertBoundTo(managerId: string): Promise<void>;
  list(input?: ListInput): Promise<unknown>;
  readBronze(
    input: { knowledgeId: string; generation: 1 } & BronzeInput,
  ): Promise<unknown>;
};
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
export type KnowledgeAccountProps = { access: Access };
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
  #disposed = false;
  constructor(q: RpcStub<ApprovalQueue>, a: Access, id: string, g: 1) {
    super();
    this.#q = q;
    this.#a = a;
    this.#id = id;
    this.#g = g;
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
  readonly #h = new Set<Knowledge>();
  #disposed = false;
  constructor(q: RpcStub<ApprovalQueue>, a: Access) {
    super();
    this.#q = q;
    this.#a = a;
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
  if (!rec(v) || !exact(v, ["access"]) || !v.access)
    throw new TypeError("Knowledge Account props must contain only access.");
  return { access: validateStub<Access>(v.access as object) };
}

@validateRpc()
export class CustomGatekeeper
  extends DurableObject<Cloudflare.Env, Props>
  implements Gatekeeper<KnowledgeBase>
{
  #access() {
    const p = this.ctx.props as unknown;
    if (!rec(p) || !exact(p, ["access"]) || !p.access)
      throw new TypeError("Knowledge Account props must contain only access.");
    return validateStub<Access>(p.access as object);
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
    const access = this.#access();
    const queue = q.dup();
    try {
      return new KnowledgeSession(queue, access);
    } catch (cause) {
      try {
        queue[Symbol.dispose]?.();
      } catch {
        // Preserve the constructor failure while still attempting ownership cleanup.
      }
      throw cause;
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
  async applyAction() {
    throw err("invalid_input");
  }
  async rejectAction() {
    throw err("invalid_input");
  }
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
    const p = validateProps(this.ctx.props);
    await p.access.assertBoundTo(managerIdValue);
    return "bound";
  }
  async getSingletonGatekeeperClass(): Promise<
    DurableObjectClass<Gatekeeper<KnowledgeBase>>
  > {
    const p = this.ctx.props as unknown;
    validateProps(p);
    return this.ctx.exports.CustomGatekeeper({ props: p as Props });
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
    const a = validateStub<Access>(capability as object);
    await a.assertBoundTo(managerId);
    return this.ctx.exports.CustomAccount({ props: { access: capability } });
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
};
