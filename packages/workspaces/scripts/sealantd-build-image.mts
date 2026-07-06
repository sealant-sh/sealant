/**
 * Standalone Fedora workspace image build, with sealantd baked in.
 *
 * This drives the BuildKit OS builder via its pure compile entry point
 * (`compileWorkspaceBuildSpec`) and intentionally avoids the worker / DB / queue
 * surface: it imports the builder module directly (not the package barrel, which
 * re-exports the worker job and pulls in @sealant/db + @sealant/rabbitmq).
 *
 * Flow:
 *   1. Build a WorkspaceBlueprint (validated via parseWorkspaceBlueprint).
 *   2. compileWorkspaceBuildSpec renders the build context, runs `docker build`
 *      (FROM fedora:41, dnf-installs socat, COPY --from public GHCR sealantd),
 *      then `docker save` -> OCI tarball. push=false.
 *   3. The image is ALSO tagged locally as the compile result's imageReference
 *      (docker build --tag), so no `docker load` is required to run it.
 *
 * Run with:  DOCKER_BUILDKIT=1 pnpm --filter @sealant/workspaces exec tsx scripts/sealantd-build-image.mts
 * (or from repo root: DOCKER_BUILDKIT=1 node_modules/.bin/tsx packages/workspaces/scripts/sealantd-build-image.mts)
 */
import { spawn } from "node:child_process";

import { parseWorkspaceBlueprint } from "@sealant/validators";

import {
  compileWorkspaceBuildSpec,
  type BuildkitCommandRunner,
} from "../src/buildkit/buildkit-builder.js";

// A streaming command runner so we can watch `docker build` progress live.
// Mirrors the package default runner (forces DOCKER_BUILDKIT=1) but pipes
// stdout/stderr straight through to this process for visibility.
const streamingCommandRunner: BuildkitCommandRunner = (command, args, options) => {
  return new Promise((resolve, reject) => {
    process.stdout.write(`\n$ ${command} ${args.join(" ")}\n`);
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: { ...process.env, DOCKER_BUILDKIT: "1" },
      stdio: ["ignore", "inherit", "inherit"],
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${command} exited via signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} failed with exit ${code ?? "unknown"}`));
        return;
      }
      // We stream rather than buffer, so there is nothing to hand back here.
      resolve({ stdout: "", stderr: "" });
    });
  });
};

const main = async () => {
  // harness.id MUST be one of the validator's workspaceHarnessIdSchema enum
  // ("opencode" | "codex" | "claude-code"). We use "claude-code".
  const blueprint = parseWorkspaceBlueprint({
    sources: {
      workspace: {
        // Tiny public repo so the build has a real, cloneable source.
        url: "https://github.com/octocat/Hello-World.git",
        ref: "master",
      },
    },
    harness: {
      id: "claude-code",
    },
    target: {
      os: {
        family: "fedora",
      },
    },
    customization: {
      enableSealantd: true,
    },
  });

  const startedAt = Date.now();
  const result = await compileWorkspaceBuildSpec({
    blueprint,
    options: { commandRunner: streamingCommandRunner },
  });
  const durationMs = Date.now() - startedAt;

  const imageReference = result.buildkit.spec.imageReference;
  const ociArtifact = result.artifacts.find((artifact) => artifact.kind === "oci-image");

  process.stdout.write("\n==== BUILD COMPLETE ====\n");
  process.stdout.write(`imageReference: ${imageReference}\n`);
  process.stdout.write(`tarball:        ${ociArtifact?.path ?? "(none)"}\n`);
  process.stdout.write(`osFamily:       ${result.builder.osFamily}\n`);
  process.stdout.write(`baseImage:      ${result.buildkit.imagePlan.baseImage}\n`);
  process.stdout.write(`harness.id:     ${blueprint.harness.id}\n`);
  process.stdout.write(`durationMs:     ${durationMs}\n`);
  process.stdout.write(`durationSec:    ${(durationMs / 1000).toFixed(1)}\n`);
};

main().catch((error: unknown) => {
  process.stderr.write(
    `\nBUILD FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
