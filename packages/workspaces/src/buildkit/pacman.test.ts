/**
 * The pacman transaction as the package layer runs it (sh), on the arm64 image's own mirrorlist.
 * `pacman` is a stand-in that records the first `Server` it would use and fails while that
 * server is one the test marks as stalled, as pacman fails when that mirror stalls on a signature.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ARCHLINUXARM_MIRRORLIST } from "./archlinuxarm.js";
import { renderPacmanWithMirrorFallback } from "./pacman.js";

const TRANSACTION = "pacman -Syu --noconfirm && pacman -S --noconfirm --needed git";

let work = "";
const mirrorlist = (): string => join(work, "etc", "mirrorlist");

/** The stand-in fails while the first server's host is one of `stalled`. */
const standIn = async (stalled: readonly string[]): Promise<void> => {
  await writeFile(
    join(work, "bin", "pacman"),
    [
      "#!/bin/sh",
      `first=$(grep -m1 '^Server' '${mirrorlist()}' | sed 's|^Server = http://||; s|/.*||')`,
      `echo "$1 $first" >> '${join(work, "calls")}'`,
      `case " ${stalled.join(" ")} " in *" $first "*) exit 1;; esac`,
    ].join("\n"),
  );
  await chmod(join(work, "bin", "pacman"), 0o755);
};

const run = (): Promise<{ readonly code: number; readonly output: string }> =>
  new Promise((resolve) => {
    execFile(
      "sh",
      ["-c", renderPacmanWithMirrorFallback(TRANSACTION, { mirrorlist: mirrorlist() })],
      { env: { ...process.env, PATH: `${join(work, "bin")}:${process.env.PATH ?? ""}` } },
      (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : Number(error.code ?? 1), output: stdout + stderr });
      },
    );
  });

const calls = async (): Promise<readonly string[]> =>
  (await readFile(join(work, "calls"), "utf8")).trimEnd().split("\n");

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "sealant-pacman-"));
  await mkdir(join(work, "bin"));
  await mkdir(join(work, "etc"));
  await writeFile(mirrorlist(), ARCHLINUXARM_MIRRORLIST);
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("a pacman transaction in an Arch image build", () => {
  it("runs again from the next mirror when the first stalls, and leaves the mirrorlist as it was", async () => {
    await standIn(["dk.mirror.archlinuxarm.org"]);

    const { code, output } = await run();

    expect(code, output).toBe(0);
    expect(await calls()).toEqual([
      "-Syu dk.mirror.archlinuxarm.org",
      "-Syu de4.mirror.archlinuxarm.org",
      "-S de4.mirror.archlinuxarm.org",
    ]);
    expect(await readFile(mirrorlist(), "utf8")).toBe(ARCHLINUXARM_MIRRORLIST);
    expect(await readdir(join(work, "etc"))).toEqual(["mirrorlist"]);
  });

  it("fails the build once every attempt has failed, each from a different first mirror", async () => {
    await standIn([
      "dk.mirror.archlinuxarm.org",
      "de4.mirror.archlinuxarm.org",
      "hu.mirror.archlinuxarm.org",
    ]);

    const { code, output } = await run();

    expect(code).toBe(1);
    expect(output).toContain("pacman failed 3 times");
    expect(await calls()).toEqual([
      "-Syu dk.mirror.archlinuxarm.org",
      "-Syu de4.mirror.archlinuxarm.org",
      "-Syu hu.mirror.archlinuxarm.org",
    ]);
  });
});
