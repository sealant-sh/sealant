/**
 * Every runtime builds the blueprint's image and boots it
 * (docs/workspace-image-builders-design.md, D1 and D2).
 *
 * A blueprint's operating system and packages are part of what a project is, on every runtime.
 * This file holds each adapter id to two facts, without a daemon, a cluster or a cloud account:
 *
 *   1. the recipe its builder plans starts from the blueprint's OS family and installs its package,
 *      and
 *   2. the launch boots the image that build published, and no other.
 *
 * The cases are keyed by `RuntimeAdapterId`, so adding an id without a case does not compile, and
 * a case that cannot say which image it boots fails here. Live proof stays with each runtime's e2e.
 */
import type { NewWorkspace } from "@sealant/validators";
import { describe, expect, it, vi } from "vitest";

import { planWorkspaceImageBuild } from "../buildkit/index.js";
import { CloudflareRuntimeAdapter } from "./cloudflare/adapter.js";
import { cloudflareRuntimeConfigSchema } from "./cloudflare/config.js";
import { cases, publishedImage } from "./docker-runtime-adapter.golden-fixture.js";
import { DockerRuntimeAdapter } from "./docker-runtime-adapter.js";
import { kubernetesRuntimeConfigSchema } from "./kubernetes/config.js";
import { buildLaunchSecret, buildPod, workspaceLabels } from "./kubernetes/manifests.js";
import { workspaceResourceNames } from "./kubernetes/names.js";
import { lowerMountIntents } from "./kubernetes/volumes.js";
import { buildRunInput } from "./microvm/adapter.js";
import { microvmRuntimeConfigFromEnv } from "./microvm/config.js";
import { collectMountIntents } from "./mount-intent.js";
import { runtimeAdapterIdSchema, type RuntimeAdapterId } from "./runtime-adapter.js";

const PACKAGE = "ripgrep";

/**
 * One blueprint that customises its image: a required OS family and a catalog package. (Setup
 * commands are not part of a blueprint: a control plane runs them inside the live workspace.)
 */
const customisedBlueprint: NewWorkspace = {
  ...cases.gitSource.blueprint,
  target: { ...cases.gitSource.blueprint.target, os: { family: "fedora", mode: "require" } },
  tooling: { ...cases.gitSource.blueprint.tooling, packages: [{ id: PACKAGE }] },
};

const launchInput = { ...cases.gitSource, blueprint: customisedBlueprint, publishedImage };

const kubernetesBootedImage = (adapter: "k8s" | "k3s"): string => {
  const config = kubernetesRuntimeConfigSchema.parse({
    namespace: "sealant-workspaces",
    volumeMappings: [{ logicalRoot: "/var/lib/mend/store", claimName: "mend-store" }],
    resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "4", memory: "8Gi" } },
    certManagerIssuer: { name: "sealant-internal" },
  });
  const runId = launchInput.runId ?? "run-conformance";
  const names = workspaceResourceNames(runId);
  const labels = workspaceLabels(config, { runId, adapter });
  const lowered = lowerMountIntents(
    collectMountIntents({
      blueprint: launchInput.blueprint,
      dotfilesArchiveDir: undefined,
      secretEnvDir: undefined,
    }),
    config.volumeMappings,
  );
  const launchSecret = buildLaunchSecret(names, config.namespace, labels, {
    secretEnvJson: "{}",
    dotfiles: undefined,
  });
  const pod = buildPod({
    names,
    config,
    labels,
    input: launchInput,
    lowered,
    plainEnv: [],
    secretEnvKeys: [],
    launchSecret,
    priorityClassName: undefined,
  });
  return pod.spec?.containers[0]?.image ?? "";
};

