import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { pnpmCommand } from "../cloudflare-os/scripts/pnpm-command.ts";
import { resolveBinEntry } from "../cloudflare-os/scripts/bin-entry.ts";
import { AI_GATEWAY_PROVIDERS } from "./deployment-config.ts";
import type {
  BaseConfigs,
  BuildCommand,
  DeploymentConfig,
  GeneratedConfigs,
  ProdWranglerConfig,
} from "./deployment-config.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// One deployment per checkout; use separate worktrees for concurrent deploys.
const generatedName = "wrangler.prod.jsonc";
const packageDirs = {
  workshop: "cloudflare-os/packages/workshop-backend",
  context: "cloudflare-os/packages/gatekeeper-context",
  customGatekeeper: "packages/custom-gatekeeper",
  errorReporter: "packages/error-reporter",
} as const;
const generatedPaths = Object.fromEntries(
  Object.entries(packageDirs).map(([name, dir]) => [name, join(root, dir, generatedName)]),
) as Record<keyof typeof packageDirs, string>;
const accountIdPattern = /^[a-f\d]{32}$/i;

const requiredPaths = [
  "accountId",
  "workers.workshop.name",
  "workers.context.name",
  "workers.customGatekeeper.name",
  "context.sharingDomain",
  "aiGateway.enabled",
  "errorReporting.enabled",
  "customGatekeeper.name",
  "customGatekeeper.message",
  "observability.enabled",
  "observability.headSamplingRate",
  "observability.logs.invocationLogs",
  "observability.traces.enabled",
  "observability.traces.headSamplingRate",
];

// These values configure the deployment-funded catalog and its selected Workers AI transport.
const aiGatewayPaths = [
  "aiGateway.name",
  "aiGateway.providers",
  "aiGateway.workersAi.mode",
];

const errorReportingPaths = [
  "workers.errorReporter.name",
  "errorReporting.environment",
];

const resourcePaths = [
  "context.kvNamespaceId",
  "resources.blueprintsKvNamespaceId",
  "resources.avatarsKvNamespaceId",
  "resources.blueprintContentBucket",
];

function valueAt(object: DeploymentConfig, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (value, key) => (value as Record<string, unknown> | undefined)?.[key], object);
}

