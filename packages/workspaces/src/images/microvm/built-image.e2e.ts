/**
 * Opt-in live-provider proof that a Lambda MicroVM workspace boots the image built from its
 * blueprint (docs/workspace-image-builders-design.md, D4).
 *
 * Skipped unless `SEALANT_MICROVM_BUILT_IMAGE_E2E=1`. It uses the standard `SEALANT_MICROVM_*`
 * worker configuration and the ambient AWS credentials, and it costs provider usage: one managed
 * image build (two to four minutes) and one MicroVM for about a minute. Do not run it in CI.
 *
 * What it holds the real platform to:
 *
 *   1. the builder builds a customised blueprint (a required OS family and a catalog package);
 *   2. the same plan again builds and uploads nothing;
 *   3. the adapter boots that image, and inside the VM the OS family, the package and
 *      `sealantctl` (the suspend and terminate hooks' capture flush) are all there;
 *   4. a fenced stop ends the VM through the terminate hook. With `SEALANT_MICROVM_LOG_GROUP` set,
 *      the VM's console shows the hook's `sealantctl capture flush` and the daemon's answer.
 *
 * It deletes the image it built unless `SEALANT_MICROVM_BUILT_IMAGE_E2E_KEEP=1`. It prints what it
 * observed and never credentials, tokens or raw provider errors.
 */
import { randomUUID } from "node:crypto";

import { newWorkspaceSchema, type NewWorkspace } from "@sealant/validators";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { MicrovmRuntimeAdapter } from "../../runtime/microvm/adapter.js";
import { createLiveMicrovmApi } from "../../runtime/microvm/api.js";
import { microvmRuntimeConfigFromEnv } from "../../runtime/microvm/config.js";
import { MicrovmEndpointTokens } from "../../runtime/microvm/endpoint-tokens.js";
import { parseMicrovmImageReference } from "../../runtime/microvm/image-reference.js";
import { parseRuntimeAdapterLaunchInput } from "../../runtime/runtime-adapter.js";
import { SealantRuntimeControlLive } from "../../sealantd/runtime.js";
import { execInWorkspace, sealantTargetForRuntimeInstance } from "../../sealantd/target.js";
import { MicrovmWorkspaceImageBuilder } from "./builder.js";
import { loadMicrovmContextFiles } from "./context-files.js";
import { createLiveMicrovmImageApi, createS3MicrovmArtifactStore } from "./image-api.js";

const E2E_ENABLED = process.env.SEALANT_MICROVM_BUILT_IMAGE_E2E === "1";
const KEEP_IMAGE = process.env.SEALANT_MICROVM_BUILT_IMAGE_E2E_KEEP === "1";
const PACKAGE = "ripgrep";

const numberFromEnv = (name: string): number | undefined => {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? undefined : Number(raw);
};

/** A blueprint that customises its image, with a marker so each run is a plan of its own. */
const blueprint = (marker: string): NewWorkspace =>
  parseBlueprint({
    version: "1",
    sources: {
      workspace: {
        kind: "git",
        provider: "generic",
        url: "https://github.com/octocat/Hello-World.git",
        ref: "master",
      },
      inputs: [],
      mounts: [],
    },
    harness: { id: "opencode" },
    access: { ssh: { enabled: false, listenPort: 2222 } },
    tooling: { packages: [{ id: PACKAGE }] },
    customization: {
      defaultShell: "bash",
      dotfilesManager: "auto",
      dotfilesTarget: "home",
      applyDotfiles: false,
      dotfilesBootstrap: false,
    },
    lifecycle: {
      setup: [],
      startup: { steps: [], foreground: { kind: "command", run: "sleep 600", shell: "bash" } },
    },
    runtime: {
      env: { SEALANT_E2E_MARKER: marker },
      credentialRefs: [],
      workspaceRoot: "/workspace",
      workingDirectory: "/workspace/repo",
      persistence: "ephemeral",
      ociRuntime: "runc",
      network: { outbound: true },
    },
    target: {
      os: { family: "fedora", mode: "require" },
      runtime: { family: "microvm", mode: "require" },
    },
  });

const parseBlueprint = (input: unknown): NewWorkspace => newWorkspaceSchema.parse(input);

const observed = (step: string, detail: Record<string, unknown>): void => {
  console.log(`[built-image e2e] ${step} ${JSON.stringify(detail)}`);
};