/** The image each adapter's launch boots, read from the plan or request it produces. */
const bootedImage: Record<RuntimeAdapterId, () => Promise<string>> = {
  docker: async () => {
    const calls: string[][] = [];
    const adapter = new DockerRuntimeAdapter({
      commandRunner: vi.fn(async (_command: string, args: string[]) => {
        calls.push([...args]);
        if (args[0] === "run") return { stdout: "container-id\n", stderr: "" };
        if (args[0] === "network") return { stdout: "", stderr: "" };
        return {
          stdout: '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n',
          stderr: "",
        };
      }),
      runtimeCatalogLoader: async () => ({ defaultRuntime: "runc", runtimes: new Set(["runc"]) }),
    });
    await adapter.launch(launchInput);
    const run = calls.find((args) => args[0] === "run") ?? [];
    return run.find((arg) => arg === publishedImage.digestReference) ?? run.join(" ");
  },
  k8s: async () => kubernetesBootedImage("k8s"),
  k3s: async () => kubernetesBootedImage("k3s"),
  cloudflare: async () => {
    const bodies: unknown[] = [];
    const adapter = new CloudflareRuntimeAdapter({
      config: cloudflareRuntimeConfigSchema.parse({
        bridgeUrl: "https://bridge.example.com/",
        bridgeToken: "bridge-token",
      }),
      fetchImpl: (_input, init) => {
        bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              resourceId: "do-conformance",
              reference: "cf-conformance",
              status: "ready",
              controlEndpoint: "wss://bridge.example.com/v1/workspaces/do-conformance/control",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      },
    });
    await adapter.launch(launchInput);
    const launch = bodies[0] as { image?: { digestReference?: string } } | undefined;
    return launch?.image?.digestReference ?? "";
  },
  microvm: async () => {
    const config = microvmRuntimeConfigFromEnv({
      SEALANT_MICROVM_REGION: "eu-central-1",
      SEALANT_MICROVM_IMAGE_ARN:
        "arn:aws:lambda:eu-central-1:123456789012:microvm-image:sealant-workspace",
      SEALANT_MICROVM_EXEC_ROLE_ARN: "arn:aws:iam::123456789012:role/sealant-microvm-exec",
      SEALANT_CONTROL_BEARER_TOKEN: "control-token",
    });
    if (config === undefined) throw new Error("the MicroVM runtime is not configured");
    // The run request takes no built image at all today: it names the one registered image.
    return buildRunInput(config, "run-conformance", "launch-secret", { dockerService: "disabled" })
      .imageIdentifier;
  },
};

/**
 * Adapters that do not yet boot the image built from the blueprint. `it.fails` passes while the
 * assertion fails and FAILS once it holds, so the entry must be deleted with the fix.
 *
 * microvm: boots `SEALANT_MICROVM_IMAGE_ARN`, one hand-registered image, so a blueprint's OS
 * family, base image and packages do nothing there. Fixed by the MicroVM builder (design D4).
 */
const NOT_YET_CONFORMING: ReadonlySet<RuntimeAdapterId> = new Set(["microvm"]);

describe("runtime adapter conformance: a blueprint's image customisation", () => {
  it("the recipe planned for the build starts from the OS family and installs the package", () => {
    // One planner serves every registered builder today. When a runtime gains a builder with a
    // recipe of its own (MicroVM, D4), that builder's plan is asserted here as well.
    const planned = planWorkspaceImageBuild({ blueprint: customisedBlueprint });
    expect(planned.osFamily).toBe("fedora");
    expect(planned.containerfile).toMatch(/^FROM fedora:/m);
    expect(planned.containerfile).toContain(PACKAGE);
  });

  it("has a case for every adapter id, and no case for an id that does not exist", () => {
    expect(Object.keys(bootedImage).toSorted()).toEqual(
      [...runtimeAdapterIdSchema.options].toSorted(),
    );
  });

  for (const adapterId of runtimeAdapterIdSchema.options) {
    const check = NOT_YET_CONFORMING.has(adapterId) ? it.fails : it;
    check(`${adapterId} boots the image the build published`, async () => {
      expect(await bootedImage[adapterId]()).toBe(publishedImage.digestReference);
    });
  }
});