export function validateConfig(config: DeploymentConfig): DeploymentConfig {
  const activePaths = [
    ...requiredPaths,
    ...(config.aiGateway?.enabled ? aiGatewayPaths : []),
    ...(config.errorReporting?.enabled ? errorReportingPaths : []),
  ];
  for (const path of activePaths) {
    const value = valueAt(config, path);
    if (value === undefined || value === null || value === "" || Array.isArray(value) && !value.length) {
      throw new Error(`Missing required deployment value: ${path}`);
    }
  }

  for (const path of resourcePaths) {
    const value = valueAt(config, path);
    if (value === undefined || value !== null && (typeof value !== "string" || !value)) {
      throw new Error(`Deployment resource must be null or a non-empty string: ${path}`);
    }
  }

  let activeConfig: DeploymentConfig = config.aiGateway.enabled
    ? config
    : { ...config, aiGateway: { enabled: false } };
  if (!config.errorReporting.enabled) {
    activeConfig = {
      ...activeConfig,
      workers: { ...activeConfig.workers, errorReporter: undefined },
      errorReporting: { enabled: false },
    };
  }
  const placeholder = JSON.stringify(activeConfig).match(/<[^>]+>/)?.[0];
  if (placeholder) throw new Error(`Replace deployment placeholder ${placeholder}.`);

  const stringPaths = activePaths.filter((path) => ![
    "aiGateway.enabled",
    "aiGateway.providers",
    "errorReporting.enabled",
    "observability.enabled",
    "observability.headSamplingRate",
    "observability.logs.invocationLogs",
    "observability.traces.enabled",
    "observability.traces.headSamplingRate",
  ].includes(path));
  for (const path of stringPaths) {
    if (typeof valueAt(config, path) !== "string") {
      throw new Error(`Deployment value must be a string: ${path}`);
    }
  }

  if (!accountIdPattern.test(config.accountId)) {
    throw new Error("Cloudflare account IDs must be 32 hexadecimal characters.");
  }
  if (config.workers.workshop.route !== null) {
    throw new Error("workers.workshop.route must remain null for the private Cybernest runtime.");
  }
  if ("router" in config.workers || "scheduler" in config.workers || "access" in config) {
    throw new Error("Public router, Scheduler, and standalone Access configuration are unsupported in Cybernest mode.");
  }
  if ("artifacts" in config.context) {
    throw new Error("Context Artifacts are not enabled in this Cybernest deployment.");
  }
  const workerNames = Object.entries(config.workers)
    .filter(([key]) => key !== "errorReporter" || config.errorReporting.enabled)
    .map(([, worker]) => worker.name);
  if (new Set(workerNames).size !== workerNames.length) {
    throw new Error(
      "Workshop, Context, and custom Gatekeeper names must be unique.");
  }
  if (!workerNames.every((name) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))) {
    throw new Error("Worker names must use lowercase letters, numbers, and hyphens.");
  }

  if (typeof config.context.sharingDomain !== "string" || !config.context.sharingDomain.trim()) {
    throw new Error("context.sharingDomain must be a stable non-empty string.");
  }

  validateAiGateway(config);

  if (typeof config.errorReporting.enabled !== "boolean") {
    throw new Error("Error reporting enabled must be a boolean.");
  }
  const release = config.errorReporting.release;
  if (release !== null && release !== undefined &&
      (typeof release !== "string" || !release.trim() || release !== release.trim())) {
    throw new Error("Error reporting release must be null or a non-padded string.");
  }

  const sampling = config.observability.headSamplingRate;
  if (typeof config.observability.enabled !== "boolean") {
    throw new Error("Observability enabled must be a boolean.");
  }
  if (typeof sampling !== "number" || sampling < 0 || sampling > 1) {
    throw new Error("Observability headSamplingRate must be between 0 and 1.");
  }
  if (typeof config.observability.logs.invocationLogs !== "boolean" ||
      typeof config.observability.traces.enabled !== "boolean") {
    throw new Error("Observability log and trace controls must be booleans.");
  }
  const traceSampling = config.observability.traces.headSamplingRate;
  if (typeof traceSampling !== "number" || traceSampling < 0 || traceSampling > 1) {
    throw new Error("Observability trace sampling must be between 0 and 1.");
  }
  return config;
}

/**
 * How the Workshop reaches AI Gateway, derived rather than configured.
 *
 * The Worker cannot discover its own account at runtime, so it cannot tell whether the gateway it
 * is pointed at is one its `WORKERS_AI` binding can reach. This script can: it holds both account
 * IDs. Everything below follows from comparing them.
 */
export interface AiGatewayPlan {
  /** The account owning the gateway, with `aiGateway.accountId: null` resolved. */
  gatewayAccountId: string;
  /** Whether the gateway lives outside the deployment's own account. */
  crossAccount: boolean;
  /** Whether `CF_AI_GATEWAY_API_TOKEN` has to be installed before the Workshop will start a chat. */
  needsToken: boolean;
  /** One sentence per reason a token is needed. Empty when the binding transport covers it all. */
  tokenReasons: string[];
}

/**
 * {@link AiGatewayPlan} for `config`, or null when the deployment advertises no model catalog.
 *
 * Both IDs are lowercased first. `accountIdPattern` accepts either case, so the same account can be
 * written two ways across `accountId` and `aiGateway.accountId`; comparing the raw strings would
 * read that as cross-account and demand a token for a gateway the binding can reach in-account.
 * Lowercase is also the form the dashboard and the API expect, so it is what the vars carry.
 */
