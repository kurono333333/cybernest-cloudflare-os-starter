import { RpcStub } from "cloudflare:workers";
import { validateRpc, validateStub } from "capnweb-validate";
import { boundAgentCatalog } from "@gadgets/workshop-shared/gatekeeper";
import type {
  AgentCatalog,
  AgentCatalogRequest,
  ObservationAuthorizer,
} from "@gadgets/workshop-shared/gatekeeper";

import { CustomGatekeeper as BaseCustomGatekeeper } from "./custom.js";
import {
  readKnowledgeCatalogDescription,
  type GoldRecallAccess,
} from "./gold-recall-catalog.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function goldRecallAccessFromProps(props: unknown): GoldRecallAccess | undefined {
  if (!isRecord(props) || !("access" in props)) return undefined;
  const access = props.access;
  if ((typeof access !== "object" && typeof access !== "function") || access === null) {
    return undefined;
  }
  return validateStub<GoldRecallAccess>(access as object);
}

@validateRpc()
export class GoldRecallCustomGatekeeper extends BaseCustomGatekeeper {
  override async getAgentCatalog(
    request: AgentCatalogRequest,
    authorizer: RpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog> {
    const description = await readKnowledgeCatalogDescription(
      goldRecallAccessFromProps(this.ctx.props as unknown),
    );
    const catalog = boundAgentCatalog(
      [
        {
          id: "knowledge-base",
          title: "Knowledge Base",
          description,
        },
      ],
      request,
    );
    await authorizer.authorizeObservation({
      title: "Knowledge Base catalog",
      description:
        "Listed " +
        catalog.entries.length +
        " Knowledge Base catalog entr" +
        (catalog.entries.length === 1 ? "y." : "ies."),
    });
    return catalog;
  }
}