describe.skipIf(!E2E_ENABLED)(
  "Lambda MicroVM boots the image built from its blueprint (live)",
  () => {
    it(
      "builds a customised blueprint once, boots it, and finds the OS, the package and sealantctl inside",
      { timeout: 45 * 60_000 },
      async () => {
        const config = microvmRuntimeConfigFromEnv({
          SEALANT_MICROVM_REGION: process.env.SEALANT_MICROVM_REGION,
          SEALANT_MICROVM_BUILD_ROLE_ARN: process.env.SEALANT_MICROVM_BUILD_ROLE_ARN,
          SEALANT_MICROVM_ARTIFACT_BUCKET: process.env.SEALANT_MICROVM_ARTIFACT_BUCKET,
          SEALANT_MICROVM_ARTIFACT_PREFIX: process.env.SEALANT_MICROVM_ARTIFACT_PREFIX,
          SEALANT_MICROVM_IMAGE_NAME_PREFIX: process.env.SEALANT_MICROVM_IMAGE_NAME_PREFIX,
          SEALANT_MICROVM_BUILD_LOG_GROUP: process.env.SEALANT_MICROVM_BUILD_LOG_GROUP,
          SEALANT_MICROVM_MEMORY_MIB: numberFromEnv("SEALANT_MICROVM_MEMORY_MIB"),
          SEALANT_MICROVM_EXEC_ROLE_ARN: process.env.SEALANT_MICROVM_EXEC_ROLE_ARN,
          SEALANT_MICROVM_EGRESS_CONNECTOR: process.env.SEALANT_MICROVM_EGRESS_CONNECTOR,
          SEALANT_MICROVM_LOG_GROUP: process.env.SEALANT_MICROVM_LOG_GROUP,
          SEALANT_MICROVM_MAX_DURATION_SECONDS: 900,
          SEALANT_CONTROL_BEARER_TOKEN: process.env.SEALANT_CONTROL_BEARER_TOKEN,
        });
        if (config === undefined) {
          throw new Error("The built-image E2E needs the SEALANT_MICROVM_* worker configuration.");
        }

        const imageApi = createLiveMicrovmImageApi({
          region: config.region,
          accountArn: config.build.roleArn,
        });
        const contextFiles = await loadMicrovmContextFiles();
        const builder = new MicrovmWorkspaceImageBuilder({
          api: imageApi,
          artifacts: createS3MicrovmArtifactStore({
            region: config.region,
            bucket: config.build.artifactBucket,
          }),
          config: {
            baseImageArn: config.build.baseImageArn,
            buildRoleArn: config.build.roleArn,
            artifactPrefix: config.build.artifactPrefix,
            memoryMiB: config.build.memoryMiB,
            agentPort: config.agentPort,
            logGroup: config.build.logGroup,
            imageNamePrefix: config.build.imageNamePrefix,
            dockerService: false,
            maxImages: config.build.maxImages,
            pollIntervalMs: config.build.pollIntervalMs,
            buildTimeoutMs: config.build.timeoutMs,
          },
          readContextFile: contextFiles.read,
          contextDigest: contextFiles.digest,
        });

        // A fixed marker reuses one image across runs (with `_KEEP=1`); unset, every run builds.
        const spec = blueprint(process.env.SEALANT_MICROVM_BUILT_IMAGE_E2E_MARKER ?? randomUUID());
        const fixtureId = `sealant-built-image-e2e-${randomUUID().slice(0, 8)}`;
        let imageName: string | undefined;
        let microvmId: string | undefined;
        const microvmApi = createLiveMicrovmApi({ region: config.region });
        const tokens = new MicrovmEndpointTokens({
          api: microvmApi,
          port: config.agentPort,
          ttlMinutes: config.endpointTokenTtlMinutes,
          refreshMarginMs: config.endpointTokenRefreshMarginMs,
          webSocketAuth: config.endpointWebSocketAuth,
        });
        const adapter = new MicrovmRuntimeAdapter({ config, api: microvmApi, tokens });

        try {
          // 1. The managed build of the blueprint's own recipe.
          const buildStarted = Date.now();
          const first = await builder.buildAndPublish({
            spec,
            repository: "ignored",
            tag: "ignored",
            buildId: fixtureId,
          });
          imageName = first.publishedImage.repository;
          const image = parseMicrovmImageReference(first.publishedImage.digestReference);
          observed("built", {
            image: imageName,
            version: first.publishedImage.tag,
            seconds: Math.round((Date.now() - buildStarted) / 1000),
            note: first.build.metadata?.notes?.[0],
          });
          expect(image).toBeDefined();
          expect(first.build.metadata?.notes?.[0]).toMatch(/^Built the MicroVM image/);

          // 2. One recipe is one image.
          const reuseStarted = Date.now();
          const second = await builder.buildAndPublish({
            spec,
            repository: "ignored",
            tag: "ignored",
            buildId: `${fixtureId}-again`,
          });
          observed("reused", {
            seconds: Math.round((Date.now() - reuseStarted) / 1000),
            note: second.build.metadata?.notes?.[0],
          });
          expect(second.publishedImage).toEqual(first.publishedImage);
          expect(second.build.metadata?.notes?.[0]).toMatch(/^Reused the MicroVM image/);

          // 3. The adapter boots what the build published.
          const launchStarted = Date.now();
          const launched = await adapter.launch(
            parseRuntimeAdapterLaunchInput({
              runId: fixtureId,
              blueprint: spec,
              publishedImage: first.publishedImage,
            }),
          );
          microvmId = launched.resourceId;
          const vm = await microvmApi.getMicrovm(launched.resourceId);
          observed("launched", {
            microvmId,
            status: launched.status,
            bootedImageArn: vm?.imageArn,
            seconds: Math.round((Date.now() - launchStarted) / 1000),
          });
          expect(launched.status).toBe("ready");
          expect(vm?.imageArn).toContain(imageName);

          const target = sealantTargetForRuntimeInstance(
            {
              adapter: "microvm",
              resourceId: launched.resourceId,
              endpoint: launched.endpoint ?? null,
            },
            {
              controlBearerToken: config.controlBearerToken,
              microvmConnectMaterial: (id) => tokens.connectMaterial(id),
            },
          );
          if (target === undefined) throw new Error("No authenticated control target was derived.");

          const inside = await Effect.runPromise(
            execInWorkspace(target, {
              executable: "bash",
              args: [
                "-c",
                [
                  ". /etc/os-release",
                  'printf "os=%s\\n" "$ID"',
                  `printf "package=%s\\n" "$(rg --version | head -n 1)"`,
                  'printf "sealantd=%s\\n" "$(command -v sealantd)"',
                  'printf "sealantctl=%s\\n" "$(sealantctl --version)"',
                  'printf "health=%s\\n" "$(sealantctl --socket /run/sealant/control.sock health 2>&1 | head -c 200 | tr "\\n" " ")"',
                  'printf "repo=%s\\n" "$(git -C /workspace/repo rev-parse --is-inside-work-tree 2>/dev/null)"',
                ].join("; "),
              ],
            }).pipe(Effect.provide(SealantRuntimeControlLive)),
          );
          observed("inside the VM", { exitCode: inside.exitCode, stdout: inside.stdout });
          expect(inside.exitCode).toBe(0);
          expect(inside.stdout).toContain("os=fedora");
          expect(inside.stdout).toMatch(/package=ripgrep \d/);
          expect(inside.stdout).toContain("sealantd=/usr/local/bin/sealantd");
          expect(inside.stdout).toMatch(/sealantctl=sealantctl /);
          // The client the terminate hook flushes captures with reaches the daemon.
          expect(inside.stdout).toContain('"state":"healthy"');

          // 4. A fenced stop goes through the terminate hook, where the agent runs the flush.
          const stopStarted = Date.now();
          const stopped = await adapter.stop({ resourceId: launched.resourceId, fence: true });
          observed("stopped", {
            outcome: stopped,
            seconds: Math.round((Date.now() - stopStarted) / 1000),
            state: (await microvmApi.getMicrovm(launched.resourceId))?.state,
          });
          microvmId = undefined;
        } finally {
          if (microvmId !== undefined) {
            await adapter.stop({ resourceId: microvmId, fence: true }).catch(() => undefined);
          }
          if (imageName !== undefined && !KEEP_IMAGE) {
            const removed = await imageApi.deleteImage(imageName).catch(() => "failed" as const);
            observed("image cleanup", { image: imageName, removed });
          }
        }
      },
    );
  },
);
