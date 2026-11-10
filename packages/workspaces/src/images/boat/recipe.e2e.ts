import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { newWorkspaceSchema } from "@sealant/validators";
import { expect, it } from "vitest";

import { nativeWorkspaceInstallation } from "../../buildkit/buildkit-builder.js";
import { createWorkspaceBuildSpec } from "../../buildkit/docker-parity.fixture.js";
import { createNativeRecipe } from "./recipe.js";
import { NATIVE_RUNTIME_PIN } from "./runtime-bundle.js";

const run = promisify(execFile);

it("resolves the project's Ubuntu catalog packages inside the actual native bootstrap root", async () => {
  const base = createWorkspaceBuildSpec();
  const spec = newWorkspaceSchema.parse({
    ...base,
    target: {
      os: { family: "ubuntu", mode: "prefer" },
      runtime: { family: "boat", mode: "require" },
    },
    harness: { id: "codex" },
    customization: { ...base.customization, defaultShell: "zsh" },
    tooling: {
      packages: [
        "pnpm",
        "bun",
        "python",
        "uv",
        "mise",
        "github-cli",
        "lazygit",
        "bat",
        "curl",
        "unzip",
        "jq",
        "ripgrep",
        "fd",
        "fzf",
        "starship",
        "zsh-autosuggestions",
        "zsh-syntax-highlighting",
        "zsh-history-substring-search",
        "direnv",
        "doppler",
        "postgresql-client",
        "redis-cli",
      ].map((id) => ({ id })),
    },
  });
  const recipe = await createNativeRecipe(spec, {
    identity: { ...NATIVE_RUNTIME_PIN, platform: "linux/amd64" },
    files: () => [],
  });
  if (!recipe.ok) throw recipe.error;
  // The VM is the workspace: the project installs on the Ubuntu root itself, after the agent's
  // own packages. The same base image stands in for the VM here.
  const agentPackages = recipe.value.installScript
    .split("\n")
    .find((line) => line.startsWith("DEBIAN_FRONTEND=noninteractive apt-get install -y "));
  const apt = nativeWorkspaceInstallation(spec)
    .shell.split("\n")
    .find(
      (line) =>
        line.startsWith("DEBIAN_FRONTEND=noninteractive apt-get install -y ") &&
        line.split(/\s+/).includes("npm"),
    );
  if (agentPackages === undefined || apt === undefined)
    throw new Error("Native Ubuntu installation commands missing");
  const name = `boat-recipe-proof-${randomUUID()}`;
  try {
    const result = await run(
      "docker",
      [
        "run",
        "--name",
        name,
        "--label",
        "sealant-dev=boat-stream",
        "ubuntu:24.04",
        "/bin/bash",
        "-ceu",
        [
          "apt-get update",
          agentPackages,
          apt.replace("apt-get install -y", "apt-get --simulate install"),
        ].join("\n"),
      ],
      { timeout: 240_000, maxBuffer: 8 * 1024 * 1024 },
    );
    expect(result.stdout).toContain("Inst nodejs");
    expect(result.stdout).toContain("Inst npm");
    expect(result.stdout).toContain("Inst gh");
    expect(result.stdout).toContain("Inst redis-tools");
  } finally {
    await run("docker", ["rm", "--force", name], { timeout: 30_000 });
  }
}, 270_000);
