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
 * a case that cannot say which image it boots fails here. A runtime that boots no container image
 * (MicroVM) builds with its own builder here, and is held to the same two facts. Live proof stays
 * with each runtime's e2e.
 */
import type { NewWorkspace } from "@sealant/validators";
import { describe, expect, it, vi } from "vitest";

import { planWorkspaceImageBuild } from "../buildkit/index.js";
import { MicrovmWorkspaceImageBuilder } from "../images/microvm/builder.js";
import type { MicrovmImageDescription } from "../images/microvm/image-api.js";
import { CloudflareRuntimeAdapter } from "./cloudflare/adapter.js";
import { cloudflareRuntimeConfigSchema } from "./cloudflare/config.js";
import { cases, publishedImage } from "./docker-runtime-adapter.golden-fixture.js";
import { DockerRuntimeAdapter } from "./docker-runtime-adapter.js";
import { kubernetesRuntimeConfigSchema } from "./kubernetes/config.js";
import { buildLaunchSecret, buildPod, workspaceLabels } from "./kubernetes/manifests.js";
import { workspaceResourceNames } from "./kubernetes/names.js";
import { lowerMountIntents } from "./kubernetes/volumes.js";
import { MicrovmRuntimeAdapter } from "./microvm/adapter.js";
import type { MicrovmRunInput } from "./microvm/api.js";
import { microvmRuntimeConfigFromEnv } from "./microvm/config.js";
import { microvmImageReference } from "./microvm/image-reference.js";
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

/** A MicroVM builder over an in-memory account: a created image is built at the next read. */
const microvmBuilder = (): MicrovmWorkspaceImageBuilder => {
  const images = new Map<string, MicrovmImageDescription>();
  return new MicrovmWorkspaceImageBuilder({
    api: {
      getImage: async (name) => images.get(name),
      createImage: async (input) => {
        const created: MicrovmImageDescription = {
          imageArn: `arn:aws:lambda:eu-central-1:123456789012:microvm-image:${input.name}`,
          name: input.name,
          state: "CREATED",
          latestActiveImageVersion: "1.0",
        };
        images.set(input.name, created);
        return created;
      },
      deleteImage: async (name) => (images.delete(name) ? "deleted" : "not-found"),
      listImages: async (nameContains) =>
        [...images.values()].filter((image) => image.name.includes(nameContains)),
    },
    artifacts: { put: async (key) => `s3://artifacts/${key}`, remove: async () => undefined },
    config: {
      baseImageArn: "arn:aws:lambda:eu-central-1:aws:microvm-image:al2023-1",
      buildRoleArn: "arn:aws:iam::123456789012:role/sealant-microvm-build",
      artifactPrefix: "sealant/workspace-images",
      memoryMiB: 4096,
      agentPort: 8080,
      imageNamePrefix: "sealant-ws",
      dockerService: false,
      maxImages: 50,
      pollIntervalMs: 1,
      buildTimeoutMs: 1_000,
    },
    readContextFile: async () => Buffer.alloc(0),
    contextDigest: "0".repeat(64),
    sleep: async () => undefined,
  });
};

interface BuiltAndBooted {
  /** What the runtime's build published for the blueprint. */
  readonly published: string;
  /** What the launch booted, read from the plan or request it produced. */
  readonly booted: string;
}

const bootedImage: Record<RuntimeAdapterId, () => Promise<BuiltAndBooted>> = {
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
    return {
      published: publishedImage.digestReference,
      booted: run.find((arg) => arg === publishedImage.digestReference) ?? run.join(" "),
    };
  },
  k8s: async () => ({
    published: publishedImage.digestReference,
    booted: kubernetesBootedImage("k8s"),
  }),
  k3s: async () => ({
    published: publishedImage.digestReference,
    booted: kubernetesBootedImage("k3s"),
  }),
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
    return {
      published: publishedImage.digestReference,
      booted: launch?.image?.digestReference ?? "",
    };
  },
  microvm: async () => {
    const config = microvmRuntimeConfigFromEnv({
      SEALANT_MICROVM_REGION: "eu-central-1",
      SEALANT_MICROVM_BUILD_ROLE_ARN: "arn:aws:iam::123456789012:role/sealant-microvm-build",
      SEALANT_MICROVM_ARTIFACT_BUCKET: "sealant-artifacts",
      SEALANT_MICROVM_EXEC_ROLE_ARN: "arn:aws:iam::123456789012:role/sealant-microvm-exec",
      SEALANT_CONTROL_BEARER_TOKEN: "control-token",
    });
    if (config === undefined) throw new Error("the MicroVM runtime is not configured");
    const runs: MicrovmRunInput[] = [];
    const adapter = new MicrovmRuntimeAdapter({
      config,
      api: {
        runMicrovm: async (input) => {
          runs.push(input);
          // The request is what this file reads; the launch need go no further.
          throw new Error("stop after RunMicrovm");
        },
        getMicrovm: async () => undefined,
        terminateMicrovm: async () => "not-found",
        createAuthToken: async () => "token",
      },
    });
    // A MicroVM boots no container image, so this case builds with the MicroVM builder.
    const built = await microvmBuilder().buildAndPublish({
      spec: customisedBlueprint,
      repository: "ignored",
      tag: "ignored",
      buildId: "job-conformance",
    });
    await adapter
      .launch({ ...launchInput, publishedImage: built.publishedImage })
      .catch(() => undefined);
    const run = runs[0];
    return {
      published: built.publishedImage.digestReference,
      booted:
        run === undefined ? "" : microvmImageReference(run.imageIdentifier, run.imageVersion ?? ""),
    };
  },
};

describe("runtime adapter conformance: a blueprint's image customisation", () => {
  it("the recipe planned for the build starts from the OS family and installs the package", () => {
    // The Docker, Kubernetes and Cloudflare builders build this plan as it is. The MicroVM
    // builder has a recipe of its own on top of it, held to the same two facts.
    const planned = planWorkspaceImageBuild({ blueprint: customisedBlueprint });
    expect(planned.osFamily).toBe("fedora");
    expect(planned.containerfile).toMatch(/^FROM fedora:/m);
    expect(planned.containerfile).toContain(PACKAGE);

    const microvm = microvmBuilder().plan(customisedBlueprint);
    expect(microvm.osFamily).toBe("fedora");
    expect(microvm.containerfile).toMatch(/^FROM public\.ecr\.aws\/docker\/library\/fedora:/m);
    expect(microvm.containerfile).toContain(PACKAGE);
  });

  it("has a case for every adapter id, and no case for an id that does not exist", () => {
    expect(Object.keys(bootedImage).toSorted()).toEqual(
      [...runtimeAdapterIdSchema.options].toSorted(),
    );
  });

  for (const adapterId of runtimeAdapterIdSchema.options) {
    it(`${adapterId} boots the image the build published`, async () => {
      const { published, booted } = await bootedImage[adapterId]();
      expect(published).not.toBe("");
      expect(booted).toBe(published);
    });
  }
});
