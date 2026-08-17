/**
 * Adapter-driven end-to-end proof of the P6 consumer seam: the EXISTING Docker runtime path
 * (`DockerRuntimeAdapter.launch`) produces a container id; that id flows through the pure
 * `sealantTargetForDockerContainer` derivation into a `SealantTarget`; and the worker-facing
 * `execInWorkspace` helper drives a REAL control session (P5 `SealantRuntime` over the docker-exec
 * transport) to run `/bin/echo hi` inside that container — asserting `stdout === "hi\n"` and
 * `exitCode === 0`.
 *
 * The chain this proves end-to-end:
 *   container-id (from DockerRuntimeAdapter) → SealantTarget → SealantRuntime.connect → exec → events.
 *
 * HOW MUCH OF THE REAL ADAPTER IS EXERCISED
 * -----------------------------------------
 * We drive the actual `DockerRuntimeAdapter.launch()` — not a reimplementation. That executes, for
 * real, all of: launch-input Zod parsing, the `supports()` gate, `assertRuntimeConfigured` (via an
 * injected catalog loader reporting `runc`), container-name derivation, blueprint→env arg assembly,
 * the real `docker run -d` (its own argv), and the post-run `assertContainerRunning` inspect probe,
 * then `parseRuntimeAdapterLaunchResult`. The returned `result.resourceId` is the genuine container
 * id, and that — nothing synthetic — is what we feed to the seam.
 *
 * TWO NARROW, DOCUMENTED ACCOMMODATIONS (the adapter's launch API can't yet express them; we do NOT
 * stub the adapter, we only adjust its inputs / augment its argv):
 *
 *   1. KEEP-ALIVE + CLONE-SKIP via blueprint env. `launch()` derives container env from
 *      `blueprint.runtime.env`, so we set `SEALANT_FOREGROUND_COMMAND=sleep infinity` there — the
 *      same knob `bootSealantdContainer` uses — so the entrypoint launches sealantd in the
 *      background and then stays alive instead of running the harness foreground. This is a real
 *      adapter input, not a stub.
 *
 *   2. `.git` MARKER MOUNT via a commandRunner shim. The entrypoint skips its git clone (no network,
 *      no auth) when `<workingDirectory>/.git` exists, but `launch()` has no volume-mount knob. So we
 *      wrap the REAL docker command runner and, for the `run` invocation only, splice in
 *      `-v <hostTmp-with-.git>:/workspace/repo`. Every other docker call (inspect/etc.) passes through
 *      untouched to the real docker CLI. We assert the spliced argv is otherwise the adapter's own.
 *      The published image is the local tag (set as `digestReference`, which `launch` passes straight
 *      to `docker run`); no registry is involved.
 *
 * Net: the only thing NOT real is the volume mount injection (an API gap in `launch`) and the
 * keep-alive env (a deliberate test affordance, identical to the P3/P5 boots). The container id →
 * target → SealantRuntime → exec path is 100% real against a live container.
 *
 * Requires Docker + the prebuilt image; excluded from the default unit run; runs via `test:e2e`.
 * Skips gracefully when the image is absent.
 */
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DockerRuntimeAdapter,
  parseRuntimeAdapterLaunchInput,
  parseRuntimeAdapterSupportInput,
  type DockerCommandRunner,
} from "../runtime/index.js";
import {
  assertImageRequirement,
  DEFAULT_IMAGE_REF,
  DEFAULT_WORKING_DIRECTORY,
  docker,
  isImagePresent,
} from "./boot.js";
import { SealantRuntimeDockerExecLive } from "./runtime.js";
import { execInWorkspace, sealantTargetForDockerContainer } from "./target.js";

const execFileAsync = promisify(execFile);

