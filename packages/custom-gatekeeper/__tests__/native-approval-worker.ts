import { WorkerEntrypoint } from "cloudflare:workers";
import { KnowledgeAccountAccess as ProductKnowledgeAccountAccess } from "../src/custom.js";

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
export { CustomGatekeeper } from "../src/custom.js";
export {
  InspectableCustomGatekeeper,
  NativeApprovalOwner,
  NativeArticleAccess,
  TestKnowledgeAccess,
} from "./worker.js";

type NativeBronzeCapabilityProps = {
  managerId: string;
  role: "writer" | "sourceReader";
  token: string;
};

type NativeBronzeCapabilityState = {
  assertions: number;
  holdNext: boolean;
  waiting: boolean;
};

const nativeBronzeCapabilityStates = new Map<string, NativeBronzeCapabilityState>();
const nativeBronzeCapabilityState = (token: string): NativeBronzeCapabilityState => {
  let state = nativeBronzeCapabilityStates.get(token);
  if (state === undefined) {
    state = { assertions: 0, holdNext: false, waiting: false };
    nativeBronzeCapabilityStates.set(token, state);
  }
  return state;
};

/** Test-only RPC capability with an explicit hold point for Account gate contention coverage. */
export class NativeBronzeCapability extends WorkerEntrypoint<
  Cloudflare.Env,
  NativeBronzeCapabilityProps
> {
  async disposeTestControl(): Promise<void> {
    nativeBronzeCapabilityStates.delete(this.ctx.props.token);
  }

  async holdNextAssertion(): Promise<void> {
    nativeBronzeCapabilityState(this.ctx.props.token).holdNext = true;
  }

  async assertionState(): Promise<{ count: number; waiting: boolean }> {
    const state = nativeBronzeCapabilityState(this.ctx.props.token);
    return { count: state.assertions, waiting: state.waiting };
  }

  async tokenForTest(): Promise<string> {
    return this.ctx.props.token;
  }

  async assertBoundTo(managerId: string): Promise<string> {
    const state = nativeBronzeCapabilityState(this.ctx.props.token);
    state.assertions += 1;
    if (state.holdNext) {
      state.holdNext = false;
      state.waiting = true;
      try {
          await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
      } finally {
        state.waiting = false;
      }
    }
    if (managerId !== this.ctx.props.managerId)
      throw new Error("Native Bronze test capability is bound to another Manager.");
    return this.ctx.props.role === "writer"
      ? "cybernest-knowledge-bronze-write-v1"
      : "cybernest-knowledge-source-read-v1";
  }

  async apply(): Promise<unknown> {
    throw new Error("Native Bronze gate test capability cannot write.");
  }

  async cancel(): Promise<unknown> {
    throw new Error("Native Bronze gate test capability cannot cancel.");
  }

  async verifySource(): Promise<unknown> {
    throw new Error("Native Bronze gate test capability cannot read sources.");
  }
}

// This test Worker has no outbound network capability. Native RPC/service-binding fixtures remain local.
globalThis.fetch = async () => {
  throw new Error("Outbound fetch is disabled in the native Article approval test Worker.");
};

type AccountProbeState = {
  armed: boolean;
  waiting: boolean;
  released: boolean;
  completed: boolean;
};

const accountProbeStates = new Map<string, AccountProbeState>();
const accountProbeKey = (id: string, token: string): string => `${id}:${token}`;
const waitForAccountProbeTick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 5));

/** Test-only Account subclass observes whether a failing local gate resets an in-flight RPC. */
export class KnowledgeAccountAccess extends ProductKnowledgeAccountAccess {
  async armCapabilityProbeForTest(managerId: string, token: string): Promise<void> {
    const id = this.ctx.id.toString();
    if (id !== this.ctx.exports.KnowledgeAccountAccess.idFromName(managerId).toString())
      throw new Error("Account probe is bound to another Manager.");
    accountProbeStates.set(accountProbeKey(id, token), {
      armed: true,
      waiting: false,
      released: false,
      completed: false,
    });
  }

  async probeCapabilitiesForTest(managerId: string, token: string): Promise<{ token: string }> {
    await this.getBronzeCapabilities(managerId);
    const state = accountProbeStates.get(accountProbeKey(this.ctx.id.toString(), token));
    if (state) state.completed = true;
    return { token };
  }

  async capabilityProbeStateForTest(token: string): Promise<Readonly<{
    armed: boolean;
    waiting: boolean;
    completed: boolean;
  }> | undefined> {
    const state = accountProbeStates.get(accountProbeKey(this.ctx.id.toString(), token));
    if (!state) return undefined;
    return { armed: state.armed, waiting: state.waiting, completed: state.completed };
  }

  async releaseCapabilityProbeForTest(token: string): Promise<void> {
    const state = accountProbeStates.get(accountProbeKey(this.ctx.id.toString(), token));
    if (state) state.released = true;
  }

  async disposeCapabilityProbeForTest(token: string): Promise<void> {
    accountProbeStates.delete(accountProbeKey(this.ctx.id.toString(), token));
  }

  override async getBronzeCapabilities(managerId: string) {
    const capabilities = await super.getBronzeCapabilities(managerId);
    const state = [...accountProbeStates.entries()].find(([key, value]) =>
      key.startsWith(`${this.ctx.id.toString()}:`) && value.armed,
    )?.[1];
    if (state) {
      state.armed = false;
      state.waiting = true;
      while (!state.released) await waitForAccountProbeTick();
      state.waiting = false;
      state.completed = true;
    }
    return capabilities;
  }
}
