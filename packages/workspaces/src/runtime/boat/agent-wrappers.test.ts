import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

const BOAT_HOST = fileURLToPath(new URL("../../../microvm-image/boat-host.mjs", import.meta.url));

/** The command the Boat host starts sealantd with, as the agent spawns it. */
const daemonCommand = (env: Record<string, string>) =>
  z.array(z.string()).parse(
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { createBoatHost } from ${JSON.stringify(BOAT_HOST)};
             const host = createBoatHost({ env: JSON.parse(process.env.HOST_ENV), log() {} });
             console.log(JSON.stringify(host.daemonCommand("/usr/local/bin/sealantd", ["boot"])));`,
        ],
        { env: { ...process.env, HOST_ENV: JSON.stringify(env) }, encoding: "utf8" },
      ),
    ),
  );

describe("the Boat host's sealantd wrappers", () => {
  it("run Ubuntu's systemd-run and unshare by absolute path, whatever sealantd's PATH (SLNT-786)", () => {
    // The agent spawns this with sealantd's environment; a Nix launch puts the Nix profile first
    // on that PATH, so a bare name would run a systemd or util-linux the environment installed.
    const command = daemonCommand({});
    expect(command[0]).toBe("/usr/bin/systemd-run");
    expect(command[command.indexOf("--") + 1]).toBe("/usr/bin/unshare");
    expect(command.slice(-2)).toEqual(["/usr/local/bin/sealantd", "boot"]);
  });
  it("keeps the test overrides", () => {
    const command = daemonCommand({
      SEALANT_AGENT_SYSTEMD_RUN: "/tmp/fake/systemd-run",
      SEALANT_AGENT_UNSHARE: "/tmp/fake/unshare",
    });
    expect(command[0]).toBe("/tmp/fake/systemd-run");
    expect(command[command.indexOf("--") + 1]).toBe("/tmp/fake/unshare");
  });
});
