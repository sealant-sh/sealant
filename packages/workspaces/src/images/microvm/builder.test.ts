import type { NewWorkspace } from "@sealant/validators";
import { describe, expect, it } from "vitest";

import { cases } from "../../runtime/docker-runtime-adapter.golden-fixture.js";
import {
  MICROVM_IMAGE_MANAGED_TAG,
  MicrovmImageBuildError,
  MicrovmWorkspaceImageBuilder,
  microvmImageReference,
  parseMicrovmImageReference,
  type MicrovmImageBuildConfig,
} from "./builder.js";
import type {
  MicrovmArtifactStore,
  MicrovmImageApi,
  MicrovmImageCreateInput,
  MicrovmImageDescription,
  MicrovmImageState,
} from "./image-api.js";
import { microvmImageName } from "./recipe.js";

const config: MicrovmImageBuildConfig = {
  baseImageArn: "arn:aws:lambda:eu-central-1:aws:microvm-image:al2023-1",
  buildRoleArn: "arn:aws:iam::123456789012:role/sealant-microvm-build",
  artifactPrefix: "builds/org-a",
  memoryMiB: 4096,
  agentPort: 8080,
  logGroup: "/aws/lambda/microvms/build",
  imageNamePrefix: "sealant-ws",
  maxImages: 3,
  pollIntervalMs: 1,
  buildTimeoutMs: 1_000,
};

const blueprint = (packages: readonly string[]): NewWorkspace => ({
  ...cases.gitSource.blueprint,
  target: { ...cases.gitSource.blueprint.target, os: { family: "fedora", mode: "require" } },
  tooling: {
    ...cases.gitSource.blueprint.tooling,
    packages: packages.map((id) => ({ id })),
  },
});

/** An in-memory account: images settle after `buildPolls` reads, to the state given. */
const fakeAws = (
  settings: { readonly buildPolls?: number; readonly endState?: MicrovmImageState } = {},
) => {
  const images = new Map<string, { description: MicrovmImageDescription; polls: number }>();
  const created: MicrovmImageCreateInput[] = [];
  const deleted: string[] = [];
  const objects = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const api: MicrovmImageApi = {
    getImage: async (name) => {
      const entry = images.get(name);
      if (entry === undefined) return undefined;
      if (entry.description.state === "CREATING") {
        entry.polls += 1;
        if (entry.polls >= (settings.buildPolls ?? 2)) {
          const state = settings.endState ?? "CREATED";
          entry.description = {
            ...entry.description,
            state,
            ...(state === "CREATED" ? { latestActiveImageVersion: "1.0" } : {}),
            ...(state === "CREATE_FAILED" ? { stateReason: "dnf: no package named nope" } : {}),
          };
        }
      }
      return entry.description;
    },
    createImage: async (input) => {
      created.push(input);
      const description: MicrovmImageDescription = {
        imageArn: `arn:aws:lambda:eu-central-1:123456789012:microvm-image:${input.name}`,
        name: input.name,
        state: "CREATING",
        tags: input.tags,
      };
      images.set(input.name, { description, polls: 0 });
      return description;
    },
    deleteImage: async (name) => {
      deleted.push(name);
      return images.delete(name) ? "deleted" : "not-found";
    },
    // As the platform answers: a name filter, and no tags on any item.
    listImages: async (nameContains) =>
      [...images.values()]
        .map((entry) => entry.description)
        .filter((description) => description.name.includes(nameContains))
        .map(({ tags: _tags, ...summary }) => summary),
  };
  const artifacts: MicrovmArtifactStore = {
    put: async (key, bytes) => {
      objects.set(key, bytes);
      return `s3://artifacts/${key}`;
    },
    remove: async (key) => {
      removed.push(key);
      objects.delete(key);
    },
  };
  return { api, artifacts, images, created, deleted, objects, removed };
};

const builderFor = (
  aws: ReturnType<typeof fakeAws>,
  overrides: Partial<MicrovmImageBuildConfig> = {},
) => {
  let id = 0;
  return new MicrovmWorkspaceImageBuilder({
    api: aws.api,
    artifacts: aws.artifacts,
    config: { ...config, ...overrides },
    readAgentFile: async (name) => Buffer.from(`// ${name}\n`),
    sleep: async () => undefined,
    uniqueId: () => `build-${String((id += 1))}`,
  });
};

const build = (builder: MicrovmWorkspaceImageBuilder, spec: NewWorkspace) =>
  builder.buildAndPublish({ spec, repository: "ignored", tag: "ignored", buildId: "job_1" });

