import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { boatGuestPublicCommand } from "./execution.js";

const run = promisify(execFile);

it("the default provider user enters the real pinned bootstrap as the outer root owner", async () => {
  const imageFile = process.env.SEALANT_BOAT_GUEST_TEST_IMAGE_FILE;
  if (imageFile === undefined) throw new Error("SEALANT_BOAT_GUEST_TEST_IMAGE_FILE is required");
  const image = (await readFile(imageFile, "utf8")).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("invalid guest fixture image");
  const name = `boat-public-command-${randomUUID()}`;
  const containers = new Set<string>();
  const invoke = async (caseName: string, command: string) => {
    containers.add(caseName);
    return run(
      "docker",
      [
        "run",
        "--name",
        caseName,
        "--label",
        "sealant-dev=boat-stream",
        "--user",
        "ubuntu",
        "--entrypoint",
        "/bin/sh",
        image,
        "-c",
        command + ' 2>&1; result=$?; test "$result" -eq 1',
      ],
      { timeout: 15_000 },
    );
  };
  try {
    // An invalid public request stops immediately after entering the real bind helper. The old
    // command instead fails the root gate, matching Run 7 on Boat's default `user` account.
    const old = await invoke(
      name + "-old",
      boatGuestPublicCommand("bind", {}).replace("/usr/bin/sudo -n -- ", ""),
    );
    expect(old.stdout).toContain("ValueError: outer-owner-required");
    const result = await invoke(name, boatGuestPublicCommand("bind", {}));
    expect(result.stdout).toContain("guest_receiver.Refusal: invalid-request");
    expect(result.stdout).not.toContain("outer-owner-required");
    expect(result.stdout).not.toContain("Permission denied");
  } finally {
    for (const owned of containers) await run("docker", ["rm", "--force", owned]);
  }
});
