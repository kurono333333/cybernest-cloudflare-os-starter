import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
        durableObjects: {
          CUSTOM_GATEKEEPER: { className: "CustomGatekeeper", useSQLite: true },
          INSPECTABLE_CUSTOM_GATEKEEPER: {
            className: "InspectableCustomGatekeeper",
            useSQLite: true,
          },
          TEST_FACTORY: { className: "TestGatekeeperFactory", useSQLite: true },
        },
      },
    }),
  ],
  test: { include: ["__tests__/*.test.ts"] },
});
