/**
 * How a resource instance is lowered to the `docker` CLI: names, labels and argv, as pure
 * functions (golden-tested). The runtime (`docker-resource-runtime.ts`) only runs what these build.
 *
 * Names start `sealres-`, outside the `sealant-` prefix the workspace exit watcher follows. Nothing
 * here removes a volume: there is no `rm -v`, no `volume rm` and no prune anywhere in this module.
 */
import { createHash } from "node:crypto";

import {
  RESOURCE_INSTANCE_ID_PREFIX,
  type ResourceInstanceId,
  type ResourceInstanceReady,
  type ResourceInstanceVolume,
} from "@sealant/api-contracts";
import type { ResourceInstanceRecord, ResourceNetworkKind } from "@sealant/db";

export const RESOURCE_LABELS = {
  instance: "sealant.resource-instance",
  domain: "sealant.resource-domain",
  specDigest: "sealant.resource-spec-digest",
  network: "sealant.resource-network",
} as const;

/** The process limit of every instance: a fork bomb in one never starves the host. */
export const RESOURCE_PIDS_LIMIT = 1024;

/** How long `docker stop` waits after the image's stop signal before it kills the instance. */
export const RESOURCE_STOP_TIMEOUT_SECONDS = 60;

const token = (id: ResourceInstanceId): string =>
  id.slice(RESOURCE_INSTANCE_ID_PREFIX.length).replaceAll("-", "").slice(0, 12);

/** `sealres-<first 12 hex of the uuid>`. */
export const instanceContainerName = (id: ResourceInstanceId): string => `sealres-${token(id)}`;

/** `sealres-<id12>-<volume>`. Core never removes it. */
export const instanceVolumeName = (id: ResourceInstanceId, volume: string): string =>
  `${instanceContainerName(id)}-${volume}`;

/** The instance's own egress network: it reaches out through it, and no other instance is on it. */
export const egressNetworkName = (id: ResourceInstanceId): string =>
  `${instanceContainerName(id)}-egress`;

/** An executor's internal network, which every instance it may reach joins. */
export const reachNetworkName = (executor: string): string => `${executor}-reach`;

/**
 * Every image `VOLUME` no volume of the spec mounts exactly gets a named volume
 * `img-<8 hex of its path>`, so no data ever lands in an anonymous volume that a removal deletes
 * (postgres:18 declares `/var/lib/postgresql`).
 */
export const coverImageVolumes = (
  volumes: ReadonlyArray<ResourceInstanceVolume>,
  imageVolumes: ReadonlyArray<string>,
): ReadonlyArray<ResourceInstanceVolume> => {
  const mounted = new Set(volumes.map((volume) => volume.mountPath));
  const covering = [...new Set(imageVolumes)]
    .filter((path) => !mounted.has(path))
    .toSorted()
    .map((mountPath) => ({
      name: `img-${createHash("sha256").update(mountPath).digest("hex").slice(0, 8)}`,
      mountPath,
    }));
  return [...volumes, ...covering];
};

/** `docker image inspect` of the image's declared `VOLUME`s. */
export const imageVolumesArgv = (image: string): ReadonlyArray<string> => [
  "image",
  "inspect",
  "--format",
  "{{json .Config.Volumes}}",
  image,
];

/** The paths in `imageVolumesArgv`'s output (`{"/path":{}}` or `null`). */
export const parseImageVolumes = (stdout: string): ReadonlyArray<string> => {
  const parsed: unknown = JSON.parse(stdout.trim() || "null");
  return typeof parsed === "object" && parsed !== null ? Object.keys(parsed).toSorted() : [];
};

/** A reach network is internal: it carries no route out, only the executor and its instances. */
export const networkCreateArgv = (
  name: string,
  kind: ResourceNetworkKind,
  subnet: string,
): ReadonlyArray<string> => [
  "network",
  "create",
  "--driver",
  "bridge",
  ...(kind === "reach" ? ["--internal"] : []),
  "--subnet",
  subnet,
  "--label",
  `${RESOURCE_LABELS.network}=${kind}`,
  name,
];

