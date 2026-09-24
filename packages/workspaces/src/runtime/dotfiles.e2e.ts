/**
 * Opt-in live proof that a Docker workspace applies a blueprint's dotfiles archives the way a
 * user's own repository needs them (`dotfiles-e2e-fixture.ts` says which facts, and why).
 *
 * Skipped unless `SEALANT_DOTFILES_E2E=1`: it builds a real workspace image for the blueprint
 * (`SEALANT_DOTFILES_E2E_FAMILY`, arch by default, the family the hosted instance runs), which
 * takes several minutes and needs Docker with BuildKit and network access. The image bakes the
 * pinned sealantd; set `SEALANT_SEALANTD_IMAGE` to a local sealantd image to prove an unreleased
 * daemon instead.
 *
 * The chain is the worker's own: the host-directory stager stages the archives, the Docker
 * adapter bind-mounts them and waits for the daemon, and the facts are read through the daemon
 * (an exec over its control socket), so `HOME` is what sealantd gives the processes it starts.
 * It prints every finding at once rather than stopping at the first.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { newWorkspaceSchema, type NewWorkspace } from "@sealant/validators";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  compileWorkspaceBuildSpec,
  type BuildkitCommandRunner,
} from "../buildkit/buildkit-builder.js";
import { SealantRuntimeControlLive } from "../sealantd/runtime.js";
import { execInWorkspace, sealantTargetForDockerContainer } from "../sealantd/target.js";
import { DockerRuntimeAdapter, type DockerCommandRunner } from "./docker-runtime-adapter.js";
import {
  DOTFILES_E2E_FOREGROUND,
  DOTFILES_PROBE_SCRIPT,
  dotfilesE2eArchives,
  dotfilesProbeFindings,
} from "./dotfiles-e2e-fixture.js";
import { hostDirectoryLaunchMaterialStager } from "./launch-material.js";
import { parseRuntimeAdapterLaunchInput } from "./runtime-adapter.js";

const E2E_ENABLED = process.env["SEALANT_DOTFILES_E2E"] === "1";
const FAMILIES = ["arch", "fedora", "ubuntu"] as const;
type Family = (typeof FAMILIES)[number];
const FAMILY: Family =
  FAMILIES.find((family) => family === process.env["SEALANT_DOTFILES_E2E_FAMILY"]) ?? "arch";

const execFileAsync = promisify(execFile);
const docker: DockerCommandRunner = async (command, args) => {
  const result = await execFileAsync(command, args, { maxBuffer: 20 * 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
};
const buildkit: BuildkitCommandRunner = async (command, args, options) => {
  const result = await execFileAsync(command, args, {
    cwd: options?.cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

const observed = (step: string, detail: Record<string, unknown>): void => {
  console.log(`[dotfiles e2e] ${step} ${JSON.stringify(detail)}`);
};

const blueprintFor = (
  workspaceDir: string,
  dotfilesArchives: NewWorkspace["runtime"]["dotfilesArchives"],
): NewWorkspace =>
  newWorkspaceSchema.parse({
    version: "1",
    sources: { workspace: { kind: "mount", hostPath: workspaceDir }, inputs: [], mounts: [] },
    harness: { id: "opencode" },
    access: { ssh: { enabled: false, listenPort: 2222 } },
    tooling: { packages: [] },
    customization: {
      defaultShell: "zsh",
      dotfilesManager: "auto",
      dotfilesTarget: "home",
      applyDotfiles: true,
      dotfilesBootstrap: false,
    },
    lifecycle: { setup: [], startup: { steps: [], foreground: DOTFILES_E2E_FOREGROUND } },
    runtime: {
      env: {},
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
      runtime: { family: "docker", mode: "require" },
    },
  });

describe.skipIf(!E2E_ENABLED)(
  `Docker workspace applies dotfiles archives (${FAMILY}, live)`,
  () => {
    const runId = `dotfiles-e2e-${process.pid}`;
    let storeRoot: string | undefined;
    let workspaceDir: string | undefined;
    let contextDirectory: string | undefined;
    let imageReference: string | undefined;
    let adapter: DockerRuntimeAdapter | undefined;
    let launched: { readonly resourceId: string; readonly reference: string } | undefined;

    beforeAll(async () => {
      // The daemon provisions a mount source only under an allowed store root, not at one.
      storeRoot = await mkdtemp(join(tmpdir(), "sealant-dotfiles-e2e-store-"));
      workspaceDir = join(storeRoot, "worktree");
      await mkdir(workspaceDir);
      await writeFile(join(workspaceDir, "README.md"), "dotfiles e2e\n");
      const blueprint = blueprintFor(workspaceDir, await dotfilesE2eArchives());

      const buildStarted = Date.now();
      const built = await compileWorkspaceBuildSpec({
        blueprint,
        options: { commandRunner: buildkit },
      });
      contextDirectory = built.buildkit.spec.contextDirectory;
      imageReference = built.buildkit.spec.imageReference;
      observed("built", {
        image: imageReference,
        seconds: Math.round((Date.now() - buildStarted) / 1000),
      });

      const staged = await hostDirectoryLaunchMaterialStager.stage({ spec: blueprint, runId });
      adapter = new DockerRuntimeAdapter({
        commandRunner: docker,
        runtimeCatalogLoader: async () => ({ defaultRuntime: "runc", runtimes: new Set(["runc"]) }),
        mountAllowedStoreRoots: storeRoot,
        readinessTimeoutMs: 180_000,
        containerNamePrefix: "sealant-dotfiles-e2e",
      });
      const launchStarted = Date.now();
      launched = await adapter.launch(
        parseRuntimeAdapterLaunchInput({
          runId,
          blueprint,
          publishedImage: {
            repository: "sealant/dotfiles-e2e",
            tag: "e2e",
            reference: imageReference,
            digestReference: imageReference,
            digest: "sha256:dotfiles-e2e",
          },
          ...(staged.dotfilesArchiveDir === undefined
            ? {}
            : { dotfilesArchiveDir: staged.dotfilesArchiveDir }),
        }),
      );
      observed("launched", {
        container: launched.resourceId.slice(0, 12),
        seconds: Math.round((Date.now() - launchStarted) / 1000),
      });
    }, 20 * 60_000);

    afterAll(async () => {
      if (launched !== undefined && adapter !== undefined) {
        await adapter
          .stop({ resourceId: launched.resourceId, reference: launched.reference })
          .catch(() => undefined);
      }
      await hostDirectoryLaunchMaterialStager.removeAll(runId);
      if (imageReference !== undefined) {
        await docker("docker", ["image", "rm", "-f", imageReference]).catch(() => undefined);
      }
      for (const dir of [contextDirectory, storeRoot]) {
        if (dir !== undefined) await rm(dir, { recursive: true, force: true });
      }
    }, 120_000);

    it("lands the dot entries in /root, stows nothing, logs in with zsh and runs with HOME=/root", async () => {
      if (launched === undefined) throw new Error("the workspace did not launch");
      const result = await Effect.runPromise(
        execInWorkspace(sealantTargetForDockerContainer(launched.resourceId), {
          executable: "sh",
          args: ["-c", DOTFILES_PROBE_SCRIPT],
        }).pipe(Effect.provide(SealantRuntimeControlLive)),
      );
      const findings = dotfilesProbeFindings(result.stdout);
      observed("inside the workspace", {
        exitCode: result.exitCode,
        stdout: result.stdout,
        findings,
      });
      expect(result.exitCode).toBe(0);
      expect(findings).toEqual([]);
    }, 60_000);
  },
);
