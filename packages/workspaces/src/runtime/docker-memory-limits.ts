/**
 * Memory limits for Docker workspaces: one for the workspace container
 * (`SEALANT_DOCKER_WORKSPACE_MEMORY_LIMIT`) and one for its Docker service, the `-docker` sidecar
 * whose daemon runs the workspace's own containers (`SEALANT_DOCKER_SERVICE_MEMORY_LIMIT`).
 *
 * Without a limit one workspace's build or test run can take all of the host's memory, and with no
 * swap the host thrashes until nothing on it answers, the control plane included. With one, the
 * kernel stops a process inside that workspace when it reaches the limit, and the host stays up.
 *
 * The two are separate containers, so they get separate limits: Docker can put two containers
 * under one cgroup only through `--cgroup-parent` and a slice the host's init must create, which
 * a worker holding only the Docker socket cannot. A container's limit counts its processes' memory
 * and the page cache they dirty. Swap is held at the same figure (`--memory-swap`), so a workspace
 * at its limit is stopped instead of paging.
 *
 * Each variable is `auto` (the default), `none`, or a size: a whole number of bytes, or a number
 * with a binary unit (`k`, `m`, `g`, `t`, with or without `i` or `b`: `4g`, `4GiB` and `4096m` are
 * the same). `auto` is a share of the Docker host's memory as `docker info` reports it, between a
 * floor and a ceiling (`autoDockerMemoryLimits`).
 */

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

/** Docker refuses a container limit below 6 MiB; anything under this is a typo, not a policy. */
const MIN_LIMIT_BYTES = 64 * MiB;

export type DockerMemorySetting =
  | { readonly kind: "auto" }
  | { readonly kind: "none" }
  | { readonly kind: "bytes"; readonly bytes: number };

/** The two settings an install declares. */
export interface DockerMemoryPolicy {
  readonly workspace: DockerMemorySetting;
  readonly service: DockerMemorySetting;
}

/** What each container runs with, in bytes; `undefined` runs it with no limit. */
export interface DockerMemoryLimits {
  readonly workspace: number | undefined;
  readonly service: number | undefined;
}

export const AUTO_DOCKER_MEMORY_POLICY: DockerMemoryPolicy = {
  workspace: { kind: "auto" },
  service: { kind: "auto" },
};

const UNIT_BYTES: Readonly<Record<string, number>> = {
  "": 1,
  b: 1,
  k: KiB,
  m: MiB,
  g: GiB,
  t: 1024 * GiB,
};

const SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s*([kmgt]?)(?:ib|i|b)?$/i;

/** Read one variable. Throws a sentence naming the variable, for the worker's start. */
export const parseDockerMemorySetting = (
  variable: string,
  raw: string | undefined,
): DockerMemorySetting => {
  const value = raw?.trim() ?? "";
  if (value === "" || value.toLowerCase() === "auto") return { kind: "auto" };
  if (value.toLowerCase() === "none") return { kind: "none" };
  const match = SIZE_PATTERN.exec(value);
  const unit = UNIT_BYTES[(match?.[2] ?? "").toLowerCase()];
  const bytes = match === null || unit === undefined ? NaN : Math.floor(Number(match[1]) * unit);
  if (!Number.isSafeInteger(bytes) || bytes < MIN_LIMIT_BYTES) {
    throw new Error(
      `${variable} must be auto, none, or a size of at least 64m such as 4g or 4096m: ${JSON.stringify(value)}.`,
    );
  }
  return { kind: "bytes", bytes };
};

/** Read both variables from the worker's environment. */
export const parseDockerMemoryPolicy = (env: {
  readonly SEALANT_DOCKER_WORKSPACE_MEMORY_LIMIT?: string | undefined;
  readonly SEALANT_DOCKER_SERVICE_MEMORY_LIMIT?: string | undefined;
}): DockerMemoryPolicy => ({
  workspace: parseDockerMemorySetting(
    "SEALANT_DOCKER_WORKSPACE_MEMORY_LIMIT",
    env.SEALANT_DOCKER_WORKSPACE_MEMORY_LIMIT,
  ),
  service: parseDockerMemorySetting(
    "SEALANT_DOCKER_SERVICE_MEMORY_LIMIT",
    env.SEALANT_DOCKER_SERVICE_MEMORY_LIMIT,
  ),
});

