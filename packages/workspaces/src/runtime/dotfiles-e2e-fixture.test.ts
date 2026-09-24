import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  AUTO_DOTFILES_TREE,
  DOTFILES_PROBE_SCRIPT,
  dotfilesE2eArchives,
  dotfilesProbeFindings,
  EXPECTED_ABSENT,
  EXPECTED_PRESENT,
  packDotfilesArchive,
} from "./dotfiles-e2e-fixture.js";

const execFileAsync = promisify(execFile);

const listArchive = async (base64: string): Promise<string[]> => {
  const dir = await mkdtemp(path.join(tmpdir(), "dotfiles-fixture-test-"));
  try {
    const file = path.join(dir, "archive.tar.gz");
    await writeFile(file, Buffer.from(base64, "base64"));
    const { stdout } = await execFileAsync("tar", ["-tzf", file]);
    return stdout.split("\n").filter((line) => line !== "" && !line.endsWith("/"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** What the probe prints when everything landed as it should. */
const healthyProbe = [
  ...EXPECTED_PRESENT.map((target) => `path ${target}=present`),
  ...EXPECTED_ABSENT.map((target) => `path ${target}=missing`),
  "zshrc=1",
  "gitconfig=1",
  "login-shell=/usr/bin/zsh",
  "exec-home=/root",
  "foreground-home=/root",
].join("\n");

describe("dotfiles e2e fixture", () => {
  it("packs the alpha-shaped tree with its top-level entries and no ./ prefix", async () => {
    const entries = await listArchive(await packDotfilesArchive(AUTO_DOTFILES_TREE));
    expect(entries.toSorted()).toEqual(Object.keys(AUTO_DOTFILES_TREE).toSorted());
  });

  it("orders the auto archive before the copy archive", async () => {
    const archives = await dotfilesE2eArchives();
    expect(archives.map((archive) => archive.manager)).toEqual(["auto", "copy"]);
    expect(await listArchive(archives[1]?.data ?? "")).toEqual([".copy-marker"]);
  });

  it("finds nothing wrong in a healthy probe", () => {
    expect(dotfilesProbeFindings(healthyProbe)).toEqual([]);
  });

  it("names each fact that does not hold, as the stow-for-mixed-trees failure would print it", () => {
    const stowed = healthyProbe
      .replace("path /root/.zshenv=present", "path /root/.zshenv=missing")
      .replace("path /root/.legacyrc=missing", "path /root/.legacyrc=present")
      .replace("exec-home=/root", "exec-home=");
    expect(dotfilesProbeFindings(stowed)).toEqual([
      "/root/.zshenv is missing",
      "/root/.legacyrc exists: a plain directory was stowed into /root",
      "exec-home is '', not /root",
    ]);
  });

  it("probes with a script sh can parse", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dotfiles-fixture-probe-"));
    try {
      const script = path.join(dir, "probe.sh");
      await writeFile(script, DOTFILES_PROBE_SCRIPT);
      await execFileAsync("sh", ["-n", script]);
      expect(await readFile(script, "utf8")).toContain("getent passwd root");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