export const volumeCreateArgv = (
  instance: ResourceInstanceRecord,
  volume: ResourceInstanceVolume,
): ReadonlyArray<string> => [
  "volume",
  "create",
  "--label",
  `${RESOURCE_LABELS.instance}=${instance.id}`,
  "--label",
  `${RESOURCE_LABELS.domain}=${instance.resourceDomainId}`,
  instanceVolumeName(instance.id, volume.name),
];

/**
 * `docker run` of an instance on its egress network. `--restart no`: Core restarts it, so the
 * metadata guard goes back in with every start. Capabilities stay Docker's defaults less
 * `NET_RAW`, so a raw socket cannot route past the guard; nothing is added.
 */
export const instanceRunArgv = (
  instance: ResourceInstanceRecord,
  volumes: ReadonlyArray<ResourceInstanceVolume>,
): ReadonlyArray<string> => {
  const { spec } = instance;
  return [
    "run",
    "-d",
    "--name",
    instanceContainerName(instance.id),
    "--hostname",
    spec.alias,
    "--label",
    `${RESOURCE_LABELS.instance}=${instance.id}`,
    "--label",
    `${RESOURCE_LABELS.domain}=${instance.resourceDomainId}`,
    "--label",
    `${RESOURCE_LABELS.specDigest}=${instance.specDigest}`,
    "--restart",
    "no",
    "--stop-timeout",
    String(RESOURCE_STOP_TIMEOUT_SECONDS),
    "--security-opt",
    "no-new-privileges:true",
    "--cap-drop",
    "NET_RAW",
    "--pids-limit",
    String(RESOURCE_PIDS_LIMIT),
    "--memory",
    String(spec.limits.memoryBytes),
    "--cpus",
    String(spec.limits.cpuMillicores / 1000),
    "--network",
    egressNetworkName(instance.id),
    ...volumes.flatMap((volume) => [
      "--mount",
      `type=volume,src=${instanceVolumeName(instance.id, volume.name)},dst=${volume.mountPath}`,
    ]),
    ...Object.entries(spec.env)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    spec.image,
    ...(spec.command ?? []),
  ];
};

/** Join an instance to an executor's reach network under its alias. */
export const connectArgv = (attachment: {
  readonly network: string;
  readonly container: string;
  readonly alias: string;
}): ReadonlyArray<string> => [
  "network",
  "connect",
  "--alias",
  attachment.alias,
  attachment.network,
  attachment.container,
];

export const disconnectArgv = (network: string, container: string): ReadonlyArray<string> => [
  "network",
  "disconnect",
  "--force",
  network,
  container,
];

/** `docker exec -i`: argv reaches the process as its arguments, stdin streams in. */
export const execArgv = (
  container: string,
  command: { readonly argv: ReadonlyArray<string>; readonly user: string | null },
): ReadonlyArray<string> => [
  "exec",
  "-i",
  ...(command.user === null ? [] : ["--user", command.user]),
  container,
  ...command.argv,
];

/**
 * One ready check. `exec` runs in the instance; `tcp` runs the guard image's `nc` in the
 * instance's network namespace, with no capability, so the instance needs no client of its own.
 */
export const probeArgv = (
  container: string,
  ready: ResourceInstanceReady,
  guardImage: string,
): ReadonlyArray<string> =>
  ready.kind === "exec"
    ? ["exec", ...(ready.user === null ? [] : ["--user", ready.user]), container, ...ready.argv]
    : [
        "run",
        "--rm",
        "--network",
        `container:${container}`,
        "--cap-drop",
        "ALL",
        "--user",
        "65534",
        "--entrypoint",
        "nc",
        guardImage,
        "-z",
        "-w",
        "2",
        "127.0.0.1",
        String(ready.port),
      ];
