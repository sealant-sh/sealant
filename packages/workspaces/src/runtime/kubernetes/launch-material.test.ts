import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cases } from "../docker-runtime-adapter.golden-fixture.js";
import { kubernetesRuntimeConfigSchema } from "./config.js";
import {
  createKubernetesLaunchMaterialStager,
  LaunchMaterialTooLargeError,
} from "./launch-material.js";

const withArchives = (bytes: number) => ({
  ...cases.gitSource.blueprint,
  runtime: {
    ...cases.gitSource.blueprint.runtime,
    dotfilesArchives: [{ data: Buffer.alloc(bytes, 7).toString("base64"), bootstrap: true }],
  },
});

describe("Kubernetes launch-material stager", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes the secret env through and stages nothing when the dotfiles fit the Secret", async () => {
    const config = kubernetesRuntimeConfigSchema.parse({
      namespace: "ns",
      volumeMappings: [{ logicalRoot: "/var/lib/mend/store", claimName: "mend-store" }],
      resources: { requests: { cpu: "1", memory: "1Gi" }, limits: { cpu: "1", memory: "1Gi" } },
      certManagerIssuer: { name: "issuer" },
    });
    const stager = createKubernetesLaunchMaterialStager(config);
    const staged = await stager.stage({
      spec: withArchives(1024),
      runId: "run-1",
      secretEnv: { A: "b" },
    });
    expect(staged).toEqual({ secretEnv: { A: "b" } });
    await stager.removeSecretEnv("run-1");
    await stager.removeAll("run-1");
  });

  it("writes oversize dotfiles to the staging claim and returns the logical path", async () => {
    const mount = await mkdtemp(join(tmpdir(), "sealant-staging-"));
    dirs.push(mount);
    const config = kubernetesRuntimeConfigSchema.parse({
      namespace: "ns",
      volumeMappings: [
        { logicalRoot: "/var/lib/mend/store", claimName: "mend-store" },
        { logicalRoot: "/var/lib/sealant/staging", claimName: "staging" },
      ],
      resources: { requests: { cpu: "1", memory: "1Gi" }, limits: { cpu: "1", memory: "1Gi" } },
      certManagerIssuer: { name: "issuer" },
      staging: { logicalRoot: "/var/lib/sealant/staging", mountPath: mount },
      launchSecretBudgetBytes: 64 * 1024,
    });
    const stager = createKubernetesLaunchMaterialStager(config);
    const staged = await stager.stage({ spec: withArchives(100 * 1024), runId: "run-2" });
    expect(staged.dotfilesArchiveDir).toBe("/var/lib/sealant/staging/sealant-dotfiles-run-2");
    const manifest = JSON.parse(
      await readFile(join(mount, "sealant-dotfiles-run-2", "manifest.json"), "utf8"),
    );
    expect(manifest.archives[0]).toEqual({ file: "0.tar.gz", bootstrap: true });
    expect((await stat(join(mount, "sealant-dotfiles-run-2", "0.tar.gz"))).size).toBe(100 * 1024);

    await stager.removeAll("run-2");
    await expect(stat(join(mount, "sealant-dotfiles-run-2"))).rejects.toThrow();
  });

  it("fails readably for oversize dotfiles without a staging claim", async () => {
    const config = kubernetesRuntimeConfigSchema.parse({
      namespace: "ns",
      volumeMappings: [{ logicalRoot: "/var/lib/mend/store", claimName: "mend-store" }],
      resources: { requests: { cpu: "1", memory: "1Gi" }, limits: { cpu: "1", memory: "1Gi" } },
      certManagerIssuer: { name: "issuer" },
      launchSecretBudgetBytes: 64 * 1024,
    });
    const stager = createKubernetesLaunchMaterialStager(config);
    await expect(
      stager.stage({ spec: withArchives(100 * 1024), runId: "run-3" }),
    ).rejects.toBeInstanceOf(LaunchMaterialTooLargeError);
  });
});
