import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";

export { default } from "../src/index.js";
export * from "../src/index.js";
export { CustomGatekeeper } from "../src/custom.js";

type TestProps = { managerId: string };

const proposalCalls: unknown[] = [];

class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  readonly submissions: Array<{ action: number; description: Record<string, unknown> }> = [];

  async authorizeObservation(): Promise<void> {}

  async submitAction(action: number, description: Record<string, unknown>): Promise<void> {
    this.submissions.push({ action, description });
  }
}

export class TestKnowledgeAccess extends WorkerEntrypoint<Cloudflare.Env, TestProps> {
  async assertBoundTo(managerId: string): Promise<void> {
    if (managerId !== this.ctx.props.managerId) throw new Error("wrong manager");
  }

  async list(): Promise<unknown> {
    return { ok: true, value: { items: [], nextCursor: null } };
  }

  async search(): Promise<unknown> {
    return { ok: true, value: { items: [], nextCursor: null } };
  }

  async read(): Promise<unknown> {
    return { ok: false, error: { code: "target_missing" } };
  }

  async applyProposal(input: {
    revisionId: string;
    documentKey: string;
    content: string;
  }): Promise<unknown> {
    const bytes = new TextEncoder().encode(input.content);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const contentHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    proposalCalls.push(input);
    return {
      ok: true,
      value: { revisionId: input.revisionId, documentKey: input.documentKey, contentHash },
    };
  }

  async cancelProposal(): Promise<unknown> {
    return { ok: true, value: null };
  }

  readProposalCalls(): unknown[] {
    return [...proposalCalls];
  }

  resetProposalCalls(): void {
    proposalCalls.length = 0;
  }
}

export class TestGatekeeperFactory extends DurableObject {
  async runProposal(managerId: string): Promise<{
    submission: { action: number; description: Record<string, unknown> };
    proposalCallCount: number;
  }> {
    const workerExports = this.ctx.exports as unknown as {
      TestKnowledgeAccess(options: { props: TestProps }): unknown;
      CustomGatekeeper(options: { props: { access: unknown } }): DurableObjectClass;
    };
    const access = workerExports.TestKnowledgeAccess({ props: { managerId } });
    const gatekeeperClass = workerExports.CustomGatekeeper({ props: { access } });
    const facetName = "knowledge-" + crypto.randomUUID();
    const gatekeeper = this.ctx.facets.get(facetName, () => ({
      class: gatekeeperClass,
      id: facetName,
    }));
    const approvalTarget = new TestApprovalQueue();
    const approvalQueue = new RpcStub(approvalTarget);
    const session = await gatekeeper.startSession(approvalQueue);
    await session.proposeUpdate({
      documentKey: "principles",
      baseSourceRevisionId: null,
      content: "# Approved principles",
    });
    const submission = approvalTarget.submissions[0];
    if (!submission) throw new Error("Expected a submitted action.");
    await gatekeeper.applyAction(submission.action);
    await gatekeeper.applyAction(submission.action);
    session[Symbol.dispose]();
    approvalQueue[Symbol.dispose]();
    return { submission, proposalCallCount: proposalCalls.length };
  }
}
