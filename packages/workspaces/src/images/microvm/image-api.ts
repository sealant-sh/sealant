/**
 * The slice of AWS the MicroVM image builder uses, behind interfaces so every builder test runs
 * against in-memory fakes and this file is the only one that knows the SDKs.
 *
 *   CreateMicrovmImage  https://docs.aws.amazon.com/lambda/latest/microvm-api/API_CreateMicrovmImage.html
 *   GetMicrovmImage     https://docs.aws.amazon.com/lambda/latest/microvm-api/API_GetMicrovmImage.html
 *   DeleteMicrovmImage  https://docs.aws.amazon.com/lambda/latest/microvm-api/API_DeleteMicrovmImage.html
 *   ListMicrovmImages   https://docs.aws.amazon.com/lambda/latest/microvm-api/API_ListMicrovmImages.html
 *
 * The control plane needs `lambda:CreateMicrovmImage`, `lambda:GetMicrovmImage`,
 * `lambda:DeleteMicrovmImage`, `lambda:ListMicrovmImages`, `iam:PassRole` on the build role, and
 * `s3:PutObject` / `s3:DeleteObject` on the artifacts prefix. The build role itself needs only
 * `s3:GetObject` on that prefix and the two log actions (measured 2026-09-20).
 */
import {
  CreateMicrovmImageCommand,
  DeleteMicrovmImageCommand,
  GetMicrovmImageCommand,
  LambdaMicrovmsClient,
  ListMicrovmImagesCommand,
  type CreateMicrovmImageCommandInput,
} from "@aws-sdk/client-lambda-microvms";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** `MicrovmImageState` as the API enumerates it. */
export type MicrovmImageState =
  | "CREATING"
  | "CREATED"
  | "CREATE_FAILED"
  | "UPDATING"
  | "UPDATED"
  | "UPDATE_FAILED"
  | "DELETING"
  | "DELETE_FAILED";

export interface MicrovmImageDescription {
  readonly imageArn: string;
  readonly name: string;
  readonly state: MicrovmImageState;
  readonly latestActiveImageVersion?: string | undefined;
  readonly stateReason?: string | undefined;
  readonly createdAt?: Date | undefined;
  readonly tags?: Readonly<Record<string, string>> | undefined;
}

/** What the builder decides about an image; everything a tenant must not choose. */
export interface MicrovmImageCreateInput {
  readonly name: string;
  readonly description: string;
  readonly baseImageArn: string;
  readonly buildRoleArn: string;
  /** `s3://bucket/key` of the zipped build context. */
  readonly codeArtifactUri: string;
  readonly memoryMiB: number;
  readonly agentPort: number;
  readonly logGroup?: string | undefined;
  /** The Docker-capable variant asks for the image-level `ALL` OS capability. */
  readonly allOsCapabilities: boolean;
  readonly tags: Readonly<Record<string, string>>;
  /** Idempotency: a redelivered build of the same plan creates one image. */
  readonly clientToken: string;
}

export interface MicrovmImageApi {
  /** Undefined when no image has the name. */
  readonly getImage: (name: string) => Promise<MicrovmImageDescription | undefined>;
  readonly createImage: (input: MicrovmImageCreateInput) => Promise<MicrovmImageDescription>;
  readonly deleteImage: (name: string) => Promise<"deleted" | "not-found">;
  /**
   * Images whose name contains the text. A listing carries no tags, so callers tell their own
   * images by name.
   */
  readonly listImages: (nameContains: string) => Promise<readonly MicrovmImageDescription[]>;
}

/** Where a build context is uploaded for the managed build to read. */
export interface MicrovmArtifactStore {
  /** Returns the `s3://` URI of the stored object. */
  readonly put: (key: string, bytes: Uint8Array) => Promise<string>;
  readonly remove: (key: string) => Promise<void>;
}

const IMAGE_STATES: readonly MicrovmImageState[] = [
  "CREATING",
  "CREATED",
  "CREATE_FAILED",
  "UPDATING",
  "UPDATED",
  "UPDATE_FAILED",
  "DELETING",
  "DELETE_FAILED",
];

const isResourceNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly name?: unknown }).name === "ResourceNotFoundException";

