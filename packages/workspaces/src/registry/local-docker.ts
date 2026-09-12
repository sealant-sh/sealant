/**
 * The single-host image store: the Docker Engine the worker builds on IS the Engine workspaces run
 * on, so a built image only needs a stable tag there. No registry process, no push/pull, no
 * loopback port, and no tarball round-trip.
 *
 * Implements the same contract as the registry client so the build pipeline, the plan-hash reuse
 * check, and the `/v1/registries` routes stay unchanged. "Digests" here are Engine image ids
 * (`sha256:…`): content-addressed, immutable, and accepted by `docker run` directly, so a launch
 * pins the exact image even if the tag moves later.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  CommandRunner,
  DeleteImageInput,
  DeleteImageOutcome,
  PublishOciImageInput,
  PublishOciImageResult,
  RegistryClient,
  RegistryExtension,
  RegistryManifest,
} from "./client.js";
import { selectLoadedImageIdentifier } from "./docker-load-output.js";

const execFileAsync = promisify(execFile);

const defaultCommandRunner: CommandRunner = async (command, args) => {
  const result = await execFileAsync(command, args, { maxBuffer: 1024 * 1024 * 10 });
  return { stdout: result.stdout, stderr: result.stderr };
};

const normalizeRepository = (repository: string): string => {
  const trimmed = repository.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed.length === 0) {
    throw new Error("Repository names must not be empty.");
  }
  return trimmed;
};

const normalizeTag = (tag: string): string => {
  const trimmed = tag.trim();
  if (trimmed.length === 0) {
    throw new Error("Image tags must not be empty.");
  }
  return trimmed;
};

const isMissingImageError = (error: unknown): boolean =>
  error instanceof Error && /no such image|no such object/i.test(error.message);

/** `docker image rm` refusing because a container (running or stopped) still references the image. */
const isImageInUseError = (error: unknown): boolean =>
  error instanceof Error &&
  /is being used by|is using its referenced image|conflict/i.test(error.message);

export interface LocalDockerImageStoreConfig {
  readonly commandRunner?: CommandRunner;
}

export class LocalDockerImageStore implements RegistryClient {
  public readonly imageTransport = "engine" as const;

  private readonly commandRunner: CommandRunner;

  public constructor(config: LocalDockerImageStoreConfig = {}) {
    this.commandRunner = config.commandRunner ?? defaultCommandRunner;
  }

  public async ping(): Promise<void> {
    await this.commandRunner("docker", ["version", "--format", "{{.Server.Version}}"]);
  }

  public async repositoryExists(repository: string): Promise<boolean> {
    const tags = await this.listTags(repository);
    return tags.length > 0;
  }

  public async listTags(repository: string): Promise<Array<string>> {
    const normalized = normalizeRepository(repository);
    const result = await this.commandRunner("docker", [
      "image",
      "ls",
      "--format",
      "{{.Repository}}\t{{.Tag}}",
      "--filter",
      `reference=${normalized}`,
    ]);
    return result.stdout
      .split("\n")
      .map((line) => line.split("\t"))
      .filter(([name, tag]) => name === normalized && tag !== undefined && tag !== "<none>")
      .map(([, tag]) => tag as string);
  }

  public async getManifest(
    repository: string,
    reference: string,
  ): Promise<RegistryManifest | null> {
    const imageReference = this.imageReference(repository, reference);
    try {
      const result = await this.commandRunner("docker", ["image", "inspect", imageReference]);
      const [inspected] = JSON.parse(result.stdout) as Array<{ readonly Id?: string }>;
      return {
        ...(typeof inspected?.Id === "string" ? { digest: inspected.Id } : {}),
        contentType: "application/vnd.docker.engine.image.inspect+json",
        body: inspected ?? null,
      };
    } catch (error) {
      if (isMissingImageError(error)) {
        return null;
      }
      throw error;
    }
  }

  public async headManifest(repository: string, reference: string): Promise<string | null> {
    return this.inspectImageId(this.imageReference(repository, reference));
  }

  public async discoverExtensions(): Promise<Array<RegistryExtension>> {
    return [];
  }

  /**
   * `docker image rm -f <image id>`: every tag on the id goes (the plan tag, and any legacy
   * `<name>:sdk-<random>` tag from before plan-keyed coordinates), and the layers no other image
   * shares are freed. The Engine refuses while a container references the image, which is the
   * retention sweep's safety net against deleting under a launch it did not see.
   */
  public async deleteImage(input: DeleteImageInput): Promise<DeleteImageOutcome> {
    const digest = input.digest.trim();
    if (!digest.startsWith("sha256:")) {
      throw new Error(`Engine image deletes take an image id (sha256:…), got '${digest}'.`);
    }
    try {
      await this.commandRunner("docker", ["image", "rm", "-f", digest]);
      return "deleted";
    } catch (error) {
      if (isMissingImageError(error)) return "missing";
      if (isImageInUseError(error)) return "in-use";
      throw error;
    }
  }

  public async publishOciImage(input: PublishOciImageInput): Promise<PublishOciImageResult> {
    const repository = normalizeRepository(input.repository);
    const tag = normalizeTag(input.tag);
    const reference = `${repository}:${tag}`;

    const sourceIdentifier = await this.resolveSourceIdentifier(input);
    await this.commandRunner("docker", ["tag", sourceIdentifier, reference]);

    const digest = await this.inspectImageId(reference);
    if (digest === null) {
      throw new Error(`Image ${reference} was tagged but the Docker Engine cannot inspect it.`);
    }

    return { repository, tag, reference, digestReference: digest, digest };
  }

  private async resolveSourceIdentifier(input: PublishOciImageInput): Promise<string> {
    if (input.sourceReference !== undefined) {
      return input.sourceReference;
    }
    if (input.artifactPath === undefined) {
      throw new Error("Publishing an image needs an artifact tarball or a source reference.");
    }
    const loadResult = await this.commandRunner("docker", ["load", "-i", input.artifactPath]);
    return selectLoadedImageIdentifier(`${loadResult.stdout}\n${loadResult.stderr}`);
  }

  private imageReference(repository: string, reference: string): string {
    const normalized = normalizeRepository(repository);
    const trimmed = reference.trim();
    return trimmed.startsWith("sha256:") ? trimmed : `${normalized}:${normalizeTag(trimmed)}`;
  }

  private async inspectImageId(imageReference: string): Promise<string | null> {
    try {
      const result = await this.commandRunner("docker", [
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        imageReference,
      ]);
      const id = result.stdout.trim();
      return id.length === 0 ? null : id;
    } catch (error) {
      if (isMissingImageError(error)) {
        return null;
      }
      throw error;
    }
  }
}

export const createLocalDockerImageStore = (
  config: LocalDockerImageStoreConfig = {},
): LocalDockerImageStore => new LocalDockerImageStore(config);