/** Minimal-but-valid blueprint mirroring the adapter's own unit-test factory, with overrides. */
const createBlueprint = (overrides: Record<string, unknown> = {}): unknown => {
  const base = {
    version: "1",
    sources: {
      workspace: {
        kind: "git" as const,
        provider: "generic" as const,
        url: "https://github.com/example/repo.git",
        ref: "main",
      },
      inputs: [] as const,
    },
    harness: { id: "opencode" as const },
    access: { ssh: { enabled: false, listenPort: 2222 } },
    tooling: { packages: [] as const },
    customization: {
      defaultShell: "bash" as const,
      dotfilesManager: "auto" as const,
      dotfilesTarget: "home" as const,
      applyDotfiles: true,
      dotfilesBootstrap: true,
    },
    lifecycle: {
      setup: [] as const,
      startup: { steps: [] as const, foreground: { kind: "harness" as const } },
    },
    runtime: {
      env: {} as Record<string, string>,
      workspaceRoot: "/workspace",
      workingDirectory: DEFAULT_WORKING_DIRECTORY,
      persistence: "ephemeral" as const,
      ociRuntime: "runc" as const,
      network: { outbound: true },
    },
    target: {
      os: { family: "nix" as const, mode: "prefer" as const },
      runtime: { family: "docker" as const, mode: "prefer" as const },
    },
  };
  const override = overrides as Record<string, any>;

  return parseRuntimeAdapterSupportInput({
    blueprint: {
      ...base,
      ...override,
      runtime: {
        ...base.runtime,
        ...override.runtime,
        env: { ...base.runtime.env, ...override.runtime?.env },
        network: { ...base.runtime.network, ...override.runtime?.network },
      },
    },
  }).blueprint;
};

const imageAvailable = await isImagePresent();
assertImageRequirement(imageAvailable);

