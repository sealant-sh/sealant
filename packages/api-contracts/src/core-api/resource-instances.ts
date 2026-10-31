/**
 * Resource instances: long-running containers a resource domain (a project) runs, such as a
 * Postgres server, a Redis or a mail catcher, with named volumes that outlive every stop.
 *
 * An instance is addressed by its domain and its `key`, the application's own name for it (Mend:
 * `<definition>` or `<definition>@<worktree>`). Its `alias` is the short name a linked workspace
 * resolves it by (`db`). An instance whose `worktreeKey` is null is reached by every workspace
 * linked to the domain; one with a worktree key only by workspaces linked with that key.
 *
 * The spec has no field for privileged mode, capabilities, host networking, host paths, devices,
 * the Docker socket or shared namespaces, and the decoder names each one it is sent.
 */
import { Result, Schema } from "effect";

import { describeRequestIssue } from "./request-refusal.js";

export const RESOURCE_INSTANCE_ID_PREFIX = "rin:";

const RESOURCE_INSTANCE_ID_PATTERN = new RegExp(
  `^${RESOURCE_INSTANCE_ID_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
);

const matching = (pattern: RegExp, message: string) =>
  Schema.makeFilter((value: string) => (pattern.test(value) ? undefined : message));

export const ResourceInstanceId = Schema.String.check(
  matching(RESOURCE_INSTANCE_ID_PATTERN, "must be a resource instance id (rin:<uuid>)"),
).pipe(Schema.brand("ResourceInstanceId"));
export type ResourceInstanceId = typeof ResourceInstanceId.Type;

export const ResourceInstanceKey = Schema.String.check(
  matching(
    /^[a-z0-9][a-z0-9._@-]{0,127}$/,
    "must be 1 to 128 lower-case letters, digits, '.', '_', '@' or '-', starting with a letter or digit",
  ),
).pipe(Schema.brand("ResourceInstanceKey"));
export type ResourceInstanceKey = typeof ResourceInstanceKey.Type;

/** One DNS label: the name a linked workspace resolves the instance by. */
export const ResourceInstanceAlias = Schema.String.check(
  matching(
    /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/,
    "must be a DNS label: lower-case letters, digits and '-', starting with a letter",
  ),
).pipe(Schema.brand("ResourceInstanceAlias"));
export type ResourceInstanceAlias = typeof ResourceInstanceAlias.Type;

/** The application's opaque name for a worktree: links and worktree instances match on it. */
export const ResourceWorktreeKey = Schema.String.check(
  matching(
    /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/,
    "must be 1 to 128 letters, digits, '.', '_', ':', '@' or '-', starting with a letter or digit",
  ),
).pipe(Schema.brand("ResourceWorktreeKey"));
export type ResourceWorktreeKey = typeof ResourceWorktreeKey.Type;

/** An image pinned by digest (a tag may precede it). Core never resolves a tag. */
export const ResourcePinnedImage = Schema.String.check(
  matching(
    /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/,
    "must be an image pinned by digest (<repository>[:tag]@sha256:<64 hex>)",
  ),
).pipe(Schema.brand("ResourcePinnedImage"));
export type ResourcePinnedImage = typeof ResourcePinnedImage.Type;

const VolumeName = Schema.String.check(
  matching(/^[a-z][a-z0-9-]{0,30}$/, "must be 1 to 31 lower-case letters, digits or '-'"),
);

const isMountPath = (path: string): string | undefined => {
  if (!path.startsWith("/") || path === "/") return "must be an absolute path other than '/'";
  const segments = path.slice(1).split("/");
  if (
    segments.some(
      (segment) => segment === "." || segment === ".." || !/^[A-Za-z0-9._@+-]+$/.test(segment),
    )
  ) {
    return "must be a normalized absolute path";
  }
  if (["/proc", "/sys", "/dev"].some((root) => path === root || path.startsWith(`${root}/`)))
    return "must not be under /proc, /sys or /dev";
  return undefined;
};
const MountPath = Schema.String.check(Schema.makeFilter(isMountPath));

const EnvName = Schema.String.check(
  matching(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "must be an environment variable name"),
);
const withoutNul = Schema.makeFilter((value: string) =>
  value.includes("\u0000") ? "must not contain a NUL byte" : undefined,
);
const EnvValue = Schema.String.check(withoutNul, Schema.isMaxLength(32_768));
const Argument = Schema.String.check(withoutNul);

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));

export const resourceInstanceVolumeSchema = Schema.Struct({
  name: VolumeName,
  mountPath: MountPath,
});
export type ResourceInstanceVolume = typeof resourceInstanceVolumeSchema.Type;

export const resourceInstanceReadySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("tcp"), port: Port }),
  Schema.Struct({
    kind: Schema.Literal("exec"),
    argv: Schema.Array(Argument).check(Schema.isMinLength(1)),
    user: Schema.NullOr(Schema.String.check(matching(/^[A-Za-z0-9._-]{1,64}$/, "must be a user"))),
  }),
]);
export type ResourceInstanceReady = typeof resourceInstanceReadySchema.Type;

/** Ten days: the longest an instance may wait unreached before Core stops it. */
export const RESOURCE_INSTANCE_MAX_IDLE_SECONDS = 864_000;

const distinct =
  <A>(by: (item: A) => string, message: string) =>
  (items: ReadonlyArray<A>) =>
    new Set(items.map(by)).size === items.length ? undefined : message;

/** What an instance runs. Excess keys are refused; see the header for what has no field. */
export const resourceInstanceSpecSchema = Schema.Struct({
  alias: ResourceInstanceAlias,
  /** Null: every workspace linked to the domain reaches it. Set: only links with this key. */
  worktreeKey: Schema.NullOr(ResourceWorktreeKey),
  image: ResourcePinnedImage,
  /** Replaces the image's CMD; its ENTRYPOINT always runs. */
  command: Schema.NullOr(Schema.Array(Argument)),
  env: Schema.Record(EnvName, EnvValue),
  /** Named volumes only. Every image `VOLUME` this does not cover gets a named volume too. */
  volumes: Schema.Array(resourceInstanceVolumeSchema).check(
    Schema.makeFilter(distinct((volume) => volume.name, "volume names must be distinct")),
    Schema.makeFilter(distinct((volume) => volume.mountPath, "mount paths must be distinct")),
    Schema.isMaxLength(16),
  ),
  limits: Schema.Struct({
    cpuMillicores: Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 256_000 })),
    memoryBytes: Schema.Int.check(
      Schema.isBetween({ minimum: 16 * 1024 * 1024, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  }),
  ready: resourceInstanceReadySchema,
  /** Seconds with no live linked executor reaching it before Core stops it. */
  idleStopAfterSeconds: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: RESOURCE_INSTANCE_MAX_IDLE_SECONDS }),
  ),
});
export type ResourceInstanceSpec = typeof resourceInstanceSpecSchema.Type;

export const resourceInstanceStopReasonSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("idle") }),
  /** `by` is the application's words for who stopped it (Mend: a display name). */
  Schema.Struct({
    kind: Schema.Literal("person"),
    by: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
]);
export type ResourceInstanceStopReason = typeof resourceInstanceStopReasonSchema.Type;

/** What Core last observed of an instance, apart from what was asked of it. Times are ISO. */
export const resourceInstanceStateSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("not-started") }),
  Schema.Struct({ kind: Schema.Literal("starting"), since: Schema.String }),
  /** Its ready check answered. */
  Schema.Struct({ kind: Schema.Literal("running"), since: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("stopped"),
    at: Schema.String,
    reason: resourceInstanceStopReasonSchema,
  }),
  /** The container ended on its own; Core starts it again. */
  Schema.Struct({
    kind: Schema.Literal("exited"),
    at: Schema.String,
    exitCode: Schema.NullOr(Schema.Int),
  }),
  /** A start that could not finish: an image pull, a ready check, a volume. */
  Schema.Struct({ kind: Schema.Literal("failed"), at: Schema.String, message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("archived"), at: Schema.String }),
]);
export type ResourceInstanceState = typeof resourceInstanceStateSchema.Type;

const NAMESPACE = "an instance shares no namespace with the host or another container";
const MOUNTS = "an instance mounts named volumes only, never a host path or the Docker socket";
const CAPABILITIES = "Sealant adds no capability to an instance";
const NETWORK = "an instance joins only the networks Sealant gives it, never the host's";

/**
 * What a spec may never ask for, by the names a caller might send it under, each with the sentence
 * the refusal carries. None of them is a field of `resourceInstanceSpecSchema`.
 */
export const FORBIDDEN_RESOURCE_INSTANCE_SPEC_FIELDS: Readonly<Record<string, string>> = {
  privileged: "Sealant never runs an instance privileged",
  capAdd: CAPABILITIES,
  cap_add: CAPABILITIES,
  capabilities: CAPABILITIES,
  network: NETWORK,
  networkMode: NETWORK,
  network_mode: NETWORK,
  hostNetwork: NETWORK,
  binds: MOUNTS,
  bind: MOUNTS,
  mounts: MOUNTS,
  hostPath: MOUNTS,
  dockerSocket: MOUNTS,
  devices: "an instance gets no device",
  pid: NAMESPACE,
  ipc: NAMESPACE,
  uts: NAMESPACE,
  userns: NAMESPACE,
  usernsMode: NAMESPACE,
  securityOpt: "an instance's security options are Sealant's",
  security_opt: "an instance's security options are Sealant's",
};

export interface ResourceInstanceSpecRefusal {
  /** Where the spec is wrong (`privileged`, `volumes[0].mountPath`); never a value it held. */
  readonly field: string;
  readonly reason: string;
}

export type ResourceInstanceSpecDecoding =
  | { readonly kind: "spec"; readonly spec: ResourceInstanceSpec }
  | { readonly kind: "refused"; readonly refusals: ReadonlyArray<ResourceInstanceSpecRefusal> };

const decodeSpec = Schema.decodeUnknownResult(resourceInstanceSpecSchema);

/**
 * A spec from outside: each forbidden field refused by name with its sentence, then the schema's
 * own decode with no excess key allowed.
 */
export const decodeResourceInstanceSpec = (input: unknown): ResourceInstanceSpecDecoding => {
  const forbidden =
    typeof input === "object" && input !== null
      ? Object.keys(input).flatMap((field) =>
          Object.hasOwn(FORBIDDEN_RESOURCE_INSTANCE_SPEC_FIELDS, field)
            ? [{ field, reason: FORBIDDEN_RESOURCE_INSTANCE_SPEC_FIELDS[field] ?? "" }]
            : [],
        )
      : [];
  if (forbidden.length > 0) return { kind: "refused", refusals: forbidden };
  const decoded = decodeSpec(input, { onExcessProperty: "error", errors: "all" });
  return Result.isSuccess(decoded)
    ? { kind: "spec", spec: decoded.success }
    : {
        kind: "refused",
        refusals: [{ field: "spec", reason: describeRequestIssue("spec", decoded.failure.issue) }],
      };
};
