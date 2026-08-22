import { validateStub } from "capnweb-validate";

const GOLD_RECALL_MAX_QUERY_BYTES = 256;
const GOLD_RECALL_MAX_PATTERNS = 32;
const GOLD_RECALL_MAX_PATTERN_BYTES = 256;
const GOLD_RECALL_MAX_TOTAL_PATTERN_BYTES = 8 * 1024;
const GOLD_RECALL_MAX_GENERATION_BYTES = 128;
const controlCharacterPattern = /\p{Cc}/u;

type PrivateGoldRecallResult =
  | { version: 1; state: "disabled" }
  | { version: 1; state: "ready"; generation: string; patterns: string[] };

export type KnowledgeRecallResult =
  | { state: "disabled" }
  | { state: "ready"; patterns: string[] };

export type GoldRecallAccess = {
  recallGold(query: string): Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

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

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !controlCharacterPattern.test(value) &&
    !hasUnpairedSurrogate(value) &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}

export function normalizeGoldRecallQuery(value: unknown): string {
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) {
    throw new Error("Knowledge Base invalid_input.");
  }
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length === 0 ||
    new TextEncoder().encode(normalized).byteLength > GOLD_RECALL_MAX_QUERY_BYTES
  ) {
    throw new Error("Knowledge Base invalid_input.");
  }
  return normalized;
}

export function parsePrivateGoldRecallResult(value: unknown): PrivateGoldRecallResult | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.state !== "string") {
    return undefined;
  }

  if (value.state === "disabled") {
    return hasExactKeys(value, ["version", "state"])
      ? { version: 1, state: "disabled" }
      : undefined;
  }

  if (
    value.state !== "ready" ||
    !hasExactKeys(value, ["version", "state", "generation", "patterns"]) ||
    !isBoundedText(value.generation, GOLD_RECALL_MAX_GENERATION_BYTES) ||
    !Array.isArray(value.patterns) ||
    value.patterns.length > GOLD_RECALL_MAX_PATTERNS
  ) {
    return undefined;
  }

  let aggregateBytes = 0;
  const patterns: string[] = [];
  for (const pattern of value.patterns) {
    if (!isBoundedText(pattern, GOLD_RECALL_MAX_PATTERN_BYTES)) return undefined;
    aggregateBytes += new TextEncoder().encode(pattern).byteLength;
    if (aggregateBytes > GOLD_RECALL_MAX_TOTAL_PATTERN_BYTES) return undefined;
    patterns.push(pattern);
  }

  return {
    version: 1,
    state: "ready",
    generation: value.generation,
    patterns,
  };
}

function parseGoldRecallRpcResult(value: unknown): PrivateGoldRecallResult | undefined {
  if (!isRecord(value) || value.ok !== true || !hasExactKeys(value, ["ok", "value"])) {
    return undefined;
  }
  return parsePrivateGoldRecallResult(value.value);
}

export function goldRecallAccessFromProps(props: unknown): GoldRecallAccess | undefined {
  if (!isRecord(props) || !("access" in props)) return undefined;
  const access = props.access;
  if ((typeof access !== "object" && typeof access !== "function") || access === null) {
    return undefined;
  }
  return validateStub<GoldRecallAccess>(access as object);
}

export async function recallGold(
  access: GoldRecallAccess | undefined,
  query: unknown,
): Promise<KnowledgeRecallResult> {
  const normalizedQuery = normalizeGoldRecallQuery(query);
  if (access === undefined) return { state: "disabled" };

  try {
    const result = parseGoldRecallRpcResult(await access.recallGold(normalizedQuery));
    if (result?.state !== "ready") return { state: "disabled" };
    return { state: "ready", patterns: result.patterns };
  } catch {
    // A mixed-version Core or a temporarily unavailable Gold producer must not make ordinary
    // Knowledge list/search/read unavailable. Gold is a recall aid, never an authority dependency.
    return { state: "disabled" };
  }
}
