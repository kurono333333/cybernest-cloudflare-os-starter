import { dirname, resolve } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const osBackendRoot = resolve(packageRoot, "../../cloudflare-os/packages/workshop-backend");

export default defineConfig({
  plugins: [
    capnwebValidate({
      cwd: packageRoot,
      tsconfig: "tsconfig.json",
      include: ["src/**/*.ts"],
      exclude: ["__tests__/**", "node_modules/**"],
    }),
    capnwebValidate({
      cwd: osBackendRoot,
      tsconfig: "tsconfig.json",
      include: ["src/**/*.ts"],
      exclude: ["__integration__/**", "node_modules/**"],
    }),
    cloudflareTest({
      main: "./__tests__/native-approval-worker.ts",
      remoteBindings: false,
      wrangler: {
        configPath: "../../cloudflare-os/packages/workshop-backend/wrangler.jsonc",
      },
      miniflare: {
        durableObjects: {
          KNOWLEDGE_ACCOUNT_ACCESS: {
            className: "KnowledgeAccountAccess",
            useSQLite: true,
          },
          NATIVE_INSPECTABLE_CUSTOM_GATEKEEPER: {
            className: "InspectableCustomGatekeeper",
            useSQLite: true,
          },
          NATIVE_ARTICLE_ACCESS: {
            className: "NativeArticleAccess",
            useSQLite: true,
          },
          NATIVE_APPROVAL_OWNER: {
            className: "NativeApprovalOwner",
            useSQLite: true,
          },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/native-approval.test.ts"],
    testTimeout: 60_000,
  },
});
