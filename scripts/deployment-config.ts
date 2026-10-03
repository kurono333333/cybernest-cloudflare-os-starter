import type {
  BindingDecl,
  ObservabilityConfig,
  WranglerConfig,
} from "../cloudflare-os/scripts/release/manifest-lib.ts";

export type AiGatewayProvider = "anthropic" | "openai" | "google" | "cloudflare";
export const AI_GATEWAY_PROVIDERS: readonly AiGatewayProvider[] =
  ["anthropic", "openai", "google", "cloudflare"];

export interface DeploymentConfig {
  accountId: string;
  workers: {
    workshop: { name: string; route: null };
    context: { name: string };
    customGatekeeper: { name: string };
    errorReporter?: { name: string };
  };
  aiGateway: {
    enabled: boolean;
    name?: string;
    accountId?: string | null;
    providers?: AiGatewayProvider[];
    workersAi?: { mode: "direct" } | { mode: "gateway"; gateway: string };
  };
  context: { sharingDomain: string; kvNamespaceId: string | null };
  customGatekeeper: { name: string; message: string };
  errorReporting: { enabled: boolean; environment?: string; release?: string | null };
  resources: {
    blueprintsKvNamespaceId: string | null;
    avatarsKvNamespaceId: string | null;
    blueprintContentBucket: string | null;
  };
  observability: {
    enabled: boolean;
    headSamplingRate: number;
    logs: { invocationLogs: boolean };
    traces: { enabled: boolean; headSamplingRate: number };
  };
}

export interface ProdObservabilityConfig extends ObservabilityConfig {
  traces?: { enabled?: boolean; head_sampling_rate?: number };
}

export type ProdWranglerConfig =
  Omit<WranglerConfig, "observability" | "kv_namespaces" | "r2_buckets">
  & {
    kv_namespaces?: (BindingDecl & { id?: string })[];
    r2_buckets?: (BindingDecl & { bucket_name?: string })[];
    account_id?: string;
    workers_dev?: boolean;
    routes?: { pattern: string; custom_domain: boolean }[];
    preview_urls?: boolean;
    observability?: ProdObservabilityConfig;
    ai?: BindingDecl;
    secrets?: { required: string[] };
  };

export interface GeneratedConfigs {
  workshop: ProdWranglerConfig;
  context: ProdWranglerConfig;
  customGatekeeper: ProdWranglerConfig;
  errorReporter?: ProdWranglerConfig;
}

export interface BaseConfigs {
  workshop: ProdWranglerConfig;
  context: ProdWranglerConfig;
  customGatekeeper: ProdWranglerConfig;
  errorReporter: ProdWranglerConfig;
}

export interface BuildCommand {
  args: string[];
  env?: Record<string, string>;
}
