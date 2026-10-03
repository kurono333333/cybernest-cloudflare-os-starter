import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse, type ParseError } from "jsonc-parser";
import { generateConfigs, validateConfig } from "./deploy.ts";
import type { BaseConfigs, DeploymentConfig, ProdWranglerConfig } from "./deployment-config.ts";

const validConfig: DeploymentConfig = {
  accountId: "0123456789abcdef0123456789abcdef",
  workers: {
    workshop: { name: "acme-cloudflare-os", route: null },
    context: { name: "acme-cloudflare-os-context" },
    customGatekeeper: { name: "acme-cloudflare-os-custom" },
    errorReporter: { name: "acme-cloudflare-os-errors" },
  },
  aiGateway: {
    enabled: true,
    name: "cloudflare-os",
    accountId: "fedcba9876543210fedcba9876543210",
    providers: ["anthropic", "cloudflare"],
    workersAi: { mode: "direct" },
  },
  context: { sharingDomain: "production", kvNamespaceId: "context-kv-id" },
  customGatekeeper: { name: "Acme", message: "Use the company handbook." },
  errorReporting: { enabled: true, environment: "production", release: "abc123" },
  resources: {
    blueprintsKvNamespaceId: "blueprints-kv-id",
    avatarsKvNamespaceId: "avatars-kv-id",
    blueprintContentBucket: "cloudflare-os-blueprints",
  },
  observability: {
    enabled: true,
    headSamplingRate: 0.5,
    logs: { invocationLogs: false },
    traces: { enabled: true, headSamplingRate: 0.25 },
  },
};

function variant(mutate: (config: Record<string, any>) => void): DeploymentConfig {
  const config = structuredClone(validConfig) as Record<string, any>;
  mutate(config);
  return config as DeploymentConfig;
}

async function baseConfigs(): Promise<BaseConfigs> {
  return {
    workshop: await baseConfig("../cloudflare-os/packages/workshop-backend/wrangler.jsonc"),
    context: await baseConfig("../cloudflare-os/packages/gatekeeper-context/wrangler.jsonc"),
    customGatekeeper: await baseConfig("../packages/custom-gatekeeper/wrangler.jsonc"),
    errorReporter: await baseConfig("../packages/error-reporter/wrangler.jsonc"),
  };
}

async function baseConfig(path: string): Promise<ProdWranglerConfig> {
  const errors: ParseError[] = [];
  const result = parse(await readFile(new URL(path, import.meta.url), "utf8"), errors,
    { allowTrailingComma: true }) as ProdWranglerConfig;
  assert.deepEqual(errors, [], `${path} did not parse cleanly`);
  return result;
}

test("rejects placeholders, public routes, and malformed config", () => {
  assert.throws(() => validateConfig(variant((c) => { c.accountId = "<ACCOUNT_ID>"; })), /placeholder/i);
  assert.throws(() => validateConfig(variant((c) => {
    c.workers.workshop.route = { customDomain: "os.example.com" };
  })), /route must remain null/i);
  assert.throws(() => validateConfig(variant((c) => { c.workers.router = { name: "public-router" }; })), /Public router/i);
  assert.throws(() => validateConfig(variant((c) => { c.workers.scheduler = { name: "scheduler" }; })), /Public router/i);
  assert.throws(() => validateConfig(variant((c) => { c.access = { issuer: "https://example.com" }; })), /Public router/i);
  assert.throws(() => validateConfig(variant((c) => { c.context.artifacts = { enabled: true }; })), /Artifacts/i);
  assert.throws(() => validateConfig(variant((c) => { c.context.sharingDomain = ""; })), /sharingDomain/i);
  assert.throws(() => validateConfig(variant((c) => { c.observability.enabled = "true"; })), /boolean/i);
  assert.throws(() => validateConfig(variant((c) => {
    c.observability.traces.headSamplingRate = 2;
  })), /sampling/i);
  assert.throws(() => validateConfig(variant((c) => { c.aiGateway.providers = ["mistral"]; })), /providers/i);
  assert.throws(() => validateConfig(variant((c) => { c.aiGateway.workersAi.mode = "other"; })), /mode/i);
  assert.throws(() => validateConfig(variant((c) => { c.workers.context.name = c.workers.workshop.name; })), /unique/i);
});

test("generates private Workshop and Gatekeeper configs with existing resources", async () => {
  const generated = generateConfigs(validConfig, await baseConfigs());
  const workshop = generated.workshop;
  const vars = workshop.vars!;
  assert.equal(workshop.name, "acme-cloudflare-os");
  assert.equal(workshop.workers_dev, false);
  assert.equal(workshop.routes, undefined);
  assert.equal(workshop.preview_urls, false);
  assert.equal(vars.CYBERNEST_PRIVATE_MANAGER_RUNTIME, "true");
  assert.equal(vars.ADMINS, undefined);
  assert.equal(vars.CF_ACCESS_ISS, undefined);
  assert.equal(vars.CF_ACCESS_AUD, undefined);
  assert.equal(vars.CF_AI_GATEWAY, "cloudflare-os");
  assert.equal(vars.CF_AI_GATEWAY_PROVIDERS, "anthropic,cloudflare");
  assert.equal(vars.CF_AI_GATEWAY_WAI_DIRECT, "true");
  assert.deepEqual(workshop.secrets, { required: ["CF_AI_GATEWAY_API_TOKEN"] });
  assert.deepEqual(workshop.ai, { binding: "WORKERS_AI" });
  assert.deepEqual(workshop.services, [
    { binding: "ERROR_REPORTER", service: "acme-cloudflare-os-errors", entrypoint: "ErrorReporter",
      props: { service: "acme-cloudflare-os", environment: "production", release: "abc123" } },
    { binding: "GATEKEEPER_CONTEXT", service: "acme-cloudflare-os-context", entrypoint: "GatekeeperVendor",
      props: { sharingDomain: "production" } },
    { binding: "GATEKEEPER_CUSTOM", service: "acme-cloudflare-os-custom", entrypoint: "GatekeeperVendor" },
  ]);
  assert.equal(workshop.assets, undefined);
  assert.deepEqual(workshop.kv_namespaces, [
    { binding: "BLUEPRINTS", id: "blueprints-kv-id" }, { binding: "AVATARS", id: "avatars-kv-id" },
  ]);
  assert.deepEqual(workshop.r2_buckets, [{ binding: "BLUEPRINT_CONTENT", bucket_name: "cloudflare-os-blueprints" }]);
  assert.equal(generated.context.name, "acme-cloudflare-os-context");
  assert.equal(generated.context.kv_namespaces![0].id, "context-kv-id");
  assert.equal(generated.customGatekeeper.name, "acme-cloudflare-os-custom");
  assert.deepEqual(generated.customGatekeeper.vars, {
    CUSTOM_NAME: "Acme", CUSTOM_MESSAGE: "Use the company handbook.",
  });
  assert.equal(generated.errorReporter!.name, "acme-cloudflare-os-errors");
  assert.equal("router" in generated, false);
  assert.equal("scheduler" in generated, false);
  assert.equal(workshop.observability!.traces?.enabled, true);
  assert.equal(workshop.services!.some((service) => service.binding === "GATEKEEPER_SCHEDULER"), false);
});