export function aiGatewayPlan(config: DeploymentConfig): AiGatewayPlan | null {
  if (!config.aiGateway.enabled) return null;
  const deploymentAccountId = config.accountId.toLowerCase();
  const gatewayAccountId = (config.aiGateway.accountId ?? config.accountId).toLowerCase();
  const crossAccount = gatewayAccountId !== deploymentAccountId;
  const tokenReasons: string[] = [];
  if (config.aiGateway.workersAi?.mode === "direct") {
    tokenReasons.push(
      "Workers AI direct mode uses the account REST API rather than the Workers AI binding, so " +
      "CF_AI_GATEWAY_API_TOKEN is required.");
  }
  if (crossAccount) {
    tokenReasons.push(
      `aiGateway.accountId (${gatewayAccountId}) is not the deployment account, so the generated ` +
      "config sets CF_AI_GATEWAY_USE_BINDING=false: the Workers AI binding only reaches gateways " +
      "in the Worker's own account. That leaves the HTTPS transport, which needs a Run + Read " +
      "CF_AI_GATEWAY_API_TOKEN. The opt-out is a flag rather than an unbound WORKERS_AI because " +
      "webFetch's toMarkdown() runs on that binding too.");
  }
  if (config.aiGateway.providers?.includes("google")) {
    tokenReasons.push(
      "The google provider needs CF_AI_GATEWAY_API_TOKEN: pi's Google adapter refuses a custom " +
      "fetch, so Google inference cannot ride the Workers AI binding transport.");
  }
  return { gatewayAccountId, crossAccount, needsToken: tokenReasons.length > 0, tokenReasons };
}

/**
 * The deploy-time half of `AiGatewayConfig`'s constructor checks
 * (cloudflare-os/packages/workshop-backend/src/ai-gateway.ts), mirroring `resolveAiGateway()` in
 * cloudflare-os/scripts/preview/staging-config.ts. A configuration the backend would reject belongs
 * in a failed `pnpm check`, not in somebody's first chat.
 */
function validateAiGateway(config: DeploymentConfig): void {
  if (typeof config.aiGateway.enabled !== "boolean") {
    throw new Error("AI Gateway enabled must be a boolean.");
  }
  if (!config.aiGateway.enabled) return;

  const providers = config.aiGateway.providers;
  if (!Array.isArray(providers) || providers.length === 0 ||
      !providers.every((provider) => AI_GATEWAY_PROVIDERS.includes(provider))) {
    throw new Error(
      `AI Gateway providers must be a non-empty subset of ${AI_GATEWAY_PROVIDERS.join(", ")}.`);
  }

  if (config.aiGateway.accountId !== undefined && config.aiGateway.accountId !== null &&
      !accountIdPattern.test(config.aiGateway.accountId)) {
    throw new Error("aiGateway.accountId must be null or a 32-character hexadecimal Cloudflare account ID.");
  }
  const workersAi = config.aiGateway.workersAi;
  if (!workersAi || (workersAi.mode !== "direct" && workersAi.mode !== "gateway")) {
    throw new Error("aiGateway.workersAi.mode must be direct or gateway.");
  }
  if (workersAi.mode === "gateway" && !workersAi.gateway) {
    throw new Error("aiGateway.workersAi.gateway is required in gateway mode.");
  }
  if (workersAi.mode === "direct" && "gateway" in workersAi) {
    throw new Error("aiGateway.workersAi.gateway is unsupported in direct mode.");
  }
}

function setCommon(
  config: ProdWranglerConfig,
  deployment: DeploymentConfig,
  name: string,
): void {
  config.account_id = deployment.accountId;
  config.name = name;
  config.workers_dev = false;
  config.preview_urls = false;
  delete config.routes;
  config.observability = {
    ...config.observability,
    enabled: deployment.observability.enabled,
    head_sampling_rate: deployment.observability.headSamplingRate,
    logs: {
      ...config.observability?.logs,
      invocation_logs: deployment.observability.logs.invocationLogs,
    },
    traces: {
      ...config.observability?.traces,
      enabled: deployment.observability.traces.enabled,
      head_sampling_rate: deployment.observability.traces.headSamplingRate,
    },
  };
}