const clamp = (share: number, floor: number, ceiling: number, cap: number): number =>
  Math.floor(Math.min(Math.max(share, floor), ceiling, cap));

/**
 * `auto`, from the Docker host's memory:
 *
 * - the workspace gets half, at least 2 GiB and at most 16 GiB, and never more than three
 *   quarters of the host;
 * - its Docker service gets a quarter, at least 1 GiB and at most 8 GiB, and never more than half.
 *
 * An 8 GiB host gives 4 GiB and 2 GiB, so one session at both limits still leaves a quarter of the
 * host to everything else on it; a 16 GiB host gives 8 and 4; 64 GiB or more gives 16 and 8. The
 * floor keeps a small host usable for a build. The limits are per workspace, not shared: several
 * workspaces together can still exceed the host. Workspace processes are the host's first choice
 * when it must stop something (`WORKSPACE_OOM_SCORE_ADJ`), so that case costs a workspace process
 * rather than the control plane.
 */
export const autoDockerMemoryLimits = (
  hostBytes: number,
): { readonly workspace: number; readonly service: number } => ({
  workspace: clamp(hostBytes / 2, 2 * GiB, 16 * GiB, (hostBytes * 3) / 4),
  service: clamp(hostBytes / 4, 1 * GiB, 8 * GiB, hostBytes / 2),
});

/** One setting's limit, given what `auto` comes to (undefined while the host is unknown). */
const limitOf = (setting: DockerMemorySetting, auto: number | undefined): number | undefined =>
  setting.kind === "bytes" ? setting.bytes : setting.kind === "none" ? undefined : auto;

/** Apply the policy, given the host's memory when either setting is `auto`. */
export const resolveDockerMemoryLimits = (
  policy: DockerMemoryPolicy,
  hostBytes: number | undefined,
): DockerMemoryLimits => {
  const auto = hostBytes === undefined ? undefined : autoDockerMemoryLimits(hostBytes);
  return {
    workspace: limitOf(policy.workspace, auto?.workspace),
    service: limitOf(policy.service, auto?.service),
  };
};

/** Whether resolving the policy needs the host's memory. */
export const dockerMemoryPolicyNeedsHost = (policy: DockerMemoryPolicy): boolean =>
  policy.workspace.kind === "auto" || policy.service.kind === "auto";

/** `docker info --format '{{json .MemTotal}}'`, as a number of bytes; `undefined` otherwise. */
export const parseDockerHostMemory = (stdout: string): number | undefined => {
  const trimmed = stdout.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const bytes = Number(trimmed);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
};

/**
 * Workspace containers and their Docker services are what the host's kernel stops first when the
 * host as a whole runs out (`--oom-score-adj`, from -1000 to 1000; Docker's default is 0, and the
 * control plane's containers keep it). Raising it needs no privilege.
 */
export const WORKSPACE_OOM_SCORE_ADJ = 500;

/** The `docker run` flags for one container's limit. */
export const dockerMemoryArgs = (bytes: number | undefined): readonly string[] => [
  ...(bytes === undefined ? [] : ["--memory", String(bytes), "--memory-swap", String(bytes)]),
  "--oom-score-adj",
  String(WORKSPACE_OOM_SCORE_ADJ),
];

/** A size as a person reads it in a log line: `4 GiB`, `1.5 GiB`, `512 MiB`. */
export const formatMemoryBytes = (bytes: number): string =>
  bytes >= GiB
    ? `${Number((bytes / GiB).toFixed(1))} GiB`
    : `${Number((bytes / MiB).toFixed(0))} MiB`;
