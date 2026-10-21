import { RpcStub, RpcTarget } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CustomAccount } from "../src/custom.js";

const managerId = "44444444-4444-4444-8444-444444444444";
const otherManagerId = "54444444-4444-4444-8444-444444444444";
const READ_CONTRACT = "cybernest-knowledge-read-v1";

class AccessFixture extends RpcTarget {
  constructor(
    private readonly ownerId: string,
    private readonly contractResult: unknown,
    private readonly rejection?: Error,
  ) {
    super();
  }

  async assertBoundTo(id: string): Promise<unknown> {
    if (this.rejection !== undefined) throw this.rejection;
    if (id !== this.ownerId) throw new Error("fixture owner mismatch");
    return this.contractResult;
  }
}

const accountWithAccess = (
  access: RpcStub<AccessFixture>,
  ownerId = managerId,
): CustomAccount => {
  const account = Object.create(CustomAccount.prototype) as CustomAccount;
  (account as unknown as { ctx: unknown }).ctx = {
    props: { managerId: ownerId },
    exports: {
      KnowledgeAccountAccess: {
        getByName: () => ({ getAccess: async () => access }),
      },
    },
  };
  return account;
};

describe("CustomAccount manager binding compatibility", () => {
  it("classifies the read-only contract literal as bound", async () => {
    const access = new RpcStub(new AccessFixture(managerId, READ_CONTRACT));
    try {
      await expect(accountWithAccess(access).inspectManagerBinding(managerId)).resolves.toBe(
        "bound",
      );
    } finally {
      access[Symbol.dispose]();
    }
  });

  it("classifies an old assert-only capability as incompatible", async () => {
    const access = new RpcStub(new AccessFixture(managerId, undefined));
    try {
      await expect(accountWithAccess(access).inspectManagerBinding(managerId)).resolves.toBe(
        "incompatible",
      );
    } finally {
      access[Symbol.dispose]();
    }
  });

  it("preserves an owner assertion rejection instead of classifying it as incompatible", async () => {
    const access = new RpcStub(
      new AccessFixture(managerId, undefined, new Error("owner assertion failure")),
    );
    try {
      await expect(accountWithAccess(access).inspectManagerBinding(managerId)).rejects.toThrow(
        "owner assertion failure",
      );
    } finally {
      access[Symbol.dispose]();
    }
  });

  it("rejects an account created for another Manager", async () => {
    const access = new RpcStub(new AccessFixture(otherManagerId, READ_CONTRACT));
    try {
      await expect(accountWithAccess(access, otherManagerId).inspectManagerBinding(managerId)).rejects.toThrow(
        "Knowledge Account is bound to another Manager.",
      );
    } finally {
      access[Symbol.dispose]();
    }
  });
});