export function generateConfigs(config: DeploymentConfig, bases: BaseConfigs): GeneratedConfigs {
  validateConfig(config);
  const workshop = structuredClone(bases.workshop);
  const context = structuredClone(bases.context);
  const customGatekeeper = structuredClone(bases.customGatekeeper);
  const errorReporter = config.errorReporting.enabled
    ? structuredClone(bases.errorReporter)
    : undefined;

  setCommon(workshop, config, config.workers.workshop.name);
  workshop.vars = {
    ...workshop.vars,
    CYBERNEST_PRIVATE_MANAGER_RUNTIME: "true",
  };
  delete workshop.vars.ADMINS;
  delete workshop.vars.CF_ACCESS_ISS;
  delete workshop.vars.CF_ACCESS_AUD;
  for (const key of [
    "CF_AI_GATEWAY",
    "CF_AI_GATEWAY_ACCOUNT_ID",
    "CF_AI_GATEWAY_PROVIDERS",
    "CF_AI_GATEWAY_USE_BINDING",
    "CF_AI_GATEWAY_WAI",
    "CF_AI_GATEWAY_WAI_DIRECT",
  ]) delete workshop.vars[key];
  const retainedSecrets = (workshop.secrets?.required ?? [])
    .filter((secret) => secret !== "CF_AI_GATEWAY_API_TOKEN");
  if (workshop.secrets) workshop.secrets = { ...workshop.secrets, required: retainedSecrets };
  if (config.aiGateway.enabled) {
    const gateway = aiGatewayPlan(config)!;
    Object.assign(workshop.vars, {
      CF_AI_GATEWAY: config.aiGateway.name,
      CF_AI_GATEWAY_ACCOUNT_ID: gateway.gatewayAccountId,
      CF_AI_GATEWAY_PROVIDERS: config.aiGateway.providers!.join(","),
      ...(gateway.crossAccount ? { CF_AI_GATEWAY_USE_BINDING: "false" } : {}),
    });
    if (gateway.needsToken) {
      workshop.secrets = {
        ...workshop.secrets,
        required: [...new Set([...(workshop.secrets?.required ?? []), "CF_AI_GATEWAY_API_TOKEN"])],
      };
    }
    if (config.aiGateway.workersAi!.mode === "gateway") {
      workshop.vars.CF_AI_GATEWAY_WAI = config.aiGateway.workersAi!.gateway;
    } else {
      workshop.vars.CF_AI_GATEWAY_WAI_DIRECT = "true";
    }
  }
  workshop.ai = { binding: "WORKERS_AI" };
  workshop.services = [
    ...(config.errorReporting.enabled ? [{
      binding: "ERROR_REPORTER",
      service: config.workers.errorReporter!.name,
      entrypoint: "ErrorReporter",
      props: {
        service: config.workers.workshop.name,
        environment: config.errorReporting.environment,
        ...(config.errorReporting.release ? { release: config.errorReporting.release } : {}),
      },
    }] : []),
    {
      binding: "GATEKEEPER_CONTEXT",
      service: config.workers.context.name,
      entrypoint: "GatekeeperVendor",
      props: { sharingDomain: config.context.sharingDomain },
    },
    {
      binding: "GATEKEEPER_CUSTOM",
      service: config.workers.customGatekeeper.name,
      entrypoint: "GatekeeperVendor",
    },
  ];
  workshop.kv_namespaces = [
    { binding: "BLUEPRINTS", ...(config.resources.blueprintsKvNamespaceId
      ? { id: config.resources.blueprintsKvNamespaceId } : {}) },
    { binding: "AVATARS", ...(config.resources.avatarsKvNamespaceId
      ? { id: config.resources.avatarsKvNamespaceId } : {}) },
  ];
  workshop.r2_buckets = [
    { binding: "BLUEPRINT_CONTENT", ...(config.resources.blueprintContentBucket
      ? { bucket_name: config.resources.blueprintContentBucket } : {}) },
  ];
  delete workshop.assets;

  setCommon(context, config, config.workers.context.name);
  context.kv_namespaces = [
    { binding: "CONTEXT_COLLECTIONS", ...(config.context.kvNamespaceId
      ? { id: config.context.kvNamespaceId } : {}) },
  ];
  delete context.artifacts;

  setCommon(customGatekeeper, config, config.workers.customGatekeeper.name);
  customGatekeeper.vars = {
    CUSTOM_NAME: config.customGatekeeper.name,
    CUSTOM_MESSAGE: config.customGatekeeper.message,
  };
  if (errorReporter) setCommon(errorReporter, config, config.workers.errorReporter!.name);

  return { workshop, context, customGatekeeper, ...(errorReporter && { errorReporter }) };
}

