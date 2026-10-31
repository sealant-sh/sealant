import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { renderReleaseInstall, WORKSPACE_PACKAGE_CATALOG } from "./package-catalog.js";

const exec = promisify(execFile);

// Exercises the same release installer emitted in managed and custom workspace images, with no
// harness downloads or supervisor boot. Only the public Doppler archive is fetched.
it("runs the pinned Doppler CLI as a non-root workspace user", async () => {
  const release = WORKSPACE_PACKAGE_CATALOG.doppler?.customRelease;
  if (release === undefined) throw new Error("Doppler has no portable release");
  const directory = await mkdtemp(join(tmpdir(), "sealant-doppler-"));
  const image = `sealant-doppler-test:${crypto.randomUUID()}`;
  try {
    await writeFile(
      join(directory, "Dockerfile"),
      [
        "FROM node:26-bookworm",
        renderReleaseInstall(release),
        "USER 1000:1000",
        'CMD ["sh", "-c", "test $(id -u) -ne 0 && doppler --version"]',
      ].join("\n"),
    );
    await exec("docker", ["build", "--pull=false", "-t", image, directory], {
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const result = await exec("docker", ["run", "--rm", "--network", "none", image]);
    expect(result.stdout).toContain(release.version);
  } finally {
    await exec("docker", ["image", "rm", "-f", image]).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}, 240_000);
