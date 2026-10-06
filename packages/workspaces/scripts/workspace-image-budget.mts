/**
 * Before-and-after measurements of the managed workspace images: size, boot, and what a session
 * does first.
 *
 * Builds one image per OS family from one blueprint (every baked harness, the packages Mend's
 * projects ask for most, the workspace's own Docker), or takes images already built (`--images`),
 * then measures them `--runs` times, every image in turn within a run, so the images compared share
 * the machine's state instead of following each other:
 *
 * - **start:** `docker run -d` until the control socket exists, from outside, as a launch waits;
 * - **boot:** inside the container, `sealantd boot` until its control socket exists;
 * - **dotfiles:** `sealantd boot` with runtime dotfiles from a local repository whose `install.sh`
 *   links files and asks mise, npm, pnpm and git what they see, until that script has finished;
 * - **first output:** each baked harness CLI (`--version`), until its first byte of output;
 * - **npm install / pnpm install:** a six-dependency project from its lockfile, warm cache and
 *   store, `node_modules` removed before each run.
 *
 * Every timed process runs as root with the image's own environment: the shared layout, the one
 * the person layout must leave alone. Prints one JSON line per image: its layers' size (`docker
 * history`, uncompressed), the Engine's `.Size`, the build's wall time, and the median, 90th
 * percentile and worst of each measure.
 *
 * `--no-cache` builds without the builder's cache, so two checkouts built back to back compare
 * like with like (no package or `@latest` drift between a cached layer and a fresh one).
 *
 * Run from the repository root:
 *   node_modules/.bin/tsx packages/workspaces/scripts/workspace-image-budget.mts \
 *     --label after --families arch,ubuntu,fedora --no-cache --build-only
 *   node_modules/.bin/tsx packages/workspaces/scripts/workspace-image-budget.mts \
 *     --images sealant-image-budget-arch:before,sealant-image-budget-arch:after --runs 10
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { parseWorkspaceBlueprint } from "@sealant/validators";

import { planWorkspaceImageBuild } from "../src/buildkit/buildkit-builder.js";

const run = (command: string, args: readonly string[], input = ""): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, DOCKER_BUILDKIT: "1" },
      stdio: ["pipe", "pipe", "pipe"],
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
    child.stdin.end(input);
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
    images: { type: "string" },
    "no-cache": { type: "boolean", default: false },
    "build-only": { type: "boolean", default: false },
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
      packages: [
        "mise",
        "pnpm",
        "uv",
        "python",
        "github-cli",
        "ripgrep",
        "jq",
        "curl",
        "fd",
        "stow",
      ].map((id) => ({ id })),
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
const platformFor = (image: string): string[] =>
  image.includes("-arch") ? ["--platform", "linux/amd64"] : [];

const scratch = mkdtempSync(join(tmpdir(), "image-budget-"));
const repo = join(scratch, "repo");
mkdirSync(join(repo, ".git"), { recursive: true });

/** A dotfiles repository like many: files to link, and an install.sh that asks the tools. */
const dotfiles = join(scratch, "dotfiles");
mkdirSync(join(dotfiles, "shell"), { recursive: true });
writeFileSync(join(dotfiles, "shell", ".budgetrc"), "export BUDGET=1\n");
writeFileSync(
  join(dotfiles, "install.sh"),
  [
    "#!/bin/sh",
    "set -e",
    'ln -sf "$PWD/shell/.budgetrc" "$HOME/.budgetrc"',
    "git config --global user.name budget",
    "mise --version >/dev/null",
    "npm config get prefix >/dev/null",
    "pnpm --version >/dev/null",
    "touch /tmp/dotfiles-done",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
await run("git", ["-C", dotfiles, "init", "-q", "-b", "main"]);
await run("git", [
  "-C",
  dotfiles,
  "-c",
  "user.email=b@example.invalid",
  "-c",
  "user.name=b",
  "commit",
  "-q",
  "--allow-empty",
  "-m",
  "init",
]);
await run("git", ["-C", dotfiles, "add", "-A"]);
await run("git", [
  "-C",
  dotfiles,
  "-c",
  "user.email=b@example.invalid",
  "-c",
  "user.name=b",
  "commit",
  "-q",
  "-m",
  "dotfiles",
]);

/** `docker run -d` until the control socket exists, measured from outside. */
const timeStart = async (image: string): Promise<number> => {
  const started = process.hrtime.bigint();
  const id = await run("docker", [
    "run",
    "-d",
    "--rm",
    ...platformFor(image),
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

/** `sealantd boot` until a file exists, measured inside the container, in milliseconds. */
const timeBootUntil = async (
  image: string,
  path: string,
  extra: readonly string[] = [],
  prelude = "true",
): Promise<number> => {
  const script = [
    prelude,
    "s=$(date +%s%N)",
    "/usr/local/bin/sealantd boot >/tmp/boot.log 2>&1 &",
    `i=0; while [ ! -e ${path} ]; do i=$((i+1)); [ $i -gt 60000 ] && { cat /tmp/boot.log >&2; exit 1; }; sleep 0.001; done`,
    "echo $(( ($(date +%s%N) - s) / 1000 ))",
  ].join("\n");
  const out = await run("docker", [
    "run",
    "--rm",
    ...platformFor(image),
    ...bootEnv,
    ...extra,
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

const dotfilesEnv = [
  "-v",
  `${dotfiles}:/dotfiles-src:ro`,
  "-e",
  "SEALANT_DOTFILES_RUNTIME_APPLY=1",
  "-e",
  "SEALANT_DOTFILES_REPO_URL=file:///dotfiles",
  "-e",
  "SEALANT_DOTFILES_REPO_REF=main",
  "-e",
  "SEALANT_DOTFILES_MANAGER=stow",
  "-e",
  "SEALANT_DOTFILES_TARGET=home",
  "-e",
  "SEALANT_DOTFILES_BOOTSTRAP=1",
  "-e",
  "SEALANT_DOTFILES_BOOTSTRAP_COMMAND=./install.sh",
];
/** A root-owned copy, made before the clock starts: git refuses a repository another uid owns. */
const DOTFILES_PRELUDE = "cp -a /dotfiles-src /dotfiles && chown -R 0:0 /dotfiles";

/** A project to install, the same in every image. */
const FIXTURE = JSON.stringify({
  name: "budget",
  private: true,
  dependencies: {
    lodash: "4.17.21",
    express: "4.21.2",
    zod: "3.24.1",
    typescript: "5.7.3",
    react: "18.3.1",
    "react-dom": "18.3.1",
  },
});
const HARNESSES = ["claude", "codex", "opencode", "pi"] as const;

/** Inside a long-lived container: one sample of each tool measure, as JSON, in microseconds. */
const TOOLS_SCRIPT = [
  "us() { echo $(( ($(date +%s%N) - $1) / 1000 )); }",
  'first() { command -v "$1" >/dev/null || { echo null; return; }; s=$(date +%s%N); "$@" 2>&1 | head -c1 >/dev/null; us $s; }',
  "out='{'",
  ...HARNESSES.map((name) => `out="$out\\"${name}\\":$(first ${name} --version),"`),
  'cd /tmp/npm && rm -rf node_modules && s=$(date +%s%N) && npm install --prefer-offline --no-audit --no-fund --loglevel=error >/dev/null 2>&1 && out="$out\\"npmInstall\\":$(us $s),"',
  'cd /tmp/pnpm && rm -rf node_modules && s=$(date +%s%N) && pnpm install --prefer-offline --frozen-lockfile --reporter=silent >/dev/null 2>&1 && out="$out\\"pnpmInstall\\":$(us $s),"',
  'echo "${out%,}}"',
].join("\n");

const startToolsContainer = async (image: string): Promise<string> => {
  const id = await run("docker", [
    "run",
    "-d",
    "--rm",
    ...platformFor(image),
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    "sleep infinity",
  ]);
  // Lockfiles and a warm cache and store, outside the measurement.
  await run("docker", [
    "exec",
    id,
    "/bin/sh",
    "-c",
    [
      `mkdir -p /tmp/npm /tmp/pnpm && printf '%s' '${FIXTURE}' > /tmp/npm/package.json && cp /tmp/npm/package.json /tmp/pnpm/`,
      "cd /tmp/npm && npm install --no-audit --no-fund --loglevel=error >/dev/null 2>&1",
      "cd /tmp/pnpm && pnpm install --reporter=silent >/dev/null 2>&1",
    ].join(" && "),
  ]);
  return id;
};

/** The image's layers, uncompressed, as `docker history` counts them. */
const layerBytes = async (image: string): Promise<number> =>
  (await run("docker", ["history", "--human=false", "--format", "{{.Size}}", image]))
    .split("\n")
    .reduce((total, line) => total + Number(line), 0);

const summary = (samples: readonly number[]) =>
  samples.length === 0
    ? null
    : {
        median: Math.round(quantile(samples, 0.5) * 10) / 10,
        p90: Math.round(quantile(samples, 0.9) * 10) / 10,
        worst: Math.round(Math.max(...samples) * 10) / 10,
      };

/** Builds the planned Containerfile, without the builder's cache when asked. */
const build = async (
  family: string,
): Promise<{ image: string; buildMs: number; planHash: string }> => {
  const planned = planWorkspaceImageBuild({ blueprint: blueprintFor(family) });
  const context = mkdtempSync(join(tmpdir(), "image-budget-build-"));
  const image = `sealant-image-budget-${family}:${values.label}`;
  try {
    writeFileSync(join(context, "Containerfile"), planned.containerfile);
    const builtAt = Date.now();
    await run("docker", [
      "build",
      ...(values["no-cache"] ? ["--no-cache", "--pull"] : []),
      ...(family === "arch" ? ["--platform", "linux/amd64"] : []),
      "--file",
      join(context, "Containerfile"),
      "--tag",
      image,
      context,
    ]);
    return { image, buildMs: Date.now() - builtAt, planHash: planned.planHash };
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
};

const images: Array<{ image: string; family?: string; planHash?: string; buildMs?: number }> =
  values.images === undefined ? [] : values.images.split(",").map((image) => ({ image }));
if (values.images === undefined) {
  for (const family of families) images.push({ family, ...(await build(family)) });
}

type Samples = Record<string, number[]>;
const samples = new Map<string, Samples>(images.map(({ image }) => [image, {}]));
const record = (image: string, name: string, value: number | null | undefined) => {
  if (value === null || value === undefined || Number.isNaN(value)) return;
  const entry = samples.get(image);
  if (entry !== undefined) (entry[name] ??= []).push(value);
};

if (!values["build-only"]) {
  const tools = new Map<string, string>();
  try {
    for (const { image } of images) tools.set(image, await startToolsContainer(image));
    // One unmeasured pass, so the first run does not pay for a cold page cache.
    for (let index = -1; index < runs; index += 1) {
      for (const { image } of images) {
        const start = await timeStart(image);
        const boot = await timeBootUntil(image, SOCKET);
        const dotfilesMs = await timeBootUntil(
          image,
          "/tmp/dotfiles-done",
          dotfilesEnv,
          DOTFILES_PRELUDE,
        );
        const toolsSample: Record<string, number | null> = JSON.parse(
          await run(
            "docker",
            ["exec", "-i", tools.get(image) ?? "", "/bin/bash", "-s"],
            TOOLS_SCRIPT,
          ),
        );
        if (index < 0) continue;
        record(image, "startMs", start);
        record(image, "bootMs", boot);
        record(image, "dotfilesMs", dotfilesMs);
        for (const [name, value] of Object.entries(toolsSample)) {
          record(image, `${name}Ms`, value === null ? null : value / 1000);
        }
      }
    }
  } finally {
    for (const id of tools.values()) await run("docker", ["rm", "-f", id]).catch(() => "");
  }
}
rmSync(scratch, { recursive: true, force: true });

for (const entry of images) {
  const measured = samples.get(entry.image) ?? {};
  process.stdout.write(
    `${JSON.stringify({
      ...entry,
      label: values.label,
      layerBytes: await layerBytes(entry.image),
      sizeBytes: Number(await run("docker", ["image", "inspect", "-f", "{{.Size}}", entry.image])),
      runs: values["build-only"] ? 0 : runs,
      ...Object.fromEntries(Object.entries(measured).map(([name, list]) => [name, summary(list)])),
    })}\n`,
  );
}