// `--no-cache` goes before the task name. Everything after it is `[ADDITIONAL_ARGS]`, forwarded to
// the task's own command -- `vp run -F x build --no-cache` reaches `tsc` as an unknown option.

/** `vp run --no-cache <task>` for a package in the submodule's workspace. */
function submoduleBuild(pkg: string, task = "build"): string[] {
  return ["--dir", "cloudflare-os", "exec", "vp", "run", "-F", pkg, "--no-cache", task];
}

/** `vp run --no-cache <task>` for a package in this repository's own workspace. */
function ownBuild(pkg: string, task = "build"): string[] {
  return ["exec", "vp", "run", "-F", pkg, "--no-cache", task];
}

/**
 * The build steps `pnpm check` and `pnpm deploy` run, in order, from the repository root.
 *
 * Every one goes through `vp run` rather than `pnpm --filter <pkg> build`; upstream packages use
 * Vite+ tasks as well as scripts.
 *
 * `--no-cache` on every deploy build so the generated configs and source are always validated.
 *
 * The Workshop is built after its Gatekeeper dependencies, then deployed behind Core's private
 * Service Binding.
 */
export function buildCommands(config: DeploymentConfig): BuildCommand[] {
  return [
    { args: submoduleBuild("@gadgets/gatekeeper-context", "build:app") },
    { args: submoduleBuild("@gadgets/gatekeeper-context") },
    { args: ownBuild("custom-gatekeeper") },
    ...(config.errorReporting.enabled ? [{ args: ownBuild("error-reporter") }] : []),
    { args: submoduleBuild("@gadgets/workshop-backend") },
  ];
}

// Wrangler accepts trailing commas in JSONC base configs, so the deploy parser must too.
const jsoncOptions = { allowTrailingComma: true };

