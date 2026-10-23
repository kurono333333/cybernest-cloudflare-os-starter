// Run the adopted OS as a regular Miniflare Worker while joining its real Core authority path.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, after } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const osRoot = resolve(packageRoot, "../../cloudflare-os");
const backendRoot = resolve(osRoot, "packages/workshop-backend");
const knowledgeRoot = resolve(packageRoot, "../../../../app/apps/knowledge");
const coreRoot = resolve(packageRoot, "../../../../app/apps/core");
const br04V1SnapshotRoot = resolve(knowledgeRoot, "test/support/br04-v1");
const customRequire = createRequire(join(packageRoot, "package.json"));
const osRequire = createRequire(join(backendRoot, "package.json"));
const coreRequire = createRequire(join(coreRoot, "package.json"));
const wranglerRequire = createRequire(customRequire.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { build } = wranglerRequire("esbuild");
const { parse } = wranglerRequire("jsonc-parser");
const sl02OldKnowledgeFixtureRoot = resolve(knowledgeRoot, "test/support/sl02-pre-policy");
const sl02OldKnowledgeSha256 = "0f3426cae70d75595f8039a3d4ccd66ed4a0117e133443bd0d0a2a6bc5457a7d";
const { generateKeyPair, exportJWK } = await import(osRequire.resolve("jose"));
const { Hono } = coreRequire("hono");
const { buildD03Runtime } = await import(
  pathToFileURL(join(knowledgeRoot, "test/support/d03-runtime-build.ts"))
);
const Cause = coreRequire("effect/Cause");
const Effect = coreRequire("effect/Effect");

let miniflare;
let postgres;
let knowledgeRuntimeDirectory;
let coreTestRuntimeModule;
after(async () => {
  try {
    await miniflare?.dispose();
  } finally {
    try {
      await postgres?.dispose();
    } finally {
      try {
        if (coreTestRuntimeModule) await rm(coreTestRuntimeModule, { force: true });
      } finally {
        if (knowledgeRuntimeDirectory)
          await rm(knowledgeRuntimeDirectory, { recursive: true, force: true });
      }
    }
  }
});

knowledgeRuntimeDirectory = await mkdtemp(join(tmpdir(), "cybernest-os-knowledge-"));
const fixtureModule = await build({
  stdin: {
    resolveDir: knowledgeRoot,
    loader: "ts",
    contents: `
      export { D03_SEEDS } from "./test/support/d03-fixtures.ts";
      export * as d01Fixtures from "./test/support/d01-fixtures.ts";
    `,
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "node24",
});
const fixtureModulePath = join(knowledgeRuntimeDirectory, "d03-fixtures.mjs");
await writeFile(fixtureModulePath, fixtureModule.outputFiles[0].text);
const { D03_SEEDS, d01Fixtures } = await import(pathToFileURL(fixtureModulePath));
const d03Runtime = await buildD03Runtime(knowledgeRuntimeDirectory);
const knowledgeScript = await readFile(d03Runtime.knowledgeWorker, "utf8");
const coreAuthorityGateScriptBuild = await build({
  stdin: {
    resolveDir: coreRoot,
    loader: "ts",
    contents: `
      import {
        KnowledgeAuthorityResolver as ProductKnowledgeAuthorityResolver,
        type KnowledgeAuthorityResolution,
      } from "./src/dev/entrypoint";
      export { default, KnowledgeAuthorityResolver, KnowledgeDevOperator } from "./src/dev/entrypoint";

      let br01AuthorityResolverCalls = 0;
      let authorityGateHeld = false;
      let authorityGateFirstResponseOnly = false;
      let authorityResponses = 0;

      const waitForAuthorityTick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

      export class BR01ObservedKnowledgeAuthorityResolver extends ProductKnowledgeAuthorityResolver {
        override async resolveKnowledgeAuthority(userId: unknown): Promise<KnowledgeAuthorityResolution> {
          br01AuthorityResolverCalls += 1;
          const result = await super.resolveKnowledgeAuthority(userId);
          if (!authorityGateHeld) return result;
          authorityResponses += 1;
          const responseNumber = authorityResponses;
          if (authorityGateFirstResponseOnly && responseNumber > 1) return result;
          while (authorityGateHeld) await waitForAuthorityTick();
          return result;
        }

        authorityResolverCallCount(): number {
          return br01AuthorityResolverCalls;
        }

        resetAuthorityResolverCallCount(): void {
          if (authorityGateHeld) throw new Error("BR01 authority gate must be released before reset.");
          br01AuthorityResolverCalls = 0;
          authorityResponses = 0;
        }

        holdAuthorityResolver(): void {
          if (authorityGateHeld) throw new Error("BR01 authority gate is already held.");
          authorityGateHeld = true;
          authorityGateFirstResponseOnly = false;
          authorityResponses = 0;
        }

        holdFirstAuthorityResolverResponse(): void {
          if (authorityGateHeld) throw new Error("BR01 authority gate is already held.");
          authorityGateHeld = true;
          authorityGateFirstResponseOnly = true;
          authorityResponses = 0;
        }

        async waitForAuthorityResolverResponses(target: number): Promise<void> {
          if (!Number.isSafeInteger(target) || target < 1)
            throw new Error("BR01 authority response target must be a positive safe integer.");
          while (authorityGateHeld && authorityResponses < target) await waitForAuthorityTick();
          if (authorityResponses < target)
            throw new Error("BR01 authority gate was released before the requested responses arrived.");
        }

        releaseAuthorityResolver(): void {
          authorityGateHeld = false;
          authorityGateFirstResponseOnly = false;
        }
      }
    `,
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:*", "node:*"],
  absWorkingDir: coreRoot,
});
const coreAuthorityGateScript = coreAuthorityGateScriptBuild.outputFiles[0].text;

coreTestRuntimeModule = join(
  coreRoot,
  "test/support/.os-native-worker-runtime-" + crypto.randomUUID() + ".mjs",
);
let coreTestRuntime;
try {
  await build({
    stdin: {
      resolveDir: coreRoot,
      loader: "ts",
      contents: `
      export { createDisposableRegistrationPostgres } from "./test/support/disposable-registration-postgres.ts";
      export { D03AccessProofFixture, D03_ACCESS_ISSUER, D03_ACCESS_AUDIENCE } from "./test/support/d03-access-proof-fixture.ts";
      export { assertLocalPostgresConnectionString } from "./test/support/local-postgres-test-guard.ts";
      export { createManagerOsConnectionProofRoutes } from "./src/http/manager-os-connection-proof-routes.ts";
      export { ManagerIntegrityFailure } from "./src/operator/manager-authority.ts";
    `,
    },
    bundle: true,
    write: true,
    outfile: coreTestRuntimeModule,
    format: "esm",
    platform: "node",
    target: "node24",
    external: ["node:*", "pg", "pg-native"],
  });
  coreTestRuntime = await import(pathToFileURL(coreTestRuntimeModule));
} catch (error) {
  await rm(coreTestRuntimeModule, { force: true });
  coreTestRuntimeModule = undefined;
  throw error;
}
const {
  createDisposableRegistrationPostgres,
  D03AccessProofFixture,
  D03_ACCESS_ISSUER,
  D03_ACCESS_AUDIENCE,
  assertLocalPostgresConnectionString,
  createManagerOsConnectionProofRoutes,
  ManagerIntegrityFailure,
} = coreTestRuntime;

const osConfig = parse(await readFile(join(backendRoot, "wrangler.jsonc"), "utf8"));
const customConfig = parse(await readFile(join(packageRoot, "wrangler.jsonc"), "utf8"));
const auth0Domain = "auth0.d03.invalid";
const proofIssuer = "https://proof-issuer.test.invalid";
const proofAudience = "cybernest-os-integration-test";
const proofEnvironment = "dev";
const proofDeployment = "cybernest-os-integration";
const allowedOrigin = "https://workshop.invalid";
const coreOrigin = "https://core.d03.invalid";
const br01ArticleBody =
  "---\ntype: article\ntitle: Review schedule\ndescription: Owner-confirmed project review date\nresource: https://example.invalid/review\ntags:\n  - project\n  - schedule\nsources:\n  - resource: Confirmed in project discussion\n    sourceKind: owner_note\n    confidence: 1\ntrust: 123\n---\n# Review schedule\n\nThe owner stated that the project review is scheduled for 2026-10-30.\n";
const br01SourceMessage =
  "The project review is scheduled for 2026-10-30; this date was confirmed in the project discussion.";

const sha256HexOf = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function loadBr04V1WorkerScripts() {
  const manifestBytes = await readFile(join(br04V1SnapshotRoot, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const sourceInputs = await readFile(
    join(br04V1SnapshotRoot, manifest.sourceState.sourceInputs.file),
  );
  const generatedBuildInputs = await readFile(
    join(br04V1SnapshotRoot, manifest.sourceState.generatedBuildInputs.file),
  );
  const artifactManifestBytes = await readFile(
    join(br04V1SnapshotRoot, manifest.workerArtifacts.manifest),
  );
  assert.equal(
    sha256HexOf(sourceInputs),
    manifest.sourceState.sourceInputs.sha256,
    "The frozen BR04 v1 source/lock manifest changed after capture.",
  );
  assert.equal(
    sha256HexOf(generatedBuildInputs),
    manifest.sourceState.generatedBuildInputs.sha256,
    "The frozen BR04 v1 generated build inputs changed after capture.",
  );
  assert.equal(
    sha256HexOf(artifactManifestBytes),
    manifest.workerArtifacts.sha256,
    "The frozen BR04 v1 worker artifact manifest changed after capture.",
  );
  const artifactManifest = JSON.parse(artifactManifestBytes.toString("utf8"));
  assert.equal(artifactManifest.formatVersion, manifest.workerArtifacts.formatVersion);
  assert.deepEqual(
    Object.keys(artifactManifest.artifacts).sort(),
    [...manifest.workerArtifacts.names].sort(),
  );

  const workerScripts = {};
  for (const [name, artifact] of Object.entries(artifactManifest.artifacts)) {
    const compressed = await readFile(join(br04V1SnapshotRoot, artifact.file));
    assert.equal(
      compressed.byteLength,
      artifact.compressedBytes,
      `${name} v1 compressed byte length changed.`,
    );
    assert.equal(
      sha256HexOf(compressed),
      artifact.compressedSha256,
      `${name} v1 compressed hash changed.`,
    );
    const script = gunzipSync(compressed);
    assert.equal(script.byteLength, artifact.bytes, `${name} v1 script byte length changed.`);
    assert.equal(sha256HexOf(script), artifact.sha256, `${name} v1 script hash changed.`);
    workerScripts[name] = script.toString("utf8");
  }
  return workerScripts;
}

const br04V1WorkerScripts = await loadBr04V1WorkerScripts();

function runNode(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: {
      ...process.env,
      PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
    },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${script} exited with status ${String(result.status)}.`);
  }
}

// Prepare only ignored/build outputs consumed by the Worker's published entrypoint.
runNode(
  join(osRoot, "scripts/vp/run.ts"),
  ["--filter", "@gadgets/typed-storage", "--no-cache", "build"],
  osRoot,
);
runNode(join(backendRoot, "scripts/build-browser-runtime.ts"), [], backendRoot);
runNode(join(backendRoot, "scripts/build-bundled-blueprints.ts"), [], backendRoot);

const customCapnwebCli = join(dirname(customRequire.resolve("capnweb-validate")), "cli.cjs");
const osCapnwebCli = join(dirname(osRequire.resolve("capnweb-validate")), "cli.cjs");
runNode(customCapnwebCli, ["build", "--out", ".wrangler/validate"], packageRoot);
runNode(osCapnwebCli, ["build", "--out", ".wrangler/validate"], backendRoot);

const common = {
  modules: true,
  compatibilityDate: osConfig.compatibility_date,
  compatibilityFlags: [
    ...new Set([...osConfig.compatibility_flags, "allow_irrevocable_stub_storage"]),
  ],
  outboundService: () => new Response("Network forbidden in native OS test.", { status: 503 }),
};

async function bundle(entryPoint, resolveDir) {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    absWorkingDir: resolveDir,
  });
  return result.outputFiles[0].text;
}

const workshopScript = await bundle(
  join(backendRoot, ".wrangler/validate/src/server.ts"),
  backendRoot,
);
const workshopTestScriptBuild = await build({
  stdin: {
    resolveDir: backendRoot,
    loader: "ts",
    contents: `
      import { OverseerDurableObject as ProductOverseerDurableObject } from "./.wrangler/validate/src/server.ts";
      export * from "./.wrangler/validate/src/server.ts";
      export { default } from "./.wrangler/validate/src/server.ts";

      export class OverseerDurableObject extends ProductOverseerDurableObject {
        br04RestoreGatekeeperForTest(gatekeeperId: number) {
          return this.ctx.restore({ type: "gatekeeper", gatekeeperId });
        }
      }
    `,
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:*", "node:*"],
  absWorkingDir: backendRoot,
});
const workshopTestScript = workshopTestScriptBuild.outputFiles[0].text;
const customScriptBuild = await build({
  stdin: {
    resolveDir: packageRoot,
    loader: "ts",
    contents: `
      import { CustomGatekeeper as ProductCustomGatekeeper } from "./.wrangler/validate/src/custom.ts";
      import { KnowledgeAccountAccess as ProductKnowledgeAccountAccess } from "./.wrangler/validate/src/custom.ts";
      import { WorkerEntrypoint } from "cloudflare:workers";
      export {
        CustomAccount,
        CustomVerifier,
        GatekeeperVendor,
        KnowledgeSession,
        describeCustomAccount,
        describeCustomVendor,
      } from "./.wrangler/validate/src/index.ts";
      export { default } from "./.wrangler/validate/src/index.ts";

      const BR01_ARTICLE_BODY = ${JSON.stringify(br01ArticleBody)};
      const nativeDateNow = Date.now;
      let controlledNow: number | null = null;
      let br01CallbackAckLossEnabled = true;
      Date.now = () => controlledNow ?? nativeDateNow.call(Date);
      export class BR01CustomTestClock extends WorkerEntrypoint {
        setNow(epochMilliseconds: number | null): number {
          if (epochMilliseconds !== null && (!Number.isSafeInteger(epochMilliseconds) || epochMilliseconds < 0))
            throw new Error("BR01 custom test clock requires null or a non-negative safe integer");
          controlledNow = epochMilliseconds;
          return Date.now();
        }

        setCallbackAckLossEnabled(enabled: boolean): boolean {
          if (typeof enabled !== "boolean")
            throw new Error("BR01 callback acknowledgement fixture requires a boolean.");
          br01CallbackAckLossEnabled = enabled;
          return br01CallbackAckLossEnabled;
        }
      }
      export class KnowledgeAccountAccess extends ProductKnowledgeAccountAccess {
        async inspectBronzeBindingsForTest(managerId: string, foreignManagerId: string): Promise<unknown> {
          const writer = await this.ctx.storage.get<Parameters<ProductKnowledgeAccountAccess['bindBronzeRoles']>[1]>("bronzeWriter");
          const sourceReader = await this.ctx.storage.get<Parameters<ProductKnowledgeAccountAccess['bindBronzeRoles']>[2]>("sourceReader");
          if (!writer || !sourceReader)
            return { writerInstalled: Boolean(writer), sourceReaderInstalled: Boolean(sourceReader) };
          const writerContract = await writer.assertBoundTo(managerId);
          const sourceReaderContract = await sourceReader.assertBoundTo(managerId);
          let foreignWriterRejected = false;
          let foreignSourceReaderRejected = false;
          try {
            await writer.assertBoundTo(foreignManagerId);
          } catch {
            foreignWriterRejected = true;
          }
          try {
            await sourceReader.assertBoundTo(foreignManagerId);
          } catch {
            foreignSourceReaderRejected = true;
          }
          return {
            writerInstalled: true,
            sourceReaderInstalled: true,
            writerContract,
            sourceReaderContract,
            ownerManagerAccepted: true,
            foreignWriterRejected,
            foreignSourceReaderRejected,
          };
        }

        async getBronzeActionReservationForTest(): Promise<unknown> {
          return this.ctx.storage.get("bronzeActionReservation");
        }

        async removeSourceReaderForSilverTest(): Promise<void> {
          await this.ctx.storage.delete("sourceReader");
        }

        async removeBronzeWriterForTest(managerId: string): Promise<void> {
          if (!this.ctx.id.equals(this.ctx.exports.KnowledgeAccountAccess.idFromName(managerId)))
            throw new TypeError("BR04 test fixture is bound to another Manager.");
          const writer = await this.ctx.storage.get("bronzeWriter");
          if (writer === undefined)
            throw new Error("BR04 test fixture could not find the current Bronze writer.");
          await this.ctx.storage.delete("bronzeWriter");
        }

        async armActivateBronzeActionAckLossForTest(localActionId: number): Promise<void> {
          if (!Number.isSafeInteger(localActionId) || localActionId < 0)
            throw new Error("BR01 test fixture requires a valid local action ID.");
          await this.ctx.storage.put("br01:activate-ack-loss:" + localActionId, true);
        }

        async armActivateBronzeActionPreCommitFailuresForTest(
          localActionId: number,
          failures: number,
        ): Promise<void> {
          if (!Number.isSafeInteger(localActionId) || localActionId < 0 || !Number.isSafeInteger(failures) || failures < 1)
            throw new Error("BR01 test fixture requires valid pre-commit failure inputs.");
          await this.ctx.storage.put("br01:activate-precommit-failures:" + localActionId, failures);
        }

        override async activateBronzeAction(
          managerId: string,
          reservation: Parameters<ProductKnowledgeAccountAccess["activateBronzeAction"]>[1],
          operationDeadlineMs: number,
        ): Promise<void> {
          const preCommitKey = "br01:activate-precommit-failures:" + reservation.localActionId;
          const preCommitFailures = await this.ctx.storage.get(preCommitKey);
          if (typeof preCommitFailures === "number" && Number.isSafeInteger(preCommitFailures) && preCommitFailures > 0) {
            if (preCommitFailures === 1) await this.ctx.storage.delete(preCommitKey);
            else await this.ctx.storage.put(preCommitKey, preCommitFailures - 1);
            throw new Error("BR01 test fixture failed Account activation before commit.");
          }
          await super.activateBronzeAction(managerId, reservation, operationDeadlineMs);
          const key = "br01:activate-ack-loss:" + reservation.localActionId;
          if (await this.ctx.storage.get(key) !== true) return;
          await this.ctx.storage.delete(key);
          throw new Error("BR01 test fixture lost Account activation acknowledgement after commit.");
        }

        async fenceBronzeAction(managerId: string, reservation: Parameters<ProductKnowledgeAccountAccess["fenceBronzeAction"]>[1]): Promise<void> {
          await super.fenceBronzeAction(managerId, reservation);
          const key = "br01:fence-ack-loss:" + reservation.localActionId;
          if (await this.ctx.storage.get(key) === true) return;
          await this.ctx.storage.put(key, true);
          throw new Error("BR01 test fixture lost callback acknowledgement after Knowledge fence.");
        }
      }
      export class CustomGatekeeper extends ProductCustomGatekeeper {
        async inspectBronzeBindingsForTest(managerId: string, foreignManagerId: string): Promise<unknown> {
          const account = this.ctx.exports.KnowledgeAccountAccess.getByName(managerId);
          return account.inspectBronzeBindingsForTest(managerId, foreignManagerId);
        }

        async removeSourceReaderForSilverTest(managerId: string): Promise<void> {
          const account = this.ctx.exports.KnowledgeAccountAccess.getByName(managerId);
          await account.removeSourceReaderForSilverTest();
        }

        articleActionSequenceForTest(): number {
          const rows = this.ctx.storage.sql.exec<{ next_id: number }>(
            "SELECT next_id FROM custom_gatekeeper_action_sequence WHERE id = 1",
          ).toArray();
          if (rows.length !== 1) throw new Error("BR04 test fixture could not inspect the Action ID sequence.");
          return rows[0]!.next_id;
        }

        articleStageCountForTest(): number {
          const rows = this.ctx.storage.sql.exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM custom_gatekeeper_article_actions " +
              "WHERE status IN ('pending_approval', 'applying', 'rejecting')",
          ).toArray();
          return rows[0]?.count ?? 0;
        }

        async inspectArticleStageForTest(operationId: string): Promise<unknown> {
          if (typeof operationId !== "string" || operationId.length === 0)
            throw new Error("BR04 test fixture requires an operation ID.");
          const rows = this.ctx.storage.sql.exec<{
            operation_id: string;
            operation_deadline_ms: number | null;
            command_json: string;
            payload_hash: string;
            status: string;
          }>(
            "SELECT operation_id, operation_deadline_ms, command_json, payload_hash, status " +
              "FROM custom_gatekeeper_article_actions WHERE operation_id = ?",
            operationId,
          ).toArray();
          if (rows.length !== 1) throw new Error("BR04 test fixture could not find exactly one stage.");
          return rows[0];
        }

        replaceArticleStageCommandForTest(
          operationId: string,
          commandJson: string,
          payloadHash: string,
        ): void {
          if (typeof operationId !== "string" || operationId.length === 0 ||
              typeof commandJson !== "string" || typeof payloadHash !== "string")
            throw new Error("BR04 test fixture requires a complete stage replacement.");
          const result = this.ctx.storage.sql.exec(
            "UPDATE custom_gatekeeper_article_actions SET command_json = ?, payload_hash = ? " +
              "WHERE operation_id = ? AND status = 'pending_approval'",
            commandJson,
            payloadHash,
            operationId,
          );
          if (result.rowsWritten !== 1)
            throw new Error("BR04 test fixture could not replace a pending stage.");
        }

        async applyAction(actionId: number, gitCache: unknown): Promise<void> {
          const rows = this.ctx.storage.sql.exec<{ command_json: string }>(
            "SELECT command_json FROM custom_gatekeeper_article_actions WHERE local_action_id = ?",
            actionId,
          ).toArray();
          let isTargetArticle = false;
          if (rows.length === 1 && typeof rows[0]?.command_json === "string" && rows[0].command_json.length > 0) {
            try {
              const command = JSON.parse(rows[0].command_json);
              isTargetArticle = command?.intent?.body === BR01_ARTICLE_BODY ||
                (command?.kind === "silver_policy" && command?.intent?.usePolicy === "included");
            } catch {
              isTargetArticle = false;
            }
          }

          await super.applyAction(actionId, gitCache);
          if (!br01CallbackAckLossEnabled || !isTargetArticle ||
              await this.ctx.storage.get("br01:callback-ack-loss") === true) return;
          await this.ctx.storage.put("br01:callback-ack-loss", true);
          throw new Error("BR01 test fixture lost callback acknowledgement after Knowledge save.");
        }
      }

    `,
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:*", "node:*"],
  absWorkingDir: packageRoot,
});
const customScript = customScriptBuild.outputFiles[0].text;
const br04CurrentWorkerScripts = {
  core: coreAuthorityGateScript,
  knowledge: knowledgeScript,
  workshop: workshopTestScript,
  custom: customScript,
};
const osDurableObjects = Object.fromEntries(
  osConfig.migrations
    .flatMap((migration) => migration.new_sqlite_classes ?? [])
    .map((className) => [className, { className, useSQLite: true }]),
);
const customDurableObjects = Object.fromEntries(
  customConfig.migrations
    .flatMap((migration) => migration.new_sqlite_classes ?? [])
    .map((className) => [className, { className, useSQLite: true }]),
);
const kvNamespaces = osConfig.kv_namespaces.map(({ binding }) => binding);
const r2Buckets = osConfig.r2_buckets.map(({ binding }) => binding);
const workerLoaders = Object.fromEntries(
  osConfig.worker_loaders.map(({ binding }) => [binding, {}]),
);
const knowledgeDurableObjects = {
  KNOWLEDGE: { className: "KnowledgeDO", useSQLite: true },
};
const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
const privateJwk = await exportJWK(privateKey);
const publicJwk = await exportJWK(publicKey);

const driverScript = await build({
  stdin: {
    resolveDir: packageRoot,
    loader: "ts",
    contents: `
      import { DurableObject } from "cloudflare:workers";
      import { newWebSocketRpcSession } from "capnweb";

      const KNOWLEDGE_SEEDS = ${JSON.stringify(D03_SEEDS)};
      const BR01_ARTICLE_BODY = ${JSON.stringify(br01ArticleBody)};
      const BR01_SOURCE_MESSAGE = ${JSON.stringify(br01SourceMessage)};
      const BR03_OBSERVATION_ARTICLE_BODY = "---\\ntype: article\\ntitle: Observation-backed procedure\\n---\\n# Observation-backed procedure\\n\\nThe current release checklist lives in the shared Knowledge page.\\n";
      const BR03_REVISED_ARTICLE_BODY = "---\\ntype: article\\ntitle: Observation-backed procedure\\n---\\n# Observation-backed procedure\\n\\nThe shared Knowledge page now records the revised release checklist.\\n";
      const BR03_REJECTED_ARTICLE_BODY = "---\\ntype: article\\ntitle: Rejected observation proposal\\n---\\n# Rejected observation proposal\\n\\nThis body must never be stored.\\n";

      function hasVerifiedSourceFields(fields, expected) {
        const containsExpectedSource = (value) => {
          if (!value || typeof value !== "object") return false;
          if (Array.isArray(value)) return value.some(containsExpectedSource);
          if (
            value.kind === expected.kind &&
            value.chatId === expected.chatId &&
            value.sequence === expected.sequence &&
            value.timestampMs === expected.timestampMs &&
            value.author?.type === expected.author.type &&
            value.author?.id === expected.author.id
          ) return true;
          return Object.values(value).some(containsExpectedSource);
        };
        return fields.some((field) => {
          if (field.kind !== "json") return false;
          try {
            return containsExpectedSource(JSON.parse(field.value));
          } catch {
            return false;
          }
        });
      }

      function hasVerifiedObservationFields(fields, expected) {
        const containsExpectedObservation = (value) => {
          if (!value || typeof value !== "object") return false;
          if (Array.isArray(value)) return value.some(containsExpectedObservation);
          if (
            value.version === "os-provenance-dto-v1" &&
            value.kind === "os_observation" &&
            value.actionId === expected.actionId &&
            value.gatekeeperId === expected.gatekeeperId &&
            value.createdAtMs === expected.createdAtMs &&
            value.title === expected.title &&
            value.resourceTitle === expected.resourceTitle
          ) return true;
          return Object.values(value).some(containsExpectedObservation);
        };
        return fields.some((field) => {
          if (field.kind !== "json") return false;
          try {
            return containsExpectedObservation(JSON.parse(field.value));
          } catch {
            return false;
          }
        });
      }

      export default {
        async fetch(request, env) {
          const path = new URL(request.url).pathname;
          if (request.method !== "POST" || ![
            "/boot", "/stopped", "/br01-open", "/br01-stage", "/br01-action-count", "/br01-approve",
            "/br01-policy-stage", "/br01-reject", "/br01-action-state", "/br01-close", "/br01-alarm",
            "/br01-set-test-clock", "/br01-authority-count", "/br01-authority-hold",
            "/br01-authority-hold-first-response",
            "/br01-authority-wait", "/br01-authority-release", "/br03-observe", "/br03-observation-list",
            "/br01-silver-management-activate", "/br01-silver-indexing-activate",
            "/br01-silver-alarm-observe",
            "/br03-stage-observation", "/br04-stage-inspect", "/br04-stage-replace",
            "/br04-action-sequence", "/br04-stage-count",
            "/br04-read",
            "/br04-role-bindings",
          ].includes(path)) {
            return new Response("Not found.", { status: 404 });
          }

          let socketA;
          let bootstrapA;
          let authenticatedA;
          let workspaceA;
          let knowledgeSessionA;
          let socketB;
          let bootstrapB;
          let authenticatedB;
          let workspaceB;
          let knowledgeSessionB;
          try {
            const input = await request.json();
            if (path === "/br01-authority-hold") {
              await env.CORE_AUTHORITY.holdAuthorityResolver();
              return Response.json({ held: true });
            }
            if (path === "/br01-authority-hold-first-response") {
              await env.CORE_AUTHORITY.holdFirstAuthorityResolverResponse();
              return Response.json({ held: true });
            }
            if (path === "/br01-authority-wait") {
              if (!Number.isSafeInteger(input.target) || input.target < 1)
                return Response.json({ error: "A positive authority response target is required." }, { status: 400 });
              await env.CORE_AUTHORITY.waitForAuthorityResolverResponses(input.target);
              return Response.json({ responses: input.target });
            }
            if (path === "/br01-authority-release") {
              await env.CORE_AUTHORITY.releaseAuthorityResolver();
              return Response.json({ released: true });
            }
            if (path === "/br01-set-test-clock") {
              const knowledgeNow = await env.KNOWLEDGE_TEST_CLOCK.setNow(input.now);
              const customNow = await env.CUSTOM_TEST_CLOCK.setNow(input.now);
              return Response.json({ knowledgeNow, customNow });
            }
            if ([
              "/br01-open", "/br01-stage", "/br01-policy-stage", "/br01-action-count", "/br01-approve", "/br01-reject",
              "/br01-action-state", "/br01-close", "/br03-observe",
              "/br01-silver-management-activate", "/br01-silver-indexing-activate",
              "/br03-observation-list", "/br03-stage-observation",
              "/br04-stage-inspect", "/br04-stage-replace",
              "/br04-action-sequence", "/br04-stage-count",
              "/br04-read",
              "/br04-role-bindings",
            ].includes(path)) {
              if (typeof input.managerId !== "string") {
                return Response.json({ error: "A Knowledge Manager ID is required." }, { status: 400 });
              }
              const id = env.BR01_OWNER_SESSION.idFromName(input.managerId);
              return env.BR01_OWNER_SESSION.get(id).fetch(new Request(
                "https://br01-owner.invalid" + path,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(input),
                },
              ));
            }
            if (path === "/br01-alarm") {
              if (typeof input.managerId !== "string") {
                return Response.json({ error: "A Knowledge Manager ID is required." }, { status: 400 });
              }
              const id = env.KNOWLEDGE_ALARM_INSPECTOR.idFromName(input.managerId);
              const alarm = await env.KNOWLEDGE_ALARM_INSPECTOR.get(id).inspectAlarmForTest();
              return Response.json({ alarm });
            }
            if (path === "/br01-silver-alarm-observe") {
              if (
                typeof input.managerId !== "string" ||
                !Number.isSafeInteger(input.afterCount) || input.afterCount < 0 ||
                ![1000, 5000, 10000].includes(input.timeoutMs)
              ) {
                return Response.json({ error: "A bounded alarm observation request is required." }, { status: 400 });
              }
              const id = env.KNOWLEDGE_ALARM_INSPECTOR.idFromName(input.managerId);
              const observation = await env.KNOWLEDGE_ALARM_INSPECTOR
                .get(id)
                .observeAlarmDeliveryForTest(input.afterCount, input.timeoutMs);
              return Response.json(observation);
            }
            if (path === "/br01-authority-count") {
              return Response.json({ calls: await env.CORE_AUTHORITY.authorityResolverCallCount() });
            }
            if (path === "/stopped") {
              const install = await env.CORE_OPERATOR.installKnowledgeGrant({
                accessAssertion: input.accessAssertion,
                targetUserId: input.userId,
              });
              return Response.json({
                install,
                grantCallCount: await env.KNOWLEDGE_GRANT_ISSUER_CONTROL.grantCallCount(),
                osA: await env.MANAGER_KNOWLEDGE_BRIDGE.inspectManagerKnowledge(input.managerId),
                osB: await env.MANAGER_KNOWLEDGE_BRIDGE.inspectManagerKnowledge(input.foreignManagerId),
              });
            }

            const { userId, managerId, foreignUserId, foreignManagerId } = input;
            if ([userId, managerId, foreignUserId, foreignManagerId, input.proof, input.foreignProof]
              .some((value) => typeof value !== "string")) {
              return Response.json({ error: "Canonical Users, Managers, and Core proofs are required." }, { status: 400 });
            }

            const preparedA = await env.CORE_OPERATOR.prepare({
              accessAssertion: input.accessAssertion,
              targetUserId: userId,
              seed: KNOWLEDGE_SEEDS.A,
            });
            const preparedB = await env.CORE_OPERATOR.prepare({
              accessAssertion: input.accessAssertion,
              targetUserId: foreignUserId,
              seed: KNOWLEDGE_SEEDS.B,
            });
            if (!preparedA?.ok || !preparedB?.ok) {
              throw new Error("The real Core operator could not prepare both isolated Knowledge DOs.");
            }

            const beforeProof = await env.CORE_OPERATOR.installKnowledgeGrant({
              accessAssertion: input.accessAssertion,
              targetUserId: userId,
            });
            const preflightBeforeProof = await env.MANAGER_KNOWLEDGE_BRIDGE.inspectManagerKnowledge(managerId);
            const grantCallsBeforeProof = await env.KNOWLEDGE_GRANT_ISSUER_CONTROL.grantCallCount();

            const responseB = await env.WORKSHOP.fetch(new Request("https://workshop.invalid/api", {
              headers: { Upgrade: "websocket", Origin: "${allowedOrigin}" },
            }));
            if (responseB.status !== 101 || !responseB.webSocket) {
              throw new Error("The regular OS Worker did not open B's proof-authenticated WebSocket.");
            }
            socketB = responseB.webSocket;
            socketB.accept();
            bootstrapB = newWebSocketRpcSession(socketB);
            authenticatedB = await bootstrapB.presentProof(input.foreignProof);
            const whoamiB = await authenticatedB.whoami();
            const preflightBAfterProof = await env.MANAGER_KNOWLEDGE_BRIDGE.inspectManagerKnowledge(foreignManagerId);
            const installB = await env.CORE_OPERATOR.installKnowledgeGrant({
              accessAssertion: input.accessAssertion,
              targetUserId: foreignUserId,
            });
            const preflightBAfterInstall = await env.MANAGER_KNOWLEDGE_BRIDGE.inspectManagerKnowledge(foreignManagerId);
            const bronzeInstallB = await env.CORE_OPERATOR.installKnowledgeGrant({
              accessAssertion: input.accessAssertion,
              targetUserId: foreignUserId,
            });
            const preflightBAfterBronzeInstall = await env.MANAGER_KNOWLEDGE_BRIDGE.inspectManagerKnowledge(foreignManagerId);
            workspaceB = await authenticatedB.newGadget();
            const workspaceBMetadata = await workspaceB.getMetadata();
            const knowledgeB = await workspaceB.getGatekeeperById(0);
            knowledgeSessionB = await knowledgeB.openSession();
            const readsB = {
              list: await knowledgeSessionB.list({ offset: 0, limit: 16 }),
              search: await knowledgeSessionB.search({ query: "amber", offset: 0, limit: 16 }),
              read: await knowledgeSessionB.read({ path: "concepts/only-b.md" }),
            };

            knowledgeSessionB?.[Symbol.dispose]?.();
            workspaceB?.[Symbol.dispose]?.();
            authenticatedB?.[Symbol.dispose]?.();
            bootstrapB?.[Symbol.dispose]?.();
            socketB?.close();
            knowledgeSessionB = undefined;
            workspaceB = undefined;
            authenticatedB = undefined;
            bootstrapB = undefined;
            socketB = undefined;

            const responseA = await env.WORKSHOP.fetch(new Request("https://workshop.invalid/api", {
              headers: { Upgrade: "websocket", Origin: "${allowedOrigin}" },
            }));
            if (responseA.status !== 101 || !responseA.webSocket) {
              throw new Error("The regular OS Worker did not open A's proof-authenticated WebSocket.");
            }
            socketA = responseA.webSocket;
            socketA.accept();
            bootstrapA = newWebSocketRpcSession(socketA);
            authenticatedA = await bootstrapA.presentProof(input.proof);
            const whoamiA = await authenticatedA.whoami();
            const preflightAAfterProof = await env.MANAGER_KNOWLEDGE_BRIDGE.inspectManagerKnowledge(managerId);

            const authorityB = await env.CORE_AUTHORITY.resolveKnowledgeAuthority(foreignUserId);
            if (!authorityB?.ok || authorityB.value.userId !== foreignUserId ||
                authorityB.value.managerId !== foreignManagerId) {
              throw new Error("The real Core authority resolver did not return B's canonical tuple.");
            }
            const capabilityB = await env.KNOWLEDGE_GRANT_ISSUER.issueKnowledgeGrant({
              userId: authorityB.value.userId,
              managerId: authorityB.value.managerId,
              checkedAt: Date.now(),
            });
            if (!capabilityB?.ok) throw new Error("The real Core-bound grant issuer rejected B's capability.");
            let crossManagerInstallError;
            try {
              await env.MANAGER_KNOWLEDGE_BRIDGE.ensureManagerKnowledge(managerId, capabilityB.value);
              crossManagerInstallError = null;
            } catch (error) {
              crossManagerInstallError = error instanceof Error ? error.message : String(error);
            }
            const preflightAAfterRejectedInstall = await env.MANAGER_KNOWLEDGE_BRIDGE.inspectManagerKnowledge(managerId);
            const installA = await env.CORE_OPERATOR.installKnowledgeGrant({
              accessAssertion: input.accessAssertion,
              targetUserId: userId,
            });
            const preflightAAfterInstall = await env.MANAGER_KNOWLEDGE_BRIDGE.inspectManagerKnowledge(managerId);

            workspaceA = await authenticatedA.newGadget();
            const workspaceAMetadata = await workspaceA.getMetadata();
            let crossManagerConnectCode;
            try {
              const foreignWorkspace = await authenticatedA.openGadget(workspaceBMetadata.id);
              foreignWorkspace?.[Symbol.dispose]?.();
              crossManagerConnectCode = null;
            } catch (error) {
              crossManagerConnectCode = error && typeof error === "object" && "code" in error
                ? error.code
                : error instanceof Error ? error.message : String(error);
            }

            const knowledgeA = await workspaceA.getGatekeeperById(0);
            knowledgeSessionA = await knowledgeA.openSession();
            const creationSpecA = await knowledgeA.getCreationSpec();
            const descriptionA = await knowledgeA.describe();
            const readsA = {
              list: await knowledgeSessionA.list({ offset: 0, limit: 16 }),
              search: await knowledgeSessionA.search({ query: "cobalt", offset: 0, limit: 16 }),
              foreignSearch: await knowledgeSessionA.search({ query: "amber", offset: 0, limit: 16 }),
              read: await knowledgeSessionA.read({ path: "concepts/shared.md" }),
            };
            if (input.includeNavigationPage !== false) {
              readsA.articles = await knowledgeSessionA.read({ path: "articles" });
            }
            let foreignPageReadError;
            try {
              await knowledgeSessionA.read({ path: "concepts/only-b.md" });
              foreignPageReadError = null;
            } catch (error) {
              foreignPageReadError = error instanceof Error ? error.message : String(error);
            }
            return Response.json({
              userId,
              managerId,
              foreignUserId,
              foreignManagerId,
              whoamiA,
              whoamiB,
              beforeProof,
              preflightBeforeProof,
              grantCallsBeforeProof,
              preflightBAfterProof,
              installB,
              preflightBAfterInstall,
              bronzeInstallB,
              preflightBAfterBronzeInstall,
              workspaceBId: workspaceBMetadata.id,
              readsB,
              preflightAAfterProof,
              crossManagerInstallError,
              preflightAAfterRejectedInstall,
              installA,
              preflightAAfterInstall,
              crossManagerConnectCode,
              workspaceAId: workspaceAMetadata.id,
              readsA,
              foreignPageReadError,
              creationSpecA,
              descriptionA,
              grantCallCount: await env.KNOWLEDGE_GRANT_ISSUER_CONTROL.grantCallCount(),
            });
          } catch (error) {
            return Response.json({
              error: error instanceof Error ? error.message : String(error),
            }, { status: 500 });
          } finally {
            knowledgeSessionA?.[Symbol.dispose]?.();
            workspaceA?.[Symbol.dispose]?.();
            authenticatedA?.[Symbol.dispose]?.();
            bootstrapA?.[Symbol.dispose]?.();
            socketA?.close();
            knowledgeSessionB?.[Symbol.dispose]?.();
            workspaceB?.[Symbol.dispose]?.();
            authenticatedB?.[Symbol.dispose]?.();
            bootstrapB?.[Symbol.dispose]?.();
            socketB?.close();
          }
        },
      };

      export class BR01OwnerSession extends DurableObject {
        constructor(ctx, env) {
          super(ctx, env);
          this.ctx = ctx;
          this.env = env;
          this.managerId = undefined;
          this.workspaceId = undefined;
          this.ownerSessionId = undefined;
          this.ownerIdentity = undefined;
          this.proofPresentations = 0;
          this.socket = undefined;
          this.bootstrap = undefined;
          this.authenticated = undefined;
          this.workspace = undefined;
          this.knowledgeGatekeeper = undefined;
          this.knowledgeSession = undefined;
        }

        async fetch(request) {
          const path = new URL(request.url).pathname;
          try {
            const input = await request.json();
            if (path === "/br01-open") {
              if (typeof input.managerId !== "string" || typeof input.proof !== "string" ||
                  typeof input.workspaceId !== "string") {
                return Response.json({ error: "A canonical owner proof, Manager, and workspace are required." }, { status: 400 });
              }
              await this.closeOwner();
              const ownerResponse = await this.env.WORKSHOP.fetch(new Request("https://workshop.invalid/api", {
                headers: { Upgrade: "websocket", Origin: "${allowedOrigin}" },
              }));
              if (ownerResponse.status !== 101 || !ownerResponse.webSocket) {
                throw new Error("The regular OS Worker did not open the owner's proof-authenticated WebSocket.");
              }
              this.managerId = input.managerId;
              this.workspaceId = input.workspaceId;
              this.ownerSessionId = crypto.randomUUID();
              this.socket = ownerResponse.webSocket;
              this.socket.accept();
              this.bootstrap = newWebSocketRpcSession(this.socket);
              this.authenticated = await this.bootstrap.presentProof(input.proof);
              this.ownerIdentity = await this.authenticated.whoami();
              this.proofPresentations = 1;
              this.workspace = await this.authenticated.openGadget(input.workspaceId);
              this.knowledgeGatekeeper = await this.workspace.getGatekeeperById(0);
              this.knowledgeSession = await this.knowledgeGatekeeper.openSession();
              return Response.json({
                opened: true,
                ownerSessionId: this.ownerSessionId,
                proofPresentations: this.proofPresentations,
              });
            }

            if (typeof input.managerId !== "string" || input.managerId !== this.managerId ||
                !this.workspace || !this.authenticated || !this.knowledgeSession) {
              return Response.json({ error: "The proof-authenticated owner session is not open." }, { status: 409 });
            }

            if (path === "/br01-silver-management-activate") {
              const id = this.env.KNOWLEDGE_ALARM_INSPECTOR.idFromName(input.managerId);
              const envelope = await this.env.KNOWLEDGE_ALARM_INSPECTOR
                .get(id)
                .activateSilverManagementForTest(input.managerId);
              return Response.json(envelope);
            }

            if (path === "/br01-silver-indexing-activate") {
              const id = this.env.KNOWLEDGE_ALARM_INSPECTOR.idFromName(input.managerId);
              const envelope = await this.env.KNOWLEDGE_ALARM_INSPECTOR
                .get(id)
                .activateSilverIndexingForTest(input.managerId);
              return Response.json(envelope);
            }

            if (path === "/br01-stage") {
              const sourceChatId = await this.workspace.newChat(BR01_SOURCE_MESSAGE, null);
              const sourceMessage = await this.workspace.getChatMessage(sourceChatId, 0);
              if (!sourceMessage || sourceMessage.author.type !== "user" ||
                  sourceMessage.message !== BR01_SOURCE_MESSAGE) {
                throw new Error("The owner-scoped native source message could not be verified.");
              }

              const articleBody = typeof input.articleBody === "string" ? input.articleBody : BR01_ARTICLE_BODY;
              const metadataOverflow = input.metadataOverflow === true;
              const initialUsePolicy = input.initialUsePolicy === "excluded" ? "excluded" : "included";
              const article = {
                kind: "adopt",
                body: articleBody,
                sourceSelector: {
                  kind: "chat_message",
                  chatId: sourceMessage.chatId,
                  sequence: sourceMessage.sequence,
                },
                observedTargetDescription: metadataOverflow ? "x".repeat(18_000) : "Project review schedule",
                sourceRelationshipClaim: metadataOverflow ? "y".repeat(18_000) : "The review date in this article comes from the referenced user message.",
                initialUsePolicy,
                expectedCurrentRevision: null,
              };
              const pending = await this.knowledgeSession.proposeArticle({ article });
              if (pending?.status !== "pending_approval" || typeof pending.operationId !== "string") {
                throw new Error("The native Knowledge proposal did not return a pending operation.");
              }

              const actions = await this.workspace.listActions({ filter: "pending" });
              const pendingActions = actions.entries.filter((entry) =>
                entry.type === "action" && entry.gatekeeperId === 0 && entry.state === "pending",
              );
              const action = pendingActions.find((entry) =>
                (entry.description.fields ?? []).some((field) =>
                  field.kind === "text" && field.value === articleBody,
                ),
              );
              if (!action) throw new Error("The native proposal did not create a pending owner Action.");
              const fields = action.description.fields ?? [];
              const verifiedSource = {
                kind: "chat_message",
                chatId: sourceMessage.chatId,
                sequence: sourceMessage.sequence,
                timestampMs: sourceMessage.timestamp.getTime(),
                author: {
                  type: sourceMessage.author.type,
                  id: sourceMessage.author.id,
                },
              };
              return Response.json({
                status: pending.status,
                operationId: pending.operationId,
                proposalResultContainsManagerId: JSON.stringify(pending).includes(this.managerId),
                actionId: action.id,
                sourceMetadataVerified: sourceMessage.chatId === sourceChatId &&
                  Number.isSafeInteger(sourceMessage.sequence) &&
                  Number.isSafeInteger(sourceMessage.timestamp.getTime()) &&
                  sourceMessage.author.type === "user" &&
                  typeof sourceMessage.author.id === "string" &&
                  sourceMessage.author.id === this.ownerIdentity?.id,
                actionDescriptionComplete: action.description.descriptionIsComplete === true,
                noTruncatedFields: fields.every((field) => field.truncated === undefined),
                exactBodyPresented: fields.some((field) =>
                  field.kind === "text" && field.value === articleBody,
                ),
                initialUsePolicyPresented: fields.some((field) => {
                  if (field.kind !== "json") return false;
                  try {
                    return JSON.parse(field.value).initialUsePolicy === initialUsePolicy;
                  } catch {
                    return false;
                  }
                }),
                verifiedSource,
                verifiedSourcePresented: hasVerifiedSourceFields(fields, verifiedSource),
                ownerSessionId: this.ownerSessionId,
                proofPresentations: this.proofPresentations,
              });
            }

            if (path === "/br01-policy-stage") {
              const before = await this.workspace.listActions({ filter: "all" });
              const existingActionIds = new Set(before.entries
                .filter((entry) => entry.type === "action" && entry.gatekeeperId === 0)
                .map((entry) => entry.id));
              const policyInput = {
                articleId: input.articleId,
                usePolicy: input.usePolicy,
                expectedMetadataRevision: input.expectedMetadataRevision,
              };
              const pending = await this.knowledgeSession.proposeArticlePolicy(policyInput);
              if (pending?.status !== "pending_approval" || typeof pending.operationId !== "string") {
                throw new Error("The native Knowledge policy proposal did not return a pending operation.");
              }
              const actions = await this.workspace.listActions({ filter: "pending" });
              const createdActions = actions.entries.filter((entry) =>
                entry.type === "action" && entry.gatekeeperId === 0 && entry.state === "pending" &&
                !existingActionIds.has(entry.id),
              );
              if (createdActions.length !== 1)
                throw new Error("The native policy proposal must create exactly one pending owner Action.");
              return Response.json({
                status: pending.status,
                operationId: pending.operationId,
                actionId: createdActions[0].id,
                nativeInputKeys: Object.keys(policyInput).sort(),
                proposalResultContainsManagerId: JSON.stringify(pending).includes(this.managerId),
                ownerSessionId: this.ownerSessionId,
              });
            }

            if (path === "/br01-action-count") {
              const actions = await this.workspace.listActions({ filter: "all" });
              const ownerActions = actions.entries.filter((entry) =>
                entry.type === "action" && entry.gatekeeperId === 0,
              );
              return Response.json({
                pending: ownerActions.filter((entry) => entry.state === "pending").length,
                total: ownerActions.length,
              });
            }

            if (path === "/br03-observe") {
              const before = await this.workspace.listActions({ filter: "all" });
              const priorObservationKeys = new Set(before.entries
                .filter((entry) => entry.type === "observation")
                .map((entry) => entry.gatekeeperId + ":" + entry.id));
              const read = await this.knowledgeSession.read({ path: "concepts/shared.md" });
              const after = await this.workspace.listActions({ filter: "all" });
              const created = after.entries.filter((entry) =>
                entry.type === "observation" &&
                !priorObservationKeys.has(entry.gatekeeperId + ":" + entry.id),
              );
              if (created.length !== 1) {
                throw new Error("A real Knowledge read must create exactly one new native observation log entry.");
              }
              const action = created[0];
              const createdAtMs = action.createdAt instanceof Date ? action.createdAt.getTime() : NaN;
              if (
                !Number.isSafeInteger(action.id) || action.id < 0 ||
                !Number.isSafeInteger(action.gatekeeperId) || action.gatekeeperId < 0 ||
                !Number.isSafeInteger(createdAtMs) || createdAtMs < 0 ||
                typeof action.description?.title !== "string" ||
                typeof action.resourceTitle !== "string"
              ) {
                throw new Error("The native observation log entry is missing verified provenance metadata.");
              }
              return Response.json({
                source: {
                  kind: "os_observation",
                  actionId: action.id,
                  gatekeeperId: action.gatekeeperId,
                  createdAtMs,
                  title: action.description.title,
                  resourceTitle: action.resourceTitle,
                },
                read: { path: read.path, bundleId: read.bundleId, versionId: read.versionId },
                ownerSessionId: this.ownerSessionId,
                proofPresentations: this.proofPresentations,
              });
            }

            if (path === "/br03-observation-list") {
              const actions = await this.workspace.listActions({ filter: "all" });
              return Response.json({
                observations: actions.entries
                  .filter((entry) => entry.type === "observation")
                  .filter((entry) => Number.isSafeInteger(entry.gatekeeperId))
                  .map((entry) => ({ actionId: entry.id, gatekeeperId: entry.gatekeeperId })),
                actionCount: actions.entries.filter((entry) => entry.type === "action").length,
                ownerSessionId: this.ownerSessionId,
              });
            }

            if (path === "/br03-stage-observation") {
              if (
                !Number.isSafeInteger(input.sourceActionId) || input.sourceActionId < 0 ||
                !Number.isSafeInteger(input.sourceGatekeeperId) || input.sourceGatekeeperId < 0 ||
                (input.kind !== "adopt" && input.kind !== "revise")
              ) {
                return Response.json({ error: "A native observation source and article intent are required." }, { status: 400 });
              }
              const isAdopt = input.kind === "adopt";
              if (!isAdopt && (typeof input.articleId !== "string" || typeof input.expectedCurrentRevision !== "string")) {
                return Response.json({ error: "A revise proposal requires its article and current revision selectors." }, { status: 400 });
              }
              const body = isAdopt
                ? BR03_OBSERVATION_ARTICLE_BODY
                : BR03_REVISED_ARTICLE_BODY;
              const article = isAdopt ? {
                kind: "adopt",
                body,
                sourceSelector: {
                  kind: "os_observation",
                  actionId: input.sourceActionId,
                  gatekeeperId: input.sourceGatekeeperId,
                },
                observedTargetDescription: "Shared release checklist",
                sourceRelationshipClaim: "This article records the checklist observed in the referenced Knowledge read.",
                initialUsePolicy: "included",
                expectedCurrentRevision: null,
              } : {
                kind: "revise",
                articleId: input.articleId,
                body,
                sourceSelector: {
                  kind: "os_observation",
                  actionId: input.sourceActionId,
                  gatekeeperId: input.sourceGatekeeperId,
                },
                observedTargetDescription: "Shared release checklist",
                sourceRelationshipClaim: "This revision reflects the checklist observed in the referenced Knowledge read.",
                expectedCurrentRevision: input.expectedCurrentRevision,
              };
              const pending = await this.knowledgeSession.proposeArticle({ article });
              if (pending?.status !== "pending_approval" || typeof pending.operationId !== "string") {
                throw new Error("The native observation-backed Knowledge proposal did not return a pending operation.");
              }
              const actions = await this.workspace.listActions({ filter: "pending" });
              const action = actions.entries.find((entry) =>
                entry.type === "action" && entry.state === "pending" &&
                (entry.description.fields ?? []).some((field) => field.kind === "text" && field.value === body),
              );
              if (!action) throw new Error("The observation-backed proposal did not create a pending native owner Action.");
              const fields = action.description.fields ?? [];
              const observations = await this.workspace.listActions({ filter: "all" });
              const sourceLog = observations.entries.find((entry) =>
                entry.type === "observation" && entry.id === input.sourceActionId &&
                entry.gatekeeperId === input.sourceGatekeeperId,
              );
              const expectedSource = sourceLog?.type === "observation" ? {
                kind: "os_observation",
                actionId: sourceLog.id,
                gatekeeperId: sourceLog.gatekeeperId,
                createdAtMs: sourceLog.createdAt instanceof Date ? sourceLog.createdAt.getTime() : NaN,
                title: sourceLog.description.title,
                resourceTitle: sourceLog.resourceTitle,
              } : undefined;
              return Response.json({
                status: pending.status,
                operationId: pending.operationId,
                actionId: action.id,
                body,
                kind: article.kind,
                articleId: article.kind === "revise" ? article.articleId : undefined,
                expectedCurrentRevision: article.kind === "revise" ? article.expectedCurrentRevision : undefined,
                ownerSessionId: this.ownerSessionId,
                proofPresentations: this.proofPresentations,
                proposalResultContainsManagerId: JSON.stringify(pending).includes(this.managerId),
                actionDescriptionComplete: action.description.descriptionIsComplete === true,
                noTruncatedFields: fields.every((field) => field.truncated === undefined),
                exactBodyPresented: fields.some((field) => field.kind === "text" && field.value === body),
                verifiedSource: expectedSource,
                verifiedSourcePresented: expectedSource !== undefined &&
                  hasVerifiedObservationFields(fields, expectedSource),
              });
            }

            if (path === "/br04-stage-inspect") {
              if (typeof input.operationId !== "string")
                return Response.json({ error: "A staged operation ID is required." }, { status: 400 });
              const gatekeeper = await this.br04GatekeeperForTest();
              return Response.json(await gatekeeper.inspectArticleStageForTest(input.operationId));
            }

            if (path === "/br04-stage-replace") {
              if (typeof input.operationId !== "string" || typeof input.commandJson !== "string" ||
                  typeof input.payloadHash !== "string")
                return Response.json({ error: "A complete staged command replacement is required." }, { status: 400 });
              const gatekeeper = await this.br04GatekeeperForTest();
              await gatekeeper.replaceArticleStageCommandForTest(
                input.operationId,
                input.commandJson,
                input.payloadHash,
              );
              return Response.json({ replaced: true });
            }

            if (path === "/br04-action-sequence") {
              const gatekeeper = await this.br04GatekeeperForTest();
              return Response.json({ nextId: await gatekeeper.articleActionSequenceForTest() });
            }

            if (path === "/br04-stage-count") {
              const gatekeeper = await this.br04GatekeeperForTest();
              return Response.json({ count: await gatekeeper.articleStageCountForTest() });
            }

            if (path === "/br04-read") {
              if (input.searchInput !== undefined || input.readPath !== undefined) {
                const search = await this.knowledgeSession.search(input.searchInput);
                try {
                  const read = await this.knowledgeSession.read({ path: input.readPath });
                  return Response.json({ search, read, readError: null });
                } catch (error) {
                  return Response.json({
                    search,
                    read: null,
                    readError: error instanceof Error ? error.message : String(error),
                  });
                }
              }
              const list = await this.knowledgeSession.list({ offset: 0, limit: 16 });
              const search = await this.knowledgeSession.search({ query: "amber", offset: 0, limit: 16 });
              const read = await this.knowledgeSession.read({ path: "concepts/only-b.md" });
              return Response.json({ list, search, read });
            }

            if (path === "/br04-role-bindings") {
              if (typeof input.foreignManagerId !== "string")
                return Response.json({ error: "A comparison Manager ID is required." }, { status: 400 });
              const gatekeeper = await this.br04GatekeeperForTest();
              return Response.json(await gatekeeper.inspectBronzeBindingsForTest(
                this.managerId,
                input.foreignManagerId,
              ));
            }

            if (path === "/br01-approve" || path === "/br01-reject") {
              if (!Number.isSafeInteger(input.actionId)) {
                return Response.json({ error: "A pending native Action ID is required." }, { status: 400 });
              }
              if (path === "/br01-approve") {
                await this.workspace.approveAction(input.actionId);
              } else {
                await this.workspace.rejectAction(input.actionId);
              }
            }

            if (path === "/br01-action-state") {
              const actions = await this.workspace.listActions({ filter: "all" });
              const action = actions.entries.find((entry) =>
                entry.type === "action" && entry.id === input.actionId && entry.gatekeeperId === 0,
              );
              return Response.json({
                state: action?.state ?? null,
                ownerSessionId: this.ownerSessionId,
                proofPresentations: this.proofPresentations,
              });
            }

            if (path === "/br01-approve" || path === "/br01-reject") {
              const actions = await this.workspace.listActions({ filter: "all" });
              const action = actions.entries.find((entry) =>
                entry.type === "action" && entry.id === input.actionId && entry.gatekeeperId === 0,
              );
              const reads = path === "/br01-approve" ? {
                list: await this.knowledgeSession.list({ offset: 0, limit: 16 }),
                search: await this.knowledgeSession.search({ query: "amber", offset: 0, limit: 16 }),
                read: await this.knowledgeSession.read({ path: "concepts/only-b.md" }),
              } : undefined;
              return Response.json({
                actionState: action?.state ?? null,
                actionWasAutomatic: action?.autoApproved === true,
                reads,
                ownerSessionId: this.ownerSessionId,
                proofPresentations: this.proofPresentations,
              });
            }

            if (path === "/br01-close") {
              await this.closeOwner();
              return Response.json({ closed: true });
            }

            return new Response("Not found.", { status: 404 });
          } catch (error) {
            return Response.json({
              error: error instanceof Error ? error.message : String(error),
              code: error && typeof error === "object" && "code" in error ? error.code : null,
              ownerSessionId: this.ownerSessionId,
              proofPresentations: this.proofPresentations,
            }, { status: 500 });
          }
        }

        async closeOwner() {
          const cleanupErrors = [];
          try {
            for (const resource of [
              this.knowledgeSession,
              this.knowledgeGatekeeper,
              this.workspace,
              this.authenticated,
              this.bootstrap,
            ]) {
              try {
                resource?.[Symbol.dispose]?.();
              } catch (error) {
                cleanupErrors.push(error);
              }
            }
          } finally {
            try {
              this.socket?.close();
            } catch (error) {
              cleanupErrors.push(error);
            } finally {
              this.managerId = undefined;
            this.workspaceId = undefined;
              this.ownerSessionId = undefined;
              this.ownerIdentity = undefined;
              this.proofPresentations = 0;
              this.socket = undefined;
              this.bootstrap = undefined;
              this.authenticated = undefined;
              this.workspace = undefined;
              this.knowledgeGatekeeper = undefined;
              this.knowledgeSession = undefined;
            }
          }
          if (cleanupErrors.length > 0) {
            throw new AggregateError(cleanupErrors, "The BR01 owner session did not close cleanly.");
          }
        }

        async br04GatekeeperForTest() {
          if (typeof this.workspaceId !== "string")
            throw new Error("The BR04 test owner session has no workspace ID.");
          const overseer = this.env.OVERSEER_TEST.get(
            this.env.OVERSEER_TEST.idFromString(this.workspaceId),
          );
          return await overseer.br04RestoreGatekeeperForTest(0);
        }
      }
    `,
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:*", "node:*"],
});

const service = (name, entrypoint) => (entrypoint === undefined ? { name } : { name, entrypoint });
const compatibilityFlags = [
  "nodejs_compat",
  "enable_ctx_exports",
  "allow_irrevocable_stub_storage",
];

function workerHyperdriveUrl(connectionString) {
  assertLocalPostgresConnectionString(connectionString);
  const url = new URL(connectionString);
  url.password = "cybernest-local-hyperdrive-only";
  return url.toString();
}

function createProofApp(identity, events = undefined) {
  const auth0Identity = { iss: identity.iss, sub: identity.sub };
  const app = new Hono();
  app.use("*", async (context, next) => {
    context.set("auth0", {
      user: auth0Identity,
      session: {
        user: auth0Identity,
        idToken: undefined,
        refreshToken: undefined,
        tokenSets: [],
      },
      org: null,
    });
    return next();
  });
  const failureObserver =
    events === undefined
      ? undefined
      : ({ phase, cause }) => Effect.sync(() => events.push({ phase, cause }));
  app.route(
    "/",
    createManagerOsConnectionProofRoutes(failureObserver === undefined ? {} : { failureObserver }),
  );
  return app;
}

function coreProofBindings(connectionString) {
  return {
    APP_ENV: "dev",
    APP_ORIGIN: coreOrigin,
    AUTH0_DOMAIN: auth0Domain,
    OPERATOR_DB: { connectionString },
    CYBERNEST_OS_PROOF_PRIVATE_JWK: JSON.stringify(privateJwk),
    CYBERNEST_OS_PROOF_ISSUER: proofIssuer,
    CYBERNEST_OS_PROOF_AUDIENCE: proofAudience,
    CYBERNEST_OS_PROOF_DEPLOYMENT: proofDeployment,
  };
}

async function issueCoreProof(identity, connectionString, events = undefined) {
  const request = new Request(coreOrigin + "/os/connection-proof", {
    method: "POST",
    headers: {
      host: new URL(coreOrigin).host,
      origin: coreOrigin,
      "content-type": "application/json",
    },
    body: "{}",
  });
  const response = await createProofApp(identity, events).request(
    request,
    undefined,
    coreProofBindings(connectionString),
  );
  const body = await response.text();
  if (response.status !== 200) return { response, body };
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Core proof route returned invalid JSON.");
  }
  if (typeof parsed.proof !== "string") throw new Error("Core proof route omitted its proof.");
  return { response, body, proof: parsed.proof };
}

async function seedCanonicalIdentity(database, identity) {
  await database.query("BEGIN");
  try {
    await database.query("INSERT INTO operator.identity_users (id, status) VALUES ($1, 'active')", [
      identity.userId,
    ]);
    await database.query(
      "INSERT INTO operator.identity_managers (id, status) VALUES ($1, 'active')",
      [identity.managerId],
    );
    await database.query(
      `INSERT INTO operator.identity_manager_ownerships (user_id, manager_id, role, status, is_default)
       VALUES ($1, $2, 'owner', 'active', true)`,
      [identity.userId, identity.managerId],
    );
    await database.query(
      `INSERT INTO operator.identity_mappings (id, issuer, subject, user_id, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [crypto.randomUUID(), identity.iss, identity.sub, identity.userId],
    );
    await database.query("COMMIT");
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  }
}

function createMiniflareOptions(
  connectionString,
  accessFixture,
  {
    workerScripts = {},
    resourcePersistencePath,
    coreServiceBindingOverrides = {},
    knowledgeServiceBindingOverrides = {},
  } = {},
) {
  const localHyperdrive = workerHyperdriveUrl(connectionString);
  const customWorkerScript = workerScripts.custom ?? customScript;
  const coreWorker = {
    ...common,
    name: "core",
    script: workerScripts.core ?? coreAuthorityGateScript,
    compatibilityDate: "2026-10-01",
    compatibilityFlags,
    hyperdrives: { OPERATOR_DB: localHyperdrive },
    bindings: {
      APP_ENV: "dev",
      ACCESS_ISSUER: D03_ACCESS_ISSUER,
      ACCESS_AUDIENCE: D03_ACCESS_AUDIENCE,
    },
    serviceBindings: {
      KNOWLEDGE_PREPARATION: service("knowledge", "OwnedKnowledgePreparation"),
      KNOWLEDGE_GRANT_ISSUER: service("knowledge", "D03OwnedKnowledgeGrantIssuer"),
      KNOWLEDGE_BRONZE_GRANT_ISSUER: service("knowledge", "OwnedKnowledgeBronzeGrantIssuer"),
      MANAGER_KNOWLEDGE_BRIDGE: service("workshop", "ManagerKnowledgeBridge"),
      ...coreServiceBindingOverrides,
    },
    outboundService: (request) => accessFixture.fetch(request),
  };
  return convertV4MiniflareOptions({
    unsafeInspectDurableObjects: true,
    ...(resourcePersistencePath === undefined ? {} : { resourcePersistencePath }),
    workers: [
      {
        ...common,
        name: "driver",
        script: workerScripts.driver ?? driverScript.outputFiles[0].text,
        durableObjects: {
          BR01_OWNER_SESSION: {
            className: "BR01OwnerSession",
          },
          KNOWLEDGE_ALARM_INSPECTOR: {
            className: "KnowledgeDO",
            scriptName: "knowledge",
            useSQLite: true,
          },
          OVERSEER_TEST: {
            className: "OverseerDurableObject",
            scriptName: "workshop",
            useSQLite: true,
          },
        },
        serviceBindings: {
          WORKSHOP: service("workshop"),
          MANAGER_KNOWLEDGE_BRIDGE: service("workshop", "ManagerKnowledgeBridge"),
          CORE_OPERATOR: service("core", "KnowledgeDevOperator"),
          CORE_AUTHORITY: service("core", "BR01ObservedKnowledgeAuthorityResolver"),
          KNOWLEDGE_GRANT_ISSUER: service("knowledge", "D03OwnedKnowledgeGrantIssuer"),
          KNOWLEDGE_GRANT_ISSUER_CONTROL: service("knowledge", "D03OwnedKnowledgeGrantIssuer"),
          KNOWLEDGE_TEST_CLOCK: service("knowledge", "D03KnowledgeTestClock"),
          KNOWLEDGE_BR01_TEST_CONTROL: service("knowledge", "D03KnowledgeBr01TestControl"),
          CUSTOM_TEST_CLOCK: service("custom", "BR01CustomTestClock"),
        },
      },
      {
        ...common,
        name: "workshop",
        script: workerScripts.workshop ?? workshopTestScript,
        durableObjects: osDurableObjects,
        serviceBindings: {
          GATEKEEPER_CUSTOM: service("custom", "GatekeeperVendor"),
        },
        kvNamespaces,
        r2Buckets,
        workerLoaders,
        bindings: {
          CYBERNEST_PRIVATE_MANAGER_RUNTIME: "true",
          PUBLIC_BASE_URL: allowedOrigin + "/",
          CYBERNEST_OS_PROOF_PUBLIC_JWK: JSON.stringify(publicJwk),
          CYBERNEST_OS_PROOF_ISSUER: proofIssuer,
          CYBERNEST_OS_PROOF_AUDIENCE: proofAudience,
          CYBERNEST_OS_PROOF_ENVIRONMENT: proofEnvironment,
          CYBERNEST_OS_PROOF_DEPLOYMENT: proofDeployment,
          CYBERNEST_OS_ALLOWED_ORIGINS: JSON.stringify([allowedOrigin]),
        },
      },
      {
        ...common,
        name: "custom",
        compatibilityDate: customConfig.compatibility_date,
        compatibilityFlags: [
          ...new Set([...customConfig.compatibility_flags, "allow_irrevocable_stub_storage"]),
        ],
        script: customWorkerScript,
        durableObjects: customDurableObjects,
      },
      {
        ...common,
        name: "knowledge",
        ...(workerScripts.knowledge === undefined
          ? { rootPath: knowledgeRuntimeDirectory, scriptPath: "knowledge.mjs" }
          : { script: workerScripts.knowledge }),
        compatibilityDate: "2026-10-01",
        compatibilityFlags: [...compatibilityFlags, "new_module_registry"],
        bindings: { APP_ENV: "dev", APP_ORIGIN: "https://knowledge.d03.invalid" },
        durableObjects: knowledgeDurableObjects,
        r2Buckets: ["KNOWLEDGE_BRONZE_BUCKET"],
        serviceBindings: {
          KNOWLEDGE_AUTHORITY: service("core", "BR01ObservedKnowledgeAuthorityResolver"),
          ...knowledgeServiceBindingOverrides,
        },
        outboundService: (request) => accessFixture.fetch(request),
      },
      ...(workerScripts.knowledgeLegacy === undefined
        ? []
        : [
            {
              ...common,
              name: "knowledge-legacy",
              script: workerScripts.knowledgeLegacy,
              compatibilityDate: "2026-10-01",
              compatibilityFlags: [...compatibilityFlags, "new_module_registry"],
              bindings: { APP_ENV: "dev", APP_ORIGIN: "https://knowledge-legacy.d03.invalid" },
              durableObjects: knowledgeDurableObjects,
              r2Buckets: ["KNOWLEDGE_BRONZE_BUCKET"],
              serviceBindings: {
                KNOWLEDGE_AUTHORITY: service("core", "BR01ObservedKnowledgeAuthorityResolver"),
              },
              outboundService: (request) => accessFixture.fetch(request),
            },
          ]),
      coreWorker,
    ],
  });
}

function createMiniflare(connectionString, accessFixture, options = {}) {
  return new Miniflare(createMiniflareOptions(connectionString, accessFixture, options));
}

function auth0Identity(subject, userId, managerId) {
  return {
    iss: "https://" + auth0Domain + "/",
    sub: subject,
    userId,
    managerId,
  };
}

async function doStorageState(managerId) {
  const storage = await miniflare.unsafeGetDurableObjectStorage("knowledge", "KnowledgeDO", {
    name: managerId,
  });
  return storage.exec("SELECT * FROM knowledge_state");
}

async function knowledgeDatabaseSnapshot(targetMiniflare, managerId, workerName = "knowledge") {
  const storage = await targetMiniflare.unsafeGetDurableObjectStorage(workerName, "KnowledgeDO", {
    name: managerId,
  });
  const tables = await storage.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const snapshot = {};
  for (const { name } of tables) {
    const quotedName = `"${name.replaceAll('"', '""')}"`;
    const columns = await storage.exec(`PRAGMA table_info(${quotedName})`);
    snapshot[name] = {
      columns: columns.map(({ name: columnName }) => columnName),
      rows: await storage.exec(`SELECT * FROM ${quotedName}`),
    };
  }
  return snapshot;
}

async function knowledgeArticlePolicySnapshot(targetMiniflare, managerId, articleId) {
  const storage = await targetMiniflare.unsafeGetDurableObjectStorage("knowledge", "KnowledgeDO", {
    name: managerId,
  });
  const rows = await storage.exec(
    "SELECT article_id, use_policy, metadata_revision FROM knowledge_articles WHERE article_id = ?",
    articleId,
  );
  assert.equal(rows.length, 1);
  return rows[0];
}

async function bronzeActionReservation(targetMiniflare, managerId) {
  const namespace = await targetMiniflare.getDurableObjectNamespace(
    "KnowledgeAccountAccess",
    "custom",
  );
  const stub = namespace.get(namespace.idFromName(managerId));
  const reservation = await stub.getBronzeActionReservationForTest();
  return reservation === undefined ? undefined : JSON.parse(JSON.stringify(reservation));
}

async function armBronzeActivateAckLoss(targetMiniflare, managerId, localActionId) {
  const namespace = await targetMiniflare.getDurableObjectNamespace(
    "KnowledgeAccountAccess",
    "custom",
  );
  await namespace
    .get(namespace.idFromName(managerId))
    .armActivateBronzeActionAckLossForTest(localActionId);
}

async function armBronzeActivatePreCommitFailures(
  targetMiniflare,
  managerId,
  localActionId,
  failures,
) {
  const namespace = await targetMiniflare.getDurableObjectNamespace(
    "KnowledgeAccountAccess",
    "custom",
  );
  await namespace
    .get(namespace.idFromName(managerId))
    .armActivateBronzeActionPreCommitFailuresForTest(localActionId, failures);
}

async function knowledgeAlarm(targetMiniflare, managerId) {
  const response = await targetMiniflare.dispatchFetch("https://driver.invalid/br01-alarm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ managerId }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result.alarm;
}

async function knowledgeAuthorityResolverCallCount(targetMiniflare) {
  const response = await targetMiniflare.dispatchFetch(
    "https://driver.invalid/br01-authority-count",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(Number.isSafeInteger(result.calls), true);
  return result.calls;
}

async function holdBr01AuthorityResolver(targetMiniflare) {
  const result = await postNative(targetMiniflare, "/br01-authority-hold", {});
  assert.equal(result.response.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.held, true);
}

async function holdFirstBr01AuthorityResolverResponse(targetMiniflare) {
  const result = await postNative(targetMiniflare, "/br01-authority-hold-first-response", {});
  assert.equal(result.response.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.held, true);
}

async function waitForBr01AuthorityResolverResponses(targetMiniflare, target = 1) {
  const result = await postNative(targetMiniflare, "/br01-authority-wait", { target });
  assert.equal(result.response.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.responses, target);
}

async function releaseBr01AuthorityResolver(targetMiniflare) {
  const result = await postNative(targetMiniflare, "/br01-authority-release", {});
  assert.equal(result.response.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.released, true);
}

function requireKnowledgeTable(snapshot, name, requiredColumns) {
  const table = snapshot[name];
  assert.ok(table, `The real Knowledge SQLite schema is missing ${name}.`);
  for (const column of requiredColumns) {
    assert.equal(
      table.columns.includes(column),
      true,
      `The real ${name} table is missing required column ${column}.`,
    );
  }
  return table;
}

function requireSilverArticle(snapshot, articleId) {
  const table = requireKnowledgeTable(snapshot, "knowledge_articles", [
    "article_id",
    "current_revision_id",
    "use_policy",
    "metadata_revision",
    "policy_receipt_json",
    "policy_control_json",
  ]);
  const article = table.rows.find((row) => row.article_id === articleId);
  assert.ok(article, `The real Knowledge article ${articleId} is missing from SQLite.`);
  return article;
}

function assertKnowledgeAndR2Unchanged(before, after) {
  assert.deepEqual(
    after.knowledge,
    before.knowledge,
    "A refused Silver callback must leave the real Knowledge SQLite state unchanged.",
  );
  assert.deepEqual(
    after.objects,
    before.objects,
    "A refused Silver callback must leave private R2 objects unchanged.",
  );
  assert.equal(after.objectsTruncated, before.objectsTruncated);
}

function knowledgeWriteInvariantSnapshot(snapshot) {
  const projectRows = (name, fields) => {
    const table = snapshot[name];
    if (!table) return null;
    return table.rows
      .map((row) => Object.fromEntries(fields.map((field) => [field, row[field]])))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  };
  return {
    currentArticles: projectRows("knowledge_articles", [
      "article_id",
      "current_revision_id",
      "use_policy",
      "metadata_revision",
      "policy_receipt_json",
    ]),
    immutableRevisions: projectRows("knowledge_article_revisions", [
      "article_id",
      "revision_id",
      "operation_id",
      "body_hash",
      "body_length",
      "object_key",
      "provenance_json",
      "intent_json",
      "outcome_json",
    ]),
    goldState: projectRows("knowledge_gold_state", ["mode", "dirty_through"]),
  };
}

function knowledgeExceptSilverNormalControlSnapshot(snapshot) {
  return Object.fromEntries(
    Object.entries(snapshot).map(([name, table]) => {
      if (name !== "knowledge_state") return [name, table];
      return [
        name,
        {
          ...table,
          columns: table.columns.filter((column) => column !== "silver_normal_control_json"),
          rows: table.rows.map((row) => {
            const copy = { ...row };
            delete copy.silver_normal_control_json;
            return copy;
          }),
        },
      ];
    }),
  );
}

function assertSilverNormalFenceOnlyEffects(before, after) {
  assert.deepEqual(
    knowledgeWriteInvariantSnapshot(after.knowledge),
    knowledgeWriteInvariantSnapshot(before.knowledge),
    "A normal-control fence must preserve Article policy/version/latest receipt, immutable revisions, and Gold state.",
  );
  assert.deepEqual(
    knowledgeExceptSilverNormalControlSnapshot(after.knowledge),
    knowledgeExceptSilverNormalControlSnapshot(before.knowledge),
    "A normal-control fence may change only knowledge_state.silver_normal_control_json in SQLite.",
  );
  assert.deepEqual(
    after.objects,
    before.objects,
    "A normal-control fence must not change private R2.",
  );
  assert.equal(after.objectsTruncated, before.objectsTruncated);
}

function requireSilverNormalControl(snapshot) {
  const table = requireKnowledgeTable(snapshot, "knowledge_state", ["silver_normal_control_json"]);
  assert.equal(table.rows.length, 1, "Knowledge must keep exactly one silver normal control row.");
  const controlJson = table.rows[0]?.silver_normal_control_json;
  assert.equal(typeof controlJson, "string");
  return JSON.parse(controlJson);
}

function hasVerifiedSourceFields(fields, expected) {
  const containsExpectedSource = (value) => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(containsExpectedSource);
    if (
      value.kind === expected.kind &&
      value.chatId === expected.chatId &&
      value.sequence === expected.sequence &&
      value.timestampMs === expected.timestampMs &&
      value.author?.type === expected.author.type &&
      value.author?.id === expected.author.id
    )
      return true;
    return Object.values(value).some(containsExpectedSource);
  };
  return fields.some((field) => {
    if (field.kind === "json") {
      try {
        return containsExpectedSource(JSON.parse(field.value));
      } catch {
        return false;
      }
    }
    return false;
  });
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function postNative(targetMiniflare, path, input) {
  const response = await targetMiniflare.dispatchFetch(`https://driver.invalid${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return { response, value: await response.json() };
}

async function setBr01CallbackAckLossEnabled(targetMiniflare, enabled) {
  const control = await targetMiniflare.getBindings("driver");
  const result = await control.CUSTOM_TEST_CLOCK.setCallbackAckLossEnabled(enabled);
  assert.equal(result, enabled);
}

async function setBr01TestClock(targetMiniflare, now) {
  const result = await postNative(targetMiniflare, "/br01-set-test-clock", { now });
  assert.equal(result.response.status, 200, JSON.stringify(result.value));
  if (now === null) {
    assert.equal(Number.isSafeInteger(result.value.customNow) && result.value.customNow >= 0, true);
    assert.equal(Number.isSafeInteger(result.value.knowledgeNow) && result.value.knowledgeNow >= 0, true);
  } else {
    assert.equal(result.value.customNow, now);
    assert.equal(result.value.knowledgeNow, now);
  }
  return now;
}

async function startBR04Scenario({
  workerScripts = {},
  resourcePersistencePath,
  includeNavigationPage = true,
} = {}) {
  const nativePostgres = await createDisposableRegistrationPostgres();
  let nativeMiniflare;
  let ownerSessionOpened = false;
  let temporaryPersistenceRoot;
  let identities;
  try {
    identities = {
      A: auth0Identity("auth0|br04-owner-a", crypto.randomUUID(), crypto.randomUUID()),
      B: auth0Identity("auth0|br04-owner-b", crypto.randomUUID(), crypto.randomUUID()),
    };
    await seedCanonicalIdentity(nativePostgres.db, identities.A);
    await seedCanonicalIdentity(nativePostgres.db, identities.B);
    const accessFixture = await D03AccessProofFixture.create();
    if (resourcePersistencePath === "temporary") {
      temporaryPersistenceRoot = await mkdtemp(join(tmpdir(), "cybernest-br04-persistence-"));
      resourcePersistencePath = join(temporaryPersistenceRoot, "workerd-persistence");
    }
    nativeMiniflare = createMiniflare(nativePostgres.connectionString, accessFixture, {
      workerScripts,
      resourcePersistencePath,
    });
    await nativeMiniflare.ready;
    if (workerScripts.custom === undefined || workerScripts.custom === customScript)
      await setBr01CallbackAckLossEnabled(nativeMiniflare, false);

    const accessAssertion = await accessFixture.assertion();
    const proofA = await issueCoreProof(identities.A, nativePostgres.connectionString);
    const proofB = await issueCoreProof(identities.B, nativePostgres.connectionString);
    assert.equal(
      proofA.response.status,
      200,
      "Core did not issue the BR04 owner's canonical proof.",
    );
    assert.equal(
      proofB.response.status,
      200,
      "Core did not issue the BR04 Manager's canonical proof.",
    );
    const boot = await postNative(nativeMiniflare, "/boot", {
      userId: identities.A.userId,
      managerId: identities.A.managerId,
      foreignUserId: identities.B.userId,
      foreignManagerId: identities.B.managerId,
      accessAssertion,
      proof: proofA.proof,
      foreignProof: proofB.proof,
      includeNavigationPage,
    });
    assert.equal(boot.response.status, 200, JSON.stringify(boot.value));
    assert.deepEqual(boot.value.bronzeInstallB, {
      ok: true,
      value: { managerId: identities.B.managerId },
    });

    const openOwner = async () => {
      const opened = await postNative(nativeMiniflare, "/br01-open", {
        managerId: identities.B.managerId,
        proof: proofB.proof,
        workspaceId: boot.value.workspaceBId,
      });
      assert.equal(opened.response.status, 200, JSON.stringify(opened.value));
      assert.equal(opened.value.opened, true);
      ownerSessionOpened = true;
      return opened.value;
    };
    await openOwner();

    const closeOwner = async () => {
      if (!ownerSessionOpened) return;
      const closed = await postNative(nativeMiniflare, "/br01-close", {
        managerId: identities.B.managerId,
      });
      assert.equal(closed.response.status, 200, JSON.stringify(closed.value));
      assert.equal(closed.value.closed, true);
      ownerSessionOpened = false;
    };
    const dispose = async () => {
      try {
        await closeOwner();
      } finally {
        try {
          await nativeMiniflare.dispose();
        } finally {
          await nativePostgres.dispose();
          if (temporaryPersistenceRoot)
            await rm(temporaryPersistenceRoot, { recursive: true, force: true });
        }
      }
    };
    const restartWith = async (nextWorkerScripts, additionalOptions = {}) => {
      await closeOwner();
      await nativeMiniflare.setOptions(
        createMiniflareOptions(nativePostgres.connectionString, accessFixture, {
          workerScripts: nextWorkerScripts,
          resourcePersistencePath,
          ...additionalOptions,
        }),
      );
      await nativeMiniflare.ready;
      if (nextWorkerScripts.custom === undefined || nextWorkerScripts.custom === customScript)
        await setBr01CallbackAckLossEnabled(nativeMiniflare, false);
      await openOwner();
    };
    return {
      identities,
      nativePostgres,
      nativeMiniflare,
      accessFixture,
      proofA: proofA.proof,
      proofB: proofB.proof,
      boot: boot.value,
      openOwner,
      closeOwner,
      restartWith,
      dispose,
    };
  } catch (error) {
    try {
      if (ownerSessionOpened && nativeMiniflare) {
        await postNative(nativeMiniflare, "/br01-close", {
          managerId: identities?.B.managerId,
        }).catch(() => undefined);
      }
      await nativeMiniflare?.dispose();
    } finally {
      await nativePostgres.dispose();
      if (temporaryPersistenceRoot)
        await rm(temporaryPersistenceRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

async function activateSilverManagementForTest(targetMiniflare, managerId) {
  const result = await postNative(targetMiniflare, "/br01-silver-management-activate", {
    managerId,
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.value));
  const envelope = result.value;
  assert.deepEqual(envelope, {
    ok: true,
    value: { status: "enabled", accountingVersion: 1 },
  });
  return envelope.value;
}

async function activateSilverIndexingForNativeTest(targetMiniflare, managerId) {
  const result = await postNative(targetMiniflare, "/br01-silver-indexing-activate", { managerId });
  assert.equal(result.response.status, 200, JSON.stringify(result.value));
  assert.deepEqual(result.value, {
    ok: true,
    value: { status: "enabled", accountingVersion: 1 },
  });
  return result.value.value;
}

async function observeSilverAlarmForNativeTest(targetMiniflare, managerId, afterCount) {
  const result = await postNative(targetMiniflare, "/br01-silver-alarm-observe", {
    managerId,
    afterCount,
    timeoutMs: 10_000,
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.value));
  return result.value;
}

async function removeSourceReaderForSilverTest(targetMiniflare, managerId) {
  const namespace = await targetMiniflare.getDurableObjectNamespace(
    "KnowledgeAccountAccess",
    "custom",
  );
  await namespace.get(namespace.idFromName(managerId)).removeSourceReaderForSilverTest();
}

async function proposeNativePolicy(
  targetMiniflare,
  managerId,
  articleId,
  usePolicy,
  expectedMetadataRevision,
) {
  return postNative(targetMiniflare, "/br01-policy-stage", {
    managerId,
    articleId,
    usePolicy,
    expectedMetadataRevision,
  });
}

async function createNativeArticleForPolicy(
  targetMiniflare,
  managerId,
  initialUsePolicy = "excluded",
) {
  const staged = await postNative(targetMiniflare, "/br01-stage", { managerId, initialUsePolicy });
  assert.equal(staged.response.status, 200, JSON.stringify(staged.value));
  const approved = await postNative(targetMiniflare, "/br01-approve", {
    managerId,
    actionId: staged.value.actionId,
  });
  assert.equal(approved.response.status, 200, JSON.stringify(approved.value));
  assert.equal(approved.value.actionState, "approved");
  const snapshot = await knowledgeDatabaseSnapshot(targetMiniflare, managerId);
  const revisions = requireKnowledgeTable(snapshot, "knowledge_article_revisions", [
    "article_id",
    "operation_id",
  ]).rows.filter((row) => row.operation_id === staged.value.operationId);
  assert.equal(
    revisions.length,
    1,
    "The native Bronze Action must identify exactly one saved revision by its operation ID.",
  );
  const articles = requireKnowledgeTable(snapshot, "knowledge_articles", [
    "article_id",
    "use_policy",
  ]);
  const article = articles.rows.find((row) => row.article_id === revisions[0].article_id);
  assert.ok(article, "The native Bronze operation must resolve to its current Knowledge article.");
  assert.equal(
    article.use_policy,
    initialUsePolicy,
    `The native Bronze proposal did not create an ${initialUsePolicy} article.`,
  );
  return { article, snapshot, staged: staged.value, approved: approved.value };
}

async function br04NoEffectSnapshot(scenario, { includeLegacyKnowledge = false } = {}) {
  const { identities, nativeMiniflare } = scenario;
  const managerId = identities.B.managerId;
  const actions = await postNative(nativeMiniflare, "/br01-action-count", { managerId });
  assert.equal(actions.response.status, 200, JSON.stringify(actions.value));
  const actionSequence = await postNative(nativeMiniflare, "/br04-action-sequence", { managerId });
  assert.equal(actionSequence.response.status, 200, JSON.stringify(actionSequence.value));
  const stageCount = await postNative(nativeMiniflare, "/br04-stage-count", { managerId });
  assert.equal(stageCount.response.status, 200, JSON.stringify(stageCount.value));
  const bronzeBucket = await nativeMiniflare.getR2Bucket("KNOWLEDGE_BRONZE_BUCKET", "knowledge");
  const objects = await bronzeBucket.list({ limit: 32 });
  const snapshot = {
    actions: actions.value,
    nextActionId: actionSequence.value.nextId,
    stageCount: stageCount.value.count,
    reservation: await bronzeActionReservation(nativeMiniflare, managerId),
    knowledge: await knowledgeDatabaseSnapshot(nativeMiniflare, managerId),
    objects: objects.objects
      .map(({ key, size, etag }) => ({ key, size, etag }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    objectsTruncated: objects.truncated,
  };
  if (!includeLegacyKnowledge) return snapshot;

  const legacyBucket = await nativeMiniflare.getR2Bucket(
    "KNOWLEDGE_BRONZE_BUCKET",
    "knowledge-legacy",
  );
  const legacyObjects = await legacyBucket.list({ limit: 32 });
  return {
    ...snapshot,
    legacyKnowledge: await knowledgeDatabaseSnapshot(
      nativeMiniflare,
      managerId,
      "knowledge-legacy",
    ),
    legacyObjects: legacyObjects.objects
      .map(({ key, size, etag }) => ({ key, size, etag }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    legacyObjectsTruncated: legacyObjects.truncated,
  };
}

function assertBr04NoKnowledgeEffects(before, after) {
  assert.deepEqual(
    after.actions,
    before.actions,
    "A refused proposal/approval must not change native Action counts.",
  );
  assert.equal(
    after.nextActionId,
    before.nextActionId,
    "A refused proposal must not consume a native Action ID.",
  );
  assert.equal(
    after.stageCount,
    before.stageCount,
    "A refused proposal/approval must not add or remove a stage.",
  );
  assert.deepEqual(
    after.knowledge,
    before.knowledge,
    "A refused proposal/approval must leave Knowledge SQLite unchanged.",
  );
  assert.deepEqual(
    after.objects,
    before.objects,
    "A refused proposal/approval must leave private R2 unchanged.",
  );
  assert.equal(after.objectsTruncated, before.objectsTruncated);
  if ("legacyKnowledge" in before) {
    assert.deepEqual(
      after.legacyKnowledge,
      before.legacyKnowledge,
      "A refused callback must leave the isolated legacy Knowledge SQLite state unchanged.",
    );
    assert.deepEqual(
      after.legacyObjects,
      before.legacyObjects,
      "A refused callback must leave the legacy Worker’s R2 view unchanged.",
    );
    assert.equal(after.legacyObjectsTruncated, before.legacyObjectsTruncated);
  }
}

function assertBr04SameReservationIdentity(before, after) {
  if (before === undefined) {
    assert.equal(after, undefined, "A refused proposal must not create an Account reservation.");
    return;
  }
  assert.ok(after, "A rejected legacy stage must retain its existing Account reservation.");
  for (const key of [
    "workspaceId",
    "gatekeeperInstanceId",
    "localActionId",
    "operationId",
    "status",
  ])
    assert.equal(
      after[key],
      before[key],
      `The existing Account reservation ${key} must remain bound to the same operation.`,
    );
}

const br04CurrentProfileId = "cybernest-bronze-article-okf-v0.2-1";
const br04V1ProfileId = "cybernest-bronze-article-okf-v0.2-0";

function canonicalBr04Provenance(value) {
  if (value.kind === "chat_message") {
    return JSON.stringify({
      version: value.version,
      kind: value.kind,
      chatId: value.chatId,
      sequence: value.sequence,
      timestampMs: value.timestampMs,
      author: { type: value.author.type, id: value.author.id },
      observedTargetDescription: value.observedTargetDescription,
      sourceRelationshipClaim: value.sourceRelationshipClaim,
    });
  }
  return JSON.stringify({
    version: value.version,
    kind: value.kind,
    actionId: value.actionId,
    gatekeeperId: value.gatekeeperId,
    createdAtMs: value.createdAtMs,
    title: value.title,
    resourceTitle: value.resourceTitle,
    observedTargetDescription: value.observedTargetDescription,
    sourceRelationshipClaim: value.sourceRelationshipClaim,
  });
}

function br04V2FullIntentHash(command, managerId, profileId) {
  const intent = command.intent;
  const bodyBytes = Buffer.from(intent.body, "utf8");
  const bodyHash = sha256HexOf(bodyBytes);
  const provenanceHash = sha256HexOf(
    Buffer.from(canonicalBr04Provenance(intent.provenance), "utf8"),
  );
  const fields = [
    "knowledge-bronze-intent-v2",
    intent.kind,
    command.operationId,
    intent.articleId,
    intent.revisionId,
    intent.expectedCurrentRevision ?? "",
    bodyHash,
    String(bodyBytes.byteLength),
    intent.provenance.version,
    provenanceHash,
    intent.kind === "adopt" ? intent.initialUsePolicy : "",
    managerId,
    command.namespace.workspaceId,
    command.namespace.gatekeeperInstanceId,
    String(command.namespace.localActionId),
    profileId,
  ];
  const encoded = Buffer.concat(
    fields.map((field) => {
      const bytes = Buffer.from(field, "utf8");
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.byteLength);
      return Buffer.concat([length, bytes]);
    }),
  );
  return { fullIntentHash: sha256HexOf(encoded), bodyHash };
}

async function br04Stage(scenario, operationId) {
  const result = await postNative(scenario.nativeMiniflare, "/br04-stage-inspect", {
    managerId: scenario.identities.B.managerId,
    operationId,
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.value));
  return result.value;
}

async function replaceWithSelfConsistentV1ProfileStage(scenario, operationId) {
  const staged = await br04Stage(scenario, operationId);
  const command = JSON.parse(staged.command_json);
  assert.equal(command.kind, "staged");
  assert.equal(command.profileId, br04CurrentProfileId);
  const oldProfileHash = br04V2FullIntentHash(
    command,
    scenario.identities.B.managerId,
    br04V1ProfileId,
  );
  command.profileId = br04V1ProfileId;
  command.bodyHash = oldProfileHash.bodyHash;
  command.fullIntentHash = oldProfileHash.fullIntentHash;
  const commandJson = JSON.stringify(command);
  const replaced = await postNative(scenario.nativeMiniflare, "/br04-stage-replace", {
    managerId: scenario.identities.B.managerId,
    operationId,
    commandJson,
    payloadHash: oldProfileHash.fullIntentHash,
  });
  assert.equal(replaced.response.status, 200, JSON.stringify(replaced.value));
  assert.equal(replaced.value.replaced, true);
  return {
    before: staged,
    command,
    commandJson,
    payloadHash: oldProfileHash.fullIntentHash,
  };
}

test(
  "real Core authority and proof install Knowledge through the regular OS Worker",
  {
    timeout: 60_000,
    skip: process.env.CYBERNEST_RUN_LOCAL_DB !== "1",
  },
  async () => {
    postgres = await createDisposableRegistrationPostgres();
    const identities = {
      A: auth0Identity("auth0|joined-a", crypto.randomUUID(), crypto.randomUUID()),
      B: auth0Identity("auth0|joined-b", crypto.randomUUID(), crypto.randomUUID()),
    };
    await seedCanonicalIdentity(postgres.db, identities.A);
    await seedCanonicalIdentity(postgres.db, identities.B);
    const accessFixture = await D03AccessProofFixture.create();
    miniflare = createMiniflare(postgres.connectionString, accessFixture);
    await miniflare.ready;

    const accessAssertion = await accessFixture.assertion();
    const proofA = await issueCoreProof(identities.A, postgres.connectionString);
    const proofB = await issueCoreProof(identities.B, postgres.connectionString);
    assert.equal(proofA.response.status, 200, "Core did not issue A's canonical proof.");
    assert.equal(proofB.response.status, 200, "Core did not issue B's canonical proof.");

    const response = await miniflare.dispatchFetch("https://driver.invalid/boot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: identities.A.userId,
        managerId: identities.A.managerId,
        foreignUserId: identities.B.userId,
        foreignManagerId: identities.B.managerId,
        accessAssertion,
        proof: proofA.proof,
        foreignProof: proofB.proof,
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.userId, identities.A.userId);
    assert.equal(result.managerId, identities.A.managerId);
    assert.equal(result.foreignUserId, identities.B.userId);
    assert.equal(result.foreignManagerId, identities.B.managerId);
    assert.equal(result.whoamiA.id, identities.A.managerId);
    assert.equal(result.whoamiB.id, identities.B.managerId);
    assert.deepEqual(result.beforeProof, { ok: false, code: "dependency_unavailable" });
    assert.deepEqual(result.preflightBeforeProof, { ok: false, code: "dependency_unavailable" });
    assert.equal(result.grantCallsBeforeProof, 0);
    assert.deepEqual(result.preflightBAfterProof, {
      ok: true,
      value: {
        managerId: identities.B.managerId,
        profileReady: true,
        provenanceConfirmed: true,
        accountState: "absent",
        bronzeRoles: { sourceReader: "absent", writer: "absent" },
      },
    });
    assert.deepEqual(result.installB, { ok: true, value: { managerId: identities.B.managerId } });
    assert.deepEqual(result.preflightBAfterInstall, {
      ok: true,
      value: {
        managerId: identities.B.managerId,
        profileReady: true,
        provenanceConfirmed: true,
        accountState: "bound",
        bronzeRoles: { sourceReader: "installed", writer: "installed" },
      },
    });
    assert.deepEqual(result.preflightAAfterProof, {
      ok: true,
      value: {
        managerId: identities.A.managerId,
        profileReady: true,
        provenanceConfirmed: true,
        accountState: "absent",
        bronzeRoles: { sourceReader: "absent", writer: "absent" },
      },
    });
    assert.equal(typeof result.crossManagerInstallError, "string");
    assert.match(result.crossManagerInstallError, /Knowledge owner assertion failed/u);
    assert.deepEqual(result.preflightAAfterRejectedInstall, result.preflightAAfterProof);
    assert.deepEqual(result.installA, { ok: true, value: { managerId: identities.A.managerId } });
    assert.deepEqual(result.preflightAAfterInstall, {
      ok: true,
      value: {
        managerId: identities.A.managerId,
        profileReady: true,
        provenanceConfirmed: true,
        accountState: "bound",
        bronzeRoles: { sourceReader: "installed", writer: "installed" },
      },
    });
    assert.equal(result.crossManagerConnectCode, "WORKSPACE_ACCESS_DENIED");
    assert.notEqual(result.workspaceAId, result.workspaceBId);
    assert.equal(result.descriptionA.tsType, "KnowledgeBase");
    assert.equal(result.descriptionA.title, "Knowledge Base");
    assert.deepEqual(result.creationSpecA, {
      type: "ambient",
      vendorId: "custom",
      accountId: 0,
    });

    assert.deepEqual(
      result.readsA.list.items.map(({ path }) => path),
      d01Fixtures.EXPECTED_PATHS.A,
    );
    assert.equal(result.readsA.list.bundleId, d01Fixtures.A_BUNDLE_HASH);
    assert.equal(result.readsA.search.hits[0]?.path, "concepts/shared.md");
    assert.match(result.readsA.search.hits[0]?.snippet ?? "", /cobalt/u);
    assert.deepEqual(result.readsA.foreignSearch.hits, []);
    assert.equal(result.readsA.read.bundleId, d01Fixtures.A_BUNDLE_HASH);
    assert.equal(result.readsA.read.path, "concepts/shared.md");
    assert.equal(result.readsA.read.sourceMarkdown, d01Fixtures.A_SHARED_SOURCE);
    assert.deepEqual(result.readsA.read.metadata, d01Fixtures.A_SHARED_METADATA);
    assert.deepEqual(Object.keys(result.readsA.articles).sort(), [
      "goldStatus",
      "kind",
      "path",
      "sourceMarkdown",
    ]);
    assert.equal(result.readsA.articles.kind, "navigation");
    assert.equal(result.readsA.articles.path, "articles");
    assert.equal(result.readsA.articles.goldStatus, "disabled");
    assert.equal(typeof result.readsA.articles.sourceMarkdown, "string");
    assert.equal(result.foreignPageReadError, "Knowledge Base page_not_found.");

    assert.deepEqual(
      result.readsB.list.items.map(({ path }) => path),
      d01Fixtures.EXPECTED_PATHS.B,
    );
    assert.equal(result.readsB.list.bundleId, d01Fixtures.B_BUNDLE_HASH);
    assert.equal(result.readsB.search.hits[0]?.path, "concepts/shared.md");
    assert.match(result.readsB.search.hits[0]?.snippet ?? "", /amber/u);
    assert.equal(result.readsB.read.bundleId, d01Fixtures.B_BUNDLE_HASH);
    assert.equal(result.readsB.read.path, "concepts/only-b.md");
    assert.equal(result.readsB.read.sourceMarkdown, d01Fixtures.B_ONLY_SOURCE);
    assert.deepEqual(result.readsB.read.metadata, d01Fixtures.B_ONLY_METADATA);

    const knowledgeStateABeforeStop = await doStorageState(identities.A.managerId);
    const knowledgeStateBBeforeStop = await doStorageState(identities.B.managerId);
    const databaseStateAfterStop = await postgres.db.query(
      "UPDATE operator.identity_manager_ownerships SET status='suspended' WHERE user_id=$1 AND manager_id=$2 AND status='active'",
      [identities.A.userId, identities.A.managerId],
    );
    assert.equal(databaseStateAfterStop.rowCount, 1);
    const databaseAfterStop = await postgres.digest();

    const stoppedEvents = [];
    const freshProofA = await issueCoreProof(
      identities.A,
      postgres.connectionString,
      stoppedEvents,
    );
    assert.equal(freshProofA.response.status, 503);
    assert.equal(freshProofA.body.includes(JSON.stringify(privateJwk)), false);
    assert.equal(freshProofA.body.includes(privateJwk.d), false);
    assert.equal(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u.test(freshProofA.body),
      false,
    );
    assert.equal(stoppedEvents.length, 1);
    assert.equal(stoppedEvents[0].phase, "os_handoff");
    assert.equal(Cause.hasFails(stoppedEvents[0].cause), true);
    assert.equal(Cause.hasDies(stoppedEvents[0].cause), false);
    assert.equal(Cause.hasInterrupts(stoppedEvents[0].cause), false);
    const stoppedFailure = Cause.findErrorOption(stoppedEvents[0].cause);
    assert.equal(stoppedFailure._tag, "Some");
    assert.equal(stoppedFailure.value instanceof ManagerIntegrityFailure, true);
    assert.equal(stoppedFailure.value.reason, "inactive_ownership");

    const stoppedResponse = await miniflare.dispatchFetch("https://driver.invalid/stopped", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: identities.A.userId,
        managerId: identities.A.managerId,
        foreignManagerId: identities.B.managerId,
        accessAssertion,
      }),
    });
    const stopped = await stoppedResponse.json();
    assert.equal(stoppedResponse.status, 200, JSON.stringify(stopped));
    assert.deepEqual(stopped.install, { ok: false, code: "permission_denied" });
    assert.equal(stopped.grantCallCount, result.grantCallCount);
    assert.deepEqual(stopped.osA, result.preflightAAfterInstall);
    assert.deepEqual(stopped.osB, result.preflightBAfterInstall);
    assert.deepEqual(await postgres.digest(), databaseAfterStop);
    assert.deepEqual(await doStorageState(identities.A.managerId), knowledgeStateABeforeStop);
    assert.deepEqual(await doStorageState(identities.B.managerId), knowledgeStateBBeforeStop);
  },
);

test(
  "BR01 existing read-bound Manager adds callback roles through Core private grant without changing old read",
  {
    timeout: 180_000,
    skip: process.env.CYBERNEST_RUN_LOCAL_DB !== "1",
  },
  async () => {
    let nativePostgres;
    let nativeMiniflare;
    let br01ManagerId;
    let br01OwnerSessionOpened = false;
    try {
      nativePostgres = await createDisposableRegistrationPostgres();
      const identities = {
        A: auth0Identity("auth0|br01-owner-a", crypto.randomUUID(), crypto.randomUUID()),
        B: auth0Identity("auth0|br01-owner-b", crypto.randomUUID(), crypto.randomUUID()),
      };
      br01ManagerId = identities.B.managerId;
      await seedCanonicalIdentity(nativePostgres.db, identities.A);
      await seedCanonicalIdentity(nativePostgres.db, identities.B);
      const accessFixture = await D03AccessProofFixture.create();
      nativeMiniflare = createMiniflare(nativePostgres.connectionString, accessFixture);
      await nativeMiniflare.ready;
      const br01Failures = [];
      const br01Post = async (path, input) => {
        const response = await nativeMiniflare.dispatchFetch(`https://driver.invalid${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        return { response, value: await response.json() };
      };
      const setBR01TestClock = async (now) => {
        const result = await br01Post("/br01-set-test-clock", { now });
        assert.equal(result.response.status, 200, JSON.stringify(result.value));
        assert.equal(Number.isSafeInteger(result.value.knowledgeNow), true);
        assert.equal(Number.isSafeInteger(result.value.customNow), true);
        if (now !== null) {
          assert.equal(result.value.knowledgeNow, now);
          assert.equal(result.value.customNow, now);
        }
        return result.value;
      };

      const accessAssertion = await accessFixture.assertion();
      const proofA = await issueCoreProof(identities.A, nativePostgres.connectionString);
      const proofB = await issueCoreProof(identities.B, nativePostgres.connectionString);
      assert.equal(proofA.response.status, 200, "Core did not issue A's canonical proof.");
      assert.equal(proofB.response.status, 200, "Core did not issue B's canonical proof.");

      const response = await nativeMiniflare.dispatchFetch("https://driver.invalid/boot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: identities.A.userId,
          managerId: identities.A.managerId,
          foreignUserId: identities.B.userId,
          foreignManagerId: identities.B.managerId,
          accessAssertion,
          proof: proofA.proof,
          foreignProof: proofB.proof,
        }),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));

      // Exercise the actual Miniflare SQLite/R2/DO alarm observers before the first missing
      // Bronze-role assertion. This separates harness failures from an expected implementation red.
      const beforeProposal = await knowledgeDatabaseSnapshot(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.equal(
        Array.isArray(beforeProposal.knowledge_state?.rows),
        true,
        "The real Knowledge DO SQLite inspector must return actual table rows.",
      );
      assert.equal(
        beforeProposal.knowledge_state.rows.length,
        1,
        "The existing owner-bound Knowledge state must remain present.",
      );
      assert.equal(beforeProposal.knowledge_state.rows[0].owner_manager_id, identities.B.managerId);
      const bronzeBucket = await nativeMiniflare.getR2Bucket(
        "KNOWLEDGE_BRONZE_BUCKET",
        "knowledge",
      );
      const beforeProposalObjects = await bronzeBucket.list({ limit: 16 });
      assert.equal(
        beforeProposalObjects.objects.length,
        0,
        "The isolated Bronze R2 bucket must start empty.",
      );
      assert.equal(beforeProposalObjects.truncated, false);
      const alarmBeforeProposal = await knowledgeAlarm(nativeMiniflare, identities.B.managerId);

      assert.deepEqual(result.installB, {
        ok: true,
        value: { managerId: identities.B.managerId },
      });
      assert.deepEqual(result.preflightBAfterInstall.value.accountState, "bound");
      assert.deepEqual(result.bronzeInstallB, {
        ok: true,
        value: { managerId: identities.B.managerId },
      });
      assert.deepEqual(result.preflightBAfterBronzeInstall.value.accountState, "bound");
      assert.deepEqual(result.preflightBAfterBronzeInstall.value.bronzeRoles, {
        writer: "installed",
        sourceReader: "installed",
      });

      const goldStateBeforeTable = requireKnowledgeTable(beforeProposal, "knowledge_gold_state", [
        "mode",
        "dirty_through",
      ]);
      assert.equal(
        goldStateBeforeTable.rows.length,
        1,
        "The real DO must have one durable Gold lifecycle row before Bronze is enabled.",
      );
      const goldStateBefore = goldStateBeforeTable.rows[0];
      assert.equal(goldStateBefore.mode, "disabled");
      const bronzeOperationsBefore = requireKnowledgeTable(
        beforeProposal,
        "knowledge_bronze_operations",
        ["operation_id"],
      );
      assert.equal(
        bronzeOperationsBefore.rows.length,
        0,
        "A fresh read-bound owner must not begin with an unresolved Bronze write.",
      );

      assert.deepEqual(
        result.readsB.list.items.map(({ path }) => path),
        d01Fixtures.EXPECTED_PATHS.B,
      );
      assert.equal(result.readsB.list.bundleId, d01Fixtures.B_BUNDLE_HASH);
      assert.equal(result.readsB.search.hits[0]?.path, "concepts/shared.md");
      assert.match(result.readsB.search.hits[0]?.snippet ?? "", /amber/u);
      assert.equal(result.readsB.read.bundleId, d01Fixtures.B_BUNDLE_HASH);
      assert.equal(result.readsB.read.path, "concepts/only-b.md");
      assert.equal(result.readsB.read.sourceMarkdown, d01Fixtures.B_ONLY_SOURCE);
      assert.deepEqual(result.readsB.read.metadata, d01Fixtures.B_ONLY_METADATA);

      const ownerSessionResponse = await nativeMiniflare.dispatchFetch(
        "https://driver.invalid/br01-open",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            managerId: identities.B.managerId,
            proof: proofB.proof,
            workspaceId: result.workspaceBId,
          }),
        },
      );
      const ownerSession = await ownerSessionResponse.json();
      assert.equal(
        ownerSessionResponse.status,
        200,
        "The real owner session did not open for BR01 operations.",
      );
      assert.equal(ownerSession.opened, true);
      assert.equal(typeof ownerSession.ownerSessionId, "string");
      assert.equal(
        ownerSession.proofPresentations,
        1,
        "The real OS owner connection must present one proof and then remain open across the stale-authority decision.",
      );
      br01OwnerSessionOpened = true;

      const beforeInvalidArticle = await br04NoEffectSnapshot({ identities, nativeMiniflare });
      const invalidArticleBody =
        "---\ntitle: Missing article type\ndescription: Invalid candidate\n---\n# Incomplete article\n";
      const invalidArticleProposal = await br01Post("/br01-stage", {
        managerId: identities.B.managerId,
        articleBody: invalidArticleBody,
      });
      const afterInvalidArticle = await br04NoEffectSnapshot({ identities, nativeMiniflare });
      assertBr04NoKnowledgeEffects(beforeInvalidArticle, afterInvalidArticle);
      assert.deepEqual(
        afterInvalidArticle.reservation,
        beforeInvalidArticle.reservation,
        "An invalid article candidate must not create or alter the owner Account reservation.",
      );
      assert.equal(
        invalidArticleProposal.response.status,
        500,
        JSON.stringify(invalidArticleProposal.value),
      );
      assert.equal(
        invalidArticleProposal.value.error,
        "Knowledge Base invalid_input.",
        "A valid owner source paired with a malformed article body must fail candidate validation.",
      );

      const beforeProposalWriteState = knowledgeWriteInvariantSnapshot(
        await knowledgeDatabaseSnapshot(nativeMiniflare, identities.B.managerId),
      );
      const alarmBeforeProposalAction = await knowledgeAlarm(
        nativeMiniflare,
        identities.B.managerId,
      );

      const initialStageResponse = await nativeMiniflare.dispatchFetch(
        "https://driver.invalid/br01-stage",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ managerId: identities.B.managerId }),
        },
      );
      const rejectedStage = await initialStageResponse.json();
      assert.equal(
        initialStageResponse.status,
        200,
        "The real native Knowledge proposal did not stage.",
      );
      assert.equal(rejectedStage.status, "pending_approval");
      assert.equal(typeof rejectedStage.operationId, "string");
      assert.equal(Number.isSafeInteger(rejectedStage.actionId), true);
      assert.equal(rejectedStage.sourceMetadataVerified, true);
      assert.equal(rejectedStage.actionDescriptionComplete, true);
      assert.equal(rejectedStage.noTruncatedFields, true);
      assert.equal(rejectedStage.exactBodyPresented, true);
      assert.equal(rejectedStage.initialUsePolicyPresented, true);
      assert.equal(rejectedStage.verifiedSourcePresented, true);
      assert.equal(rejectedStage.verifiedSource.kind, "chat_message");
      assert.equal(Number.isSafeInteger(rejectedStage.verifiedSource.chatId), true);
      assert.equal(rejectedStage.verifiedSource.chatId >= 0, true);
      assert.equal(Number.isSafeInteger(rejectedStage.verifiedSource.sequence), true);
      assert.equal(Number.isSafeInteger(rejectedStage.verifiedSource.timestampMs), true);
      assert.equal(rejectedStage.verifiedSource.author.type, "user");
      assert.equal(typeof rejectedStage.verifiedSource.author.id, "string");
      assert.equal(rejectedStage.verifiedSource.author.id.length > 0, true);
      assert.equal(
        rejectedStage.ownerSessionId,
        ownerSession.ownerSessionId,
        "The native proposal must use the same live proof-authenticated owner session.",
      );
      assert.equal(
        rejectedStage.proofPresentations,
        1,
        "Staging must not mint or present another Core proof.",
      );
      assert.equal(
        rejectedStage.proposalResultContainsManagerId,
        false,
        "The owner manager ID must not cross the native proposal result boundary.",
      );

      const rejectInitialResponse = await nativeMiniflare.dispatchFetch(
        "https://driver.invalid/br01-reject",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            managerId: identities.B.managerId,
            actionId: rejectedStage.actionId,
          }),
        },
      );
      const rejectedInitial = await rejectInitialResponse.json();
      assert.equal(
        rejectInitialResponse.status,
        200,
        "The first rejection of an undispatched Bronze proposal must use its durable clear lookup.",
      );
      assert.equal(rejectedInitial.actionState, "rejected");
      const afterInitialReject = await knowledgeDatabaseSnapshot(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.deepEqual(
        knowledgeWriteInvariantSnapshot(afterInitialReject),
        beforeProposalWriteState,
        "Rejecting before the first apply dispatch must not write a revision or dirty Gold.",
      );
      const objectsAfterInitialReject = await bronzeBucket.list({ limit: 16 });
      assert.equal(
        objectsAfterInitialReject.objects.length,
        0,
        "Rejecting before the first apply dispatch must not write an R2 object.",
      );
      assert.equal(
        await knowledgeAlarm(nativeMiniflare, identities.B.managerId),
        alarmBeforeProposalAction,
        "Rejecting before the first apply dispatch must not arm a Gold alarm.",
      );

      const actionsBeforeMetadataOverflow = (
        await br01Post("/br01-action-count", {
          managerId: identities.B.managerId,
        })
      ).value;
      const metadataOverflow = await br01Post("/br01-stage", {
        managerId: identities.B.managerId,
        metadataOverflow: true,
      });
      if (metadataOverflow.response.status === 200) {
        br01Failures.push("BR-D04 accepted >32 KiB stage metadata.");
        const cleanupOverflow = await br01Post("/br01-reject", {
          managerId: identities.B.managerId,
          actionId: metadataOverflow.value.actionId,
        });
        assert.equal(cleanupOverflow.response.status, 200, JSON.stringify(cleanupOverflow.value));
        assert.equal(cleanupOverflow.value.actionState, "rejected");
      } else if (
        metadataOverflow.response.status !== 500 ||
        metadataOverflow.value.error !== "Knowledge Base capacity_exceeded."
      ) {
        br01Failures.push(
          `BR-D04 returned ${metadataOverflow.response.status}: ${metadataOverflow.value.error}`,
        );
      }
      const actionsAfterMetadataOverflow = (
        await br01Post("/br01-action-count", {
          managerId: identities.B.managerId,
        })
      ).value;
      assert.equal(
        actionsAfterMetadataOverflow.pending,
        actionsBeforeMetadataOverflow.pending,
        "An oversized stage must not leave a native pending Action.",
      );
      if (actionsAfterMetadataOverflow.total !== actionsBeforeMetadataOverflow.total) {
        br01Failures.push(
          `BR-D04 changed native Action count from ${actionsBeforeMetadataOverflow.total} to ${actionsAfterMetadataOverflow.total}.`,
        );
      }
      assert.equal(
        await bronzeActionReservation(nativeMiniflare, identities.B.managerId),
        undefined,
        "An oversized stage must fail before reserving the Manager-wide Account slot.",
      );
      const afterMetadataOverflow = await knowledgeDatabaseSnapshot(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.deepEqual(
        knowledgeWriteInvariantSnapshot(afterMetadataOverflow),
        beforeProposalWriteState,
        "An oversized stage must not write Knowledge metadata or alter its current state.",
      );

      const stageResponse = await nativeMiniflare.dispatchFetch(
        "https://driver.invalid/br01-stage",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ managerId: identities.B.managerId }),
        },
      );
      const staged = await stageResponse.json();
      assert.equal(stageResponse.status, 200, "A second native Knowledge proposal did not stage.");
      assert.equal(staged.status, "pending_approval");
      assert.equal(Number.isSafeInteger(staged.actionId), true);
      assert.notEqual(staged.actionId, rejectedStage.actionId);
      assert.equal(staged.sourceMetadataVerified, true);
      assert.equal(staged.exactBodyPresented, true);
      assert.equal(staged.verifiedSourcePresented, true);
      assert.equal(staged.ownerSessionId, ownerSession.ownerSessionId);
      assert.equal(staged.proofPresentations, 1);

      const afterProposal = await knowledgeDatabaseSnapshot(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.deepEqual(
        knowledgeWriteInvariantSnapshot(afterProposal),
        beforeProposalWriteState,
        "Creating a pending native Action must not advance Silver current/revisions or Gold dirty state before owner approval.",
      );
      const afterProposalObjects = await bronzeBucket.list({ limit: 16 });
      assert.equal(
        afterProposalObjects.objects.length,
        0,
        "Submitting the native Action must not write a Bronze R2 object before approval.",
      );
      assert.equal(afterProposalObjects.truncated, false);
      assert.equal(
        await knowledgeAlarm(nativeMiniflare, identities.B.managerId),
        alarmBeforeProposalAction,
        "Creating a pending native Action must not create or move a Gold wake before owner approval.",
      );

      const beforeStaleApproval = await knowledgeDatabaseSnapshot(
        nativeMiniflare,
        identities.B.managerId,
      );
      const protectedKnowledgeStateBeforeStale =
        knowledgeWriteInvariantSnapshot(beforeStaleApproval);
      const objectsBeforeStaleApproval = await bronzeBucket.list({ limit: 16 });
      const alarmBeforeStaleApproval = await knowledgeAlarm(
        nativeMiniflare,
        identities.B.managerId,
      );

      const suspendedOwner = await nativePostgres.db.query(
        `UPDATE operator.identity_manager_ownerships
       SET status = 'suspended'
       WHERE user_id = $1 AND manager_id = $2 AND role = 'owner' AND status = 'active'`,
        [identities.B.userId, identities.B.managerId],
      );
      assert.equal(
        suspendedOwner.rowCount,
        1,
        "The isolated Core PG18 fixture must suspend exactly this canonical owner before approval.",
      );
      const authorityResolverCallsBeforeStaleApproval =
        await knowledgeAuthorityResolverCallCount(nativeMiniflare);
      try {
        const staleApproveResponse = await nativeMiniflare.dispatchFetch(
          "https://driver.invalid/br01-approve",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ managerId: identities.B.managerId, actionId: staged.actionId }),
          },
        );
        const staleApprove = await staleApproveResponse.json();
        assert.equal(
          staleApproveResponse.status,
          500,
          "A stale owner decision must fail at the real Knowledge write-authority boundary.",
        );
        assert.equal(
          staleApprove.error,
          "Knowledge Base permission_denied.",
          "The real Knowledge authority rejection must retain the existing native error message contract.",
        );
        assert.equal(
          staleApprove.ownerSessionId,
          ownerSession.ownerSessionId,
          "The stale-owner check must use the already-open OS session.",
        );
        assert.equal(
          staleApprove.proofPresentations,
          1,
          "The stale-owner check must not hide behind a newly issued or presented proof.",
        );
        const authorityResolverCallsAfterStaleApproval =
          await knowledgeAuthorityResolverCallCount(nativeMiniflare);
        assert.equal(
          authorityResolverCallsAfterStaleApproval > authorityResolverCallsBeforeStaleApproval,
          true,
          "The stale decision must reach the real Core authority resolver used by the Knowledge write guard.",
        );

        const pendingStateResponse = await nativeMiniflare.dispatchFetch(
          "https://driver.invalid/br01-action-state",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ managerId: identities.B.managerId, actionId: staged.actionId }),
          },
        );
        const pendingState = await pendingStateResponse.json();
        assert.equal(pendingStateResponse.status, 200);
        assert.equal(
          pendingState.state,
          "pending",
          "A stale-owner rejection must leave the native Action pending for a later valid owner decision.",
        );
        assert.equal(pendingState.ownerSessionId, ownerSession.ownerSessionId);
        assert.equal(pendingState.proofPresentations, 1);

        const afterStaleApproval = await knowledgeDatabaseSnapshot(
          nativeMiniflare,
          identities.B.managerId,
        );
        assert.deepEqual(
          knowledgeWriteInvariantSnapshot(afterStaleApproval),
          protectedKnowledgeStateBeforeStale,
          "A stale Core owner must not change Silver current/revision or Gold dirty state; legitimate pending-operation state is preserved.",
        );
        const objectsAfterStaleApproval = await bronzeBucket.list({ limit: 16 });
        assert.deepEqual(
          objectsAfterStaleApproval.objects
            .map(({ key, size, etag }) => ({ key, size, etag }))
            .sort((left, right) => left.key.localeCompare(right.key)),
          objectsBeforeStaleApproval.objects
            .map(({ key, size, etag }) => ({ key, size, etag }))
            .sort((left, right) => left.key.localeCompare(right.key)),
          "A stale Core owner must not add, replace, or remove a Bronze object.",
        );
        assert.equal(
          await knowledgeAlarm(nativeMiniflare, identities.B.managerId),
          alarmBeforeStaleApproval,
          "A rejected stale-owner write must not create a Gold wake.",
        );
      } finally {
        const restoredOwner = await nativePostgres.db.query(
          `UPDATE operator.identity_manager_ownerships
         SET status = 'active'
         WHERE user_id = $1 AND manager_id = $2 AND role = 'owner' AND status = 'suspended'`,
          [identities.B.userId, identities.B.managerId],
        );
        assert.equal(
          restoredOwner.rowCount,
          1,
          "The isolated Core PG18 fixture must restore the canonical owner after the stale check.",
        );
      }

      const lostAckResponse = await nativeMiniflare.dispatchFetch(
        "https://driver.invalid/br01-approve",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            managerId: identities.B.managerId,
            actionId: staged.actionId,
          }),
        },
      );
      const lostAck = await lostAckResponse.json();
      assert.equal(
        lostAckResponse.status,
        500,
        "The test-only Gatekeeper subclass must lose the callback acknowledgement after Knowledge save.",
      );
      assert.equal(
        lostAck.error,
        "BR01 test fixture lost callback acknowledgement after Knowledge save.",
      );

      const pendingAfterLostAckResponse = await nativeMiniflare.dispatchFetch(
        "https://driver.invalid/br01-action-state",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ managerId: identities.B.managerId, actionId: staged.actionId }),
        },
      );
      const pendingAfterLostAck = await pendingAfterLostAckResponse.json();
      assert.equal(pendingAfterLostAckResponse.status, 200);
      assert.equal(
        pendingAfterLostAck.state,
        "pending",
        "The OS Action remains pending when the Gatekeeper callback response is lost after its Knowledge save.",
      );

      const afterLostAck = await knowledgeDatabaseSnapshot(nativeMiniflare, identities.B.managerId);
      const revisionsAfterLostAck = requireKnowledgeTable(
        afterLostAck,
        "knowledge_article_revisions",
        ["operation_id", "revision_id", "body_hash", "object_key"],
      ).rows.filter((row) => row.operation_id === staged.operationId);
      assert.equal(
        revisionsAfterLostAck.length,
        1,
        "The callback response loss must happen after exactly one immutable Knowledge revision was saved.",
      );
      const objectsAfterLostAck = await bronzeBucket.list({ limit: 16 });
      assert.equal(objectsAfterLostAck.objects.length, 1);
      const savedObjectAfterLostAck = objectsAfterLostAck.objects[0];

      const rejectAfterLostAckResponse = await nativeMiniflare.dispatchFetch(
        "https://driver.invalid/br01-reject",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ managerId: identities.B.managerId, actionId: staged.actionId }),
        },
      );
      const rejectAfterLostAck = await rejectAfterLostAckResponse.json();
      assert.equal(
        rejectAfterLostAckResponse.status,
        500,
        "A rejection must not erase a Knowledge save whose native approval acknowledgement was lost.",
      );
      const stillPendingAfterRejectResponse = await nativeMiniflare.dispatchFetch(
        "https://driver.invalid/br01-action-state",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ managerId: identities.B.managerId, actionId: staged.actionId }),
        },
      );
      assert.equal((await stillPendingAfterRejectResponse.json()).state, "pending");
      const afterRejectAfterLostAck = await knowledgeDatabaseSnapshot(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.deepEqual(
        requireKnowledgeTable(afterRejectAfterLostAck, "knowledge_article_revisions", [
          "operation_id",
          "revision_id",
          "body_hash",
          "object_key",
        ]).rows.filter((row) => row.operation_id === staged.operationId),
        revisionsAfterLostAck,
        "A rejected callback retry must leave the already-saved immutable revision unchanged.",
      );
      const objectsAfterReject = await bronzeBucket.list({ limit: 16 });
      assert.deepEqual(
        objectsAfterReject.objects.map(({ key, size, etag }) => ({ key, size, etag })),
        [
          {
            key: savedObjectAfterLostAck.key,
            size: savedObjectAfterLostAck.size,
            etag: savedObjectAfterLostAck.etag,
          },
        ],
        "Rejecting an action after the saved callback response was lost must not duplicate or replace the R2 object.",
      );

      const yBody = br01ArticleBody + "\n\nSecond pending proposal.\n";
      const yStage = await br01Post("/br01-stage", {
        managerId: identities.B.managerId,
        articleBody: yBody,
      });
      assert.equal(yStage.response.status, 200, JSON.stringify(yStage.value));
      assert.equal(yStage.value.status, "pending_approval");
      assert.notEqual(yStage.value.actionId, staged.actionId);
      assert.notEqual(yStage.value.operationId, staged.operationId);
      const yReservationBeforeRetry = await bronzeActionReservation(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.equal(
        yReservationBeforeRetry.operationId,
        yStage.value.operationId,
        "The Manager Account slot must belong to Y before retrying saved X.",
      );

      const d03FirstXRetry = await br01Post("/br01-approve", {
        managerId: identities.B.managerId,
        actionId: staged.actionId,
      });
      if (d03FirstXRetry.response.status !== 200 || d03FirstXRetry.value.actionState !== "approved")
        br01Failures.push(
          `BR-D03 retry X while Y owns the Account slot returned ${d03FirstXRetry.response.status}: ${d03FirstXRetry.value.error ?? d03FirstXRetry.value.actionState}`,
        );
      assert.deepEqual(
        await bronzeActionReservation(nativeMiniflare, identities.B.managerId),
        yReservationBeforeRetry,
        "Retrying saved X must leave Y's Account reservation unchanged.",
      );
      const afterXRetryWhileY = await knowledgeDatabaseSnapshot(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.deepEqual(
        requireKnowledgeTable(afterXRetryWhileY, "knowledge_article_revisions", [
          "operation_id",
          "revision_id",
          "body_hash",
          "object_key",
        ]).rows.filter((row) => row.operation_id === staged.operationId),
        revisionsAfterLostAck,
        "Retrying X against its saved receipt must not create another revision while Y owns the slot.",
      );

      const suspendOwnerForY = await nativePostgres.db.query(
        `UPDATE operator.identity_manager_ownerships
       SET status = 'suspended'
       WHERE user_id = $1 AND manager_id = $2 AND role = 'owner' AND status = 'active'`,
        [identities.B.userId, identities.B.managerId],
      );
      assert.equal(suspendOwnerForY.rowCount, 1);
      try {
        const yStaleApproval = await br01Post("/br01-approve", {
          managerId: identities.B.managerId,
          actionId: yStage.value.actionId,
        });
        assert.equal(yStaleApproval.response.status, 500, JSON.stringify(yStaleApproval.value));
        assert.equal(yStaleApproval.value.error, "Knowledge Base permission_denied.");
      } finally {
        const restoreOwnerForY = await nativePostgres.db.query(
          `UPDATE operator.identity_manager_ownerships
         SET status = 'active'
         WHERE user_id = $1 AND manager_id = $2 AND role = 'owner' AND status = 'suspended'`,
          [identities.B.userId, identities.B.managerId],
        );
        assert.equal(restoreOwnerForY.rowCount, 1);
      }
      const yReservationBeforeFirstReject = await bronzeActionReservation(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.equal(yReservationBeforeFirstReject.status, "active");
      assert.equal(yReservationBeforeFirstReject.operationId, yStage.value.operationId);
      assert.ok(yReservationBeforeFirstReject.operationDeadlineMs > 0);
      assert.deepEqual(yReservationBeforeFirstReject, {
        ...yReservationBeforeRetry,
        operationDeadlineMs: yReservationBeforeFirstReject.operationDeadlineMs,
      });

      const firstYReject = await br01Post("/br01-reject", {
        managerId: identities.B.managerId,
        actionId: yStage.value.actionId,
      });
      assert.equal(firstYReject.response.status, 500, JSON.stringify(firstYReject.value));
      assert.equal(
        firstYReject.value.error,
        "BR01 test fixture lost callback acknowledgement after Knowledge fence.",
      );
      const fencedYReservation = await bronzeActionReservation(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.deepEqual(fencedYReservation, { ...yReservationBeforeFirstReject, status: "fenced" });
      assert.equal(fencedYReservation.operationId, yStage.value.operationId);
      const yFenceSnapshot = await knowledgeDatabaseSnapshot(
        nativeMiniflare,
        identities.B.managerId,
      );
      const yFenceMarker = requireKnowledgeTable(yFenceSnapshot, "knowledge_bronze_operations", [
        "operation_id",
      ]).rows.filter((row) => row.operation_id === yStage.value.operationId);
      assert.equal(
        yFenceMarker.length,
        1,
        "The lost Account-fence acknowledgement must follow a durable Knowledge fence.",
      );

      const retryYReject = await br01Post("/br01-reject", {
        managerId: identities.B.managerId,
        actionId: yStage.value.actionId,
      });
      if (retryYReject.response.status !== 200 || retryYReject.value.actionState !== "rejected")
        br01Failures.push(
          `BR-D01 pre-deadline reject retry returned ${retryYReject.response.status}: ${retryYReject.value.error ?? retryYReject.value.actionState}`,
        );
      assert.deepEqual(
        await bronzeActionReservation(nativeMiniflare, identities.B.managerId),
        fencedYReservation,
        "A pre-deadline terminal reject must retain its own fenced slot until its admission window expires.",
      );
      assert.deepEqual(
        requireKnowledgeTable(
          await knowledgeDatabaseSnapshot(nativeMiniflare, identities.B.managerId),
          "knowledge_bronze_operations",
          ["operation_id"],
        ).rows.filter((row) => row.operation_id === yStage.value.operationId),
        yFenceMarker,
        "Completing a fenced reject must not mutate the already durable Knowledge fence marker.",
      );

      await setBR01TestClock(fencedYReservation.operationDeadlineMs + 1);
      assert.deepEqual(
        await bronzeActionReservation(nativeMiniflare, identities.B.managerId),
        fencedYReservation,
        "A terminal fenced reject may retain its own expired Account slot until the next proposal reuses it.",
      );

      const zBody = br01ArticleBody + "\n\nExpired fence proposal.\n";
      const zStage = await br01Post("/br01-stage", {
        managerId: identities.B.managerId,
        articleBody: zBody,
      });
      assert.equal(zStage.response.status, 200, JSON.stringify(zStage.value));
      const zReservationBeforeReject = await bronzeActionReservation(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.equal(
        zReservationBeforeReject.operationId,
        zStage.value.operationId,
        "The Account slot must move to Z after Y's fenced deadline expires.",
      );
      const suspendOwnerForZ = await nativePostgres.db.query(
        `UPDATE operator.identity_manager_ownerships
       SET status = 'suspended'
       WHERE user_id = $1 AND manager_id = $2 AND role = 'owner' AND status = 'active'`,
        [identities.B.userId, identities.B.managerId],
      );
      assert.equal(suspendOwnerForZ.rowCount, 1);
      try {
        const zStaleApproval = await br01Post("/br01-approve", {
          managerId: identities.B.managerId,
          actionId: zStage.value.actionId,
        });
        assert.equal(zStaleApproval.response.status, 500, JSON.stringify(zStaleApproval.value));
        assert.equal(zStaleApproval.value.error, "Knowledge Base permission_denied.");
      } finally {
        const restoreOwnerForZ = await nativePostgres.db.query(
          `UPDATE operator.identity_manager_ownerships
         SET status = 'active'
         WHERE user_id = $1 AND manager_id = $2 AND role = 'owner' AND status = 'suspended'`,
          [identities.B.userId, identities.B.managerId],
        );
        assert.equal(restoreOwnerForZ.rowCount, 1);
      }
      const zReservationBeforeFirstReject = await bronzeActionReservation(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.equal(zReservationBeforeFirstReject.status, "active");
      assert.equal(zReservationBeforeFirstReject.operationId, zStage.value.operationId);
      assert.ok(zReservationBeforeFirstReject.operationDeadlineMs > 0);
      assert.deepEqual(zReservationBeforeFirstReject, {
        ...zReservationBeforeReject,
        operationDeadlineMs: zReservationBeforeFirstReject.operationDeadlineMs,
      });
      const firstZReject = await br01Post("/br01-reject", {
        managerId: identities.B.managerId,
        actionId: zStage.value.actionId,
      });
      assert.equal(firstZReject.response.status, 500, JSON.stringify(firstZReject.value));
      assert.equal(
        firstZReject.value.error,
        "BR01 test fixture lost callback acknowledgement after Knowledge fence.",
      );
      const fencedZReservation = await bronzeActionReservation(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.deepEqual(fencedZReservation, { ...zReservationBeforeFirstReject, status: "fenced" });
      assert.equal(fencedZReservation.operationId, zStage.value.operationId);
      const expiredZReject = await setBR01TestClock(fencedZReservation.operationDeadlineMs + 1);
      assert.equal(expiredZReject.customNow, fencedZReservation.operationDeadlineMs + 1);
      const retryExpiredZReject = await br01Post("/br01-reject", {
        managerId: identities.B.managerId,
        actionId: zStage.value.actionId,
      });
      if (
        retryExpiredZReject.response.status !== 200 ||
        retryExpiredZReject.value.actionState !== "rejected"
      )
        br01Failures.push(
          `BR-D01 expired reject retry returned ${retryExpiredZReject.response.status}: ${retryExpiredZReject.value.error ?? retryExpiredZReject.value.actionState}`,
        );
      if (
        retryExpiredZReject.response.status === 200 &&
        retryExpiredZReject.value.actionState === "rejected"
      )
        assert.deepEqual(
          await bronzeActionReservation(nativeMiniflare, identities.B.managerId),
          fencedZReservation,
          "A matching durable fenced Account slot is sufficient evidence to terminalize the expired reject.",
        );
      assert.equal(
        requireKnowledgeTable(
          await knowledgeDatabaseSnapshot(nativeMiniflare, identities.B.managerId),
          "knowledge_bronze_operations",
          ["operation_id"],
        ).rows.some((row) => row.operation_id === zStage.value.operationId),
        false,
        "The trusted clear lookup after expiry must release the Knowledge fence marker.",
      );

      // A new undispatched proposal exercises the real expired-slot admission cleanup and then
      // releases its own slot, allowing the earlier saved X receipt retry to finish independently.
      const wStage = await br01Post("/br01-stage", {
        managerId: identities.B.managerId,
        articleBody: br01ArticleBody + "\n\nPost-expiry cleanup proposal.\n",
      });
      assert.equal(wStage.response.status, 200, JSON.stringify(wStage.value));
      const wReject = await br01Post("/br01-reject", {
        managerId: identities.B.managerId,
        actionId: wStage.value.actionId,
      });
      assert.equal(wReject.response.status, 200, JSON.stringify(wReject.value));
      assert.equal(wReject.value.actionState, "rejected");
      await setBR01TestClock(null);
      const afterD01Cleanup = await knowledgeDatabaseSnapshot(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.equal(
        requireKnowledgeTable(afterD01Cleanup, "knowledge_article_revisions", [
          "operation_id",
        ]).rows.some(
          (row) =>
            row.operation_id === yStage.value.operationId ||
            row.operation_id === zStage.value.operationId,
        ),
        false,
        "Stale-owner proposals rejected through a fence must not persist article revisions.",
      );
      assert.equal(
        (await bronzeBucket.list({ limit: 16 })).objects.length,
        1,
        "Rejecting fenced proposals must retain only the already-saved X R2 object.",
      );

      const finalXRetry =
        d03FirstXRetry.response.status === 200 && d03FirstXRetry.value.actionState === "approved"
          ? d03FirstXRetry
          : await br01Post("/br01-approve", {
              managerId: identities.B.managerId,
              actionId: staged.actionId,
            });
      const approved = finalXRetry.value;
      assert.equal(
        finalXRetry.response.status,
        200,
        "The same native approval did not recover its saved result.",
      );
      assert.equal(
        approved.actionState,
        "approved",
        "The native ActionLog must record approval after the real owner callback returns.",
      );
      assert.equal(
        approved.actionWasAutomatic,
        false,
        "This acceptance case requires a manual owner decision.",
      );
      assert.equal(approved.ownerSessionId, ownerSession.ownerSessionId);
      assert.equal(
        approved.proofPresentations,
        1,
        "Retrying approval after the same owner is restored must reuse the original proof-authenticated session.",
      );
      assert.deepEqual(
        approved.reads.list.items.map(({ path }) => path),
        d01Fixtures.EXPECTED_PATHS.B,
      );
      assert.equal(approved.reads.list.bundleId, d01Fixtures.B_BUNDLE_HASH);
      assert.equal(approved.reads.search.hits[0]?.path, "concepts/shared.md");
      assert.match(approved.reads.search.hits[0]?.snippet ?? "", /amber/u);
      assert.equal(approved.reads.read.bundleId, d01Fixtures.B_BUNDLE_HASH);
      assert.equal(approved.reads.read.path, "concepts/only-b.md");
      assert.equal(approved.reads.read.sourceMarkdown, d01Fixtures.B_ONLY_SOURCE);
      assert.deepEqual(approved.reads.read.metadata, d01Fixtures.B_ONLY_METADATA);

      const afterApproval = await knowledgeDatabaseSnapshot(
        nativeMiniflare,
        identities.B.managerId,
      );

      const savedObjects = await bronzeBucket.list({ limit: 16 });
      assert.equal(savedObjects.truncated, false);
      assert.equal(
        savedObjects.objects.length,
        1,
        "One approved Bronze revision must create exactly one private R2 object.",
      );
      const savedObject = savedObjects.objects[0];
      assert.equal(savedObject.size, new TextEncoder().encode(br01ArticleBody).byteLength);
      const savedBody = new Uint8Array(
        await (await bronzeBucket.get(savedObject.key)).arrayBuffer(),
      );
      const savedBodyHash = await sha256Hex(savedBody);
      const expectedBodyHash = await sha256Hex(new TextEncoder().encode(br01ArticleBody));
      assert.equal(
        savedBodyHash,
        expectedBodyHash,
        "The private R2 object must contain the exact Markdown approved by the owner.",
      );
      assert.equal(savedBody.byteLength, new TextEncoder().encode(br01ArticleBody).byteLength);

      const articleTable = requireKnowledgeTable(afterApproval, "knowledge_articles", [
        "article_id",
        "current_revision_id",
        "use_policy",
      ]);
      const revisionTable = requireKnowledgeTable(afterApproval, "knowledge_article_revisions", [
        "article_id",
        "revision_id",
        "operation_id",
        "body_hash",
        "body_length",
        "object_key",
        "provenance_json",
        "intent_json",
        "outcome_json",
      ]);
      const goldStateTable = requireKnowledgeTable(afterApproval, "knowledge_gold_state", [
        "mode",
        "dirty_through",
      ]);
      const bronzeOperations = requireKnowledgeTable(afterApproval, "knowledge_bronze_operations", [
        "operation_id",
      ]);
      const savedRevisions = revisionTable.rows.filter(
        (row) => row.operation_id === staged.operationId,
      );
      assert.equal(
        savedRevisions.length,
        1,
        "The saved operation must resolve to one immutable ArticleRevision reference.",
      );
      const revision = savedRevisions[0];
      const articleRows = articleTable.rows.filter((row) => row.article_id === revision.article_id);
      assert.equal(articleRows.length, 1, "The saved revision must belong to one Silver Article.");
      const article = articleRows[0];
      assert.equal(
        article.current_revision_id,
        revision.revision_id,
        "The Article current pointer must reference the operation's immutable revision.",
      );
      assert.equal(
        article.use_policy,
        "included",
        "The Article's initial Wiki-use policy must match the owner-approved Action.",
      );
      assert.equal(
        revision.body_hash,
        savedBodyHash,
        "The immutable revision reference must retain the verified R2 body hash.",
      );
      assert.equal(
        revision.body_length,
        savedBody.byteLength,
        "The immutable revision reference must retain the exact UTF-8 body length.",
      );
      assert.equal(
        revision.object_key,
        savedObject.key,
        "The immutable revision reference must point to the exact private R2 object read back.",
      );
      const provenance = JSON.parse(revision.provenance_json);
      assert.equal(provenance.kind, staged.verifiedSource.kind);
      assert.equal(provenance.chatId, staged.verifiedSource.chatId);
      assert.equal(provenance.sequence, staged.verifiedSource.sequence);
      assert.equal(provenance.timestampMs, staged.verifiedSource.timestampMs);
      assert.deepEqual(
        provenance.author,
        staged.verifiedSource.author,
        "The stored provenance must retain the exact owner-verified author metadata.",
      );
      assert.equal(provenance.observedTargetDescription, "Project review schedule");
      assert.equal(
        provenance.sourceRelationshipClaim,
        "The review date in this article comes from the referenced user message.",
      );
      const intent = JSON.parse(revision.intent_json);
      assert.equal(intent.kind, "adopt");
      assert.equal(intent.initialUsePolicy, "included");
      assert.equal(intent.expectedCurrentRevision, null);
      const savedOutcome = JSON.parse(revision.outcome_json);
      assert.equal(savedOutcome.status, "saved");
      assert.equal(savedOutcome.operationId, staged.operationId);
      assert.equal(savedOutcome.revisionId, revision.revision_id);
      assert.equal(
        bronzeOperations.rows.some((row) => row.operation_id === staged.operationId),
        false,
        "A saved operation must move to its bounded immutable revision reference, not remain active.",
      );
      assert.equal(goldStateTable.rows.length, 1);
      const goldState = goldStateTable.rows[0];
      assert.equal(
        goldState.mode,
        "disabled",
        "Bronze save must not enable Gold or require its future configuration.",
      );
      assert.notEqual(
        goldState.dirty_through,
        goldStateBefore.dirty_through,
        "The approved Silver mutation must durably advance Gold's dirty watermark.",
      );
      assert.notEqual(
        goldState.dirty_through,
        null,
        "The approved Silver mutation must leave a durable dirty watermark while Gold is disabled.",
      );
      assert.equal(
        await knowledgeAlarm(nativeMiniflare, identities.B.managerId),
        alarmBeforeProposal,
        "Gold-disabled Bronze save must not create or move a Durable Object wake.",
      );

      // A self-consistent v2 stage carrying the prior profile must pass the CustomGatekeeper's
      // stage hash check and reach the real Knowledge apply boundary before failing closed.
      const br04ScenarioView = { identities, nativeMiniflare };
      const readBeforeStaleProfile = await br01Post("/br04-read", {
        managerId: identities.B.managerId,
      });
      assert.equal(
        readBeforeStaleProfile.response.status,
        200,
        JSON.stringify(readBeforeStaleProfile.value),
      );
      assert.equal(readBeforeStaleProfile.value.read.sourceMarkdown, d01Fixtures.B_ONLY_SOURCE);
      const staleProfileStageResult = await br01Post("/br01-stage", {
        managerId: identities.B.managerId,
        articleBody:
          br01ArticleBody +
          "\n\nThis proposal must remain staged after a stale-profile conflict.\n",
      });
      assert.equal(
        staleProfileStageResult.response.status,
        200,
        JSON.stringify(staleProfileStageResult.value),
      );
      assert.equal(staleProfileStageResult.value.status, "pending_approval");
      const staleProfileFixture = await replaceWithSelfConsistentV1ProfileStage(
        br04ScenarioView,
        staleProfileStageResult.value.operationId,
      );
      const staleStageBeforeApply = await br04Stage(
        br04ScenarioView,
        staleProfileStageResult.value.operationId,
      );
      const staleCommandBeforeApply = JSON.parse(staleStageBeforeApply.command_json);
      assert.equal(staleCommandBeforeApply.profileId, br04V1ProfileId);
      assert.equal(staleCommandBeforeApply.bodyHash, staleProfileFixture.command.bodyHash);
      assert.equal(staleStageBeforeApply.payload_hash, staleProfileFixture.payloadHash);
      const staleProfileBefore = await br04NoEffectSnapshot(br04ScenarioView);
      const staleProfileApproval = await br01Post("/br01-approve", {
        managerId: identities.B.managerId,
        actionId: staleProfileStageResult.value.actionId,
      });
      assert.equal(
        staleProfileApproval.response.status,
        500,
        JSON.stringify(staleProfileApproval.value),
      );
      assert.equal(
        staleProfileApproval.value.error,
        "Knowledge Base conflict.",
        "A self-consistent prior-profile v2 stage must fail at Knowledge with conflict.",
      );
      const staleProfileAfter = await br04NoEffectSnapshot(br04ScenarioView);
      assertBr04NoKnowledgeEffects(staleProfileBefore, staleProfileAfter);
      assertBr04SameReservationIdentity(
        staleProfileBefore.reservation,
        staleProfileAfter.reservation,
      );
      const staleProfileActionState = await br01Post("/br01-action-state", {
        managerId: identities.B.managerId,
        actionId: staleProfileStageResult.value.actionId,
      });
      assert.equal(staleProfileActionState.value.state, "pending");
      const staleStageAfterApply = await br04Stage(
        br04ScenarioView,
        staleProfileStageResult.value.operationId,
      );
      const staleCommandAfterApply = JSON.parse(staleStageAfterApply.command_json);
      assert.equal(staleStageAfterApply.status, "pending_approval");
      assert.equal(staleStageAfterApply.payload_hash, staleStageBeforeApply.payload_hash);
      assert.equal(staleCommandAfterApply.profileId, staleCommandBeforeApply.profileId);
      assert.equal(staleCommandAfterApply.bodyHash, staleCommandBeforeApply.bodyHash);
      assert.equal(staleCommandAfterApply.fullIntentHash, staleCommandBeforeApply.fullIntentHash);
      assert.deepEqual(
        staleCommandAfterApply.intent,
        staleCommandBeforeApply.intent,
        "The exact immutable intent/body bytes must remain staged after the profile conflict.",
      );
      const br04Control = await nativeMiniflare.getBindings("driver");
      const staleProfileApplyTrace = await br04Control.KNOWLEDGE_BR01_TEST_CONTROL.br04ApplyTrace(
        identities.B.managerId,
      );
      assert.deepEqual(
        staleProfileApplyTrace.at(-1),
        {
          kind: "staged",
          profileId: br04V1ProfileId,
          bodyHash: staleCommandBeforeApply.bodyHash,
          result: "conflict",
        },
        "The real Knowledge apply trace must show rejection of the stale profile after validation.",
      );
      const readAfterStaleProfile = await br01Post("/br04-read", {
        managerId: identities.B.managerId,
      });
      assert.deepEqual(
        readAfterStaleProfile.value,
        readBeforeStaleProfile.value,
        "A stale-profile rejection must preserve the existing Manager read.",
      );
      const staleProfileReject = await br01Post("/br01-reject", {
        managerId: identities.B.managerId,
        actionId: staleProfileStageResult.value.actionId,
      });
      assert.equal(
        staleProfileReject.response.status,
        500,
        JSON.stringify(staleProfileReject.value),
      );
      assert.equal(
        staleProfileReject.value.error,
        "BR01 test fixture lost callback acknowledgement after Knowledge fence.",
      );
      const staleProfileFencedReservation = await bronzeActionReservation(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.equal(staleProfileFencedReservation.status, "fenced");
      assert.equal(
        staleProfileFencedReservation.operationId,
        staleProfileStageResult.value.operationId,
      );
      const retryStaleProfileReject = await br01Post("/br01-reject", {
        managerId: identities.B.managerId,
        actionId: staleProfileStageResult.value.actionId,
      });
      assert.equal(
        retryStaleProfileReject.response.status,
        200,
        JSON.stringify(retryStaleProfileReject.value),
      );
      assert.equal(retryStaleProfileReject.value.actionState, "rejected");
      // Keep both worker clocks beyond this durable fence deadline until the remaining
      // Knowledge operations finish; restoring wall time here would revive its marker.
      await setBR01TestClock(staleProfileFencedReservation.operationDeadlineMs + 1);

      // BR03: use an ActionLog observation created by the real KnowledgeSession.read path as
      // provenance. The workspace is bound when the proof-authenticated session opens; proposal
      // input carries only the actual ActionLog IDs, never a caller-selected workspace.
      const post = async (path, input) => {
        return br01Post(path, input);
      };
      const br03Before = await knowledgeDatabaseSnapshot(nativeMiniflare, identities.B.managerId);
      const br03BeforeInvariant = knowledgeWriteInvariantSnapshot(br03Before);
      const br03BeforeObjects = await bronzeBucket.list({ limit: 32 });
      assert.equal(br03BeforeObjects.truncated, false);
      const br03BeforeAlarm = await knowledgeAlarm(nativeMiniflare, identities.B.managerId);

      const observedBResult = await post("/br03-observe", { managerId: identities.B.managerId });
      assert.equal(
        observedBResult.response.status,
        200,
        "A native Knowledge read did not produce an observation.",
      );
      const observedB = observedBResult.value.source;
      assert.equal(observedB.kind, "os_observation");
      assert.equal(Number.isSafeInteger(observedB.actionId), true);
      assert.equal(observedB.actionId >= 0, true);
      assert.equal(Number.isSafeInteger(observedB.gatekeeperId), true);
      assert.equal(observedB.gatekeeperId >= 0, true);
      assert.equal(Number.isSafeInteger(observedB.createdAtMs), true);
      assert.equal(typeof observedB.title, "string");
      assert.equal(observedB.title.length > 0, true);
      assert.equal(typeof observedB.resourceTitle, "string");
      assert.equal(observedB.resourceTitle.length > 0, true);
      assert.equal(observedBResult.value.read.path, "concepts/shared.md");
      assert.equal(observedBResult.value.ownerSessionId, ownerSession.ownerSessionId);
      assert.equal(observedBResult.value.proofPresentations, 1);

      const observationsBResult = await post("/br03-observation-list", {
        managerId: identities.B.managerId,
      });
      assert.equal(observationsBResult.response.status, 200);
      const observationsB = observationsBResult.value.observations;
      const observationPair = (source) => `${source.gatekeeperId}:${source.actionId}`;
      const observationKeysB = new Set(observationsB.map(observationPair));
      assert.equal(
        observationKeysB.has(observationPair(observedB)),
        true,
        "The returned source must be present in this proof-authenticated workspace's real ActionLog.",
      );
      const actionCountBeforeRejectedSources = observationsBResult.value.actionCount;

      let unknownActionId = Math.max(...observationsB.map((source) => source.actionId)) + 1;
      while (observationKeysB.has(`${observedB.gatekeeperId}:${unknownActionId}`))
        unknownActionId += 1;
      assert.equal(Number.isSafeInteger(unknownActionId), true);
      const unknownSourceResult = await post("/br03-stage-observation", {
        managerId: identities.B.managerId,
        kind: "adopt",
        sourceActionId: unknownActionId,
        sourceGatekeeperId: observedB.gatekeeperId,
      });
      assert.equal(
        unknownSourceResult.response.status,
        500,
        "An unknown ActionLog observation must fail through the real source-reader boundary.",
      );
      assert.equal(
        unknownSourceResult.value.error,
        "Manager Knowledge invalid_input.",
        "The source reader must reject an unknown observation using its existing fixed native error contract.",
      );

      let ownerASessionOpened = false;
      try {
        const ownerAOpen = await post("/br01-open", {
          managerId: identities.A.managerId,
          proof: proofA.proof,
          workspaceId: result.workspaceAId,
        });
        assert.equal(ownerAOpen.response.status, 200);
        ownerASessionOpened = true;
        let foreignSource;
        for (let attempt = 0; attempt < 8 && foreignSource === undefined; attempt += 1) {
          const observedAResult = await post("/br03-observe", {
            managerId: identities.A.managerId,
          });
          assert.equal(
            observedAResult.response.status,
            200,
            "The foreign owner workspace must produce an actual native observation.",
          );
          const candidate = observedAResult.value.source;
          if (!observationKeysB.has(observationPair(candidate))) foreignSource = candidate;
        }
        assert.ok(
          foreignSource,
          "The actual foreign ActionLog pair must not collide with an observation in the target workspace.",
        );
        const closeA = await post("/br01-close", { managerId: identities.A.managerId });
        assert.equal(closeA.response.status, 200);
        ownerASessionOpened = false;

        const foreignSourceResult = await post("/br03-stage-observation", {
          managerId: identities.B.managerId,
          kind: "adopt",
          sourceActionId: foreignSource.actionId,
          sourceGatekeeperId: foreignSource.gatekeeperId,
        });
        assert.equal(
          foreignSourceResult.response.status,
          500,
          "An actual source from another owner's workspace must fail in the target owner's fixed workspace.",
        );
        assert.equal(
          foreignSourceResult.value.error,
          "Manager Knowledge invalid_input.",
          "The fixed target workspace must reject a source pair that exists only in another owner's workspace.",
        );
      } finally {
        if (ownerASessionOpened) await post("/br01-close", { managerId: identities.A.managerId });
      }

      const observationsAfterDeniedSources = await post("/br03-observation-list", {
        managerId: identities.B.managerId,
      });
      assert.equal(observationsAfterDeniedSources.response.status, 200);
      assert.equal(
        observationsAfterDeniedSources.value.actionCount,
        actionCountBeforeRejectedSources,
        "Unknown and foreign source attempts must not create native pending Actions.",
      );
      const afterDeniedSources = await knowledgeDatabaseSnapshot(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.deepEqual(
        knowledgeWriteInvariantSnapshot(afterDeniedSources),
        br03BeforeInvariant,
        "Unknown and foreign source attempts must not mutate actual Knowledge SQLite state.",
      );
      const objectsAfterDeniedSources = await bronzeBucket.list({ limit: 32 });
      assert.deepEqual(
        objectsAfterDeniedSources.objects.map(({ key, size, etag }) => ({ key, size, etag })),
        br03BeforeObjects.objects.map(({ key, size, etag }) => ({ key, size, etag })),
        "Unknown and foreign source attempts must not write or replace real R2 objects.",
      );
      assert.equal(await knowledgeAlarm(nativeMiniflare, identities.B.managerId), br03BeforeAlarm);

      const rejectedObservationProposal = await post("/br03-stage-observation", {
        managerId: identities.B.managerId,
        kind: "adopt",
        sourceActionId: observedB.actionId,
        sourceGatekeeperId: observedB.gatekeeperId,
      });
      assert.equal(
        rejectedObservationProposal.response.status,
        200,
        JSON.stringify(rejectedObservationProposal.value),
      );
      assert.equal(
        (await bronzeActionReservation(nativeMiniflare, identities.B.managerId)).operationId,
        rejectedObservationProposal.value.operationId,
        "The next proposal must replace the expired fenced slot through the existing reservation path.",
      );
      assert.equal(rejectedObservationProposal.value.status, "pending_approval");
      assert.equal(rejectedObservationProposal.value.verifiedSourcePresented, true);
      assert.deepEqual(rejectedObservationProposal.value.verifiedSource, observedB);
      assert.equal(rejectedObservationProposal.value.actionDescriptionComplete, true);
      assert.equal(rejectedObservationProposal.value.noTruncatedFields, true);
      assert.equal(rejectedObservationProposal.value.exactBodyPresented, true);
      const rejectObservation = await post("/br01-reject", {
        managerId: identities.B.managerId,
        actionId: rejectedObservationProposal.value.actionId,
      });
      assert.equal(rejectObservation.response.status, 200);
      assert.equal(rejectObservation.value.actionState, "rejected");
      const afterObservationReject = await knowledgeDatabaseSnapshot(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.deepEqual(
        knowledgeWriteInvariantSnapshot(afterObservationReject),
        br03BeforeInvariant,
        "Rejecting an observation-backed proposal must not persist its article or advance dirty state.",
      );
      assert.deepEqual(
        (await bronzeBucket.list({ limit: 32 })).objects.map(({ key, size, etag }) => ({
          key,
          size,
          etag,
        })),
        br03BeforeObjects.objects.map(({ key, size, etag }) => ({ key, size, etag })),
      );

      const observationAdopt = await post("/br03-stage-observation", {
        managerId: identities.B.managerId,
        kind: "adopt",
        sourceActionId: observedB.actionId,
        sourceGatekeeperId: observedB.gatekeeperId,
      });
      assert.equal(observationAdopt.response.status, 200);
      assert.equal(observationAdopt.value.status, "pending_approval");
      assert.equal(observationAdopt.value.verifiedSourcePresented, true);
      assert.deepEqual(observationAdopt.value.verifiedSource, observedB);
      assert.equal(observationAdopt.value.proposalResultContainsManagerId, false);
      const observationAdoptDecision = await post("/br01-approve", {
        managerId: identities.B.managerId,
        actionId: observationAdopt.value.actionId,
      });
      assert.equal(
        observationAdoptDecision.response.status,
        200,
        JSON.stringify(observationAdoptDecision.value),
      );
      assert.equal(observationAdoptDecision.value.actionState, "approved");
      assert.equal(observationAdoptDecision.value.actionWasAutomatic, false);
      const afterObservationAdopt = await knowledgeDatabaseSnapshot(
        nativeMiniflare,
        identities.B.managerId,
      );
      const adoptedObservationRevisions = requireKnowledgeTable(
        afterObservationAdopt,
        "knowledge_article_revisions",
        [
          "operation_id",
          "article_id",
          "revision_id",
          "body_hash",
          "body_length",
          "provenance_json",
        ],
      ).rows.filter((row) => row.operation_id === observationAdopt.value.operationId);
      assert.equal(adoptedObservationRevisions.length, 1);
      const adoptedObservationRevision = adoptedObservationRevisions[0];
      assert.deepEqual(JSON.parse(adoptedObservationRevision.provenance_json), {
        version: "os-provenance-dto-v1",
        kind: "os_observation",
        actionId: observedB.actionId,
        gatekeeperId: observedB.gatekeeperId,
        createdAtMs: observedB.createdAtMs,
        title: observedB.title,
        resourceTitle: observedB.resourceTitle,
        observedTargetDescription: "Shared release checklist",
        sourceRelationshipClaim:
          "This article records the checklist observed in the referenced Knowledge read.",
      });
      assert.equal(
        adoptedObservationRevision.body_length,
        new TextEncoder().encode(observationAdopt.value.body).byteLength,
      );
      const adoptedCurrentArticle = requireKnowledgeTable(
        afterObservationAdopt,
        "knowledge_articles",
        ["article_id", "current_revision_id", "use_policy"],
      ).rows.find((row) => row.article_id === adoptedObservationRevision.article_id);
      assert.equal(
        adoptedCurrentArticle.current_revision_id,
        adoptedObservationRevision.revision_id,
      );
      assert.equal(adoptedCurrentArticle.use_policy, "included");

      const observationRevise = await post("/br03-stage-observation", {
        managerId: identities.B.managerId,
        kind: "revise",
        articleId: adoptedObservationRevision.article_id,
        expectedCurrentRevision: adoptedObservationRevision.revision_id,
        sourceActionId: observedB.actionId,
        sourceGatekeeperId: observedB.gatekeeperId,
      });
      assert.equal(observationRevise.response.status, 200);
      assert.equal(observationRevise.value.status, "pending_approval");
      assert.equal(observationRevise.value.verifiedSourcePresented, true);
      assert.deepEqual(observationRevise.value.verifiedSource, observedB);
      const observationReviseDecision = await post("/br01-approve", {
        managerId: identities.B.managerId,
        actionId: observationRevise.value.actionId,
      });
      assert.equal(observationReviseDecision.response.status, 200);
      assert.equal(observationReviseDecision.value.actionState, "approved");
      const afterObservationRevise = await knowledgeDatabaseSnapshot(
        nativeMiniflare,
        identities.B.managerId,
      );
      const observationRevisions = requireKnowledgeTable(
        afterObservationRevise,
        "knowledge_article_revisions",
        [
          "operation_id",
          "article_id",
          "revision_id",
          "body_hash",
          "body_length",
          "provenance_json",
        ],
      ).rows.filter((row) => row.article_id === adoptedObservationRevision.article_id);
      assert.equal(
        observationRevisions.length,
        2,
        "The observation-backed revise must retain the immutable adopted revision and append one current revision.",
      );
      assert.equal(
        observationRevisions.some(
          (row) => row.revision_id === adoptedObservationRevision.revision_id,
        ),
        true,
      );
      const revisedObservationRevision = observationRevisions.find(
        (row) => row.operation_id === observationRevise.value.operationId,
      );
      assert.ok(revisedObservationRevision);
      assert.deepEqual(JSON.parse(revisedObservationRevision.provenance_json), {
        version: "os-provenance-dto-v1",
        kind: "os_observation",
        actionId: observedB.actionId,
        gatekeeperId: observedB.gatekeeperId,
        createdAtMs: observedB.createdAtMs,
        title: observedB.title,
        resourceTitle: observedB.resourceTitle,
        observedTargetDescription: "Shared release checklist",
        sourceRelationshipClaim:
          "This revision reflects the checklist observed in the referenced Knowledge read.",
      });
      const revisedCurrentArticle = requireKnowledgeTable(
        afterObservationRevise,
        "knowledge_articles",
        ["article_id", "current_revision_id", "use_policy"],
      ).rows.find((row) => row.article_id === adoptedObservationRevision.article_id);
      assert.equal(
        revisedCurrentArticle.current_revision_id,
        revisedObservationRevision.revision_id,
      );
      assert.equal(
        revisedCurrentArticle.use_policy,
        "included",
        "A revise proposal must preserve the article's existing use policy.",
      );
      assert.equal(afterObservationRevise.knowledge_gold_state.rows[0].mode, "disabled");

      const unknownBody =
        br01ArticleBody + "\n\nReject retry after a lost Account activation acknowledgement.\n";
      const unknownStage = await br01Post("/br01-stage", {
        managerId: identities.B.managerId,
        articleBody: unknownBody,
      });
      assert.equal(unknownStage.response.status, 200, JSON.stringify(unknownStage.value));
      const control = await nativeMiniflare.getBindings("driver");
      await control.KNOWLEDGE_BR01_TEST_CONTROL.armFault("lose-put-and-reconciliation-get");
      const firstUnknownApproval = await br01Post("/br01-approve", {
        managerId: identities.B.managerId,
        actionId: unknownStage.value.actionId,
      });
      assert.equal(
        firstUnknownApproval.response.status,
        500,
        JSON.stringify(firstUnknownApproval.value),
      );
      assert.equal(firstUnknownApproval.value.error, "Knowledge Base result_unknown.");
      const unknownReservation = await bronzeActionReservation(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.equal(unknownReservation.operationId, unknownStage.value.operationId);
      assert.equal(unknownReservation.status, "active");
      assert.ok(unknownReservation.operationDeadlineMs > 0);
      const unknownAfterApply = await knowledgeDatabaseSnapshot(
        nativeMiniflare,
        identities.B.managerId,
      );
      const unknownOperation = requireKnowledgeTable(
        unknownAfterApply,
        "knowledge_bronze_operations",
        ["operation_id", "state"],
      ).rows.find((row) => row.operation_id === unknownStage.value.operationId);
      assert.equal(
        unknownOperation?.state,
        "object_unknown",
        "The existing real-PUT/response-loss fixture must leave an active object_unknown operation.",
      );

      const reconciliationUnknownApproval = await br01Post("/br01-approve", {
        managerId: identities.B.managerId,
        actionId: unknownStage.value.actionId,
      });
      assert.equal(
        reconciliationUnknownApproval.response.status,
        500,
        JSON.stringify(reconciliationUnknownApproval.value),
      );
      assert.equal(reconciliationUnknownApproval.value.error, "Knowledge Base result_unknown.");
      assert.equal(
        (await bronzeActionReservation(nativeMiniflare, identities.B.managerId)).status,
        "active",
      );
      assert.equal(
        requireKnowledgeTable(
          await knowledgeDatabaseSnapshot(nativeMiniflare, identities.B.managerId),
          "knowledge_bronze_operations",
          ["operation_id", "state"],
        ).rows.find((row) => row.operation_id === unknownStage.value.operationId)?.state,
        "object_unknown",
        "The real reconciliation-GET response loss must leave the operation unknown before rejecting it.",
      );

      await armBronzeActivateAckLoss(
        nativeMiniflare,
        identities.B.managerId,
        unknownReservation.localActionId,
      );
      const firstUnknownReject = await br01Post("/br01-reject", {
        managerId: identities.B.managerId,
        actionId: unknownStage.value.actionId,
      });
      assert.equal(
        firstUnknownReject.response.status,
        500,
        JSON.stringify(firstUnknownReject.value),
      );
      assert.equal(
        firstUnknownReject.value.error,
        "BR01 test fixture lost Account activation acknowledgement after commit.",
      );
      assert.equal(
        (await bronzeActionReservation(nativeMiniflare, identities.B.managerId)).status,
        "active",
      );
      const unknownAfterReject = await knowledgeDatabaseSnapshot(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.equal(
        requireKnowledgeTable(unknownAfterReject, "knowledge_bronze_operations", [
          "operation_id",
          "state",
        ]).rows.find((row) => row.operation_id === unknownStage.value.operationId)?.state,
        "object_unknown",
        "Losing the activation acknowledgement must happen before the staged_fence RPC is delivered.",
      );

      const retryUnknownReject = await br01Post("/br01-reject", {
        managerId: identities.B.managerId,
        actionId: unknownStage.value.actionId,
      });
      if (
        retryUnknownReject.response.status === 500 &&
        retryUnknownReject.value.error ===
          "BR01 test fixture lost callback acknowledgement after Knowledge fence."
      ) {
        assert.equal(
          (await bronzeActionReservation(nativeMiniflare, identities.B.managerId)).status,
          "fenced",
        );
        assert.equal(
          requireKnowledgeTable(
            await knowledgeDatabaseSnapshot(nativeMiniflare, identities.B.managerId),
            "knowledge_bronze_operations",
            ["operation_id", "state"],
          ).rows.find((row) => row.operation_id === unknownStage.value.operationId)?.state,
          "cancelled_fenced",
          "The known lost Account fence acknowledgement must follow the durable Knowledge fence.",
        );
        const terminalUnknownReject = await br01Post("/br01-reject", {
          managerId: identities.B.managerId,
          actionId: unknownStage.value.actionId,
        });
        if (
          terminalUnknownReject.response.status !== 200 ||
          terminalUnknownReject.value.actionState !== "rejected"
        )
          br01Failures.push(
            `BR-D01 terminal retry after the known fence acknowledgement loss returned ${terminalUnknownReject.response.status}: ${terminalUnknownReject.value.error ?? terminalUnknownReject.value.actionState}`,
          );
      } else if (
        retryUnknownReject.response.status !== 200 ||
        retryUnknownReject.value.actionState !== "rejected"
      ) {
        br01Failures.push(
          `BR-D01 rejecting retry after active object_unknown returned ${retryUnknownReject.response.status}: ${retryUnknownReject.value.error ?? retryUnknownReject.value.actionState}`,
        );
      }

      const fencedUnknownReservation = await bronzeActionReservation(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.equal(fencedUnknownReservation.status, "fenced");
      await setBR01TestClock(fencedUnknownReservation.operationDeadlineMs + 1);
      const expiredUnknownBody =
        br01ArticleBody + "\n\nReject an unknown object after the admission deadline.\n";
      const expiredUnknownStage = await br01Post("/br01-stage", {
        managerId: identities.B.managerId,
        articleBody: expiredUnknownBody,
      });
      assert.equal(
        expiredUnknownStage.response.status,
        200,
        JSON.stringify(expiredUnknownStage.value),
      );
      const expiredUnknownReservation = await bronzeActionReservation(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.equal(expiredUnknownReservation.operationId, expiredUnknownStage.value.operationId);
      const currentArticlesBeforeExpiredUnknown = requireKnowledgeTable(
        await knowledgeDatabaseSnapshot(nativeMiniflare, identities.B.managerId),
        "knowledge_articles",
        ["article_id", "current_revision_id", "use_policy"],
      ).rows;
      const currentRevisionsBeforeExpiredUnknown = requireKnowledgeTable(
        await knowledgeDatabaseSnapshot(nativeMiniflare, identities.B.managerId),
        "knowledge_article_revisions",
        ["operation_id", "article_id", "revision_id", "body_hash"],
      ).rows;
      await control.KNOWLEDGE_BR01_TEST_CONTROL.armFault("lose-put-and-reconciliation-get");
      const expiredUnknownApproval = await br01Post("/br01-approve", {
        managerId: identities.B.managerId,
        actionId: expiredUnknownStage.value.actionId,
      });
      assert.equal(
        expiredUnknownApproval.response.status,
        500,
        JSON.stringify(expiredUnknownApproval.value),
      );
      assert.equal(expiredUnknownApproval.value.error, "Knowledge Base result_unknown.");
      const expiredUnknownAfterApply = await knowledgeDatabaseSnapshot(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.equal(
        requireKnowledgeTable(expiredUnknownAfterApply, "knowledge_bronze_operations", [
          "operation_id",
          "state",
        ]).rows.find((row) => row.operation_id === expiredUnknownStage.value.operationId)?.state,
        "object_unknown",
      );
      const reconciliationExpiredUnknownApproval = await br01Post("/br01-approve", {
        managerId: identities.B.managerId,
        actionId: expiredUnknownStage.value.actionId,
      });
      assert.equal(
        reconciliationExpiredUnknownApproval.response.status,
        500,
        JSON.stringify(reconciliationExpiredUnknownApproval.value),
      );
      assert.equal(
        reconciliationExpiredUnknownApproval.value.error,
        "Knowledge Base result_unknown.",
      );
      assert.equal(
        (await bronzeActionReservation(nativeMiniflare, identities.B.managerId)).status,
        "active",
      );
      assert.equal(
        requireKnowledgeTable(
          await knowledgeDatabaseSnapshot(nativeMiniflare, identities.B.managerId),
          "knowledge_bronze_operations",
          ["operation_id", "state"],
        ).rows.find((row) => row.operation_id === expiredUnknownStage.value.operationId)?.state,
        "object_unknown",
        "The real reconciliation-GET response loss must leave the expired operation unknown before rejecting it.",
      );
      const activeExpiredUnknownReservation = await bronzeActionReservation(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.equal(activeExpiredUnknownReservation.status, "active");
      assert.ok(activeExpiredUnknownReservation.operationDeadlineMs > 0);
      await armBronzeActivateAckLoss(
        nativeMiniflare,
        identities.B.managerId,
        activeExpiredUnknownReservation.localActionId,
      );
      const firstExpiredUnknownReject = await br01Post("/br01-reject", {
        managerId: identities.B.managerId,
        actionId: expiredUnknownStage.value.actionId,
      });
      assert.equal(
        firstExpiredUnknownReject.response.status,
        500,
        JSON.stringify(firstExpiredUnknownReject.value),
      );
      assert.equal(
        firstExpiredUnknownReject.value.error,
        "BR01 test fixture lost Account activation acknowledgement after commit.",
      );
      assert.equal(
        (await bronzeActionReservation(nativeMiniflare, identities.B.managerId)).status,
        "active",
      );
      assert.equal(
        requireKnowledgeTable(
          await knowledgeDatabaseSnapshot(nativeMiniflare, identities.B.managerId),
          "knowledge_bronze_operations",
          ["operation_id", "state"],
        ).rows.find((row) => row.operation_id === expiredUnknownStage.value.operationId)?.state,
        "object_unknown",
      );
      await setBR01TestClock(activeExpiredUnknownReservation.operationDeadlineMs + 1);
      const expiredFenceRetry = await br01Post("/br01-reject", {
        managerId: identities.B.managerId,
        actionId: expiredUnknownStage.value.actionId,
      });
      assert.equal(expiredFenceRetry.response.status, 500, JSON.stringify(expiredFenceRetry.value));
      assert.equal(
        expiredFenceRetry.value.error,
        "BR01 test fixture lost callback acknowledgement after Knowledge fence.",
      );
      assert.equal(
        (await bronzeActionReservation(nativeMiniflare, identities.B.managerId)).status,
        "fenced",
      );
      const expiredFenceSnapshot = await knowledgeDatabaseSnapshot(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.equal(
        requireKnowledgeTable(expiredFenceSnapshot, "knowledge_bronze_operations", [
          "operation_id",
        ]).rows.some((row) => row.operation_id === expiredUnknownStage.value.operationId),
        false,
        "The expired staged fence must close the unknown operation after retaining its object as an orphan.",
      );
      assert.equal(
        requireKnowledgeTable(expiredFenceSnapshot, "knowledge_bronze_orphans", [
          "operation_id",
        ]).rows.some((row) => row.operation_id === expiredUnknownStage.value.operationId),
        true,
      );
      assert.deepEqual(
        requireKnowledgeTable(expiredFenceSnapshot, "knowledge_articles", [
          "article_id",
          "current_revision_id",
          "use_policy",
        ]).rows,
        currentArticlesBeforeExpiredUnknown,
        "Fencing the unknown object after expiry must not advance any current article.",
      );
      assert.deepEqual(
        requireKnowledgeTable(expiredFenceSnapshot, "knowledge_article_revisions", [
          "operation_id",
          "article_id",
          "revision_id",
          "body_hash",
        ]).rows,
        currentRevisionsBeforeExpiredUnknown,
        "Fencing the unknown object after expiry must not create a saved revision.",
      );
      const terminalExpiredUnknownReject = await br01Post("/br01-reject", {
        managerId: identities.B.managerId,
        actionId: expiredUnknownStage.value.actionId,
      });
      assert.equal(
        terminalExpiredUnknownReject.response.status,
        200,
        JSON.stringify(terminalExpiredUnknownReject.value),
      );
      assert.equal(terminalExpiredUnknownReject.value.actionState, "rejected");
      assert.equal(
        (await bronzeActionReservation(nativeMiniflare, identities.B.managerId)).status,
        "fenced",
      );

      const stuckBaseNow = activeExpiredUnknownReservation.operationDeadlineMs + 1;
      await setBR01TestClock(stuckBaseNow);
      const preCommitFailureStage = await br01Post("/br01-stage", {
        managerId: identities.B.managerId,
        articleBody:
          br01ArticleBody +
          "\n\nPre-commit Account activation failures must not strand the Manager.\n",
      });
      assert.equal(
        preCommitFailureStage.response.status,
        200,
        JSON.stringify(preCommitFailureStage.value),
      );
      const preCommitReservation = await bronzeActionReservation(
        nativeMiniflare,
        identities.B.managerId,
      );
      assert.equal(preCommitReservation.operationId, preCommitFailureStage.value.operationId);
      assert.equal(preCommitReservation.status, "active");
      assert.equal(preCommitReservation.operationDeadlineMs, 0);
      await armBronzeActivatePreCommitFailures(
        nativeMiniflare,
        identities.B.managerId,
        preCommitReservation.localActionId,
        2,
      );
      const preCommitApproval = await br01Post("/br01-approve", {
        managerId: identities.B.managerId,
        actionId: preCommitFailureStage.value.actionId,
      });
      assert.equal(preCommitApproval.response.status, 500);
      assert.deepEqual(
        await bronzeActionReservation(nativeMiniflare, identities.B.managerId),
        preCommitReservation,
        "A pre-commit activation failure during approval must leave the original deadline-zero Account slot intact.",
      );
      const preCommitReject = await br01Post("/br01-reject", {
        managerId: identities.B.managerId,
        actionId: preCommitFailureStage.value.actionId,
      });
      assert.equal(preCommitReject.response.status, 500);
      assert.deepEqual(
        await bronzeActionReservation(nativeMiniflare, identities.B.managerId),
        preCommitReservation,
        "A second pre-commit activation failure during rejection must still leave the deadline-zero slot intact.",
      );

      await setBR01TestClock(stuckBaseNow + 300_001);
      const expiredPreCommitReject = await br01Post("/br01-reject", {
        managerId: identities.B.managerId,
        actionId: preCommitFailureStage.value.actionId,
      });
      assert.equal(
        expiredPreCommitReject.response.status,
        200,
        JSON.stringify(expiredPreCommitReject.value),
      );
      assert.equal(expiredPreCommitReject.value.actionState, "rejected");
      assert.equal(
        await bronzeActionReservation(nativeMiniflare, identities.B.managerId),
        undefined,
        "A deadline-expired rejection must release its matching deadline-zero Account reservation.",
      );
      const nextAfterPreCommitFailures = await br01Post("/br01-stage", {
        managerId: identities.B.managerId,
        articleBody: br01ArticleBody + "\n\nA new proposal after recovered pre-commit failures.\n",
      });
      assert.equal(
        nextAfterPreCommitFailures.response.status,
        200,
        JSON.stringify(nextAfterPreCommitFailures.value),
      );

      await setBR01TestClock(null);

      assert.deepEqual(br01Failures, [], "Native Bronze regressions: " + br01Failures.join("; "));

      const closeOwnerResponse = await nativeMiniflare.dispatchFetch(
        "https://driver.invalid/br01-close",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ managerId: identities.B.managerId }),
        },
      );
      const closeOwner = await closeOwnerResponse.json();
      assert.equal(
        closeOwnerResponse.status,
        200,
        "The BR01 owner session must close cleanly after the native test.",
      );
      assert.equal(closeOwner.closed, true);
      br01OwnerSessionOpened = false;
    } finally {
      try {
        if (nativeMiniflare) {
          try {
            await nativeMiniflare.dispatchFetch("https://driver.invalid/br01-set-test-clock", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ now: null }),
            });
          } catch {
            // Miniflare disposal below remains the final cleanup for a failed fixture operation.
          }
        }
        if (br01OwnerSessionOpened && br01ManagerId && nativeMiniflare) {
          try {
            await nativeMiniflare.dispatchFetch("https://driver.invalid/br01-close", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ managerId: br01ManagerId }),
            });
          } catch {
            // Miniflare disposal below remains the final cleanup for a failed fixture operation.
          }
        }
        await nativeMiniflare?.dispose();
      } finally {
        await nativePostgres?.dispose();
      }
    }
  },
);

test(
  "BR04 unavailable validator refuses proposal before staging",
  {
    timeout: 180_000,
    skip: process.env.CYBERNEST_RUN_LOCAL_DB !== "1",
  },
  async () => {
    const unavailableScenario = await startBR04Scenario();
    try {
      const managerId = unavailableScenario.identities.B.managerId;
      const readBefore = await postNative(unavailableScenario.nativeMiniflare, "/br04-read", {
        managerId,
      });
      assert.equal(readBefore.response.status, 200, JSON.stringify(readBefore.value));
      const before = await br04NoEffectSnapshot(unavailableScenario);
      const control = await unavailableScenario.nativeMiniflare.getBindings("driver");
      await control.KNOWLEDGE_BR01_TEST_CONTROL.armBr04ValidatorRpcFailure();
      const unavailable = await postNative(unavailableScenario.nativeMiniflare, "/br01-stage", {
        managerId,
        articleBody: br01ArticleBody,
      });
      const after = await br04NoEffectSnapshot(unavailableScenario);
      assert.deepEqual(
        after,
        before,
        "RPC unavailability must happen before an Action ID, Account reservation, stage, Knowledge write, or R2 object.",
      );
      assert.equal(unavailable.response.status, 500, JSON.stringify(unavailable.value));
      assert.equal(
        unavailable.value.error,
        "Knowledge Base dependency_unavailable.",
        "The awaited validator RPC rejection must surface as dependency_unavailable.",
      );
      await control.KNOWLEDGE_BR01_TEST_CONTROL.clearBr04ValidatorRpcFailure();
      const readAfter = await postNative(unavailableScenario.nativeMiniflare, "/br04-read", {
        managerId,
      });
      assert.deepEqual(readAfter.value, readBefore.value);
    } finally {
      await unavailableScenario.dispose();
    }

    // An actual old worker installs its v1 writer under fixed owner props. Updating only the
    // CustomGatekeeper consumer leaves that persisted capability untouched and must refuse it.
    const v1CapabilityScenario = await startBR04Scenario({
      workerScripts: br04V1WorkerScripts,
      resourcePersistencePath: "temporary",
      includeNavigationPage: false,
    });
    try {
      const managerId = v1CapabilityScenario.identities.B.managerId;
      await v1CapabilityScenario.restartWith({
        ...br04V1WorkerScripts,
        workshop: workshopTestScript,
        custom: customScript,
      });
      const readBefore = await postNative(v1CapabilityScenario.nativeMiniflare, "/br04-read", {
        managerId,
      });
      assert.equal(readBefore.response.status, 200, JSON.stringify(readBefore.value));
      const ownerBindingsBefore = await postNative(
        v1CapabilityScenario.nativeMiniflare,
        "/br04-role-bindings",
        {
          managerId,
          foreignManagerId: v1CapabilityScenario.identities.A.managerId,
        },
      );
      assert.equal(
        ownerBindingsBefore.response.status,
        200,
        JSON.stringify(ownerBindingsBefore.value),
      );
      assert.equal(
        ownerBindingsBefore.value.writerInstalled,
        true,
        "The old private writer must remain stored in the Account slot across the consumer upgrade.",
      );
      assert.equal(
        ownerBindingsBefore.value.sourceReaderInstalled,
        true,
        "The old source reader must remain stored in the Account slot across the consumer upgrade.",
      );
      assert.equal(
        ownerBindingsBefore.value.ownerManagerAccepted,
        true,
        "The stored writer and source reader must remain bound to their original Manager.",
      );
      assert.equal(ownerBindingsBefore.value.foreignWriterRejected, true);
      assert.equal(ownerBindingsBefore.value.foreignSourceReaderRejected, true);
      const before = await br04NoEffectSnapshot(v1CapabilityScenario);
      const rejected = await postNative(v1CapabilityScenario.nativeMiniflare, "/br01-stage", {
        managerId,
        articleBody: br01ArticleBody,
      });
      assert.equal(rejected.response.status, 500, JSON.stringify(rejected.value));
      assert.equal(
        rejected.value.error,
        "Knowledge Base permission_denied.",
        "A v1 private writer contract mismatch must refuse proposal before staging.",
      );
      const after = await br04NoEffectSnapshot(v1CapabilityScenario);
      assert.deepEqual(
        after,
        before,
        "A retained v1 writer refusal must not consume an Action ID, reserve capacity, stage, or write Knowledge/R2.",
      );
      const readAfter = await postNative(v1CapabilityScenario.nativeMiniflare, "/br04-read", {
        managerId,
      });
      assert.deepEqual(
        readAfter.value,
        readBefore.value,
        "The v1 writer refusal must preserve the existing owner-bound read capability.",
      );
      const ownerBindingsAfter = await postNative(
        v1CapabilityScenario.nativeMiniflare,
        "/br04-role-bindings",
        {
          managerId,
          foreignManagerId: v1CapabilityScenario.identities.A.managerId,
        },
      );
      assert.deepEqual(
        ownerBindingsAfter,
        ownerBindingsBefore,
        "The v1 writer refusal must preserve the stored writer/read slots and fixed owner bindings.",
      );
    } finally {
      await v1CapabilityScenario.dispose();
    }
  },
);

test(
  "SL02 Silver policy uses owner Actions and advances metadata without a body revision",
  {
    timeout: 180_000,
    skip: process.env.CYBERNEST_RUN_LOCAL_DB !== "1",
  },
  async () => {
    const scenario = await startBR04Scenario();
    const { identities, nativeMiniflare } = scenario;
    const managerId = identities.B.managerId;
    try {
      assert.deepEqual(
        scenario.boot.preflightBAfterBronzeInstall.value.bronzeRoles,
        {
          writer: "installed",
          sourceReader: "installed",
        },
        "The real Core→OS Bronze role check must succeed before the test-only Silver activation.",
      );

      const created = await createNativeArticleForPolicy(nativeMiniflare, managerId, "excluded");
      const articleId = created.article.article_id;
      const initialArticle = requireSilverArticle(created.snapshot, articleId);
      assert.equal(initialArticle.use_policy, "excluded");
      const initialMetadataRevision = initialArticle.metadata_revision;
      const initialCurrentRevisionId = initialArticle.current_revision_id;
      const initialRevisionIds = requireKnowledgeTable(
        created.snapshot,
        "knowledge_article_revisions",
        ["article_id", "revision_id"],
      )
        .rows.filter((row) => row.article_id === articleId)
        .map((row) => row.revision_id)
        .sort();
      const initialSnapshot = await br04NoEffectSnapshot(scenario);
      const readBeforeGateCheck = await postNative(nativeMiniflare, "/br04-read", { managerId });
      assert.equal(
        readBeforeGateCheck.response.status,
        200,
        JSON.stringify(readBeforeGateCheck.value),
      );

      const closedGateProposal = await proposeNativePolicy(
        nativeMiniflare,
        managerId,
        articleId,
        "included",
        initialMetadataRevision,
      );
      assert.equal(
        closedGateProposal.response.status,
        200,
        JSON.stringify(closedGateProposal.value),
      );
      assert.equal(closedGateProposal.value.status, "pending_approval");
      assert.deepEqual(closedGateProposal.value.nativeInputKeys, [
        "articleId",
        "expectedMetadataRevision",
        "usePolicy",
      ]);
      assert.equal(
        closedGateProposal.value.proposalResultContainsManagerId,
        false,
        "The public Knowledge proposal input/result must not add an owner field.",
      );
      const includeStage = await br04Stage(scenario, closedGateProposal.value.operationId);
      const includeCommand = JSON.parse(includeStage.command_json);
      assert.equal(includeCommand.kind, "silver_policy");
      assert.deepEqual(includeCommand.intent, {
        articleId,
        usePolicy: "included",
        expectedMetadataRevision: initialMetadataRevision,
      });
      assert.equal(
        includeCommand.operationDeadlineMs,
        0,
        "The shared callback deadline begins at dispatch, not while the human reviews the Action.",
      );
      const includeActionBeforeApprove = await postNative(nativeMiniflare, "/br01-action-state", {
        managerId,
        actionId: closedGateProposal.value.actionId,
      });
      assert.equal(
        includeActionBeforeApprove.value.state,
        "pending",
        "The policy change must wait for the real native owner Action.",
      );
      const beforeClosedGateApproval = await br04NoEffectSnapshot(scenario);
      const closedGateApproval = await postNative(nativeMiniflare, "/br01-approve", {
        managerId,
        actionId: closedGateProposal.value.actionId,
      });
      assert.equal(
        closedGateApproval.response.status,
        500,
        JSON.stringify(closedGateApproval.value),
      );
      assert.equal(closedGateApproval.value.error, "Knowledge Base dependency_unavailable.");
      assertKnowledgeAndR2Unchanged(beforeClosedGateApproval, await br04NoEffectSnapshot(scenario));
      const closedGateActionAfterApproval = await postNative(
        nativeMiniflare,
        "/br01-action-state",
        { managerId, actionId: closedGateProposal.value.actionId },
      );
      assert.equal(closedGateActionAfterApproval.value.state, "pending");
      const readAfterClosedGate = await postNative(nativeMiniflare, "/br04-read", { managerId });
      assert.deepEqual(
        readAfterClosedGate.value,
        readBeforeGateCheck.value,
        "A closed Silver management gate must retain the existing owner-bound read path.",
      );

      const roleBindings = await postNative(nativeMiniflare, "/br04-role-bindings", {
        managerId,
        foreignManagerId: identities.A.managerId,
      });
      assert.equal(roleBindings.response.status, 200, JSON.stringify(roleBindings.value));
      assert.equal(roleBindings.value.writerInstalled, true);
      assert.equal(
        roleBindings.value.sourceReaderInstalled,
        true,
        "The gate-closed characterization uses the existing complete Bronze role set.",
      );
      await activateSilverManagementForTest(nativeMiniflare, managerId);

      const includeProposal = closedGateProposal;
      const includeApproval = await postNative(nativeMiniflare, "/br01-approve", {
        managerId,
        actionId: includeProposal.value.actionId,
      });
      assert.equal(includeApproval.response.status, 200, JSON.stringify(includeApproval.value));
      assert.equal(includeApproval.value.actionState, "approved");

      let snapshot = await knowledgeDatabaseSnapshot(nativeMiniflare, managerId);
      let article = requireSilverArticle(snapshot, articleId);
      assert.equal(article.use_policy, "included");
      assert.equal(article.metadata_revision, initialMetadataRevision + 1);
      assert.equal(
        article.current_revision_id,
        initialCurrentRevisionId,
        "Policy metadata must not change the current Bronze body revision.",
      );
      assert.deepEqual(
        requireKnowledgeTable(snapshot, "knowledge_article_revisions", [
          "article_id",
          "revision_id",
        ])
          .rows.filter((row) => row.article_id === articleId)
          .map((row) => row.revision_id)
          .sort(),
        initialRevisionIds,
        "Policy metadata must not append an immutable article-body revision.",
      );
      const includeReceipt = JSON.parse(article.policy_receipt_json);
      assert.deepEqual(Object.keys(includeReceipt).sort(), ["bindingHash", "result"]);
      assert.match(includeReceipt.bindingHash, /^[a-f0-9]{64}$/u);
      assert.deepEqual(includeReceipt.result, {
        status: "saved",
        operationId: includeProposal.value.operationId,
        articleId,
        usePolicy: "included",
        metadataRevision: initialMetadataRevision + 1,
      });

      const excludeProposal = await proposeNativePolicy(
        nativeMiniflare,
        managerId,
        articleId,
        "excluded",
        article.metadata_revision,
      );
      assert.equal(excludeProposal.response.status, 200, JSON.stringify(excludeProposal.value));
      assert.equal(excludeProposal.value.status, "pending_approval");
      const excludeStage = await br04Stage(scenario, excludeProposal.value.operationId);
      const excludeCommand = JSON.parse(excludeStage.command_json);
      assert.equal(excludeCommand.kind, "silver_policy");
      assert.deepEqual(excludeCommand.intent, {
        articleId,
        usePolicy: "excluded",
        expectedMetadataRevision: article.metadata_revision,
      });
      const excludeApproval = await postNative(nativeMiniflare, "/br01-approve", {
        managerId,
        actionId: excludeProposal.value.actionId,
      });
      assert.equal(excludeApproval.response.status, 200, JSON.stringify(excludeApproval.value));
      assert.equal(excludeApproval.value.actionState, "approved");

      snapshot = await knowledgeDatabaseSnapshot(nativeMiniflare, managerId);
      article = requireSilverArticle(snapshot, articleId);
      assert.equal(article.use_policy, "excluded");
      assert.equal(article.metadata_revision, initialMetadataRevision + 2);
      assert.equal(article.current_revision_id, initialCurrentRevisionId);
      assert.deepEqual(
        requireKnowledgeTable(snapshot, "knowledge_article_revisions", [
          "article_id",
          "revision_id",
        ])
          .rows.filter((row) => row.article_id === articleId)
          .map((row) => row.revision_id)
          .sort(),
        initialRevisionIds,
      );

      const staleProposal = await proposeNativePolicy(
        nativeMiniflare,
        managerId,
        articleId,
        "included",
        initialMetadataRevision,
      );
      assert.equal(staleProposal.response.status, 200, JSON.stringify(staleProposal.value));
      assert.equal(staleProposal.value.status, "pending_approval");
      const staleStage = await br04Stage(scenario, staleProposal.value.operationId);
      const staleCommand = JSON.parse(staleStage.command_json);
      assert.equal(staleCommand.kind, "silver_policy");
      assert.deepEqual(staleCommand.intent, {
        articleId,
        usePolicy: "included",
        expectedMetadataRevision: initialMetadataRevision,
      });
      assert.equal(staleCommand.operationDeadlineMs, 0);
      const beforeStaleCasApproval = await br04NoEffectSnapshot(scenario);
      const staleApproval = await postNative(nativeMiniflare, "/br01-approve", {
        managerId,
        actionId: staleProposal.value.actionId,
      });
      assert.equal(staleApproval.response.status, 500, JSON.stringify(staleApproval.value));
      assert.equal(staleApproval.value.error, "Knowledge Base conflict.");
      assertKnowledgeAndR2Unchanged(beforeStaleCasApproval, await br04NoEffectSnapshot(scenario));
      const staleActionAfterApproval = await postNative(nativeMiniflare, "/br01-action-state", {
        managerId,
        actionId: staleProposal.value.actionId,
      });
      assert.equal(staleActionAfterApproval.value.state, "pending");
      const finalRead = await postNative(nativeMiniflare, "/br04-read", { managerId });
      assert.deepEqual(finalRead.value, readBeforeGateCheck.value);
      assert.deepEqual(
        (await br04NoEffectSnapshot(scenario)).objects,
        initialSnapshot.objects,
        "Metadata-only policy actions must not create or rewrite private R2 body objects.",
      );
    } finally {
      await scenario.dispose();
    }
  },
);

test(
  "SL02 policy callback uses fresh Core authority without changing the existing read session",
  {
    timeout: 180_000,
    skip: process.env.CYBERNEST_RUN_LOCAL_DB !== "1",
  },
  async () => {
    const scenario = await startBR04Scenario();
    const { identities, nativeMiniflare, nativePostgres } = scenario;
    const managerId = identities.B.managerId;
    try {
      const created = await createNativeArticleForPolicy(nativeMiniflare, managerId, "excluded");
      const article = requireSilverArticle(created.snapshot, created.article.article_id);
      await activateSilverManagementForTest(nativeMiniflare, managerId);
      const readBeforeRevoke = await postNative(nativeMiniflare, "/br04-read", { managerId });
      assert.equal(readBeforeRevoke.response.status, 200, JSON.stringify(readBeforeRevoke.value));

      const proposal = await proposeNativePolicy(
        nativeMiniflare,
        managerId,
        article.article_id,
        "included",
        article.metadata_revision,
      );
      assert.equal(proposal.response.status, 200, JSON.stringify(proposal.value));
      const stage = await br04Stage(scenario, proposal.value.operationId);
      const command = JSON.parse(stage.command_json);
      assert.equal(command.kind, "silver_policy");
      assert.equal(command.operationDeadlineMs, 0);
      const beforeApproval = await br04NoEffectSnapshot(scenario);
      const authorityCallsBeforeApproval =
        await knowledgeAuthorityResolverCallCount(nativeMiniflare);

      const revokedOwner = await nativePostgres.db.query(
        `UPDATE operator.identity_manager_ownerships
         SET status = 'suspended'
         WHERE user_id = $1 AND manager_id = $2 AND role = 'owner' AND status = 'active'`,
        [identities.B.userId, managerId],
      );
      assert.equal(revokedOwner.rowCount, 1);
      try {
        const approval = await postNative(nativeMiniflare, "/br01-approve", {
          managerId,
          actionId: proposal.value.actionId,
        });
        assert.equal(approval.response.status, 500, JSON.stringify(approval.value));
        assert.equal(approval.value.error, "Knowledge Base permission_denied.");
        assert.equal(approval.value.ownerSessionId, proposal.value.ownerSessionId);
        assert.equal(approval.value.proofPresentations, 1);
        assert.equal(
          (await knowledgeAuthorityResolverCallCount(nativeMiniflare)) >
            authorityCallsBeforeApproval,
          true,
          "The approved policy callback must reach the fresh real Core authority resolver.",
        );
        assertKnowledgeAndR2Unchanged(beforeApproval, await br04NoEffectSnapshot(scenario));
        const action = await postNative(nativeMiniflare, "/br01-action-state", {
          managerId,
          actionId: proposal.value.actionId,
        });
        assert.equal(action.value.state, "pending");
        assert.equal(action.value.ownerSessionId, proposal.value.ownerSessionId);
        assert.equal(action.value.proofPresentations, 1);
      } finally {
        const restoredOwner = await nativePostgres.db.query(
          `UPDATE operator.identity_manager_ownerships
           SET status = 'active'
           WHERE user_id = $1 AND manager_id = $2 AND role = 'owner' AND status = 'suspended'`,
          [identities.B.userId, managerId],
        );
        assert.equal(restoredOwner.rowCount, 1);
      }
    } finally {
      await scenario.dispose();
    }
  },
);

test(
  "SL02 active management fails writes closed when the existing Bronze source-reader role is missing",
  {
    timeout: 180_000,
    skip: process.env.CYBERNEST_RUN_LOCAL_DB !== "1",
  },
  async () => {
    const scenario = await startBR04Scenario();
    const { identities, nativeMiniflare } = scenario;
    const managerId = identities.B.managerId;
    try {
      const first = await createNativeArticleForPolicy(nativeMiniflare, managerId, "excluded");
      const second = await createNativeArticleForPolicy(nativeMiniflare, managerId, "excluded");
      const firstArticle = requireSilverArticle(first.snapshot, first.article.article_id);
      const secondArticle = requireSilverArticle(second.snapshot, second.article.article_id);
      const readBeforeRoleRemoval = await postNative(nativeMiniflare, "/br04-read", { managerId });
      assert.equal(readBeforeRoleRemoval.response.status, 200);
      await activateSilverManagementForTest(nativeMiniflare, managerId);

      const existingProposal = await proposeNativePolicy(
        nativeMiniflare,
        managerId,
        firstArticle.article_id,
        "included",
        firstArticle.metadata_revision,
      );
      assert.equal(existingProposal.response.status, 200, JSON.stringify(existingProposal.value));
      await removeSourceReaderForSilverTest(nativeMiniflare, managerId);
      const roleBindings = await postNative(nativeMiniflare, "/br04-role-bindings", {
        managerId,
        foreignManagerId: identities.A.managerId,
      });
      assert.equal(roleBindings.response.status, 200, JSON.stringify(roleBindings.value));
      assert.equal(roleBindings.value.writerInstalled, true);
      assert.equal(roleBindings.value.sourceReaderInstalled, false);

      const beforeExistingApproval = await br04NoEffectSnapshot(scenario);
      const existingApproval = await postNative(nativeMiniflare, "/br01-approve", {
        managerId,
        actionId: existingProposal.value.actionId,
      });
      assert.equal(existingApproval.response.status, 500, JSON.stringify(existingApproval.value));
      assert.equal(existingApproval.value.error, "Knowledge Base dependency_unavailable.");
      assertKnowledgeAndR2Unchanged(beforeExistingApproval, await br04NoEffectSnapshot(scenario));
      const existingAction = await postNative(nativeMiniflare, "/br01-action-state", {
        managerId,
        actionId: existingProposal.value.actionId,
      });
      assert.equal(existingAction.value.state, "pending");

      const beforeNewProposal = await br04NoEffectSnapshot(scenario);
      const newProposal = await proposeNativePolicy(
        nativeMiniflare,
        managerId,
        secondArticle.article_id,
        "included",
        secondArticle.metadata_revision,
      );
      assert.equal(newProposal.response.status, 500, JSON.stringify(newProposal.value));
      assert.equal(newProposal.value.error, "Knowledge Base dependency_unavailable.");
      const afterNewProposal = await br04NoEffectSnapshot(scenario);
      assertBr04NoKnowledgeEffects(beforeNewProposal, afterNewProposal);
      assert.deepEqual(afterNewProposal.reservation, beforeNewProposal.reservation);

      const readAfterRoleRemoval = await postNative(nativeMiniflare, "/br04-read", { managerId });
      assert.equal(
        readAfterRoleRemoval.response.status,
        200,
        JSON.stringify(readAfterRoleRemoval.value),
      );
      assert.deepEqual(readAfterRoleRemoval.value, readBeforeRoleRemoval.value);
    } finally {
      await scenario.dispose();
    }
  },
);

test(
  "SL02 safe exclusion supersedes a saved include whose native callback acknowledgement was lost",
  {
    timeout: 180_000,
    skip: process.env.CYBERNEST_RUN_LOCAL_DB !== "1",
  },
  async () => {
    const scenario = await startBR04Scenario();
    const { identities, nativeMiniflare } = scenario;
    const managerId = identities.B.managerId;
    try {
      assert.deepEqual(scenario.boot.preflightBAfterBronzeInstall.value.bronzeRoles, {
        writer: "installed",
        sourceReader: "installed",
      });
      const created = await createNativeArticleForPolicy(nativeMiniflare, managerId, "excluded");
      const articleId = created.article.article_id;
      const initialArticle = requireSilverArticle(created.snapshot, articleId);
      const initialMetadataRevision = initialArticle.metadata_revision;
      const currentRevisionId = initialArticle.current_revision_id;
      const initialRevisionIds = requireKnowledgeTable(
        created.snapshot,
        "knowledge_article_revisions",
        ["article_id", "revision_id"],
      )
        .rows.filter((row) => row.article_id === articleId)
        .map((row) => row.revision_id)
        .sort();
      const readBefore = await postNative(nativeMiniflare, "/br04-read", { managerId });
      assert.equal(readBefore.response.status, 200, JSON.stringify(readBefore.value));
      await activateSilverManagementForTest(nativeMiniflare, managerId);

      const dispatchNow = Date.now();
      await setBr01TestClock(nativeMiniflare, dispatchNow);
      await setBr01CallbackAckLossEnabled(nativeMiniflare, true);
      const includeProposal = await proposeNativePolicy(
        nativeMiniflare,
        managerId,
        articleId,
        "included",
        initialMetadataRevision,
      );
      assert.equal(includeProposal.response.status, 200, JSON.stringify(includeProposal.value));
      const includeStageBeforeDispatch = await br04Stage(
        scenario,
        includeProposal.value.operationId,
      );
      const includeCommandBeforeDispatch = JSON.parse(includeStageBeforeDispatch.command_json);
      assert.equal(includeCommandBeforeDispatch.kind, "silver_policy");
      assert.equal(includeCommandBeforeDispatch.operationDeadlineMs, 0);
      const lostIncludeAck = await postNative(nativeMiniflare, "/br01-approve", {
        managerId,
        actionId: includeProposal.value.actionId,
      });
      assert.equal(lostIncludeAck.response.status, 500, JSON.stringify(lostIncludeAck.value));
      const lostIncludeAction = await postNative(nativeMiniflare, "/br01-action-state", {
        managerId,
        actionId: includeProposal.value.actionId,
      });
      assert.equal(
        lostIncludeAction.value.state,
        "pending",
        "A lost callback acknowledgement leaves the real native Action pending for retry.",
      );

      let snapshot = await knowledgeDatabaseSnapshot(nativeMiniflare, managerId);
      let article = requireSilverArticle(snapshot, articleId);
      assert.equal(
        article.use_policy,
        "included",
        "The actual Knowledge write completed before the test fixture dropped the callback acknowledgement.",
      );
      assert.equal(article.metadata_revision, initialMetadataRevision + 1);
      assert.equal(article.current_revision_id, currentRevisionId);
      const includeStageAfterDispatch = await br04Stage(
        scenario,
        includeProposal.value.operationId,
      );
      assert.equal(
        includeStageAfterDispatch.operation_deadline_ms,
        dispatchNow + 300_000,
        "The shared five-minute deadline is fixed when native approval dispatch begins.",
      );

      const excludeProposal = await proposeNativePolicy(
        nativeMiniflare,
        managerId,
        articleId,
        "excluded",
        article.metadata_revision,
      );
      assert.equal(excludeProposal.response.status, 200, JSON.stringify(excludeProposal.value));
      assert.equal(
        excludeProposal.value.status,
        "pending_approval",
        "Safe exclusion must use its existing per-target control lane while normal include is unresolved.",
      );
      const excludeApproval = await postNative(nativeMiniflare, "/br01-approve", {
        managerId,
        actionId: excludeProposal.value.actionId,
      });
      assert.equal(excludeApproval.response.status, 200, JSON.stringify(excludeApproval.value));
      assert.equal(excludeApproval.value.actionState, "approved");
      const excludedSnapshot = await knowledgeDatabaseSnapshot(nativeMiniflare, managerId);
      const excludedArticle = requireSilverArticle(excludedSnapshot, articleId);
      assert.equal(excludedArticle.use_policy, "excluded");
      assert.equal(excludedArticle.metadata_revision, initialMetadataRevision + 2);
      assert.equal(excludedArticle.current_revision_id, currentRevisionId);

      await setBr01CallbackAckLossEnabled(nativeMiniflare, false);
      const staleIncludeRetry = await postNative(nativeMiniflare, "/br01-approve", {
        managerId,
        actionId: includeProposal.value.actionId,
      });
      assert.equal(staleIncludeRetry.response.status, 500, JSON.stringify(staleIncludeRetry.value));
      assert.equal(
        staleIncludeRetry.value.error,
        "Knowledge Base conflict.",
        "A callback for the older include must be obsolete after the same-target exclusion commits.",
      );
      const oldActionAfterRetry = await postNative(nativeMiniflare, "/br01-action-state", {
        managerId,
        actionId: includeProposal.value.actionId,
      });
      assert.equal(oldActionAfterRetry.value.state, "pending");
      snapshot = await knowledgeDatabaseSnapshot(nativeMiniflare, managerId);
      article = requireSilverArticle(snapshot, articleId);
      assert.equal(
        article.use_policy,
        "excluded",
        "Retrying the old include must never revive the excluded article.",
      );
      assert.equal(article.metadata_revision, initialMetadataRevision + 2);
      assert.equal(article.current_revision_id, currentRevisionId);
      assert.deepEqual(
        requireKnowledgeTable(snapshot, "knowledge_article_revisions", [
          "article_id",
          "revision_id",
        ])
          .rows.filter((row) => row.article_id === articleId)
          .map((row) => row.revision_id)
          .sort(),
        initialRevisionIds,
      );
      assert.deepEqual(
        (await postNative(nativeMiniflare, "/br04-read", { managerId })).value,
        readBefore.value,
      );
    } finally {
      await setBr01CallbackAckLossEnabled(nativeMiniflare, false).catch(() => undefined);
      await setBr01TestClock(nativeMiniflare, null).catch(() => undefined);
      await releaseBr01AuthorityResolver(nativeMiniflare).catch(() => undefined);
      await scenario.dispose();
    }
  },
);

test(
  "SL02 native rejection fences a delayed include before its Knowledge apply can commit",
  {
    timeout: 180_000,
    skip: process.env.CYBERNEST_RUN_LOCAL_DB !== "1",
  },
  async () => {
    const scenario = await startBR04Scenario();
    const { identities, nativeMiniflare } = scenario;
    const managerId = identities.B.managerId;
    let approvalPromise;
    let rejectionPromise;
    try {
      const created = await createNativeArticleForPolicy(nativeMiniflare, managerId, "excluded");
      const article = requireSilverArticle(created.snapshot, created.article.article_id);
      const initialCurrentRevisionId = article.current_revision_id;
      await activateSilverManagementForTest(nativeMiniflare, managerId);
      const proposal = await proposeNativePolicy(
        nativeMiniflare,
        managerId,
        article.article_id,
        "included",
        article.metadata_revision,
      );
      assert.equal(proposal.response.status, 200, JSON.stringify(proposal.value));
      const beforeDispatch = await br04NoEffectSnapshot(scenario);

      await holdBr01AuthorityResolver(nativeMiniflare);
      approvalPromise = postNative(nativeMiniflare, "/br01-approve", {
        managerId,
        actionId: proposal.value.actionId,
      });
      let authorityWaitTimeout;
      const authorityReached = await Promise.race([
        waitForBr01AuthorityResolverResponses(nativeMiniflare).then(() => true),
        new Promise((resolve) => {
          authorityWaitTimeout = setTimeout(() => resolve(false), 10_000);
        }),
      ]);
      clearTimeout(authorityWaitTimeout);
      assert.equal(
        authorityReached,
        true,
        "The include callback must be held after the real Core authority resolver responds.",
      );
      const commandAtAuthorityHold = JSON.parse(
        (await br04Stage(scenario, proposal.value.operationId)).command_json,
      );
      assert.equal(commandAtAuthorityHold.kind, "silver_policy");
      assert.equal(Number.isSafeInteger(commandAtAuthorityHold.operationDeadlineMs), true);
      assert.equal(commandAtAuthorityHold.operationDeadlineMs > 0, true);

      rejectionPromise = postNative(nativeMiniflare, "/br01-reject", {
        managerId,
        actionId: proposal.value.actionId,
      });
      let rejectionWaitTimeout;
      const rejection = await Promise.race([
        rejectionPromise,
        new Promise((resolve) => {
          rejectionWaitTimeout = setTimeout(() => resolve(undefined), 10_000);
        }),
      ]);
      clearTimeout(rejectionWaitTimeout);
      assert.ok(
        rejection,
        "The exact normal fence must finish while the approval's Core authority response remains held.",
      );
      assert.equal(rejection.response.status, 200, JSON.stringify(rejection.value));
      assert.equal(rejection.value.actionState, "rejected");
      const rejectedActionBeforeRelease = await postNative(nativeMiniflare, "/br01-action-state", {
        managerId,
        actionId: proposal.value.actionId,
      });
      assert.equal(rejectedActionBeforeRelease.value.state, "rejected");
      const fencedSnapshot = await br04NoEffectSnapshot(scenario);
      assertSilverNormalFenceOnlyEffects(beforeDispatch, fencedSnapshot);
      const normalFence = requireSilverNormalControl(fencedSnapshot.knowledge);
      assert.deepEqual(Object.keys(normalFence).sort(), [
        "articleId",
        "bindingHash",
        "operationDeadlineMs",
        "operationId",
        "state",
      ]);
      assert.equal(normalFence.operationId, proposal.value.operationId);
      assert.equal(normalFence.articleId, article.article_id);
      assert.equal(normalFence.operationDeadlineMs, commandAtAuthorityHold.operationDeadlineMs);
      assert.equal(normalFence.state, "cancelled_fenced");
      assert.match(normalFence.bindingHash, /^[a-f0-9]{64}$/u);

      await releaseBr01AuthorityResolver(nativeMiniflare);

      const approval = await approvalPromise;
      assert.equal(approval.response.status, 500, JSON.stringify(approval.value));
      assert.equal(approval.value.error, "Knowledge Base conflict.");
      const afterLateApproval = await br04NoEffectSnapshot(scenario);
      assertSilverNormalFenceOnlyEffects(beforeDispatch, afterLateApproval);
      assert.deepEqual(requireSilverNormalControl(afterLateApproval.knowledge), normalFence);
      const actionState = await postNative(nativeMiniflare, "/br01-action-state", {
        managerId,
        actionId: proposal.value.actionId,
      });
      assert.equal(actionState.value.state, "rejected");
      const snapshot = await knowledgeDatabaseSnapshot(nativeMiniflare, managerId);
      const afterArticle = requireSilverArticle(snapshot, article.article_id);
      assert.equal(afterArticle.use_policy, "excluded");
      assert.equal(afterArticle.metadata_revision, article.metadata_revision);
      assert.equal(afterArticle.current_revision_id, initialCurrentRevisionId);
    } finally {
      await releaseBr01AuthorityResolver(nativeMiniflare).catch(() => undefined);
      await Promise.allSettled([approvalPromise, rejectionPromise].filter(Boolean));
      await scenario.dispose();
    }
  },
);

test(
  "SL02 safe exclusion commits through its target lane while normal include remains unresolved",
  {
    timeout: 180_000,
    skip: process.env.CYBERNEST_RUN_LOCAL_DB !== "1",
  },
  async () => {
    const scenario = await startBR04Scenario();
    const { identities, nativeMiniflare } = scenario;
    const managerId = identities.B.managerId;
    let includeApprovalPromise;
    let safeExcludeApprovalPromise;
    let ownerSuspendedForExpiredReject = false;
    try {
      const targetCreated = await createNativeArticleForPolicy(
        nativeMiniflare,
        managerId,
        "included",
      );
      const otherCreated = await createNativeArticleForPolicy(
        nativeMiniflare,
        managerId,
        "excluded",
      );
      const targetArticle = requireSilverArticle(
        targetCreated.snapshot,
        targetCreated.article.article_id,
      );
      const otherArticle = requireSilverArticle(
        otherCreated.snapshot,
        otherCreated.article.article_id,
      );
      assert.equal(targetArticle.metadata_revision, 0);
      assert.equal(otherArticle.metadata_revision, 0);
      const initialCurrentRevisionId = targetArticle.current_revision_id;
      const initialRevisionIds = requireKnowledgeTable(
        targetCreated.snapshot,
        "knowledge_article_revisions",
        ["article_id", "revision_id"],
      )
        .rows.filter((row) => row.article_id === targetArticle.article_id)
        .map((row) => row.revision_id)
        .sort();
      await activateSilverManagementForTest(nativeMiniflare, managerId);

      const includeProposal = await proposeNativePolicy(
        nativeMiniflare,
        managerId,
        targetArticle.article_id,
        "included",
        targetArticle.metadata_revision,
      );
      assert.equal(includeProposal.response.status, 200, JSON.stringify(includeProposal.value));
      assert.equal(includeProposal.value.status, "pending_approval");
      const includeStageBeforeDispatch = await br04Stage(
        scenario,
        includeProposal.value.operationId,
      );
      const includeCommandBeforeDispatch = JSON.parse(includeStageBeforeDispatch.command_json);
      assert.equal(includeStageBeforeDispatch.operation_deadline_ms, 0);
      assert.deepEqual(includeCommandBeforeDispatch.intent, {
        articleId: targetArticle.article_id,
        usePolicy: "included",
        expectedMetadataRevision: 0,
      });
      const beforeDispatch = await br04NoEffectSnapshot(scenario);
      const goldBeforeDispatch = requireKnowledgeTable(
        beforeDispatch.knowledge,
        "knowledge_gold_state",
        ["dirty_through"],
      ).rows[0]?.dirty_through;
      assert.equal(Number.isInteger(goldBeforeDispatch), true);

      await holdFirstBr01AuthorityResolverResponse(nativeMiniflare);
      includeApprovalPromise = postNative(nativeMiniflare, "/br01-approve", {
        managerId,
        actionId: includeProposal.value.actionId,
      });
      let authorityWaitTimeout;
      const authorityReached = await Promise.race([
        waitForBr01AuthorityResolverResponses(nativeMiniflare).then(() => true),
        new Promise((resolve) => {
          authorityWaitTimeout = setTimeout(() => resolve(false), 10_000);
        }),
      ]);
      clearTimeout(authorityWaitTimeout);
      assert.equal(
        authorityReached,
        true,
        "The normal include must wait after its first fresh Core authority resolution.",
      );
      const normalStageAtAuthorityHold = await br04Stage(
        scenario,
        includeProposal.value.operationId,
      );
      const normalCommandAtAuthorityHold = JSON.parse(normalStageAtAuthorityHold.command_json);
      assert.equal(normalStageAtAuthorityHold.status, "applying");
      assert.equal(
        normalStageAtAuthorityHold.operation_deadline_ms,
        normalCommandAtAuthorityHold.operationDeadlineMs,
      );
      assert.equal(normalStageAtAuthorityHold.operation_deadline_ms > 0, true);
      const normalReservationAtAuthorityHold = await bronzeActionReservation(
        nativeMiniflare,
        managerId,
      );
      assert.equal(normalReservationAtAuthorityHold.operationId, includeProposal.value.operationId);
      assert.equal(normalReservationAtAuthorityHold.status, "active");

      const beforeBusyProposal = await br04NoEffectSnapshot(scenario);
      const busyNormalProposal = await proposeNativePolicy(
        nativeMiniflare,
        managerId,
        otherArticle.article_id,
        "included",
        otherArticle.metadata_revision,
      );
      assert.equal(
        busyNormalProposal.response.status,
        500,
        JSON.stringify(busyNormalProposal.value),
      );
      assert.equal(busyNormalProposal.value.error, "Knowledge Base capacity_exceeded.");
      const afterBusyProposal = await br04NoEffectSnapshot(scenario);
      assert.deepEqual(afterBusyProposal.actions, beforeBusyProposal.actions);
      assert.equal(afterBusyProposal.stageCount, beforeBusyProposal.stageCount);
      assert.deepEqual(afterBusyProposal.knowledge, beforeBusyProposal.knowledge);
      assert.deepEqual(afterBusyProposal.objects, beforeBusyProposal.objects);
      assert.equal(afterBusyProposal.objectsTruncated, beforeBusyProposal.objectsTruncated);
      assert.deepEqual(afterBusyProposal.reservation, beforeBusyProposal.reservation);

      const safeExcludeProposal = await proposeNativePolicy(
        nativeMiniflare,
        managerId,
        targetArticle.article_id,
        "excluded",
        targetArticle.metadata_revision,
      );
      assert.equal(
        safeExcludeProposal.response.status,
        200,
        JSON.stringify(safeExcludeProposal.value),
      );
      assert.equal(safeExcludeProposal.value.status, "pending_approval");
      const safeExcludeStageBeforeDispatch = await br04Stage(
        scenario,
        safeExcludeProposal.value.operationId,
      );
      const safeExcludeCommandBeforeDispatch = JSON.parse(
        safeExcludeStageBeforeDispatch.command_json,
      );
      assert.equal(safeExcludeStageBeforeDispatch.operation_deadline_ms, 0);
      assert.deepEqual(safeExcludeCommandBeforeDispatch.intent, {
        articleId: targetArticle.article_id,
        usePolicy: "excluded",
        expectedMetadataRevision: 0,
      });
      safeExcludeApprovalPromise = postNative(nativeMiniflare, "/br01-approve", {
        managerId,
        actionId: safeExcludeProposal.value.actionId,
      });
      let safeExcludeApprovalTimeout;
      let safeExcludeApproval;
      try {
        safeExcludeApproval = await Promise.race([
          safeExcludeApprovalPromise,
          new Promise((resolve) => {
            safeExcludeApprovalTimeout = setTimeout(() => resolve(null), 10_000);
          }),
        ]);
      } finally {
        clearTimeout(safeExcludeApprovalTimeout);
      }
      assert.ok(
        safeExcludeApproval,
        "Safe exclusion must finish while the first Core authority response remains held.",
      );
      assert.equal(
        safeExcludeApproval.response.status,
        200,
        JSON.stringify(safeExcludeApproval.value),
      );
      assert.equal(safeExcludeApproval.value.actionState, "approved");

      const excludedSnapshot = await knowledgeDatabaseSnapshot(nativeMiniflare, managerId);
      const goldAfterExclude = requireKnowledgeTable(excludedSnapshot, "knowledge_gold_state", [
        "dirty_through",
      ]).rows[0]?.dirty_through;
      assert.equal(goldAfterExclude, goldBeforeDispatch + 1);
      const excludedArticle = requireSilverArticle(excludedSnapshot, targetArticle.article_id);
      assert.equal(excludedArticle.use_policy, "excluded");
      assert.equal(excludedArticle.metadata_revision, 1);
      assert.equal(excludedArticle.current_revision_id, initialCurrentRevisionId);
      const excludeReceipt = JSON.parse(excludedArticle.policy_receipt_json);
      assert.deepEqual(excludeReceipt.result, {
        status: "saved",
        operationId: safeExcludeProposal.value.operationId,
        articleId: targetArticle.article_id,
        usePolicy: "excluded",
        metadataRevision: 1,
      });
      assert.deepEqual(
        requireKnowledgeTable(excludedSnapshot, "knowledge_article_revisions", [
          "article_id",
          "revision_id",
        ])
          .rows.filter((row) => row.article_id === targetArticle.article_id)
          .map((row) => row.revision_id)
          .sort(),
        initialRevisionIds,
      );
      assert.deepEqual(
        (await br04NoEffectSnapshot(scenario)).objects,
        beforeDispatch.objects,
        "The safe metadata exclusion must not change private R2 body objects.",
      );

      const normalStageAfterSafeExclude = await br04Stage(
        scenario,
        includeProposal.value.operationId,
      );
      assert.equal(normalStageAfterSafeExclude.status, "applying");
      assert.equal(
        normalStageAfterSafeExclude.command_json,
        normalStageAtAuthorityHold.command_json,
      );
      assert.equal(
        normalStageAfterSafeExclude.operation_deadline_ms,
        normalStageAtAuthorityHold.operation_deadline_ms,
      );
      assert.deepEqual(
        await bronzeActionReservation(nativeMiniflare, managerId),
        normalReservationAtAuthorityHold,
        "The safe exclusion must preserve the separately held normal Account reservation.",
      );

      await releaseBr01AuthorityResolver(nativeMiniflare);
      const lateIncludeApproval = await includeApprovalPromise;
      assert.equal(
        lateIncludeApproval.response.status,
        500,
        JSON.stringify(lateIncludeApproval.value),
      );
      assert.equal(lateIncludeApproval.value.error, "Knowledge Base conflict.");
      const lateIncludeStage = await br04Stage(scenario, includeProposal.value.operationId);
      assert.equal(lateIncludeStage.status, "pending_approval");
      assert.equal(lateIncludeStage.command_json, normalStageAtAuthorityHold.command_json);
      assert.equal(
        lateIncludeStage.operation_deadline_ms,
        normalStageAtAuthorityHold.operation_deadline_ms,
      );
      assert.deepEqual(
        await bronzeActionReservation(nativeMiniflare, managerId),
        normalReservationAtAuthorityHold,
      );
      const includeActionAfterConflict = await postNative(nativeMiniflare, "/br01-action-state", {
        managerId,
        actionId: includeProposal.value.actionId,
      });
      assert.equal(includeActionAfterConflict.value.state, "pending");
      const afterLateInclude = await br04NoEffectSnapshot(scenario);
      assertKnowledgeAndR2Unchanged(
        {
          knowledge: excludedSnapshot,
          objects: beforeDispatch.objects,
          objectsTruncated: beforeDispatch.objectsTruncated,
        },
        afterLateInclude,
      );
      const finalArticle = requireSilverArticle(
        afterLateInclude.knowledge,
        targetArticle.article_id,
      );
      assert.equal(finalArticle.use_policy, "excluded");
      assert.equal(finalArticle.metadata_revision, 1);
      assert.equal(finalArticle.current_revision_id, initialCurrentRevisionId);
      assert.deepEqual(
        JSON.parse(finalArticle.policy_receipt_json),
        excludeReceipt,
        "The delayed normal include must not replace the newer safe exclusion receipt.",
      );

      const normalOperationDeadlineMs = normalStageAtAuthorityHold.operation_deadline_ms;
      assert.equal(Number.isSafeInteger(normalOperationDeadlineMs), true);
      assert.ok(normalOperationDeadlineMs > 0);
      await setBr01TestClock(nativeMiniflare, normalOperationDeadlineMs + 1);

      const suspendedOwner = await scenario.nativePostgres.db.query(
        `UPDATE operator.identity_manager_ownerships
         SET status = 'suspended'
         WHERE user_id = $1 AND manager_id = $2 AND role = 'owner' AND status = 'active'`,
        [identities.B.userId, managerId],
      );
      assert.equal(suspendedOwner.rowCount, 1);
      ownerSuspendedForExpiredReject = true;
      const beforeUnavailableReject = await br04NoEffectSnapshot(scenario);
      const unavailableReject = await postNative(nativeMiniflare, "/br01-reject", {
        managerId,
        actionId: includeProposal.value.actionId,
      });
      assert.equal(unavailableReject.response.status, 500, JSON.stringify(unavailableReject.value));
      assert.equal(unavailableReject.value.error, "Knowledge Base permission_denied.");
      assert.deepEqual(
        await bronzeActionReservation(nativeMiniflare, managerId),
        normalReservationAtAuthorityHold,
        "A typed authority failure after expiry must retain the matching normal reservation for retry.",
      );
      const afterUnavailableReject = await br04NoEffectSnapshot(scenario);
      assert.equal(
        (
          await postNative(nativeMiniflare, "/br01-action-state", {
            managerId,
            actionId: includeProposal.value.actionId,
          })
        ).value.state,
        "pending",
      );
      assertKnowledgeAndR2Unchanged(beforeUnavailableReject, afterUnavailableReject);

      const restoredOwner = await scenario.nativePostgres.db.query(
        `UPDATE operator.identity_manager_ownerships
         SET status = 'active'
         WHERE user_id = $1 AND manager_id = $2 AND role = 'owner' AND status = 'suspended'`,
        [identities.B.userId, managerId],
      );
      assert.equal(restoredOwner.rowCount, 1);
      ownerSuspendedForExpiredReject = false;

      const expiredReject = await postNative(nativeMiniflare, "/br01-reject", {
        managerId,
        actionId: includeProposal.value.actionId,
      });
      assert.equal(expiredReject.response.status, 200, JSON.stringify(expiredReject.value));
      assert.equal(expiredReject.value.actionState, "rejected");
      assert.deepEqual(
        await bronzeActionReservation(nativeMiniflare, managerId),
        undefined,
        "A typed conflict from the expired exact apply recheck must release only its matching normal reservation.",
      );
      assertKnowledgeAndR2Unchanged(afterLateInclude, await br04NoEffectSnapshot(scenario));
      const expiredActionState = await postNative(nativeMiniflare, "/br01-action-state", {
        managerId,
        actionId: includeProposal.value.actionId,
      });
      assert.equal(expiredActionState.value.state, "rejected");

      const nextNormalProposal = await proposeNativePolicy(
        nativeMiniflare,
        managerId,
        otherArticle.article_id,
        "included",
        otherArticle.metadata_revision,
      );
      assert.equal(
        nextNormalProposal.response.status,
        200,
        JSON.stringify(nextNormalProposal.value),
      );
      assert.equal(nextNormalProposal.value.status, "pending_approval");
      const nextNormalReservation = await bronzeActionReservation(nativeMiniflare, managerId);
      assert.equal(nextNormalReservation.operationId, nextNormalProposal.value.operationId);
      assert.equal(nextNormalReservation.status, "active");

      for (const path of ["/br01-approve", "/br01-reject"]) {
        await postNative(nativeMiniflare, path, {
          managerId,
          actionId: includeProposal.value.actionId,
        });
        assert.deepEqual(
          await bronzeActionReservation(nativeMiniflare, managerId),
          nextNormalReservation,
          "A terminal old Action callback must not clear a newer normal reservation.",
        );
        const oldAction = await postNative(nativeMiniflare, "/br01-action-state", {
          managerId,
          actionId: includeProposal.value.actionId,
        });
        assert.equal(oldAction.value.state, "rejected");
      }
      assertKnowledgeAndR2Unchanged(afterLateInclude, await br04NoEffectSnapshot(scenario));
    } finally {
      if (ownerSuspendedForExpiredReject) {
        await scenario.nativePostgres.db
          .query(
            `UPDATE operator.identity_manager_ownerships
           SET status = 'active'
           WHERE user_id = $1 AND manager_id = $2 AND role = 'owner' AND status = 'suspended'`,
            [identities.B.userId, managerId],
          )
          .catch(() => undefined);
      }
      await setBr01TestClock(nativeMiniflare, null).catch(() => undefined);
      await releaseBr01AuthorityResolver(nativeMiniflare).catch(() => undefined);
      await Promise.allSettled(
        [includeApprovalPromise, safeExcludeApprovalPromise].filter(Boolean),
      );
      await scenario.dispose();
    }
  },
);

test(
  "SL02 old Knowledge worker rejects the new silver_policy verb without changing SQLite or R2",
  {
    timeout: 180_000,
    skip: process.env.CYBERNEST_RUN_LOCAL_DB !== "1",
  },
  async () => {
    let oldKnowledgeBytes;
    const oldKnowledgeOverride = process.env.CYBERNEST_SL02_OLD_RUNTIME_KNOWLEDGE_BUNDLE;
    if (typeof oldKnowledgeOverride === "string") {
      oldKnowledgeBytes = await readFile(oldKnowledgeOverride);
    } else {
      const manifest = JSON.parse(
        await readFile(join(sl02OldKnowledgeFixtureRoot, "manifest.json"), "utf8"),
      );
      assert.equal(manifest.formatVersion, 1);
      assert.match(manifest.purpose, /pre-SL02 Knowledge worker/u);
      assert.equal(manifest.capture.includes("activation test seam is unavailable"), true);
      assert.equal(manifest.containsUserData, false);
      assert.equal(manifest.containsSecrets, false);
      const compressed = await readFile(join(sl02OldKnowledgeFixtureRoot, manifest.artifact.file));
      assert.equal(compressed.byteLength, manifest.artifact.compressedBytes);
      assert.equal(sha256HexOf(compressed), manifest.artifact.compressedSha256);
      oldKnowledgeBytes = gunzipSync(compressed);
      assert.equal(oldKnowledgeBytes.byteLength, manifest.artifact.uncompressedBytes);
      assert.equal(sha256HexOf(oldKnowledgeBytes), manifest.artifact.uncompressedSha256);
    }
    assert.equal(
      sha256HexOf(oldKnowledgeBytes),
      sl02OldKnowledgeSha256,
      "The old Knowledge compatibility test must use the preserved pre-SL02 Worker artifact.",
    );

    const scenario = await startBR04Scenario({ resourcePersistencePath: "temporary" });
    const { identities, nativeMiniflare } = scenario;
    const managerId = identities.B.managerId;
    try {
      const created = await createNativeArticleForPolicy(nativeMiniflare, managerId, "excluded");
      const article = requireSilverArticle(created.snapshot, created.article.article_id);
      const proposal = await proposeNativePolicy(
        nativeMiniflare,
        managerId,
        article.article_id,
        "included",
        article.metadata_revision,
      );
      assert.equal(proposal.response.status, 200, JSON.stringify(proposal.value));
      assert.equal(proposal.value.status, "pending_approval");

      await scenario.restartWith(
        {
          ...br04CurrentWorkerScripts,
          knowledgeLegacy: oldKnowledgeBytes.toString("utf8"),
        },
        {
          coreServiceBindingOverrides: {
            KNOWLEDGE_BRONZE_GRANT_ISSUER: service(
              "knowledge-legacy",
              "OwnedKnowledgeBronzeGrantIssuer",
            ),
          },
        },
      );
      const accessNamespace = await nativeMiniflare.getDurableObjectNamespace(
        "KnowledgeAccountAccess",
        "custom",
      );
      const accessStub = accessNamespace.get(accessNamespace.idFromName(managerId));
      await accessStub.removeBronzeWriterForTest(managerId);
      const reinstallResponse = await postNative(nativeMiniflare, "/stopped", {
        accessAssertion: await scenario.accessFixture.assertion(),
        userId: identities.B.userId,
        managerId,
        foreignManagerId: identities.A.managerId,
      });
      assert.equal(reinstallResponse.response.status, 200, JSON.stringify(reinstallResponse.value));
      const reinstalled = reinstallResponse.value.install;
      assert.equal(
        reinstalled.ok,
        true,
        `Core could not reinstall the legacy-bound Bronze writer: ${JSON.stringify({ ok: reinstalled.ok, code: reinstalled.code })}`,
      );
      assert.equal(reinstalled.value.managerId, managerId);
      const bindings = await accessStub.inspectBronzeBindingsForTest(
        managerId,
        identities.A.managerId,
      );
      assert.equal(bindings.writerInstalled, true);
      assert.equal(bindings.sourceReaderInstalled, true);
      assert.equal(
        bindings.writerContract,
        "cybernest-knowledge-bronze-write-v2",
        "Core must install a Manager-bound Bronze writer capability from the isolated legacy Worker.",
      );
      assert.equal(bindings.foreignWriterRejected, true);

      const beforeApproval = await br04NoEffectSnapshot(scenario, {
        includeLegacyKnowledge: true,
      });
      const legacyDatabaseText = JSON.stringify(beforeApproval.legacyKnowledge);
      assert.equal(
        legacyDatabaseText.includes(article.article_id),
        false,
        "The separate pre-SL02 namespace must not inherit the current article data.",
      );
      assert.ok(
        typeof beforeApproval.reservation?.operationId === "string",
        "The pending current OS action must retain its Account reservation before legacy approval.",
      );
      assert.equal(
        legacyDatabaseText.includes(beforeApproval.reservation.operationId),
        false,
        "The separate pre-SL02 namespace must not inherit the current OS Action reservation.",
      );
      const approval = await postNative(nativeMiniflare, "/br01-approve", {
        managerId,
        actionId: proposal.value.actionId,
      });
      assert.equal(approval.response.status, 500, JSON.stringify(approval.value));
      assert.equal(
        approval.value.error,
        "Knowledge Base invalid_input.",
        "The captured old Knowledge decoder must reject the unknown native policy writer verb.",
      );
      const afterApproval = await br04NoEffectSnapshot(scenario, {
        includeLegacyKnowledge: true,
      });
      assertBr04NoKnowledgeEffects(beforeApproval, afterApproval);
      assertBr04SameReservationIdentity(beforeApproval.reservation, afterApproval.reservation);
      assert.equal(
        afterApproval.reservation.retainedBytesReserved,
        beforeApproval.reservation.retainedBytesReserved,
        "A refused callback must retain the current OS Action's reservation budget.",
      );
      const action = await postNative(nativeMiniflare, "/br01-action-state", {
        managerId,
        actionId: proposal.value.actionId,
      });
      assert.equal(action.value.state, "pending");
    } finally {
      await scenario.dispose();
    }
  },
);

test(
  "SL06 real OS owner Actions index and then suppress an excluded Article through the owned reader",
  {
    timeout: 180_000,
    skip: process.env.CYBERNEST_RUN_LOCAL_DB !== "1",
  },
  async () => {
    const scenario = await startBR04Scenario();
    const { identities, nativeMiniflare, nativePostgres } = scenario;
    const managerId = identities.B.managerId;
    const searchInput = { kind: "articles", limit: 16 };
    let ownerSuspended = false;
    try {
      assert.deepEqual(scenario.boot.preflightBAfterBronzeInstall.value.bronzeRoles, {
        writer: "installed",
        sourceReader: "installed",
      });

      const created = await createNativeArticleForPolicy(nativeMiniflare, managerId, "included");
      const articleId = created.article.article_id;
      const articlePath =
        "articles/" + Buffer.from(articleId, "utf8").toString("base64url") + ".md";
      const initialAuthority = requireKnowledgeTable(
        await knowledgeDatabaseSnapshot(nativeMiniflare, managerId),
        "knowledge_state",
        ["authority_expires_at"],
      ).rows[0]?.authority_expires_at;
      assert.ok(Number.isSafeInteger(initialAuthority) && initialAuthority > 0);

      const resolverCallsBeforeRevoke = await knowledgeAuthorityResolverCallCount(nativeMiniflare);
      const revokedOwner = await nativePostgres.db.query(
        `UPDATE operator.identity_manager_ownerships
         SET status = 'suspended'
         WHERE user_id = $1 AND manager_id = $2 AND role = 'owner' AND status = 'active'`,
        [identities.B.userId, managerId],
      );
      assert.equal(revokedOwner.rowCount, 1);
      ownerSuspended = true;
      await setBr01TestClock(nativeMiniflare, initialAuthority + 1);
      const rejectedReaderCall = await postNative(nativeMiniflare, "/br04-read", {
        managerId,
        searchInput,
        readPath: articlePath,
      });
      assert.equal(rejectedReaderCall.response.status, 500, JSON.stringify(rejectedReaderCall.value));
      assert.equal(rejectedReaderCall.value.error, "Knowledge Base permission_denied.");
      assert.equal(
        (await knowledgeAuthorityResolverCallCount(nativeMiniflare)) > resolverCallsBeforeRevoke,
        true,
        "An expired owner-reader authority must be refreshed through the real Core resolver.",
      );
      const restoredOwner = await nativePostgres.db.query(
        `UPDATE operator.identity_manager_ownerships
         SET status = 'active'
         WHERE user_id = $1 AND manager_id = $2 AND role = 'owner' AND status = 'suspended'`,
        [identities.B.userId, managerId],
      );
      assert.equal(restoredOwner.rowCount, 1);
      ownerSuspended = false;
      await setBr01TestClock(nativeMiniflare, null);

      await scenario.closeOwner();
      const ownerAOpened = await postNative(nativeMiniflare, "/br01-open", {
        managerId: identities.A.managerId,
        proof: scenario.proofA,
        workspaceId: scenario.boot.workspaceAId,
      });
      assert.equal(ownerAOpened.response.status, 200, JSON.stringify(ownerAOpened.value));
      const foreignArticleRead = await postNative(nativeMiniflare, "/br04-read", {
        managerId: identities.A.managerId,
        searchInput,
        readPath: articlePath,
      });
      assert.equal(foreignArticleRead.response.status, 200, JSON.stringify(foreignArticleRead.value));
      assert.equal(foreignArticleRead.value.search.kind, "articles");
      assert.equal(
        foreignArticleRead.value.search.items.some((item) => item.articleId === articleId),
        false,
        "A different Manager's Article must not enter this owner's native Article search.",
      );
      assert.equal(foreignArticleRead.value.read, null);
      assert.equal(foreignArticleRead.value.readError, "Knowledge Base not_found.");
      await scenario.openOwner();

      await activateSilverManagementForTest(nativeMiniflare, managerId);
      await activateSilverIndexingForNativeTest(nativeMiniflare, managerId);
      const firstWake = await observeSilverAlarmForNativeTest(nativeMiniflare, managerId, 0);
      assert.equal(firstWake.outcome, "completed");
      assert.equal(firstWake.failure, null);
      assert.equal(firstWake.progress.projectionRowsBefore, 0);
      assert.equal(firstWake.progress.projectionRowsAfter, 1);
      assert.equal(firstWake.r2.getCalls, 1);
      assert.equal(firstWake.r2.putCalls, 0);
      assert.equal(firstWake.r2.completedReads, 1);
      assert.equal(firstWake.r2.materializedBytes, Buffer.byteLength(br01ArticleBody, "utf8"));

      const indexedArticle = await postNative(nativeMiniflare, "/br04-read", {
        managerId,
        searchInput,
        readPath: articlePath,
      });
      assert.equal(indexedArticle.response.status, 200, JSON.stringify(indexedArticle.value));
      assert.equal(indexedArticle.value.search.kind, "articles");
      assert.deepEqual(indexedArticle.value.search.items.map((item) => item.articleId), [articleId]);
      const indexedItem = indexedArticle.value.search.items[0];
      assert.equal(indexedItem.state, "indexed");
      assert.equal(indexedItem.currentPath, articlePath);
      assert.equal(indexedItem.usePolicy, "included");
      assert.equal(indexedArticle.value.read.kind, "article");
      assert.equal(indexedArticle.value.read.articleId, articleId);
      assert.equal(indexedArticle.value.read.path, articlePath);
      assert.equal(indexedArticle.value.read.sourceMarkdown, br01ArticleBody);
      assert.equal(indexedArticle.value.read.bodyHash, sha256HexOf(Buffer.from(br01ArticleBody, "utf8")));
      assert.equal(indexedArticle.value.readError, null);

      const currentArticle = await knowledgeArticlePolicySnapshot(
        nativeMiniflare,
        managerId,
        articleId,
      );
      assert.equal(currentArticle.article_id, articleId);
      assert.equal(currentArticle.use_policy, "included");
      assert.equal(currentArticle.metadata_revision, created.article.metadata_revision);
      const excludeProposal = await proposeNativePolicy(
        nativeMiniflare,
        managerId,
        articleId,
        "excluded",
        currentArticle.metadata_revision,
      );
      assert.equal(excludeProposal.response.status, 200, JSON.stringify(excludeProposal.value));
      assert.equal(excludeProposal.value.status, "pending_approval");
      const pendingAction = await postNative(nativeMiniflare, "/br01-action-state", {
        managerId,
        actionId: excludeProposal.value.actionId,
      });
      assert.equal(pendingAction.value.state, "pending");
      const excludeApproval = await postNative(nativeMiniflare, "/br01-approve", {
        managerId,
        actionId: excludeProposal.value.actionId,
      });
      assert.equal(excludeApproval.response.status, 200, JSON.stringify(excludeApproval.value));
      assert.equal(excludeApproval.value.actionState, "approved");

      const excludedArticle = await knowledgeArticlePolicySnapshot(
        nativeMiniflare,
        managerId,
        articleId,
      );
      assert.equal(excludedArticle.use_policy, "excluded");
      assert.equal(excludedArticle.metadata_revision, currentArticle.metadata_revision + 1);

      const excludedReaderResult = await postNative(nativeMiniflare, "/br04-read", {
        managerId,
        searchInput,
        readPath: articlePath,
      });
      assert.equal(excludedReaderResult.response.status, 200, JSON.stringify(excludedReaderResult.value));
      assert.deepEqual(excludedReaderResult.value.search.items, []);
      assert.equal(excludedReaderResult.value.read, null);
      assert.equal(excludedReaderResult.value.readError, "Knowledge Base not_found.");
    } finally {
      if (ownerSuspended) {
        await nativePostgres.db
          .query(
            `UPDATE operator.identity_manager_ownerships
             SET status = 'active'
             WHERE user_id = $1 AND manager_id = $2 AND role = 'owner' AND status = 'suspended'`,
            [identities.B.userId, managerId],
          )
          .catch(() => undefined);
      }
      await setBr01TestClock(nativeMiniflare, null).catch(() => undefined);
      await scenario.dispose();
    }
  },
);
