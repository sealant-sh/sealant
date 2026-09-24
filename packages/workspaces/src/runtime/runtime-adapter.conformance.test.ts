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
 *
 * A blueprint's dotfiles are part of what a project is too. Each adapter id is also held to a
 * third fact:
 *
 *   3. the dotfiles archives a launch carries (staged by the stager the worker pairs with that
 *      runtime) reach the transport sealantd reads them from, whole, in order, with their managers,
 *      and the daemon is told where to find them.
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { V1Secret } from "@kubernetes/client-node";
import type { NewWorkspace } from "@sealant/validators";
import { afterAll, describe, expect, it, vi } from "vitest";

import { planWorkspaceImageBuild } from "../buildkit/index.js";
import { MicrovmWorkspaceImageBuilder } from "../images/microvm/builder.js";
import type { MicrovmImageDescription } from "../images/microvm/image-api.js";
import { CloudflareRuntimeAdapter } from "./cloudflare/adapter.js";
import { bridgeLaunchRequestSchema } from "./cloudflare/bridge-contract.js";
import { cloudflareRuntimeConfigSchema } from "./cloudflare/config.js";
import { cases, publishedImage } from "./docker-runtime-adapter.golden-fixture.js";
import { DockerRuntimeAdapter } from "./docker-runtime-adapter.js";
import { KubernetesRuntimeAdapter } from "./kubernetes/adapter.js";
import { kubernetesRuntimeConfigSchema } from "./kubernetes/config.js";
import { fakeCluster } from "./kubernetes/fake-cluster.fixture.js";
import { createKubernetesLaunchMaterialStager } from "./kubernetes/launch-material.js";
import {
  buildLaunchSecret,
  buildPod,
  LAUNCH_MOUNT_PATH,
  workspaceLabels,
} from "./kubernetes/manifests.js";
import { workspaceResourceNames } from "./kubernetes/names.js";
import { lowerMountIntents } from "./kubernetes/volumes.js";
import {
  hostDirectoryLaunchMaterialStager,
  removeStagedDotfilesArchives,
  type LaunchMaterialStager,
} from "./launch-material.js";
import { MicrovmRuntimeAdapter } from "./microvm/adapter.js";
import { agentLaunchRequestSchema } from "./microvm/agent-contract.js";
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

// --------------------------------------------------------------------------------------------
// 3. Dotfiles archives reach the runtime's transport.
// --------------------------------------------------------------------------------------------

/** Two archives the way Mend sends them: a repository with `auto`, a home snapshot with `copy`. */
const dotfilesArchives = [
  { bytes: Buffer.from("auto-archive: .config/ .zshenv bin/ legacy/"), manager: "auto" },
  { bytes: Buffer.from("copy-archive: .copy-marker"), manager: "copy" },
] as const;

const dotfilesBlueprint: NewWorkspace = {
  ...customisedBlueprint,
  customization: { ...customisedBlueprint.customization, applyDotfiles: true },
  runtime: {
    ...customisedBlueprint.runtime,
    dotfilesArchives: dotfilesArchives.map((archive) => ({
      data: archive.bytes.toString("base64"),
      manager: archive.manager,
      bootstrap: false,
    })),
  },
};

const DOTFILES_RUN_ID = "run-conformance-dotfiles";

/** What reached the transport, whatever the transport is. */
interface CarriedDotfiles {
  /** Where the daemon is told to read the archives (`SEALANT_DOTFILES_ARCHIVE_DIR`), if here. */
  readonly archiveDir: string | undefined;
  /** `manifest.json` as the daemon will read it. */
  readonly manifest: unknown;
  /** The archive files as the daemon will read them, in manifest order. */
  readonly archives: readonly Buffer[];
}

const stagedHostDirs: string[] = [];

/** Stage as the worker does for a host-directory runtime; the adapter then reads that dir. */
const stageOnHost = async (): Promise<string> => {
  const staged = await hostDirectoryLaunchMaterialStager.stage({
    spec: dotfilesBlueprint,
    runId: DOTFILES_RUN_ID,
  });
  if (staged.dotfilesArchiveDir === undefined) throw new Error("nothing was staged");
  stagedHostDirs.push(staged.dotfilesArchiveDir);
  return staged.dotfilesArchiveDir;
};

const readStagedDir = async (dir: string): Promise<Omit<CarriedDotfiles, "archiveDir">> => {
  const manifest: { archives: Array<{ file: string }> } = JSON.parse(
    await readFile(path.join(dir, "manifest.json"), "utf8"),
  );
  return {
    manifest,
    archives: await Promise.all(
      manifest.archives.map((entry) => readFile(path.join(dir, entry.file))),
    ),
  };
};

