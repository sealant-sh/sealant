/**
 * A launch's files staged into a sandbox, against a stand-in sandbox that runs the bridge's real
 * scripts under the host's `sh`, dash and bash, every absolute path under a scratch root. It records every
 * command's arguments and environment, so a test can check that no file's bytes are ever in them.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bridgeLaunchRequestSchema } from "@sealant/workspaces/cloudflare/bridge-contract";
import { afterEach, describe, expect, it } from "vitest";

import { INSTALL_STAGED_SCRIPT, LAUNCH_CLAIM_DIR, STAGING_DIR } from "./plan.js";
import { stageLaunchFiles, stageLaunchFilesOrReleaseClaim, type StagingSandbox } from "./stage.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Recorded {
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

const exited = (code: number) => ({ waitForExit: async () => ({ code }) });

/** The shells the scripts run under: the host's `sh`, and dash and bash where installed. */
const SHELLS = [
  ...new Set(
    ["sh", "dash", "bash"]
      .map((name) =>
        spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim(),
      )
      .filter((path) => path.startsWith("/"))
      .map((path) => realpathSync(path)),
  ),
];

/**
 * A stand-in sandbox: each command runs for real under `shell`, every `/run/…` path in its script
 * and every absolute path in its environment moved under a scratch root, `HOME` the root's `home`
 * (or unset). It records what it was asked to run.
 */
const standIn = (
  shell: string,
  options: {
    readonly failWrite?: boolean;
    readonly failInstall?: boolean;
    readonly withoutHome?: boolean;
  } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "sealant-cf-stage-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const at = (path: string) => join(root, path);
  const execs: Recorded[] = [];
  const sandbox: StagingSandbox = {
    exec: async (command, execOptions) => {
      const env = { ...execOptions?.env };
      execs.push({ command: [...command], env });
      if (options.failInstall === true && command[2] === INSTALL_STAGED_SCRIPT) {
        throw new Error("the sandbox's transport dropped the call");
      }
      const path = env["SEALANT_WRITE_PATH"] ?? "";
      const result = spawnSync(
        shell,
        ["-c", (command[2] ?? "").replaceAll("/run/", `${root}/run/`)],
        {
          env: {
            ...env,
            ...(env["SEALANT_STAGED"] === undefined
              ? {}
              : { SEALANT_STAGED: at(env["SEALANT_STAGED"]) }),
            ...(env["SEALANT_WRITE_PATH"] === undefined
              ? {}
              : { SEALANT_WRITE_PATH: path.startsWith("/") ? at(path) : path }),
            ...(options.withoutHome === true ? {} : { HOME: home }),
            PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          },
          encoding: "utf8",
        },
      );
      return exited(result.status ?? -1);
    },
    writeFile: async (path, content, writeOptions) => {
      writeFileSync(at(path), options.failWrite === true ? "half" : "");
      if (options.failWrite === true) throw new Error("the file API dropped the write");
      writeFileSync(
        at(path),
        Buffer.from(content, writeOptions?.encoding === "base64" ? "base64" : "utf8"),
      );
    },
    deleteFile: async (path) => {
      rmSync(at(path), { force: true });
    },
  };
  return { root, home, at, execs, sandbox };
};

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64");
const ARCHIVE = Buffer.alloc(200 * 1024, 7);

const launch = (credentialPath = "$HOME/.claude/.credentials.json") =>
  bridgeLaunchRequestSchema.parse({
    version: 1,
    runId: "run_1",
    source: { url: "https://github.com/example/repo.git" },
    image: {
      repository: "sealant/workspaces/demo",
      tag: "opencode",
      reference: "registry.example.com/demo:opencode",
      digestReference: "registry.example.com/demo@sha256:test",
      digest: "sha256:test",
    },
    env: {},
    secretEnv: { API_KEY: "SECRET-env-ünïcode" },
    credentialFiles: [
      { path: credentialPath, contentBase64: b64("SECRET-claude-login"), mode: "600" },
    ],
    dotfiles: {
      manifestJson: '{"archives":["a.tar"]}',
      archives: [{ name: "a.tar", contentBase64: b64(ARCHIVE) }],
    },
  });

