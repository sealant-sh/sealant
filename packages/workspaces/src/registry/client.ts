import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { selectLoadedImageIdentifier } from "./docker-load-output.js";

const execFileAsync = promisify(execFile);

const contentDigestHeader = "docker-content-digest";

const defaultManifestAccept = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v1+json",
].join(", ");

const parseJsonObject = (value: string): unknown => {
  return JSON.parse(value) as unknown;
};

const expectRecord = (value: unknown, message: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }

  return value as Record<string, unknown>;
};

const expectStringArray = (value: unknown, message: string): Array<string> => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(message);
  }

  return value;
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

const joinRegistryUrl = (baseUrl: URL, path: string): URL => {
  return new URL(path.replace(/^\//, ""), `${baseUrl.toString().replace(/\/?$/, "/")}`);
};

const buildBasicAuthHeader = (username: string, password: string): string => {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
};

export class RegistryClientHttpError extends Error {
  public readonly status: number;

  public readonly url: string;

  public readonly body: string;

  public constructor(message: string, options: { status: number; url: string; body: string }) {
    super(message);
    this.name = "RegistryClientHttpError";
    this.status = options.status;
    this.url = options.url;
    this.body = options.body;
  }
}

export interface RegistryExtension {
  readonly name: string;
  readonly url?: string;
  readonly description?: string;
  readonly endpoints: Array<string>;
}

export interface RegistryManifest {
  readonly digest?: string;
  readonly contentType: string | null;
  readonly body: unknown;
}

/**
 * How a store expects to receive a built image:
 *
 * - `tarball` — an OCI tarball on disk (`docker save` output) that the store `docker load`s first;
 * - `engine` — the image is already present in the Docker Engine the store talks to, named by
 *   `sourceReference`; no tarball is written or read.
 */
export type ImageTransport = "tarball" | "engine";

export interface PublishOciImageInput {
  /** Required for `tarball` transport; ignored when `sourceReference` is already in the Engine. */
  readonly artifactPath?: string;
  readonly repository: string;
  readonly tag: string;
  readonly sourceReference?: string;
}

export interface PublishOciImageResult {
  readonly repository: string;
  readonly tag: string;
  readonly reference: string;
  readonly digestReference: string;
  readonly digest: string;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (command: string, args: Array<string>) => Promise<CommandResult>;

export interface ZotRegistryClientConfig {
  readonly baseUrl: string;
  readonly pushRegistry?: string;
  readonly username?: string;
  readonly password?: string;
  readonly fetch?: typeof fetch;
  readonly commandRunner?: CommandRunner;
}

/**
 * Where workspace images are published to and launched from. Two implementations: an OCI
 * registry (`ZotRegistryClient`, required on Kubernetes where builder and kubelet are different
 * machines) and the local Docker Engine (`LocalDockerImageStore`, the single-host default — the
 * Engine that built the image is the Engine that runs it, so nothing needs to be pushed anywhere).
 */
export interface DeleteImageInput {
  readonly repository: string;
  /** The digest recorded at publish: a registry manifest digest, or an Engine image id. */
  readonly digest: string;
}

/**
 * What became of a delete: `deleted`, `missing` (already gone — a no-op, not a failure), or
 * `in-use` (the Engine store refuses to remove an image a container still references; the
 * retention sweep leaves it for a later pass).
 */
export type DeleteImageOutcome = "deleted" | "missing" | "in-use";

export interface RegistryClient {
  /** Defaults to `tarball` when absent. */
  readonly imageTransport?: ImageTransport;
  ping(): Promise<void>;
  repositoryExists(repository: string): Promise<boolean>;
  listTags(repository: string): Promise<Array<string>>;
  getManifest(repository: string, reference: string): Promise<RegistryManifest | null>;
  headManifest(repository: string, reference: string): Promise<string | null>;
  discoverExtensions(): Promise<Array<RegistryExtension>>;
  publishOciImage(input: PublishOciImageInput): Promise<PublishOciImageResult>;
  /** Removes one published image. Best-effort by contract: callers treat a throw as "left in place". */
  deleteImage(input: DeleteImageInput): Promise<DeleteImageOutcome>;
}

const defaultCommandRunner: CommandRunner = async (command, args) => {
  const result = await execFileAsync(command, args, {
    maxBuffer: 1024 * 1024 * 10,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

export class ZotRegistryClient implements RegistryClient {
  private readonly baseUrl: URL;

  private readonly pushRegistry: string;

  private readonly fetchImpl: typeof fetch;

  private readonly commandRunner: CommandRunner;

  private readonly authorizationHeader?: string;

  public constructor(config: ZotRegistryClientConfig) {
    this.baseUrl = new URL(config.baseUrl);
    this.pushRegistry = config.pushRegistry ?? this.baseUrl.host;
    this.fetchImpl = config.fetch ?? fetch;
    this.commandRunner = config.commandRunner ?? defaultCommandRunner;

    if ((config.username === undefined) !== (config.password === undefined)) {
      throw new Error("Registry username and password must be provided together.");
    }

    if (config.username !== undefined && config.password !== undefined) {
      this.authorizationHeader = buildBasicAuthHeader(config.username, config.password);
    }
  }

  public async ping(): Promise<void> {
    await this.request("/v2/");
  }

  public async repositoryExists(repository: string): Promise<boolean> {
    const response = await this.request(`/v2/${normalizeRepository(repository)}/tags/list`, {
      allowStatusCodes: [404],
    });

    return response.status !== 404;
  }

  public async listTags(repository: string): Promise<Array<string>> {
    const response = await this.request(`/v2/${normalizeRepository(repository)}/tags/list`, {
      allowStatusCodes: [404],
    });

    if (response.status === 404) {
      return [];
    }

    const body = expectRecord(
      parseJsonObject(await response.text()),
      "Expected a tags list object from the registry.",
    );
    const tags = body.tags;

    if (tags === null || tags === undefined) {
      return [];
    }

    return expectStringArray(tags, "Expected the registry to return a string array of tags.");
  }

  public async getManifest(
    repository: string,
    reference: string,
  ): Promise<RegistryManifest | null> {
    const response = await this.request(
      `/v2/${normalizeRepository(repository)}/manifests/${reference}`,
      {
        allowStatusCodes: [404],
        headers: {
          Accept: defaultManifestAccept,
        },
      },
    );

    if (response.status === 404) {
      return null;
    }

    const digest = response.headers.get(contentDigestHeader);

    return {
      ...(digest === null ? {} : { digest }),
      contentType: response.headers.get("content-type"),
      body: parseJsonObject(await response.text()),
    };
  }

  public async headManifest(repository: string, reference: string): Promise<string | null> {
    const response = await this.request(
      `/v2/${normalizeRepository(repository)}/manifests/${reference}`,
      {
        method: "HEAD",
        allowStatusCodes: [404],
        headers: {
          Accept: defaultManifestAccept,
        },
      },
    );

    if (response.status === 404) {
      return null;
    }

    return response.headers.get(contentDigestHeader);
  }

  /**
   * OCI distribution `DELETE /v2/<repository>/manifests/<digest>`: the tag pointing at the manifest
   * goes with it, and the registry's own garbage collection reclaims the blobs. A 404 means the
   * manifest was already gone; a 405 (deletes disabled) surfaces as an error the sweep logs.
   */
  public async deleteImage(input: DeleteImageInput): Promise<DeleteImageOutcome> {
    const repository = normalizeRepository(input.repository);
    const digest = input.digest.trim();
    const response = await this.request(`/v2/${repository}/manifests/${digest}`, {
      method: "DELETE",
      allowStatusCodes: [404],
    });
    // A Docker worker that pushes also keeps the loaded image in its own Engine (the push records
    // the digest on it). Drop that copy too, best-effort: a Kubernetes worker has no Engine and a
    // pull-only host never had the image, and neither outcome changes what the registry holds.
    await this.commandRunner("docker", [
      "image",
      "rm",
      "-f",
      `${this.pushRegistry}/${repository}@${digest}`,
    ]).catch(() => undefined);
    return response.status === 404 ? "missing" : "deleted";
  }

  public async discoverExtensions(): Promise<Array<RegistryExtension>> {
    const response = await this.request("/v2/_oci/ext/discover");
    const body = expectRecord(
      parseJsonObject(await response.text()),
      "Expected an extension discovery object from the registry.",
    );
    const extensions = body.extensions;

    if (!Array.isArray(extensions)) {
      throw new Error("Expected the registry to return an array of extensions.");
    }

    return extensions.map((entry) => {
      const extension = expectRecord(entry, "Expected each extension entry to be an object.");

      const url = this.optionalStringField(extension, "url");
      const description = this.optionalStringField(extension, "description");

      return {
        name: this.expectStringField(extension, "name"),
        ...(url === undefined ? {} : { url }),
        ...(description === undefined ? {} : { description }),
        endpoints: expectStringArray(
          extension.endpoints ?? [],
          "Expected each extension entry to include a string array of endpoints.",
        ),
      };
    });
  }

  public async publishOciImage(input: PublishOciImageInput): Promise<PublishOciImageResult> {
    const repository = normalizeRepository(input.repository);
    const tag = normalizeTag(input.tag);
    const destinationReference = `${this.pushRegistry}/${repository}:${tag}`;

    const sourceIdentifier = await this.resolveSourceIdentifier(input);

    await this.commandRunner("docker", ["tag", sourceIdentifier, destinationReference]);
    await this.commandRunner("docker", ["push", destinationReference]);

    const digest = await this.headManifest(repository, tag);

    if (digest === null) {
      throw new Error(
        `Image ${repository}:${tag} was pushed but no manifest digest could be resolved from the registry.`,
      );
    }

    return {
      repository,
      tag,
      reference: destinationReference,
      digestReference: `${this.pushRegistry}/${repository}@${digest}`,
      digest,
    };
  }

  private async resolveSourceIdentifier(input: PublishOciImageInput): Promise<string> {
    if (input.artifactPath === undefined) {
      if (input.sourceReference === undefined) {
        throw new Error("Publishing an image needs an artifact tarball or a source reference.");
      }
      return input.sourceReference;
    }
    const loadResult = await this.commandRunner("docker", ["load", "-i", input.artifactPath]);
    return selectLoadedImageIdentifier(
      `${loadResult.stdout}\n${loadResult.stderr}`,
      input.sourceReference,
    );
  }

  private async request(
    path: string,
    options?: {
      readonly method?: string;
      readonly allowStatusCodes?: Array<number>;
      readonly headers?: Record<string, string>;
    },
  ): Promise<Response> {
    const url = joinRegistryUrl(this.baseUrl, path);
    const headers = new Headers(options?.headers);

    if (this.authorizationHeader !== undefined) {
      headers.set("Authorization", this.authorizationHeader);
    }

    const response = await this.fetchImpl(url, {
      method: options?.method ?? "GET",
      headers,
    });

    const allowed = new Set(options?.allowStatusCodes ?? []);

    if (!response.ok && !allowed.has(response.status)) {
      const body = await response.text();
      throw new RegistryClientHttpError(`Registry request failed with status ${response.status}.`, {
        status: response.status,
        url: url.toString(),
        body,
      });
    }

    return response;
  }

  private expectStringField(record: Record<string, unknown>, fieldName: string): string {
    const value = record[fieldName];

    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Expected ${fieldName} to be a non-empty string.`);
    }

    return value;
  }

  private optionalStringField(
    record: Record<string, unknown>,
    fieldName: string,
  ): string | undefined {
    const value = record[fieldName];

    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Expected ${fieldName} to be a non-empty string when present.`);
    }

    return value;
  }
}

export const createZotRegistryClient = (config: ZotRegistryClientConfig): ZotRegistryClient => {
  return new ZotRegistryClient(config);
};

export const buildRegistryImageReference = (
  pushRegistry: string,
  repository: string,
  tag: string,
): string => {
  return `${pushRegistry.trim().replace(/\/+$/, "")}/${normalizeRepository(repository)}:${normalizeTag(tag)}`;
};
