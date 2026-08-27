import { describe, expect, it, vi } from "vitest";

import {
  normalizeGoldRecallQuery,
  parsePrivateGoldRecallResult,
  recallGold,
} from "../src/gold-recall";

describe("Gold recall capability", () => {
  it("normalizes the current request before invoking the private Manager-bound capability", async () => {
    const access = {
      recallGold: vi.fn(async () => ({
        ok: true,
        value: {
          version: 1,
          state: "ready",
          generation: "generation-42",
          patterns: ["person -> organization -> project -> agreement"],
        },
      })),
    };

    await expect(recallGold(access, "  ＹＡＭＡＤＡ  ")).resolves.toEqual({
      state: "ready",
      patterns: ["person -> organization -> project -> agreement"],
    });
    expect(access.recallGold).toHaveBeenCalledWith("YAMADA");
  });

  it("keeps internal generation metadata out of the agent-facing result", async () => {
    const access = {
      recallGold: vi.fn(async () => ({
        ok: true,
        value: {
          version: 1,
          state: "ready",
          generation: "internal-generation-id",
          patterns: ["decision -> constraint -> unresolved risk"],
        },
      })),
    };

    const result = await recallGold(access, "decision history");
    expect(result).toEqual({
      state: "ready",
      patterns: ["decision -> constraint -> unresolved risk"],
    });
    expect(JSON.stringify(result)).not.toContain("internal-generation-id");
  });

  it("falls back to disabled across mixed-version, malformed, and temporary failures", async () => {
    await expect(recallGold(undefined, "山田さんの件")).resolves.toEqual({ state: "disabled" });

    const missingMethod = {
      recallGold: vi.fn(async () => {
        throw new Error("method unavailable");
      }),
    };
    await expect(recallGold(missingMethod, "山田さんの件")).resolves.toEqual({ state: "disabled" });

    const malformed = {
      recallGold: vi.fn(async () => ({
        ok: true,
        value: {
          version: 1,
          state: "ready",
          generation: "generation-42",
          patterns: ["unsafe\nsecond line"],
        },
      })),
    };
    await expect(recallGold(malformed, "山田さんの件")).resolves.toEqual({ state: "disabled" });

    const failed = {
      recallGold: vi.fn(async () => ({
        ok: false,
        error: { code: "temporarily_unavailable" },
      })),
    };
    await expect(recallGold(failed, "山田さんの件")).resolves.toEqual({ state: "disabled" });
  });

  it("rejects invalid queries before the private capability call", async () => {
    const access = { recallGold: vi.fn() };
    expect(() => normalizeGoldRecallQuery("   ")).toThrow("invalid_input");
    await expect(recallGold(access, "   ")).rejects.toThrow("invalid_input");
    expect(access.recallGold).not.toHaveBeenCalled();
  });

  it("rejects over-bounded private Gold results", () => {
    expect(
      parsePrivateGoldRecallResult({
        version: 1,
        state: "ready",
        generation: "generation-42",
        patterns: Array.from({ length: 33 }, () => "pattern"),
      }),
    ).toBeUndefined();
  });
});
