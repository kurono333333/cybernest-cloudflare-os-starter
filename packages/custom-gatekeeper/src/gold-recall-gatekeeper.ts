import { RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";

import { CustomGatekeeper as BaseCustomGatekeeper } from "./custom.js";
import {
  GoldRecallKnowledgeSession,
  goldRecallAccessFromProps,
} from "./gold-recall.js";

@validateRpc()
export class GoldRecallCustomGatekeeper extends BaseCustomGatekeeper {
  override async startSession(
    approvalQueue: RpcStub<ApprovalQueue>,
  ): Promise<GoldRecallKnowledgeSession> {
    const base = await super.startSession(approvalQueue);
    const recallObservationQueue = approvalQueue.dup();
    return new GoldRecallKnowledgeSession(
      base,
      recallObservationQueue,
      goldRecallAccessFromProps(this.ctx.props as unknown),
    );
  }
}
