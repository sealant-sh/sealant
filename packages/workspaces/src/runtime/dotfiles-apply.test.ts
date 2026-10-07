/**
 * The script that checks a person's user and home and stages their dotfiles archives, run for real
 * by `sh` against temporary directories. A fake `getent` on the PATH answers the passwd entries,
 * and the test's own uid stands in for the person's (its homes are the test's), so nothing needs
 * root; the staging directory lives in a scratch directory instead of `/run/sealant-dotfiles`.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildDotfilesCleanupScript,
  buildDotfilesStageScript,
  DOTFILES_STAGE_EXIT,
  dotfilesStagePath,
  dotfilesStageRefusal,
  dotfilesStageStdin,
  dotfilesUserProblem,
  type DotfilesStageArchive,
} from "./dotfiles-apply.js";

const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A scratch world: homes, a staging directory, and a `getent` that knows `entries`. */
const world = (entries: Readonly<Record<string, string>>) => {
  const root = mkdtempSync(join(tmpdir(), "sealant-dotfiles-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const table = Object.entries(entries)
    .map(([user, line]) => `  ${user}) echo '${line}' ;;`)
    .join("\n");
  writeFileSync(
    join(bin, "getent"),
    `#!/bin/sh\n[ "$1" = passwd ] || exit 2\ncase "$2" in\n${table}\n  *) exit 2 ;;\nesac\n`,
  );
  chmodSync(join(bin, "getent"), 0o755);
  const stage = join(root, "stage");
  const run = (
    input: { readonly user: string; readonly home: string; readonly stageId?: string },
    archives: readonly DotfilesStageArchive[],
    stdinOverride?: string,
  ) =>
    spawnSync(
      "sh",
      [
        "-c",
        buildDotfilesStageScript({
          ...input,
          archiveCount: archives.length,
          stageDir: stage,
          stageOwnerUid: uid,
        }),
      ],
      {
        input: stdinOverride ?? dotfilesStageStdin(archives),
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      },
    );
  return { root, stage, run };
};

const person = (name: string, home: string, ids: { uid: number; gid: number } = { uid, gid }) =>
  `${name}:x:${String(ids.uid)}:${String(ids.gid)}::${home}:/bin/sh`;

const archive = (
  text: string,
  extra: Partial<DotfilesStageArchive> = {},
): DotfilesStageArchive => ({
  data: Buffer.from(text, "utf8").toString("base64"),
  bootstrap: true,
  ...extra,
});

describe("dotfilesUserProblem", () => {
  it("takes a login name or a uid and never root", () => {
    expect(dotfilesUserProblem("m4lice000")).toBeUndefined();
    expect(dotfilesUserProblem("40001")).toBeUndefined();
    expect(dotfilesUserProblem("root")).toMatch(/never applied as root/);
    expect(dotfilesUserProblem("0")).toMatch(/never applied as root/);
    expect(dotfilesUserProblem("000")).toMatch(/never applied as root/);
    expect(dotfilesUserProblem("Bad User")).toMatch(/login name/);
    expect(dotfilesUserProblem("a;rm -rf /")).toMatch(/login name/);
  });

  it("is checked again by the script builder, with the home's rules", () => {
    expect(() =>
      buildDotfilesStageScript({ user: "root", home: "/root", archiveCount: 0 }),
    ).toThrow(/never applied as root/);
    expect(() =>
      buildDotfilesStageScript({ user: "m", home: "/workspace/home/m", archiveCount: 0 }),
    ).toThrow(/never under \/workspace/);
    expect(() => buildDotfilesStageScript({ user: "m", home: "/home/m", archiveCount: 1 })).toThrow(
      /staging id/,
    );
    expect(() =>
      buildDotfilesStageScript({ user: "m", home: "/home/m", stageId: "a", archiveCount: 5 }),
    ).toThrow(/0 to 4 archives/);
  });
});

describe("the stage script", () => {
  it("stages the manifest and each archive, root's only, and keeps no copy of stdin", () => {
    const w = world({});
    const home = join(w.root, "m1");
    mkdirSync(home, { mode: 0o700 });
    const ok = world({ m1: person("m1", home) });
    // The first world made the home; the second knows the user.
    const result = ok.run({ user: "m1", home, stageId: "run_1" }, [
      archive("first-archive-bytes", { manager: "copy" }),
      archive("second", { bootstrap: false, target: "config", bootstrapCommand: "./setup" }),
    ]);
    expect(result.status, result.stderr).toBe(0);
    const dir = join(ok.stage, "run_1");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir).toSorted()).toEqual(["0.tar.gz", "1.tar.gz", "manifest.json"]);
    expect(readFileSync(join(dir, "0.tar.gz"), "utf8")).toBe("first-archive-bytes");
    expect(readFileSync(join(dir, "1.tar.gz"), "utf8")).toBe("second");
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))).toEqual({
      archives: [
        { file: "0.tar.gz", manager: "copy", bootstrap: true },
        { file: "1.tar.gz", target: "config", bootstrap: false, bootstrapCommand: "./setup" },
      ],
    });
  });

  it("checks without staging when only a repository is applied", () => {
    const w = world({});
    const home = join(w.root, "m1");
    mkdirSync(home, { mode: 0o700 });
    const ok = world({ m1: person("m1", home) });
    const result = ok.run({ user: "m1", home }, []);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(ok.stage)).toBe(false);
  });

  it("refuses an unknown user, root by uid or group, and another user's home", () => {
    const w = world({});
    const home = join(w.root, "m1");
    mkdirSync(home, { mode: 0o700 });
    const other = join(w.root, "m2");
    mkdirSync(other, { mode: 0o700 });
    const known = world({
      m1: person("m1", home),
      toor: person("toor", home, { uid: 0, gid: 0 }),
      wheel: person("wheel", home, { uid: 40009, gid: 0 }),
    });
    expect(known.run({ user: "nobody2", home }, []).status).toBe(DOTFILES_STAGE_EXIT.unknownUser);
    expect(known.run({ user: "toor", home }, []).status).toBe(DOTFILES_STAGE_EXIT.rootUser);
    expect(known.run({ user: "wheel", home }, []).status).toBe(DOTFILES_STAGE_EXIT.rootUser);
    // m1's passwd home is `home`: naming m2's directory is refused, nothing staged.
    expect(known.run({ user: "m1", home: other, stageId: "run_2" }, [archive("x")]).status).toBe(
      DOTFILES_STAGE_EXIT.homeMismatch,
    );
    expect(existsSync(join(known.stage, "run_2"))).toBe(false);
  });

  it("refuses a home that is missing or reached through a symbolic link", () => {
    const w = world({});
    const real = join(w.root, "real");
    mkdirSync(real, { mode: 0o700 });
    const linked = join(w.root, "linked");
    symlinkSync(real, linked);
    const missing = join(w.root, "missing");
    const known = world({ ln: person("ln", linked), gone: person("gone", missing) });
    expect(known.run({ user: "ln", home: linked }, []).status).toBe(
      DOTFILES_STAGE_EXIT.homeUnusable,
    );
    expect(known.run({ user: "gone", home: missing }, []).status).toBe(
      DOTFILES_STAGE_EXIT.homeUnusable,
    );
  });

  it("refuses a staging directory that is a link, and a short stdin, leaving nothing staged", () => {
    const w = world({});
    const home = join(w.root, "m1");
    mkdirSync(home, { mode: 0o700 });
    const known = world({ m1: person("m1", home) });
    const short = known.run(
      { user: "m1", home, stageId: "run_3" },
      [archive("a"), archive("b")],
      dotfilesStageStdin([archive("a")]),
    );
    expect(short.status).toBe(DOTFILES_STAGE_EXIT.shortPayload);
    expect(existsSync(join(known.stage, "run_3"))).toBe(false);

    // The short run made the staging directory; a link takes its place.
    rmSync(known.stage, { recursive: true, force: true });
    const elsewhere = join(w.root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, known.stage);
    const linked = known.run({ user: "m1", home, stageId: "run_4" }, [archive("a")]);
    expect(linked.status).toBe(DOTFILES_STAGE_EXIT.stageUnusable);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("removes what a job that never ran left behind an hour ago, and the cleanup removes its own", () => {
    const w = world({});
    const home = join(w.root, "m1");
    mkdirSync(home, { mode: 0o700 });
    const known = world({ m1: person("m1", home) });
    const stale = join(known.stage, "run_old");
    mkdirSync(stale, { recursive: true });
    const anHourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, anHourAgo, anHourAgo);
    expect(known.run({ user: "m1", home, stageId: "run_5" }, [archive("a")]).status).toBe(0);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(known.stage, "run_5"))).toBe(true);

    const cleanup = spawnSync("sh", ["-c", buildDotfilesCleanupScript("run_5", known.stage)]);
    expect(cleanup.status).toBe(0);
    expect(existsSync(join(known.stage, "run_5"))).toBe(false);
    expect(() => dotfilesStagePath("../etc")).toThrow(/staging id/);
  });
});

describe("dotfilesStageRefusal", () => {
  it("names a stable code for every refusal and nothing for success", () => {
    const input = { user: "m1", home: "/home/m1" };
    expect(dotfilesStageRefusal(input, 0)).toBeUndefined();
    expect(dotfilesStageRefusal(input, 1)).toBeUndefined();
    expect(dotfilesStageRefusal(input, DOTFILES_STAGE_EXIT.unknownUser)?.code).toBe("user-unknown");
    expect(dotfilesStageRefusal(input, DOTFILES_STAGE_EXIT.rootUser)?.code).toBe("user-root");
    expect(dotfilesStageRefusal(input, DOTFILES_STAGE_EXIT.homeMismatch)?.code).toBe(
      "home-mismatch",
    );
    expect(dotfilesStageRefusal(input, DOTFILES_STAGE_EXIT.homeUnusable)?.code).toBe(
      "home-unusable",
    );
    expect(dotfilesStageRefusal(input, DOTFILES_STAGE_EXIT.stageUnusable)?.code).toBe(
      "home-unusable",
    );
  });
});