describe("MicrovmWorkspaceImageBuilder", () => {
  it("builds the blueprint's recipe with the managed build and publishes the image it made", async () => {
    const aws = fakeAws();
    const builder = builderFor(aws);
    const spec = blueprint(["ripgrep"]);

    const { publishedImage, build: result } = await build(builder, spec);

    const planned = builder.plan(spec);
    const name = microvmImageName(planned.planHash);
    expect(aws.created).toHaveLength(1);
    expect(aws.created[0]).toMatchObject({
      name,
      baseImageArn: config.baseImageArn,
      buildRoleArn: config.buildRoleArn,
      codeArtifactUri: "s3://artifacts/builds/org-a/build-1.zip",
      memoryMiB: 4096,
      agentPort: 8080,
      allOsCapabilities: false,
      clientToken: planned.planHash,
      tags: { [MICROVM_IMAGE_MANAGED_TAG]: "true" },
    });
    expect(publishedImage).toEqual({
      repository: name,
      tag: "1.0",
      reference: `arn:aws:lambda:eu-central-1:123456789012:microvm-image:${name}:1.0`,
      digestReference: `arn:aws:lambda:eu-central-1:123456789012:microvm-image:${name}:1.0`,
      digest: `sha256:${planned.planHash}`,
    });
    expect(result.metadata?.planHash).toBe(planned.planHash);
    expect(builder.isolation).toBe("isolated");
  });

  it("sends the project's OS family and package, and the agent, and nothing of the control plane", async () => {
    const aws = fakeAws();
    let uploaded = "";
    const artifacts: MicrovmArtifactStore = {
      ...aws.artifacts,
      put: async (key, bytes) => {
        uploaded = Buffer.from(bytes).toString("latin1");
        return aws.artifacts.put(key, bytes);
      },
    };
    const builder = new MicrovmWorkspaceImageBuilder({
      api: aws.api,
      artifacts,
      config,
      readAgentFile: async (name) => Buffer.from(`// trusted ${name}\n`),
      sleep: async () => undefined,
    });

    await build(builder, blueprint(["ripgrep"]));

    // Stored, not compressed, so the recipe is readable in the archive.
    expect(uploaded).toContain("FROM public.ecr.aws/docker/library/fedora:");
    expect(uploaded).toContain("ripgrep");
    expect(uploaded).toContain('ENTRYPOINT ["node", "/opt/sealant/agent.mjs"]');
    expect(uploaded).toContain("// trusted agent.mjs");
    expect(uploaded).toContain("// trusted docker-service.mjs");
  });

  it("one recipe is one image: a second workspace with the same plan builds and uploads nothing", async () => {
    const aws = fakeAws();
    const builder = builderFor(aws);
    const spec = blueprint(["ripgrep"]);

    const first = await build(builder, spec);
    const second = await build(builder, spec);

    expect(aws.created).toHaveLength(1);
    expect([...aws.objects.keys()]).toEqual([]);
    expect(aws.removed).toEqual(["builds/org-a/build-1.zip"]);
    expect(second.publishedImage).toEqual(first.publishedImage);
    expect(second.build.metadata?.notes?.[0]).toMatch(/^Reused the MicroVM image/);
  });

  it("a different recipe is a different image", async () => {
    const aws = fakeAws();
    const builder = builderFor(aws);

    const one = await build(builder, blueprint(["ripgrep"]));
    const two = await build(builder, blueprint(["ripgrep", "jq"]));

    expect(aws.created).toHaveLength(2);
    expect(two.publishedImage.repository).not.toBe(one.publishedImage.repository);
  });

  it("waits for a build of the same plan that another job started, and creates nothing", async () => {
    const aws = fakeAws({ buildPolls: 3 });
    const builder = builderFor(aws);
    const spec = blueprint(["ripgrep"]);
    const name = microvmImageName(builder.plan(spec).planHash);
    aws.images.set(name, {
      polls: 0,
      description: {
        imageArn: `arn:aws:lambda:eu-central-1:123456789012:microvm-image:${name}`,
        name,
        state: "CREATING",
      },
    });

    const { publishedImage } = await build(builder, spec);

    expect(aws.created).toHaveLength(0);
    expect(aws.objects.size).toBe(0);
    expect(publishedImage.tag).toBe("1.0");
  });

  it("clears an image whose build failed and builds it again", async () => {
    const aws = fakeAws();
    const builder = builderFor(aws);
    const spec = blueprint(["ripgrep"]);
    const name = microvmImageName(builder.plan(spec).planHash);
    aws.images.set(name, {
      polls: 0,
      description: {
        imageArn: `arn:aws:lambda:eu-central-1:123456789012:microvm-image:${name}`,
        name,
        state: "CREATE_FAILED",
      },
    });

    await build(builder, spec);

    expect(aws.deleted).toEqual([name]);
    expect(aws.created).toHaveLength(1);
  });

  it("refuses past the image cap, saying so, before anything is uploaded", async () => {
    const aws = fakeAws();
    const builder = builderFor(aws, { maxImages: 2 });
    await build(builder, blueprint(["ripgrep"]));
    await build(builder, blueprint(["jq"]));

    await expect(build(builder, blueprint(["tmux"]))).rejects.toMatchObject({
      code: "microvm-image-cap",
      message: expect.stringContaining("already holds 2 MicroVM workspace images"),
    });
    expect(aws.created).toHaveLength(2);
    expect(aws.objects.size).toBe(0);
  });

  it("counts only its own images toward the cap, told by name since a listing carries no tags", async () => {
    const aws = fakeAws();
    const foreign = (name: string) =>
      aws.images.set(name, {
        polls: 0,
        description: {
          imageArn: `arn:aws:lambda:eu-central-1:123456789012:microvm-image:${name}`,
          name,
          state: "CREATED",
          latestActiveImageVersion: "1.0",
        },
      });
    foreign("someone-elses");
    // Another control plane in the same account, under its own prefix.
    foreign(`staging-ws-${"a".repeat(24)}`);
    // The prefix alone is not enough: the rest must be a plan hash.
    foreign("sealant-ws-by-hand");

    await expect(
      build(builderFor(aws, { maxImages: 1 }), blueprint(["ripgrep"])),
    ).resolves.toBeDefined();
    await expect(build(builderFor(aws, { maxImages: 1 }), blueprint(["jq"]))).rejects.toMatchObject(
      { code: "microvm-image-cap" },
    );
    // The other control plane is not held to this one's count.
    const staging = await build(
      builderFor(aws, { maxImages: 2, imageNamePrefix: "staging-ws" }),
      blueprint(["jq"]),
    );
    expect(staging.publishedImage.repository).toMatch(/^staging-ws-[0-9a-f]{24}$/);
  });

  it("reports a failed managed build with the platform's reason, and still deletes the context", async () => {
    const aws = fakeAws({ endState: "CREATE_FAILED" });
    const builder = builderFor(aws);

    await expect(build(builder, blueprint(["ripgrep"]))).rejects.toMatchObject({
      code: "microvm-image-build-failed",
      message: expect.stringContaining("dnf: no package named nope"),
    });
    expect(aws.removed).toEqual(["builds/org-a/build-1.zip"]);
    expect(aws.objects.size).toBe(0);
  });

  it("gives up on a build that never settles, and still deletes the context", async () => {
    const aws = fakeAws({ buildPolls: Number.POSITIVE_INFINITY });
    let clock = 0;
    const builder = new MicrovmWorkspaceImageBuilder({
      api: aws.api,
      artifacts: aws.artifacts,
      config,
      readAgentFile: async () => Buffer.alloc(0),
      sleep: async () => {
        clock += 400;
      },
      now: () => clock,
      uniqueId: () => "build-1",
    });

    await expect(build(builder, blueprint(["ripgrep"]))).rejects.toBeInstanceOf(
      MicrovmImageBuildError,
    );
    expect(aws.removed).toEqual(["builds/org-a/build-1.zip"]);
  });
});

describe("microvmImageReference", () => {
  it("round-trips an image ARN and version", () => {
    const arn = "arn:aws:lambda:eu-central-1:123456789012:microvm-image:sealant-ws-abc123";
    expect(parseMicrovmImageReference(microvmImageReference(arn, "1.0"))).toEqual({
      imageArn: arn,
      imageVersion: "1.0",
    });
  });

  it("refuses a registry reference, so a container image can never be booted as a MicroVM", () => {
    for (const reference of [
      "127.0.0.1:5000/sealant/workspaces/demo:opencode",
      "127.0.0.1:5000/sealant/workspaces/demo@sha256:test",
      "arn:aws:lambda:eu-central-1:123456789012:microvm-image:name",
      "",
    ]) {
      expect(parseMicrovmImageReference(reference)).toBeUndefined();
    }
  });
});
