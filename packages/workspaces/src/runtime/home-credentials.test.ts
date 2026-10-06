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
  HOME_MARKER_FILE,
  HOME_SCRIPT_EXIT,
  homePathProblem,
  homeScriptStdin,
  type HomeCredentialProvider,
  type HomeCredentialScriptInput,
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

const run = (
  input: Omit<HomeCredentialScriptInput, "writes"> & {
    readonly writes: readonly {
      readonly provider: HomeCredentialProvider;
      readonly content: string;
    }[];
  },
) =>
  spawnSync(
    "sh",
    [
      "-c",
      buildHomeCredentialScript({ ...input, writes: input.writes.map(({ provider }) => provider) }),
    ],
    { input: homeScriptStdin(input.writes.map(({ content }) => content)), encoding: "utf8" },
  );

const GEN_A = "generation-alice-1";
const GEN_B = "generation-bob-01";
const marker = (home: string) => readFileSync(join(home, HOME_MARKER_FILE), "utf8");

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
    const result = run({
      home,
      fence: { kind: "take", generation: GEN_A },
      writes: [
        { provider: "claude", content: '{"claudeAiOauth":{"accessToken":"at-alice"}}' },
        { provider: "github", content: 'github.com:\n    oauth_token: "gho_alice"\n' },
      ],
      removes: [],
    });
    expect(result.status, result.stderr).toBe(0);
    const claude = join(home, ".claude/.credentials.json");
    expect(readFileSync(claude, "utf8")).toBe('{"claudeAiOauth":{"accessToken":"at-alice"}}');
    expect(mode(claude)).toBe(0o600);
    expect(lstatSync(claude).uid).toBe(uid);
    expect(mode(join(home, ".claude"))).toBe(0o700);
    expect(readFileSync(join(home, ".config/gh/hosts.yml"), "utf8")).toContain("gho_alice");
    expect(mode(join(home, ".config"))).toBe(0o700);
    expect(marker(home)).toBe(GEN_A);
  });

  it("fences every write by the hold's marker: a late write from an earlier hold lands nowhere", () => {
    const home = join(scratch(), "conv");
    mkdirSync(home, { mode: 0o700 });
    // Bob holds the home now (his take wrote his marker and his login).
    expect(
      run({
        home,
        fence: { kind: "take", generation: GEN_B },
        writes: [{ provider: "claude", content: "bob" }],
        removes: [],
      }).status,
    ).toBe(0);
    // Alice's refresh push, issued under her earlier hold, finally runs.
    const late = run({
      home,
      fence: { kind: "held", generation: GEN_A },
      writes: [{ provider: "claude", content: "alice" }],
      removes: [],
    });
    expect(late.status).toBe(HOME_SCRIPT_EXIT.fenced);
    // So does a late first take of hers.
    const lateTake = run({
      home,
      fence: { kind: "take", generation: GEN_A },
      writes: [{ provider: "claude", content: "alice" }],
      removes: [],
    });
    expect(lateTake.status).toBe(HOME_SCRIPT_EXIT.fenced);
    expect(readFileSync(join(home, ".claude/.credentials.json"), "utf8")).toBe("bob");
    expect(marker(home)).toBe(GEN_B);
    // Bob's own pushes still land.
    expect(
      run({
        home,
        fence: { kind: "held", generation: GEN_B },
        writes: [{ provider: "claude", content: "bob-2" }],
        removes: [],
      }).status,
    ).toBe(0);
    expect(readFileSync(join(home, ".claude/.credentials.json"), "utf8")).toBe("bob-2");
  });

  it("releases every login file and the marker, so the home can be taken again", () => {
    const home = join(scratch(), "carol");
    mkdirSync(home);
    run({
      home,
      fence: { kind: "take", generation: GEN_A },
      writes: [
        { provider: "claude", content: "a" },
        { provider: "codex", content: "b" },
      ],
      removes: [],
    });
    const released = run({ home, fence: { kind: "release" }, writes: [], removes: [] });
    expect(released.status, released.stderr).toBe(0);
    for (const file of [HOME_MARKER_FILE, ".claude/.credentials.json", ".codex/auth.json"]) {
      expect(() => lstatSync(join(home, file))).toThrow();
    }
    expect(
      run({
        home,
        fence: { kind: "take", generation: GEN_B },
        writes: [{ provider: "claude", content: "c" }],
        removes: [],
      }).status,
    ).toBe(0);
  });

  it("replaces a link at the file's name instead of writing through it", () => {
    const root = scratch();
    const home = join(root, "bob");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const elsewhere = join(root, "elsewhere.json");
    writeFileSync(elsewhere, "untouched");
    symlinkSync(elsewhere, join(home, ".codex/auth.json"));
    const result = run({
      home,
      fence: { kind: "take", generation: GEN_A },
      writes: [{ provider: "codex", content: '{"tokens":{}}' }],
      removes: [],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(elsewhere, "utf8")).toBe("untouched");
    expect(lstatSync(join(home, ".codex/auth.json")).isSymbolicLink()).toBe(false);
  });

  it.skipIf(uid === 0)("refuses a linked login directory in a home that is not root's", () => {
    const root = scratch();
    const home = join(root, "dave");
    mkdirSync(home);
    mkdirSync(join(root, "someone-else"));
    symlinkSync(join(root, "someone-else"), join(home, ".claude"));
    const result = run({
      home,
      fence: { kind: "take", generation: GEN_A },
      writes: [{ provider: "claude", content: "x" }],
      removes: [],
    });
    expect(result.status).toBe(HOME_SCRIPT_EXIT.linkOnTheWay);
    expect(() => lstatSync(join(root, "someone-else/.credentials.json"))).toThrow();
  });

  it("refuses a home reached through a symbolic link, writing nothing", () => {
    const root = scratch();
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "linked"));
    const result = run({
      home: join(root, "linked"),
      fence: { kind: "take", generation: GEN_A },
      writes: [{ provider: "claude", content: "{}" }],
      removes: [],
    });
    expect(result.status).toBe(HOME_SCRIPT_EXIT.linkOnTheWay);
    expect(() => lstatSync(join(root, "real/.claude"))).toThrow();
  });

  it("refuses a home that does not exist, unless told whose to make", () => {
    const home = join(scratch(), "missing/erin");
    const refused = run({
      home,
      fence: { kind: "take", generation: GEN_A },
      writes: [{ provider: "claude", content: "{}" }],
      removes: [],
    });
    expect(refused.status).toBe(HOME_SCRIPT_EXIT.missing);

    const made = run({
      home,
      fence: { kind: "take", generation: GEN_A },
      createWithOwner: { uid, gid },
      writes: [{ provider: "claude", content: "{}" }],
      removes: [],
    });
    expect(made.status, made.stderr).toBe(0);
    expect(mode(home)).toBe(0o700);
    expect(lstatSync(home).uid).toBe(uid);
    // A parent it had to make stays reachable.
    expect(mode(join(home, ".."))).toBe(0o755);
  });

  it("seeds a home it makes from the skeleton, and keeps the home 0700", () => {
    const root = scratch();
    const skel = join(root, "skel");
    mkdirSync(skel, { mode: 0o755 });
    writeFileSync(join(skel, ".profile"), "# skel");
    const home = join(root, "frank");
    const made = run({
      home,
      skel,
      fence: { kind: "take", generation: GEN_A },
      createWithOwner: { uid, gid },
      writes: [{ provider: "claude", content: "{}" }],
      removes: [],
    });
    expect(made.status, made.stderr).toBe(0);
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe("# skel");
    expect(mode(home)).toBe(0o700);
  });

  it("never puts a payload in the script itself", () => {
    const script = buildHomeCredentialScript({
      home: "/home/m1",
      fence: { kind: "take", generation: GEN_A },
      writes: ["claude"],
      removes: [],
    });
    expect(script).not.toContain("secret-access-token");
    expect(homeScriptStdin(["secret-access-token"])).toBe(
      `${Buffer.from("secret-access-token").toString("base64")}\n`,
    );
  });

  it("refuses to build a script for a path that is not a home", () => {
    expect(() =>
      buildHomeCredentialScript({
        home: "/workspace/repo",
        fence: { kind: "release" },
        writes: [],
        removes: [],
      }),
    ).toThrow(/never under \/workspace/);
  });
});