async function readJsonc<T>(path: string): Promise<T> {
  const errors: ParseError[] = [];
  const result = parse(await readFile(path, "utf8"), errors, jsoncOptions) as T;
  if (errors.length) {
    const where = relative(root, path) || path;
    throw new Error(`${where}: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
  }
  return result;
}

// Every validateConfig message names a config path, so say which file those paths live in.
async function readDeployment(path: string): Promise<DeploymentConfig> {
  const config = await readJsonc<DeploymentConfig>(path);
  try {
    return validateConfig(config);
  } catch (error) {
    throw new Error(`${relative(root, path)}: ${(error as Error).message}`, { cause: error });
  }
}

function runCommand(
  command: string,
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  label: string,
): void {
  const result = spawnSync(command, argv, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const where = relative(root, cwd) || ".";
    throw new Error(`${where}: ${label} failed. Its output is above.`);
  }
}

// Spawned through pnpmCommand rather than as a bare "pnpm": on Windows the pnpm on PATH is a `.cmd`
// shim Node refuses to spawn without a shell, and `shell: true` would re-split argv and break any
// checkout path containing a space.
function run(args: string[], cwd = root, env: NodeJS.ProcessEnv = process.env): void {
  const [command, argv] = pnpmCommand(args, env);
  runCommand(command, argv, cwd, env, `pnpm ${args.join(" ")}`);
}

/**
 * `wrangler deploy` for one package, spawned as `node <entry>` when the entry point behind the
 * `.bin` shim can be found. That saves the ~0.33s `pnpm exec` costs per call and sidesteps the
 * Windows `.cmd` shim entirely; when it cannot be resolved, the pnpm path is still there.
 */
function deployWorker(dir: string, extraArgs: string[]): void {
  const cwd = join(root, dir);
  const args = ["deploy", "--config", generatedName, ...extraArgs];
  const entry = resolveBinEntry(cwd, "wrangler");
  if (entry) {
    runCommand(process.execPath, [entry, ...args], cwd, process.env, `wrangler ${args.join(" ")}`);
  } else {
    run(["exec", "wrangler", ...args], cwd);
  }
}

function requireSubmodule(): void {
  if (!existsSync(join(root, "cloudflare-os/package.json"))) {
    throw new Error("CloudflareOS submodule is not initialized. Run git submodule update --init.");
  }
}

function build(config: DeploymentConfig): void {
  for (const { args, env } of buildCommands(config)) {
    run(args, root, env ? { ...process.env, ...env } : process.env);
  }
}

// Said once, up front, rather than discovered when the first chat throws.
function reportAiGateway(config: DeploymentConfig): void {
  const gateway = aiGatewayPlan(config);
  if (!gateway) {
    console.warn(
      "\naiGateway.enabled is false: this deployment advertises no model catalog, and each user " +
      "supplies their own model API keys. A Workshop migrated from the hosted deploy will show an " +
      "empty model picker -- see docs/migrate-from-hosted.md.");
    return;
  }
  if (!gateway.needsToken) return;
  // CLOUDFLARE_ACCOUNT_ID pins the account the way the deploys themselves are pinned: every
  // generated config carries `account_id`, but `wrangler secret put` takes only `--name`
  console.warn(
    `\nCF_AI_GATEWAY_API_TOKEN is required by this configuration:\n` +
    gateway.tokenReasons.map((reason) => `  - ${reason}`).join("\n") +
    `\nInstall it before deploying:\n  CLOUDFLARE_ACCOUNT_ID=${config.accountId} ` +
    `pnpm exec wrangler secret put CF_AI_GATEWAY_API_TOKEN ` +
    `--name ${config.workers.workshop.name}\n`);
}

async function main(): Promise<void> {
  requireSubmodule();
  const config = await readDeployment(join(root, "deployment.jsonc"));
  const generated = generateConfigs(config, {
    workshop: await readJsonc(join(root, packageDirs.workshop, "wrangler.jsonc")),
    context: await readJsonc(join(root, packageDirs.context, "wrangler.jsonc")),
    customGatekeeper: await readJsonc(join(root, packageDirs.customGatekeeper, "wrangler.jsonc")),
    errorReporter: await readJsonc(join(root, packageDirs.errorReporter, "wrangler.jsonc")),
  });
  reportAiGateway(config);

  try {
    for (const [name, generatedConfig] of Object.entries(generated)) {
      await writeFile(
        generatedPaths[name as keyof typeof generatedPaths],
        JSON.stringify(generatedConfig, null, 2) + "\n");
    }
    const check = process.argv.includes("--check");
    if (check) run(["test"]);
    build(config);
    const deployArgs = check ? ["--dry-run"] : [];
    if (config.errorReporting.enabled) {
      deployWorker(packageDirs.errorReporter, deployArgs);
    }
    deployWorker(packageDirs.context, deployArgs);
    deployWorker(packageDirs.customGatekeeper, deployArgs);
    deployWorker(packageDirs.workshop, deployArgs);
  } finally {
    await Promise.all(Object.values(generatedPaths).map((path) => rm(path, { force: true })));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    // One line, no stack: every failure here is a config or subprocess problem, not a script bug.
    console.error(`\nDeploy failed. ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
