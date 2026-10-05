/**
 * Image size and boot time of the managed workspace images, for a before-and-after comparison.
 *
 * Builds one image per OS family from the same blueprint (every baked harness, the packages Mend's
 * projects ask for most, the workspace's own Docker), then boots it `--runs` times through its real
 * `sealantd boot` entrypoint and times two things per run:
 *
 * - **start:** `docker run -d` until the container's control socket exists, from outside, the way a
 *   launch waits for it;
 * - **boot:** inside the container, `sealantd boot` started until its control socket exists, so the
 *   Engine's own container setup does not hide a change in the daemon's start.
 *
 * Prints one JSON line per family: the image size in bytes (`docker image inspect .Size`), the
 * build's wall time, and the median and 90th percentile of each timing. The images are tagged
 * `sealant-image-budget-<family>:<label>` and left in the Engine for inspection.
 *
 * Run from the repository root:
 *   node_modules/.bin/tsx packages/workspaces/scripts/workspace-image-budget.mts \
 *     --label after --families arch,ubuntu,fedora --runs 10
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { parseWorkspaceBlueprint } from "@sealant/validators";

import { compileWorkspaceBuildSpec } from "../src/buildkit/buildkit-builder.js";

const run = (command: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, DOCKER_BUILDKIT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited ${String(code)}: ${stderr}`));
    });
  });

const quantile = (values: readonly number[], q: number): number => {
  const sorted = values.toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? Number.NaN;
};

const { values } = parseArgs({
  options: {
    label: { type: "string", default: "local" },
    families: { type: "string", default: "arch,ubuntu,fedora" },
    runs: { type: "string", default: "10" },
  },
});
const runs = Number(values.runs);
const families = values.families.split(",").filter((family) => family.length > 0);

const blueprintFor = (family: string) =>
  parseWorkspaceBlueprint({
    sources: { workspace: { url: "https://example.invalid/skipped.git", ref: "main" } },
    harness: { id: "claude-code" },
    target: { os: { family } },
    tooling: {
      packages: ["mise", "pnpm", "uv", "python", "github-cli", "ripgrep", "jq", "curl", "fd"].map(
        (id) => ({ id }),
      ),
      services: { docker: { enabled: true } },
    },
  });

const SOCKET = "/run/sealant/control.sock";
const bootEnv = [
  "-e",
  "SEALANT_WORKSPACE_REPO_URL=https://example.invalid/skipped.git",
  "-e",
  "SEALANT_WORKSPACE_REPO_REF=main",
  "-e",
  "SEALANT_FOREGROUND_COMMAND=sleep infinity",
];

/** `docker run -d` until the control socket exists, measured from outside. */
const timeStart = async (image: string, repo: string): Promise<number> => {
  const started = process.hrtime.bigint();
  const id = await run("docker", [
    "run",
    "-d",
    "--rm",
    ...bootEnv,
    "-v",
    `${repo}:/workspace/repo`,
    image,
  ]);
  try {
    await run("docker", [
      "exec",
      id,
      "/bin/sh",
      "-c",
      `i=0; while [ ! -S ${SOCKET} ]; do i=$((i+1)); [ $i -gt 6000 ] && exit 1; sleep 0.005; done`,
    ]);
    return Number(process.hrtime.bigint() - started) / 1e6;
  } finally {
    await run("docker", ["rm", "-f", id]).catch(() => "");
  }
};

/** `sealantd boot` until the control socket exists, measured inside the container. */
const timeBoot = async (image: string, repo: string): Promise<number> => {
  const script = [
    "s=$(date +%s%N)",
    "/usr/local/bin/sealantd boot >/dev/null 2>&1 &",
    `i=0; while [ ! -S ${SOCKET} ]; do i=$((i+1)); [ $i -gt 30000 ] && exit 1; sleep 0.001; done`,
    "echo $(( ($(date +%s%N) - s) / 1000 ))",
  ].join("\n");
  const out = await run("docker", [
    "run",
    "--rm",
    ...bootEnv,
    "-v",
    `${repo}:/workspace/repo`,
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    script,
  ]);
  return Number(out.split("\n").at(-1)) / 1000;
};

for (const family of families) {
  const builtAt = Date.now();
  const result = await compileWorkspaceBuildSpec({
    blueprint: blueprintFor(family),
    options: { emitTarball: false },
  });
  const buildMs = Date.now() - builtAt;
  const image = `sealant-image-budget-${family}:${values.label}`;
  await run("docker", ["tag", result.buildkit.spec.imageReference, image]);
  rmSync(result.buildkit.spec.contextDirectory, { recursive: true, force: true });
  const sizeBytes = Number(await run("docker", ["image", "inspect", "-f", "{{.Size}}", image]));

  const repo = mkdtempSync(join(tmpdir(), "image-budget-"));
  mkdirSync(join(repo, ".git"));
  const start: number[] = [];
  const boot: number[] = [];
  try {
    // One unmeasured boot each, so the first run does not pay for a cold page cache.
    await timeStart(image, repo);
    await timeBoot(image, repo);
    for (let index = 0; index < runs; index += 1) {
      start.push(await timeStart(image, repo));
      boot.push(await timeBoot(image, repo));
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  const summary = (samples: readonly number[]) => ({
    median: Math.round(quantile(samples, 0.5) * 10) / 10,
    p90: Math.round(quantile(samples, 0.9) * 10) / 10,
    worst: Math.round(Math.max(...samples) * 10) / 10,
  });
  process.stdout.write(
    `${JSON.stringify({
      family,
      label: values.label,
      image,
      planHash: result.metadata?.planHash,
      sizeBytes,
      buildMs,
      runs,
      startMs: summary(start),
      bootMs: summary(boot),
    })}\n`,
  );
}
