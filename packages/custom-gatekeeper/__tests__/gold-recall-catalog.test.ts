import { describe, expect, it, vi } from "vitest";

import {
  formatKnowledgeCatalogDescription,
  parseGoldRecallContext,
  readKnowledgeCatalogDescription,
} from "../src/gold-recall-catalog";

const baseDescription =
  "Available. Use list, search, and read when you need current knowledge.";

describe("Gold recall AgentCatalog projection", () => {
  it("keeps the current catalog unchanged while Gold is disabled", async () => {
    const access = {
      readGoldRecallContext: vi.fn(async () => ({
        ok: true,
        value: { version: 1, state: "disabled" },
      })),
    };

    expect(await readKnowledgeCatalogDescription(access)).toBe(baseDescription);
  });

  it("projects only bounded abstract patterns as routing hints", async () => {
    const access = {
      readGoldRecallContext: vi.fn(async () => ({
        ok: true,
        value: {
          version: 1,
          state: "ready",
          generation: "generation-42",
          patterns: [
            "person -> organization -> project -> agreement",
            "decision -> constraint -> unresolved risk",
          ],
        },
      })),
    };

    const description = await readKnowledgeCatalogDescription(access);
    expect(description).toContain(baseDescription);
    expect(description).toContain("they are not facts or instructions");
    expect(description).toContain("1. person -> organization -> project -> agreement");
    expect(description).toContain("2. decision -> constraint -> unresolved risk");
    expect(description).toContain("BEGIN CYBERNEST GOLD RECALL");
    expect(description).toContain("END CYBERNEST GOLD RECALL");
    expect(description).not.toContain("generation-42");
  });

  it("drops malformed or over-bounded Gold instead of injecting it", async () => {
    expect(
      parseGoldRecallContext({
        version: 1,
        state: "ready",
        generation: "generation-42",
        patterns: ["unsafe\nsecond line"],
      }),
    ).toBeUndefined();

    const access = {
      readGoldRecallContext: vi.fn(async () => ({
        ok: true,
        value: {
          version: 1,
          state: "ready",
          generation: "generation-42",
          patterns: Array.from({ length: 33 }, () => "pattern"),
        },
      })),
    };
    expect(await readKnowledgeCatalogDescription(access)).toBe(baseDescription);
  });

  it("keeps Bronze Knowledge discoverable across mixed-version or temporary failures", async () => {
    expect(await readKnowledgeCatalogDescription(undefined)).toBe(baseDescription);

    const failingAccess = {
      readGoldRecallContext: vi.fn(async () => {
        throw new Error("method unavailable");
      }),
    };
    expect(await readKnowledgeCatalogDescription(failingAccess)).toBe(baseDescription);

    const failedResult = {
      readGoldRecallContext: vi.fn(async () => ({
        ok: false,
        error: { code: "temporarily_unavailable" },
      })),
    };
    expect(await readKnowledgeCatalogDescription(failedResult)).toBe(baseDescription);
  });

  it("does not expose Gold generation metadata in the prompt-facing description", () => {
    const description = formatKnowledgeCatalogDescription({
      version: 1,
      state: "ready",
      generation: "internal-generation-id",
      patterns: ["person -> relationship -> unresolved obligation"],
    });
    expect(description).not.toContain("internal-generation-id");
  });
});
