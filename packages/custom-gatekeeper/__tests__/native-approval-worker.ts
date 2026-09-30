// Test-only combined Worker: the pinned OS server owns Manager, User, Overseer, and its real ApprovalQueue.
export { default } from "../../../cloudflare-os/packages/workshop-backend/src/server.js";
// Keep ctx.exports-visible OS entrypoints as explicit exports; the analyzer does not follow export-star barrels.
export {
  PendingLogin,
  LoginConnectCallbackImpl,
  LanguageModelGatekeeper,
  AdminSettings,
  UserDurableObject,
  GatekeeperConnectCallbackImpl,
  ManagerKnowledgeBridge,
  OverseerDurableObject,
  GatekeeperLoopback,
  GatekeeperHookLoopback,
  CodeModeTailLoopback,
  AgentSpawnerGatekeeper,
  GadgetTailLoopback,
  AgentSelfLoopback,
  TransientStubLoopback,
  ExternalMessageGateway,
} from "../../../cloudflare-os/packages/workshop-backend/src/server.js";

// Expose only the pinned custom Gatekeeper and its test fixture classes as same-Worker exports.
export { CustomGatekeeper, KnowledgeAccountAccess } from "../src/custom.js";
export {
  InspectableCustomGatekeeper,
  NativeApprovalOwner,
  NativeArticleAccess,
  TestKnowledgeAccess,
} from "./worker.js";

// This test Worker has no outbound network capability. Native RPC/service-binding fixtures remain local.
globalThis.fetch = async () => {
  throw new Error("Outbound fetch is disabled in the native Article approval test Worker.");
};