const toDescription = (output: {
  readonly imageArn?: string | undefined;
  readonly name?: string | undefined;
  readonly state?: string | undefined;
  readonly latestActiveImageVersion?: string | undefined;
  readonly stateReason?: string | undefined;
  readonly createdAt?: Date | undefined;
  readonly tags?: Record<string, string> | undefined;
}): MicrovmImageDescription => {
  const state = IMAGE_STATES.find((candidate) => candidate === output.state);
  if (output.imageArn === undefined || output.name === undefined || state === undefined) {
    throw new Error(
      `Lambda MicroVMs answered an image without an ARN, a name or a known state (name ${String(output.name)}, state ${String(output.state)}).`,
    );
  }
  return {
    imageArn: output.imageArn,
    name: output.name,
    state,
    latestActiveImageVersion: output.latestActiveImageVersion,
    stateReason: output.stateReason,
    createdAt: output.createdAt,
    tags: output.tags,
  };
};

export interface LiveMicrovmImageApiOptions {
  readonly region: string;
  /** Test seam / custom endpoints; credentials come from the default provider chain. */
  readonly client?: LambdaMicrovmsClient;
}

/** The hooks every Sealant MicroVM image registers: the agent answers all of them. */
const hooksFor = (agentPort: number): NonNullable<CreateMicrovmImageCommandInput["hooks"]> => ({
  port: agentPort,
  microvmImageHooks: {
    ready: "ENABLED",
    readyTimeoutInSeconds: 300,
    validate: "ENABLED",
    validateTimeoutInSeconds: 300,
  },
  microvmHooks: {
    run: "ENABLED",
    runTimeoutInSeconds: 60,
    resume: "ENABLED",
    resumeTimeoutInSeconds: 60,
    suspend: "ENABLED",
    suspendTimeoutInSeconds: 60,
    terminate: "ENABLED",
    terminateTimeoutInSeconds: 60,
  },
});

export const createLiveMicrovmImageApi = (options: LiveMicrovmImageApiOptions): MicrovmImageApi => {
  const client = options.client ?? new LambdaMicrovmsClient({ region: options.region });
  return {
    getImage: async (name) => {
      try {
        return toDescription(
          await client.send(new GetMicrovmImageCommand({ imageIdentifier: name })),
        );
      } catch (error) {
        if (isResourceNotFound(error)) return undefined;
        throw error;
      }
    },
    createImage: async (input) =>
      toDescription(
        await client.send(
          new CreateMicrovmImageCommand({
            name: input.name,
            description: input.description,
            baseImageArn: input.baseImageArn,
            buildRoleArn: input.buildRoleArn,
            codeArtifact: { uri: input.codeArtifactUri },
            cpuConfigurations: [{ architecture: "ARM_64" }],
            resources: [{ minimumMemoryInMiB: input.memoryMiB }],
            hooks: hooksFor(input.agentPort),
            logging:
              input.logGroup === undefined
                ? { disabled: {} }
                : { cloudWatch: { logGroup: input.logGroup } },
            ...(input.allOsCapabilities ? { additionalOsCapabilities: ["ALL"] } : {}),
            tags: { ...input.tags },
            clientToken: input.clientToken,
          }),
        ),
      ),
    deleteImage: async (name) => {
      try {
        await client.send(new DeleteMicrovmImageCommand({ imageIdentifier: name }));
        return "deleted";
      } catch (error) {
        if (isResourceNotFound(error)) return "not-found";
        throw error;
      }
    },
    listImages: async (nameContains) => {
      const images: MicrovmImageDescription[] = [];
      let nextToken: string | undefined;
      do {
        const page = await client.send(
          new ListMicrovmImagesCommand({
            nameFilter: nameContains,
            ...(nextToken === undefined ? {} : { nextToken }),
          }),
        );
        for (const item of page.items ?? []) images.push(toDescription(item));
        nextToken = page.nextToken;
      } while (nextToken !== undefined);
      return images;
    },
  };
};

export interface S3MicrovmArtifactStoreOptions {
  readonly region: string;
  readonly bucket: string;
  readonly client?: S3Client;
}

export const createS3MicrovmArtifactStore = (
  options: S3MicrovmArtifactStoreOptions,
): MicrovmArtifactStore => {
  const client = options.client ?? new S3Client({ region: options.region });
  return {
    put: async (key, bytes) => {
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          Body: bytes,
          ContentType: "application/zip",
        }),
      );
      return `s3://${options.bucket}/${key}`;
    },
    remove: async (key) => {
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
    },
  };
};
