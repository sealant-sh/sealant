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
 * `SEALANT_MICROVM_BUILT_IMAGE_E2E_FAMILY` picks the OS family (fedora by default; nix, arch and
 * ubuntu are the others). `SEALANT_MICROVM_BUILT_IMAGE_E2E_DOCKER=1` asks the blueprint for
 * workspace-scoped Docker: the image then carries the engine, is created with the `ALL` OS
 * capability, and inside the VM `docker info` and one container run are checked as well.
 *
 * `SEALANT_MICROVM_BUILT_IMAGE_E2E_DOTFILES=1` launches with dotfiles the way Mend's hosted
 * instance does: zsh as the default shell, an `auto` archive shaped like a real user's repository
 * and a `copy` archive (`runtime/dotfiles-e2e-fixture.ts`), staged and pushed to the agent by the
 * worker's own path. Inside the VM it checks the dot entries landed in /root, nothing from the
 * repository's plain directories was stowed there, root's login shell is zsh, and the processes
 * sealantd starts see `HOME=/root`. The family defaults to arch in this mode, as on that instance.
 *
 * It deletes the image it built unless `SEALANT_MICROVM_BUILT_IMAGE_E2E_KEEP=1`. It prints what it
 * observed and never credentials, tokens or raw provider errors.
 */
import { randomUUID } from "node:crypto";

import { newWorkspaceSchema, type NewWorkspace } from "@sealant/validators";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  DOTFILES_E2E_FOREGROUND,
  DOTFILES_PROBE_SCRIPT,
  dotfilesE2eArchives,
  dotfilesProbeFindings,
} from "../../runtime/dotfiles-e2e-fixture.js";
import { hostDirectoryLaunchMaterialStager } from "../../runtime/launch-material.js";
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
const WITH_DOCKER = process.env.SEALANT_MICROVM_BUILT_IMAGE_E2E_DOCKER === "1";
const WITH_DOTFILES = process.env.SEALANT_MICROVM_BUILT_IMAGE_E2E_DOTFILES === "1";
const FAMILIES = ["fedora", "arch", "ubuntu", "nix"] as const;
type Family = (typeof FAMILIES)[number];
const FAMILY: Family =
  FAMILIES.find((family) => family === process.env.SEALANT_MICROVM_BUILT_IMAGE_E2E_FAMILY) ??
  (WITH_DOTFILES ? "arch" : "fedora");
const PACKAGE = "ripgrep";
/**
 * `SEALANT_MICROVM_BUILT_IMAGE_E2E_PACKAGES=mend-defaults` asks for Mend's default workspace
 * package list instead of ripgrep alone, and checks each tool answers `--version` inside the VM.
 */
const MEND_DEFAULTS = process.env.SEALANT_MICROVM_BUILT_IMAGE_E2E_PACKAGES === "mend-defaults";
const PACKAGES = MEND_DEFAULTS
  ? [
      "pnpm",
      "python",
      "uv",
      "mise",
      "github-cli",
      "lazygit",
      "bat",
      "curl",
      "jq",
      "ripgrep",
      "fd",
      "fzf",
    ]
  : [PACKAGE];
/** Command per package id, for the check inside the VM. */
const PACKAGE_COMMANDS: Readonly<Record<string, string>> = {
  pnpm: "pnpm --version",
  python: "python3 --version",
  uv: "uv --version",
  mise: "mise --version",
  "github-cli": "gh --version",
  lazygit: "lazygit --version",
  bat: "bat --version",
  curl: "curl --version",
  jq: "jq --version",
  ripgrep: "rg --version",
  fd: "fd --version",
  fzf: "fzf --version",
};
/** From the public ECR mirror, so the run inside the VM needs no Docker Hub login. */
const PROBE_CONTAINER = "public.ecr.aws/docker/library/alpine:3.20";

const numberFromEnv = (name: string): number | undefined => {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? undefined : Number(raw);
};