describe.skipIf(!imageAvailable)(
  "P6 seam: DockerRuntimeAdapter container id -> SealantTarget -> execInWorkspace (real container)",
  () => {
    let workspaceMount: string | undefined;
    let secretEnvDir: string | undefined;
    let containerId: string | undefined;
    /** Captured run argv, to assert the only delta vs the adapter's own argv is our `-v` splice. */
    let capturedRunArgs: ReadonlyArray<string> | undefined;

    beforeAll(async () => {
      // Host dir with a `.git/` marker, bind-mounted at the working directory to skip the clone.
      workspaceMount = mkdtempSync(join(tmpdir(), "sealantd-p6-"));
      mkdirSync(join(workspaceMount, ".git"));

      // Wrap the REAL docker command runner; only the `run` invocation gets the `.git` mount spliced
      // in (the adapter has no volume knob). All other docker calls pass through unmodified.
      const realRunner: DockerCommandRunner = async (command, args) => {
        const result = await execFileAsync(command, args, { maxBuffer: 1024 * 1024 * 10 });
        return { stdout: result.stdout, stderr: result.stderr };
      };
      const mountingRunner: DockerCommandRunner = async (command, args) => {
        if (args[0] !== "run") {
          return realRunner(command, args);
        }
        capturedRunArgs = args;
        // Insert `-v <mount>:/workspace/repo` just before the trailing image reference.
        const imageIndex = args.length - 1;
        const augmented = [
          ...args.slice(0, imageIndex),
          "-v",
          `${workspaceMount}:${DEFAULT_WORKING_DIRECTORY}`,
          ...args.slice(imageIndex),
        ];
        return realRunner(command, augmented);
      };

      const adapter = new DockerRuntimeAdapter({
        commandRunner: mountingRunner,
        autoRemove: false,
        // Report `runc` so the real assertRuntimeConfigured passes deterministically without
        // depending on this host's docker /info socket shape.
        runtimeCatalogLoader: async () => ({
          defaultRuntime: "runc",
          runtimes: new Set(["runc"]),
        }),
        containerNamePrefix: "sealant-p6",
      });

      // The transient secret channel, staged exactly as the worker stages it (0700 dir, 0600 file).
      secretEnvDir = mkdtempSync(join(tmpdir(), "sealantd-p6-secrets-"));
      chmodSync(secretEnvDir, 0o700);
      writeFileSync(
        join(secretEnvDir, "env.json"),
        JSON.stringify({
          DATABASE_URL: "postgres://user:hunter2-e2e-pass@db.internal/app",
          // A secret-shaped name: rejected on the plaintext lane, exactly right on this one.
          STRIPE_API_KEY: "sk_live_e2e_secret_value_1234",
        }),
        { mode: 0o600 },
      );

      // Drive the REAL launch(): keep-alive via blueprint env; the local tag as the published image.
      const launchInput = parseRuntimeAdapterLaunchInput({
        blueprint: createBlueprint({
          runtime: {
            env: {
              SEALANT_FOREGROUND_COMMAND: "sleep infinity",
              // Legacy env is unrestricted, so this secret-marker name DOES land in the container
              // env — and the daemon's passthrough filter must then drop it (asserted below).
              PROOF_TOKEN: "dropped-by-daemon-filter",
            },
            // The caller/project map under test: policy-valid, expected to reach every child.
            userEnv: { WORKSPACE_ENV_PROOF: "canary-e2e-value" },
          },
        }),
        publishedImage: {
          repository: "sealant-workspace-fedora",
          tag: "latest",
          reference: DEFAULT_IMAGE_REF,
          // `launch` runs `docker run ... <digestReference>`; the local tag resolves directly.
          digestReference: DEFAULT_IMAGE_REF,
          digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        },
        secretEnvDir,
      });

      const result = await adapter.launch(launchInput);
      containerId = result.resourceId;

      // Wait for the entrypoint to create the control socket before we bridge into it.
      let socketReady = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          await docker(["exec", containerId, "test", "-S", "/run/sealant/control.sock"]);
          socketReady = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (!socketReady) {
        const logs = await docker(["logs", containerId]).catch(() => "(no logs)");
        throw new Error(`sealantd control socket never appeared. Logs:\n${logs}`);
      }
    }, 120_000);

    afterAll(async () => {
      if (containerId) {
        await docker(["rm", "-f", containerId]).catch(() => {});
      }
      if (workspaceMount) {
        rmSync(workspaceMount, { recursive: true, force: true });
      }
      if (secretEnvDir) {
        rmSync(secretEnvDir, { recursive: true, force: true });
      }
    });

    it("launched via the real adapter argv, augmented only by the `.git` mount", () => {
      // The adapter built the run argv; we asserted our shim only added the documented `-v` mount.
      expect(capturedRunArgs).toBeDefined();
      expect(capturedRunArgs?.[0]).toBe("run");
      expect(capturedRunArgs).toContain("-d");
      expect(capturedRunArgs).toContain("--runtime");
      expect(capturedRunArgs).toContain("runc");
      // The keep-alive env is a real adapter input derived from blueprint.runtime.env.
      expect(capturedRunArgs).toContain("SEALANT_FOREGROUND_COMMAND=sleep infinity");
      // The published image (local tag) is the trailing arg the adapter passes to docker run.
      expect(capturedRunArgs?.[capturedRunArgs.length - 1]).toBe(DEFAULT_IMAGE_REF);
      // The adapter adds no working-directory mount itself (proves the splice is the only delta
      // there); its one `-v` is the read-only secret-env bind this test stages.
      const volumeArgs = (capturedRunArgs ?? []).filter((_, index, all) => all[index - 1] === "-v");
      expect(volumeArgs).toHaveLength(1);
      expect(volumeArgs[0]).toBe(`${secretEnvDir}:/run/sealant/secrets:ro`);
    });

    it("container-id -> sealantTargetForDockerContainer -> execInWorkspace runs /bin/echo hi", async () => {
      expect(containerId).toBeDefined();

      const target = sealantTargetForDockerContainer(containerId!);
      expect(target).toEqual({
        kind: "docker-exec",
        containerId,
        socketPath: "/run/sealant/control.sock",
      });

      const result = await Effect.runPromise(
        execInWorkspace(target, { executable: "/bin/echo", args: ["hi"] }).pipe(
          Effect.provide(SealantRuntimeDockerExecLive),
        ),
      );

      expect(result.stdout).toBe("hi\n");
      expect(result.exitCode).toBe(0);
    }, 45_000);

    it("workspace userEnv reaches an exec'd child through the daemon's boot snapshot", async () => {
      expect(containerId).toBeDefined();

      // The `-e` was on `docker run`; the daemon snapshotted its own env at boot, filtered it, and
      // rebuilt the child env — the child does NOT inherit the daemon's live environment.
      expect(capturedRunArgs).toContain("WORKSPACE_ENV_PROOF=canary-e2e-value");
      const result = await Effect.runPromise(
        execInWorkspace(sealantTargetForDockerContainer(containerId!), {
          executable: "/bin/sh",
          args: ["-c", 'printf %s "$WORKSPACE_ENV_PROOF"'],
        }).pipe(Effect.provide(SealantRuntimeDockerExecLive)),
      );

      expect(result.stdout).toBe("canary-e2e-value");
      expect(result.exitCode).toBe(0);
    }, 45_000);

    it("the transient secret channel: secrets reach children, never argv/container env, and are redacted in capture", async () => {
      expect(containerId).toBeDefined();

      // The argv carried a bind + a file path — never a secret name or value.
      expect(capturedRunArgs).toContain("SEALANT_SECRET_ENV_FILE=/run/sealant/secrets/env.json");
      expect(capturedRunArgs?.join(" ")).not.toContain("hunter2-e2e-pass");
      expect(capturedRunArgs?.join(" ")).not.toContain("STRIPE_API_KEY");
      // Container env (what `docker inspect` shows) holds no secret value either.
      const containerEnv = await docker(["exec", containerId!, "sh", "-c", "env"]);
      expect(containerEnv).not.toContain("hunter2-e2e-pass");
      expect(containerEnv).not.toContain("sk_live_e2e_secret_value_1234");

      // A daemon-managed child DOES inherit them (proved in-process, so the values never have to
      // cross the redacted capture to be asserted)…
      const check = await Effect.runPromise(
        execInWorkspace(sealantTargetForDockerContainer(containerId!), {
          executable: "/bin/sh",
          args: [
            "-c",
            'test "$STRIPE_API_KEY" = "sk_live_e2e_secret_value_1234" && test "$DATABASE_URL" = "postgres://user:hunter2-e2e-pass@db.internal/app" && echo INHERITED',
          ],
        }).pipe(Effect.provide(SealantRuntimeDockerExecLive)),
      );
      expect(check.stdout).toBe("INHERITED\n");
      expect(check.exitCode).toBe(0);

      // …and echoing them shows the redactor was seeded with EVERY value, whatever the name.
      const echoed = await Effect.runPromise(
        execInWorkspace(sealantTargetForDockerContainer(containerId!), {
          executable: "/bin/sh",
          args: ["-c", 'printf "%s|%s" "$DATABASE_URL" "$STRIPE_API_KEY"'],
        }).pipe(Effect.provide(SealantRuntimeDockerExecLive)),
      );
      expect(echoed.stdout).toBe("***REDACTED***|***REDACTED***");
    }, 45_000);

    it("secret-marker names in container env are DROPPED by the daemon filter", async () => {
      expect(containerId).toBeDefined();

      // This is the live proof behind the policy's secret-marker rejections: the name reached the
      // container env (via unrestricted legacy `runtime.env`), yet no child ever sees it. A
      // `userEnv` entry with such a name would vanish identically — hence the loud parse failure.
      expect(capturedRunArgs).toContain("PROOF_TOKEN=dropped-by-daemon-filter");
      const result = await Effect.runPromise(
        execInWorkspace(sealantTargetForDockerContainer(containerId!), {
          executable: "/bin/sh",
          args: ["-c", 'printf %s "${PROOF_TOKEN-unset}"'],
        }).pipe(Effect.provide(SealantRuntimeDockerExecLive)),
      );

      expect(result.stdout).toBe("unset");
      expect(result.exitCode).toBe(0);
    }, 45_000);
  },
);
