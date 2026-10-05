/**
 * The script that writes a person's logins into a home, run for real by `sh` against a temporary
 * directory. The test's own uid and gid stand in for the home's owner, so `chown` needs no root.
 */
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildHomeCredentialScript,
  HOME_SCRIPT_EXIT,
  homePathProblem,
  type HomeCredentialScript,
} from "./home-credentials.js";

const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;

const roots: string[] = [];
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "sealant-home-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const run = (script: HomeCredentialScript) =>
  spawnSync("sh", ["-c", script.script], { input: script.stdin, encoding: "utf8" });

const mode = (path: string) => lstatSync(path).mode & 0o7777;

describe("homePathProblem", () => {
  it("takes an absolute, normalised path outside /workspace", () => {
    expect(homePathProblem("/home/m4fkq2x7a")).toBeUndefined();
    expect(homePathProblem("/run/mend/conv/ses_1")).toBeUndefined();
    expect(homePathProblem("/root")).toBeUndefined();
  });

  it("refuses relative, unnormalised, odd and /workspace paths", () => {
    for (const home of [
      "home/x",
      "/",
      "/home/x/",
      "/home//x",
      "/home/./x",
      "/home/../etc",
      "/home/x y",
      "/home/$HOME",
      "/workspace",
      "/workspace/harness-home/people/acc_1",
    ]) {
      expect(homePathProblem(home), home).toBeDefined();
    }
  });
});

describe("buildHomeCredentialScript", () => {
  it("writes each login 0600, owned by the home's owner, in directories it makes 0700", () => {
    const home = join(scratch(), "alice");
    mkdirSync(home, { mode: 0o700 });
    const result = run(
      buildHomeCredentialScript({
        home,
        writes: [
          { provider: "claude", content: '{"claudeAiOauth":{"accessToken":"at-alice"}}' },
          { provider: "github", content: 'github.com:\n    oauth_token: "gho_alice"\n' },
        ],
        removes: [],
      }),
    );
    expect(result.status, result.stderr).toBe(0);
    const claude = join(home, ".claude/.credentials.json");
    expect(readFileSync(claude, "utf8")).toBe('{"claudeAiOauth":{"accessToken":"at-alice"}}');
    expect(mode(claude)).toBe(0o600);
    expect(lstatSync(claude).uid).toBe(uid);
    expect(mode(join(home, ".claude"))).toBe(0o700);
    expect(readFileSync(join(home, ".config/gh/hosts.yml"), "utf8")).toContain("gho_alice");
    expect(mode(join(home, ".config"))).toBe(0o700);
  });

  it("replaces a link at the file's name instead of writing through it", () => {
    const root = scratch();
    const home = join(root, "bob");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const elsewhere = join(root, "elsewhere.json");
    writeFileSync(elsewhere, "untouched");
    symlinkSync(elsewhere, join(home, ".codex/auth.json"));
    const result = run(
      buildHomeCredentialScript({
        home,
        writes: [{ provider: "codex", content: '{"tokens":{}}' }],
        removes: [],
      }),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(elsewhere, "utf8")).toBe("untouched");
    expect(lstatSync(join(home, ".codex/auth.json")).isSymbolicLink()).toBe(false);
  });

  it("removes the logins it is asked to", () => {
    const home = join(scratch(), "carol");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex/auth.json"), "old");
    const result = run(
      buildHomeCredentialScript({ home, writes: [], removes: ["codex", "claude"] }),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(() => lstatSync(join(home, ".codex/auth.json"))).toThrow();
  });

  it("refuses a home reached through a symbolic link, writing nothing", () => {
    const root = scratch();
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "linked"));
    const result = run(
      buildHomeCredentialScript({
        home: join(root, "linked"),
        writes: [{ provider: "claude", content: "{}" }],
        removes: [],
      }),
    );
    expect(result.status).toBe(HOME_SCRIPT_EXIT.linkOnTheWay);
    expect(() => lstatSync(join(root, "real/.claude"))).toThrow();
  });

  it("refuses a home that does not exist, unless told whose to make", () => {
    const home = join(scratch(), "dave");
    const refused = run(
      buildHomeCredentialScript({
        home,
        writes: [{ provider: "claude", content: "{}" }],
        removes: [],
      }),
    );
    expect(refused.status).toBe(HOME_SCRIPT_EXIT.missing);

    const made = run(
      buildHomeCredentialScript({
        home,
        createWithOwner: { uid, gid },
        writes: [{ provider: "claude", content: "{}" }],
        removes: [],
      }),
    );
    expect(made.status, made.stderr).toBe(0);
    expect(mode(home)).toBe(0o700);
    expect(lstatSync(home).uid).toBe(uid);
  });

  it("never puts a payload in the script itself", () => {
    const script = buildHomeCredentialScript({
      home: "/home/m1",
      writes: [{ provider: "claude", content: "secret-access-token" }],
      removes: [],
    });
    expect(script.script).not.toContain("secret-access-token");
    expect(script.script).not.toContain(Buffer.from("secret-access-token").toString("base64"));
    expect(script.stdin).toBe(`${Buffer.from("secret-access-token").toString("base64")}\n`);
  });

  it("refuses to build a script for a path that is not a home", () => {
    expect(() =>
      buildHomeCredentialScript({ home: "/workspace/repo", writes: [], removes: ["claude"] }),
    ).toThrow(/never under \/workspace/);
  });
});
