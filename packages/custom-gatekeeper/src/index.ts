export {
  CustomAccount,
  CustomVerifier,
  GatekeeperVendor,
  KnowledgeSession,
  describeCustomAccount,
  describeCustomVendor,
} from "./custom.js";
export { GoldRecallCustomGatekeeper as CustomGatekeeper } from "./gold-recall-gatekeeper.js";
export type { KnowledgeAccountProps } from "./custom.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("Custom Gatekeeper worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