/** Inline material (Cloudflare's bridge request, the MicroVM agent's push). */
const readInline = (inline: {
  readonly manifestJson: string;
  readonly archives: ReadonlyArray<{ readonly name: string; readonly contentBase64: string }>;
}): Omit<CarriedDotfiles, "archiveDir"> => {
  const manifest: { archives: Array<{ file: string }> } = JSON.parse(inline.manifestJson);
  return {
    manifest,
    archives: manifest.archives.map((entry) =>
      Buffer.from(
        inline.archives.find((archive) => archive.name === entry.file)?.contentBase64 ?? "",
        "base64",
      ),
    ),
  };
};

const kubernetesCarriedDotfiles = async (adapter: "k8s" | "k3s"): Promise<CarriedDotfiles> => {
  const config = kubernetesRuntimeConfigSchema.parse({
    namespace: "sealant-workspaces",
    volumeMappings: [{ logicalRoot: "/var/lib/mend/store", claimName: "mend-store" }],
    resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "4", memory: "8Gi" } },
    certManagerIssuer: { name: "sealant-internal" },
    readinessTimeoutMs: 2_000,
  });
  const stager: LaunchMaterialStager = createKubernetesLaunchMaterialStager(config);
  const staged = await stager.stage({ spec: dotfilesBlueprint, runId: DOTFILES_RUN_ID });
  const cluster = fakeCluster();
  const secrets: V1Secret[] = [];
  const createSecret = cluster.createSecret;
  const api = {
    ...cluster,
    createSecret: (secret: V1Secret) => {
      secrets.push(secret);
      return createSecret(secret);
    },
  };
  await new KubernetesRuntimeAdapter({
    id: adapter,
    config,
    api,
    clientTls: { caPath: "/tls/ca.crt", certPath: "/tls/tls.crt", keyPath: "/tls/tls.key" },
    controlChannel: { health: async () => undefined, writeCredentialFiles: async () => undefined },
    pollIntervalMs: 1,
  }).launch({
    ...launchInput,
    blueprint: dotfilesBlueprint,
    runId: DOTFILES_RUN_ID,
    ...(staged.dotfilesArchiveDir === undefined
      ? {}
      : { dotfilesArchiveDir: staged.dotfilesArchiveDir }),
  });
  const pod = [...cluster.pods.values()][0];
  const archiveDir = pod?.spec?.containers[0]?.env?.find(
    (entry) => entry.name === "SEALANT_DOTFILES_ARCHIVE_DIR",
  )?.value;
  // Archives this small ride the launch Secret, projected under the launch mount.
  const data = secrets.find((secret) => secret.data?.["dotfiles-manifest"] !== undefined)?.data;
  const manifest: { archives: Array<{ file: string }> } = JSON.parse(
    Buffer.from(data?.["dotfiles-manifest"] ?? "", "base64").toString("utf8"),
  );
  return {
    archiveDir,
    manifest,
    archives: manifest.archives.map((_entry, index) =>
      Buffer.from(data?.[`dotfiles-${index}`] ?? "", "base64"),
    ),
  };
};