describe.each(SHELLS)("stageLaunchFiles under %s", (shell) => {
  it("puts every file in place, with none of its bytes in any command's arguments or environment", async () => {
    const world = standIn(shell);
    await stageLaunchFiles(world.sandbox, launch());

    const secretEnv = world.at("/run/sealant/secrets/env.json");
    expect(JSON.parse(readFileSync(secretEnv, "utf8"))).toEqual({ API_KEY: "SECRET-env-ünïcode" });
    expect(lstatSync(secretEnv).mode & 0o777).toBe(0o600);
    // `$HOME/` is the sandbox user's home.
    const claude = join(world.home, ".claude/.credentials.json");
    expect(readFileSync(claude, "utf8")).toBe("SECRET-claude-login");
    expect(lstatSync(claude).mode & 0o777).toBe(0o600);
    // An archive larger than one environment string may be (128 KiB) arrives whole.
    expect(sha(readFileSync(world.at("/run/sealant/dotfiles/a.tar")))).toBe(sha(ARCHIVE));
    expect(readFileSync(world.at("/run/sealant/dotfiles/manifest.json"), "utf8")).toBe(
      '{"archives":["a.tar"]}',
    );
    // Every staged copy is gone.
    expect(readdirSync(world.at(STAGING_DIR))).toEqual([]);

    const recorded = JSON.stringify(world.execs);
    for (const needle of [
      "SECRET-env",
      "SECRET-claude-login",
      b64("SECRET-claude-login"),
      b64(ARCHIVE).slice(0, 64),
      "archives",
    ]) {
      expect(recorded, needle).not.toContain(needle);
    }
    // Each install carries only paths and a mode.
    for (const { env } of world.execs) {
      expect(Object.keys(env).toSorted()).toEqual(
        Object.keys(env).length === 0
          ? []
          : ["SEALANT_STAGED", "SEALANT_WRITE_MODE", "SEALANT_WRITE_PATH"],
      );
    }
  });

  it("refuses a path that is neither absolute nor under $HOME, removing the staged copy", async () => {
    const world = standIn(shell);
    await expect(stageLaunchFiles(world.sandbox, launch("relative/creds.json"))).rejects.toThrow(
      /relative\/creds\.json \(exit 64\)/,
    );
    expect(readdirSync(world.at(STAGING_DIR))).toEqual([]);
  });

  it("removes the staged copy when the file cannot be put in place", async () => {
    const world = standIn(shell);
    // A directory where the secret env file goes.
    mkdirSync(world.at("/run/sealant/secrets/env.json"), { recursive: true });
    await expect(stageLaunchFiles(world.sandbox, launch())).rejects.toThrow(/env\.json/);
    expect(readdirSync(world.at(STAGING_DIR))).toEqual([]);
  });

  it("deletes a staged file the file API failed to write whole", async () => {
    const world = standIn(shell, { failWrite: true });
    await expect(stageLaunchFiles(world.sandbox, launch())).rejects.toThrow(/dropped/);
    expect(existsSync(world.at(join(STAGING_DIR, "0")))).toBe(false);
    expect(existsSync(dirname(world.at("/run/sealant/secrets/env.json")))).toBe(false);
  });

  it("makes the staging directory root's only, whatever was there", async () => {
    const world = standIn(shell);
    mkdirSync(world.at(STAGING_DIR), { recursive: true, mode: 0o755 });
    await stageLaunchFiles(world.sandbox, launch());
    expect(lstatSync(world.at(STAGING_DIR)).mode & 0o777).toBe(0o700);
    const fresh = standIn(shell);
    await stageLaunchFiles(fresh.sandbox, launch());
    expect(lstatSync(fresh.at(STAGING_DIR)).mode & 0o777).toBe(0o700);
  });

  it("refuses a $HOME path where HOME is not set, rather than writing it at /", async () => {
    const world = standIn(shell, { withoutHome: true });
    await expect(stageLaunchFiles(world.sandbox, launch())).rejects.toThrow(
      /\$HOME\/\.claude\/\.credentials\.json \(exit 64\)/,
    );
    expect(existsSync(world.at("/.claude"))).toBe(false);
    expect(readdirSync(world.at(STAGING_DIR))).toEqual([]);
  });

  it("deletes the staged copy when the install call itself fails", async () => {
    const world = standIn(shell, { failInstall: true });
    await expect(stageLaunchFiles(world.sandbox, launch())).rejects.toThrow(/transport/);
    expect(readdirSync(world.at(STAGING_DIR))).toEqual([]);
  });

  it("gives the launch claim back when staging fails, and keeps it when staging succeeds", async () => {
    const failed = standIn(shell);
    mkdirSync(failed.at(LAUNCH_CLAIM_DIR), { recursive: true });
    await expect(
      stageLaunchFilesOrReleaseClaim(failed.sandbox, launch("relative/creds.json")),
    ).rejects.toThrow(/exit 64/);
    expect(existsSync(failed.at(LAUNCH_CLAIM_DIR))).toBe(false);

    const staged = standIn(shell);
    mkdirSync(staged.at(LAUNCH_CLAIM_DIR), { recursive: true });
    await stageLaunchFilesOrReleaseClaim(staged.sandbox, launch());
    expect(existsSync(staged.at(LAUNCH_CLAIM_DIR))).toBe(true);
  });
});