/** A blueprint that customises its image, with a marker so each run is a plan of its own. */
const blueprint = (
  marker: string,
  dotfilesArchives: NewWorkspace["runtime"]["dotfilesArchives"],
): NewWorkspace =>
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
    tooling: {
      packages: PACKAGES.map((id) => ({ id })),
      ...(WITH_DOCKER ? { services: { docker: { enabled: true } } } : {}),
    },
    customization: {
      defaultShell: WITH_DOTFILES ? "zsh" : "bash",
      dotfilesManager: "auto",
      dotfilesTarget: "home",
      applyDotfiles: WITH_DOTFILES,
      dotfilesBootstrap: false,
    },
    lifecycle: {
      setup: [],
      startup: {
        steps: [],
        foreground: WITH_DOTFILES
          ? DOTFILES_E2E_FOREGROUND
          : { kind: "command", run: "sleep 600", shell: "bash" },
      },
    },
    runtime: {
      env: { SEALANT_E2E_MARKER: marker },
      credentialRefs: [],
      dotfilesArchives,
      workspaceRoot: "/workspace",
      workingDirectory: "/workspace/repo",
      persistence: "ephemeral",
      ociRuntime: "runc",
      network: { outbound: true },
    },
    target: {
      os: { family: FAMILY, mode: "require" },
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
      `builds a customised ${FAMILY} blueprint${WITH_DOCKER ? " with Docker" : ""}${MEND_DEFAULTS ? " and Mend's default packages" : ""}${WITH_DOTFILES ? " and dotfiles" : ""} once, boots it, and finds the OS, the packages and sealantctl inside`,
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
          SEALANT_MICROVM_DOCKER_ENABLED: WITH_DOCKER,
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
            dockerService: WITH_DOCKER,
            maxImages: config.build.maxImages,
            pollIntervalMs: config.build.pollIntervalMs,
            buildTimeoutMs: config.build.timeoutMs,
          },
          readContextFile: contextFiles.read,
          contextDigest: contextFiles.digest,
        });

        // A fixed marker reuses one image across runs (with `_KEEP=1`); unset, every run builds.
        const spec = blueprint(
          process.env.SEALANT_MICROVM_BUILT_IMAGE_E2E_MARKER ?? randomUUID(),
          WITH_DOTFILES ? await dotfilesE2eArchives() : [],
        );
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

          // 3. The adapter boots what the build published, with the dotfiles staged as the
          // worker stages them (the adapter inlines them into the agent's launch push).
          const staged = await hostDirectoryLaunchMaterialStager.stage({
            spec,
            runId: fixtureId,
          });
          const launchStarted = Date.now();
          const launched = await adapter.launch(
            parseRuntimeAdapterLaunchInput({
              runId: fixtureId,
              blueprint: spec,
              publishedImage: first.publishedImage,
              ...(staged.dotfilesArchiveDir === undefined
                ? {}
                : { dotfilesArchiveDir: staged.dotfilesArchiveDir }),
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
                  ...PACKAGES.map(
                    (id) =>
                      `printf "package %s=%s\\n" ${id} "$(${PACKAGE_COMMANDS[id] ?? `${id} --version`} 2>&1 | head -n 1 | head -c 60)"`,
                  ),
                  // The baked harnesses have to run on this base, not only install.
                  'for h in codex claude opencode; do printf "harness %s=%s\\n" "$h" "$(command -v "$h" >/dev/null 2>&1 && "$h" --version 2>&1 | head -n 1 | head -c 80 || echo missing)"; done',
                  ...(WITH_DOCKER
                    ? [
                        `printf "docker=%s\\n" "$(docker info --format '{{.ServerVersion}}' 2>&1 | head -c 120)"`,
                        `printf "container=%s\\n" "$(docker run --rm ${PROBE_CONTAINER} sh -c 'echo ran-in-a-container' 2>&1 | tail -n 1 | head -c 120)"`,
                      ]
                    : []),
                ].join("; "),
              ],
            }).pipe(Effect.provide(SealantRuntimeControlLive)),
          );
          observed("inside the VM", { exitCode: inside.exitCode, stdout: inside.stdout });
          expect(inside.exitCode).toBe(0);
          // /etc/os-release ids: fedora, ubuntu, `archarm` (Arch Linux ARM), and the nix image's base.
          const OS_ID: Record<Family, RegExp> = {
            fedora: /^os=fedora$/m,
            ubuntu: /^os=ubuntu$/m,
            arch: /^os=archarm$/m,
            // The nix image has no /etc/os-release at all.
            nix: /^os=$/m,
          };
          expect(inside.stdout).toMatch(OS_ID[FAMILY]);
          expect(inside.stdout).toMatch(/package=ripgrep \d/);
          for (const id of PACKAGES) {
            // Each tool answers --version with something that starts with a digit or its name.
            expect(inside.stdout, id).toMatch(new RegExp(`^package ${id}=[^\\n]*\\d`, "m"));
          }
          expect(inside.stdout).toContain("sealantd=/usr/local/bin/sealantd");
          expect(inside.stdout).toMatch(/sealantctl=sealantctl /);
          // The client the terminate hook flushes captures with reaches the daemon.
          expect(inside.stdout).toContain('"state":"healthy"');
          // Every baked harness starts on this base.
          expect(inside.stdout).toMatch(/^harness codex=codex-cli \d/m);
          expect(inside.stdout).toMatch(/^harness claude=\d/m);
          expect(inside.stdout).toMatch(/^harness opencode=\d/m);
          if (WITH_DOCKER) {
            expect(inside.stdout).toMatch(/^docker=\d+\.\d+/m);
            expect(inside.stdout).toContain("container=ran-in-a-container");
          }

          if (WITH_DOTFILES) {
            const probe = await Effect.runPromise(
              execInWorkspace(target, {
                executable: "sh",
                args: ["-c", DOTFILES_PROBE_SCRIPT],
              }).pipe(Effect.provide(SealantRuntimeControlLive)),
            );
            const findings = dotfilesProbeFindings(probe.stdout);
            observed("dotfiles", { exitCode: probe.exitCode, stdout: probe.stdout, findings });
            expect(probe.exitCode).toBe(0);
            expect(findings).toEqual([]);
          }

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
          await hostDirectoryLaunchMaterialStager.removeAll(fixtureId);
          if (imageName !== undefined && !KEEP_IMAGE) {
            const removed = await imageApi.deleteImage(imageName).catch(() => "failed" as const);
            observed("image cleanup", { image: imageName, removed });
          }
        }
      },
    );
  },
);
