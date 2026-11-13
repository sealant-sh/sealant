import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const wrapper = fileURLToPath(new URL("./bin/docker", import.meta.url));
// `echo` stands in for the real CLI, so the test sees exactly the argv the wrapper passes on.
const env = {
  ...process.env,
  SEALANT_BOAT_HARNESS_REAL_DOCKER: "/bin/echo",
  SEALANT_BOAT_HARNESS_RUN: "abc12345",
};
const docker = async (...args: string[]) => (await run(wrapper, args, { env })).stdout.trim();

describe("bin/docker", () => {
  it("labels every container, network and volume sealant creates with the run", async () => {
    const label = "--label sh.sealant.boat-harness=abc12345";
    expect(await docker("create", "--name", "x", "image")).toBe(`create ${label} --name x image`);
    expect(await docker("run", "-d", "image")).toBe(`run ${label} -d image`);
    expect(await docker("container", "create", "image")).toBe(`container create ${label} image`);
    expect(await docker("network", "create", "--subnet", "10.0.0.0/27", "n")).toBe(
      `network create ${label} --subnet 10.0.0.0/27 n`,
    );
    expect(await docker("volume", "create", "v")).toBe(`volume create ${label} v`);
  });

  it("passes everything else through unchanged", async () => {
    expect(await docker("ps", "-a", "--filter", "label=x")).toBe("ps -a --filter label=x");
    expect(await docker("network", "inspect", "n")).toBe("network inspect n");
  });

  it("refuses global options, so nothing is created unlabelled", async () => {
    await expect(docker("--host", "unix:///x", "run", "image")).rejects.toMatchObject({ code: 97 });
  });

  it("delays a gateway configure only while the delay file exists, and marks that it started", async () => {
    const directory = await mkdtemp(join(tmpdir(), "boat-harness-wrapper-test."));
    const file = join(directory, "configure-delay");
    const delayed = { ...env, SEALANT_BOAT_HARNESS_CONFIGURE_DELAY_FILE: file };
    const configure = ["exec", "-i", "gw", "python3", "gateway.py", "configure"];
    try {
      const started = Date.now();
      await run(wrapper, configure, { env: delayed });
      expect(Date.now() - started).toBeLessThan(800);
      expect(existsSync(`${file}.started`)).toBe(false);
      await writeFile(file, "1");
      const slow = Date.now();
      expect((await run(wrapper, configure, { env: delayed })).stdout.trim()).toBe(
        configure.join(" "),
      );
      expect(Date.now() - slow).toBeGreaterThanOrEqual(900);
      expect(existsSync(`${file}.started`)).toBe(true);
      // Any other exec passes at once.
      const other = Date.now();
      await run(wrapper, ["exec", "gw", "python3", "gateway.py", "status"], { env: delayed });
      expect(Date.now() - other).toBeLessThan(800);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