const carriedDotfiles: Record<RuntimeAdapterId, () => Promise<CarriedDotfiles>> = {
  docker: async () => {
    const dir = await stageOnHost();
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
    await adapter.launch({
      ...launchInput,
      blueprint: dotfilesBlueprint,
      runId: DOTFILES_RUN_ID,
      dotfilesArchiveDir: dir,
    });
    const run = calls.find((args) => args[0] === "run") ?? [];
    // The staged directory itself is bind-mounted read-only where the daemon reads it.
    const mount = run.find((arg) => arg.includes(dir));
    expect(mount).toMatch(/\/run\/sealant\/dotfiles/);
    expect(mount).toMatch(/readonly|:ro\b/);
    const archiveDir = run
      .find((arg) => arg.startsWith("SEALANT_DOTFILES_ARCHIVE_DIR="))
      ?.slice("SEALANT_DOTFILES_ARCHIVE_DIR=".length);
    return { archiveDir, ...(await readStagedDir(dir)) };
  },
  k8s: () => kubernetesCarriedDotfiles("k8s"),
  k3s: () => kubernetesCarriedDotfiles("k3s"),
  cloudflare: async () => {
    const dir = await stageOnHost();
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
    await adapter.launch({
      ...launchInput,
      blueprint: dotfilesBlueprint,
      runId: DOTFILES_RUN_ID,
      dotfilesArchiveDir: dir,
    });
    const launch = bridgeLaunchRequestSchema.parse(bodies[0]);
    if (launch.dotfiles === undefined) throw new Error("the bridge request carried no dotfiles");
    // The bridge stages the inline material and points the daemon at it itself.
    return { archiveDir: undefined, ...readInline(launch.dotfiles) };
  },
  microvm: async () => {
    const dir = await stageOnHost();
    const config = microvmRuntimeConfigFromEnv({
      SEALANT_MICROVM_REGION: "eu-central-1",
      SEALANT_MICROVM_BUILD_ROLE_ARN: "arn:aws:iam::123456789012:role/sealant-microvm-build",
      SEALANT_MICROVM_ARTIFACT_BUCKET: "sealant-artifacts",
      SEALANT_MICROVM_EXEC_ROLE_ARN: "arn:aws:iam::123456789012:role/sealant-microvm-exec",
      SEALANT_CONTROL_BEARER_TOKEN: "control-token",
    });
    if (config === undefined) throw new Error("the MicroVM runtime is not configured");
    const running = {
      microvmId: "microvm-conformance",
      state: "RUNNING" as const,
      endpoint: "microvm-conformance.lambda-microvm.eu-central-1.on.aws",
    };
    const pushes: unknown[] = [];
    const adapter = new MicrovmRuntimeAdapter({
      config,
      api: {
        runMicrovm: async () => running,
        getMicrovm: async () => running,
        terminateMicrovm: async () => "terminated",
        createAuthToken: async () => "token",
      },
      fetchImpl: (_input, init) => {
        pushes.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
        // The push is what this file reads; the launch need go no further.
        return Promise.resolve(new Response(JSON.stringify({ message: "stop" }), { status: 400 }));
      },
      pollIntervalMs: 1,
    });
    const built = await microvmBuilder().buildAndPublish({
      spec: dotfilesBlueprint,
      repository: "ignored",
      tag: "ignored",
      buildId: "job-conformance-dotfiles",
    });
    await adapter
      .launch({
        ...launchInput,
        blueprint: dotfilesBlueprint,
        runId: DOTFILES_RUN_ID,
        dotfilesArchiveDir: dir,
        publishedImage: built.publishedImage,
      })
      .catch(() => undefined);
    const push = agentLaunchRequestSchema.parse(pushes[0]);
    if (push.dotfiles === undefined) throw new Error("the launch push carried no dotfiles");
    return {
      archiveDir: push.bootEnv["SEALANT_DOTFILES_ARCHIVE_DIR"],
      ...readInline(push.dotfiles),
    };
  },
};

/** Where each runtime tells the daemon to read the archives; the bridge decides for Cloudflare. */
const expectedArchiveDir: Record<RuntimeAdapterId, string | undefined> = {
  docker: "/run/sealant/dotfiles",
  k8s: `${LAUNCH_MOUNT_PATH}/dotfiles`,
  k3s: `${LAUNCH_MOUNT_PATH}/dotfiles`,
  cloudflare: undefined,
  microvm: "/run/sealant/dotfiles",
};

describe("runtime adapter conformance: a blueprint's dotfiles", () => {
  afterAll(async () => {
    await removeStagedDotfilesArchives(DOTFILES_RUN_ID);
    await Promise.all(stagedHostDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("plans the managers the archives need into the image, on every builder", () => {
    const planned = planWorkspaceImageBuild({ blueprint: dotfilesBlueprint });
    expect(planned.containerfile).toMatch(/\bstow\b/);
    expect(planned.containerfile).toMatch(/\bchezmoi\b/);
    const microvm = microvmBuilder().plan(dotfilesBlueprint);
    expect(microvm.containerfile).toMatch(/\bstow\b/);
    expect(microvm.containerfile).toMatch(/\bchezmoi\b/);
  });

  it("has a case for every adapter id", () => {
    expect(Object.keys(carriedDotfiles).toSorted()).toEqual(
      [...runtimeAdapterIdSchema.options].toSorted(),
    );
  });

  for (const adapterId of runtimeAdapterIdSchema.options) {
    it(`${adapterId} carries every archive, in order, with its manager, to the daemon`, async () => {
      const carried = await carriedDotfiles[adapterId]();
      expect(carried.manifest).toEqual({
        archives: [
          { file: "0.tar.gz", manager: "auto", bootstrap: false },
          { file: "1.tar.gz", manager: "copy", bootstrap: false },
        ],
      });
      expect(carried.archives.map((archive) => archive.toString("utf8"))).toEqual(
        dotfilesArchives.map((archive) => archive.bytes.toString("utf8")),
      );
      expect(carried.archiveDir).toBe(expectedArchiveDir[adapterId]);
    });
  }
});
