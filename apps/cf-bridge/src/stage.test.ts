/**
 * A launch's files staged into a sandbox, against a stand-in sandbox that runs the bridge's real
 * scripts with this machine's `sh`, every absolute path under a scratch root. It records every
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
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bridgeLaunchRequestSchema } from "@sealant/workspaces/cloudflare/bridge-contract";
import { afterEach, describe, expect, it } from "vitest";

import { PREPARE_STAGING_SCRIPT, STAGING_DIR } from "./plan.js";
import { stageLaunchFiles, type StagingSandbox } from "./stage.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Recorded {
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

const exited = (code: number) => ({ waitForExit: async () => ({ code }) });

const standIn = (options: { readonly failWrite?: boolean } = {}) => {
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
      if (command[2] === PREPARE_STAGING_SCRIPT) {
        mkdirSync(at(STAGING_DIR), { recursive: true, mode: 0o700 });
        return exited(0);
      }
      const path = env["SEALANT_WRITE_PATH"] ?? "";
      const result = spawnSync(command[0], command.slice(1), {
        env: {
          ...env,
          SEALANT_STAGED: at(env["SEALANT_STAGED"] ?? ""),
          SEALANT_WRITE_PATH: path.startsWith("/") ? at(path) : path,
          HOME: home,
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        },
      });
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

describe("stageLaunchFiles", () => {
  it("puts every file in place, with none of its bytes in any command's arguments or environment", async () => {
    const world = standIn();
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
    const world = standIn();
    await expect(stageLaunchFiles(world.sandbox, launch("relative/creds.json"))).rejects.toThrow(
      /relative\/creds\.json \(exit 64\)/,
    );
    expect(readdirSync(world.at(STAGING_DIR))).toEqual([]);
  });

  it("removes the staged copy when the file cannot be put in place", async () => {
    const world = standIn();
    // A directory where the secret env file goes.
    mkdirSync(world.at("/run/sealant/secrets/env.json"), { recursive: true });
    await expect(stageLaunchFiles(world.sandbox, launch())).rejects.toThrow(/env\.json/);
    expect(readdirSync(world.at(STAGING_DIR))).toEqual([]);
  });

  it("deletes a staged file the file API failed to write whole", async () => {
    const world = standIn({ failWrite: true });
    await expect(stageLaunchFiles(world.sandbox, launch())).rejects.toThrow(/dropped/);
    expect(existsSync(world.at(join(STAGING_DIR, "0")))).toBe(false);
    expect(existsSync(dirname(world.at("/run/sealant/secrets/env.json")))).toBe(false);
  });
});
