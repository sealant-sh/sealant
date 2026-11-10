import { execFile } from "node:child_process";
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
  it("labels every container, network and volume Core creates with the run", async () => {
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
});
