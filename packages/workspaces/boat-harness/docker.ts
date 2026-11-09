import { spawn } from "node:child_process";

/** Every container, network, volume and image the harness creates carries this label. */
export const HARNESS_LABEL = "sh.sealant.boat-harness";

export interface DockerResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Runs one docker CLI command. Never throws for a non-zero exit; callers decide. */
export const docker = (
  args: readonly string[],
  options: { readonly input?: string | Buffer; readonly timeoutMs?: number } = {},
): Promise<DockerResult> =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
      });
    });
    child.stdin.end(options.input);
  });

/** Like `docker`, but a non-zero exit is an error carrying stderr. */
export const dockerOk = async (
  args: readonly string[],
  options: { readonly input?: string | Buffer; readonly timeoutMs?: number } = {},
): Promise<string> => {
  const result = await docker(args, options);
  if (result.code !== 0)
    throw new Error(
      `docker ${args.slice(0, 3).join(" ")} failed (${result.code}): ${result.stderr.slice(-2000)}`,
    );
  return result.stdout;
};

export interface LabelledObjects {
  readonly containers: readonly string[];
  readonly networks: readonly string[];
  readonly volumes: readonly string[];
  readonly images: readonly string[];
}

const lines = (text: string) => text.split("\n").filter((line) => line.length > 0);

/** Lists every Docker object carrying `label` (a `key` or `key=value` filter). */
export const listLabelled = async (label: string): Promise<LabelledObjects> => ({
  containers: lines(
    await dockerOk(["ps", "-a", "--filter", `label=${label}`, "--format", "{{.Names}}"]),
  ),
  networks: lines(
    await dockerOk(["network", "ls", "--filter", `label=${label}`, "--format", "{{.Name}}"]),
  ),
  volumes: lines(
    await dockerOk(["volume", "ls", "--filter", `label=${label}`, "--format", "{{.Name}}"]),
  ),
  images: lines(
    await dockerOk([
      "image",
      "ls",
      "--filter",
      `label=${label}`,
      "--format",
      "{{.Repository}}:{{.Tag}}",
    ]),
  ).filter((name) => !name.includes("<none>")),
});

/** Removes exactly the objects carrying `label`, after listing them. Returns what it removed. */
export const removeLabelled = async (
  label: string,
  options: { readonly images?: boolean } = {},
): Promise<LabelledObjects> => {
  const found = await listLabelled(label);
  if (found.containers.length > 0) await docker(["rm", "-f", "-v", ...found.containers]);
  for (const network of found.networks) await docker(["network", "rm", network]);
  if (found.volumes.length > 0) await docker(["volume", "rm", "-f", ...found.volumes]);
  if (options.images === true && found.images.length > 0)
    await docker(["image", "rm", "-f", ...found.images]);
  return found;
};

/** Labels Core puts on the Docker objects it creates for resources and Boat gateways. */
export const CORE_LABELS = [
  "sealant.resource-instance",
  "sealant.resource-domain",
  "sealant.resource-network",
  "sealant.boat-tunnel",
] as const;

export interface CoreObject {
  readonly kind: "container" | "network" | "volume";
  readonly id: string;
  readonly name: string;
}

/** Every Docker object carrying one of Core's resource or gateway labels. */
export const listCoreObjects = async (): Promise<CoreObject[]> => {
  const found = new Map<string, CoreObject>();
  for (const label of CORE_LABELS) {
    const sources = [
      [
        "container",
        ["ps", "-a", "--no-trunc", "--filter", `label=${label}`, "--format", "{{.ID}} {{.Names}}"],
      ],
      [
        "network",
        [
          "network",
          "ls",
          "--no-trunc",
          "--filter",
          `label=${label}`,
          "--format",
          "{{.ID}} {{.Name}}",
        ],
      ],
      ["volume", ["volume", "ls", "--filter", `label=${label}`, "--format", "{{.Name}} {{.Name}}"]],
    ] as const;
    for (const [kind, args] of sources)
      for (const line of lines(await dockerOk(args))) {
        const [id = "", name = ""] = line.split(" ");
        found.set(`${kind}:${id}`, { kind, id, name });
      }
  }
  return [...found.values()];
};

/** Removes exactly `objects` (containers first, then networks, then volumes). */
export const removeObjects = async (objects: readonly CoreObject[]): Promise<void> => {
  const of = (kind: CoreObject["kind"]) =>
    objects.filter((entry) => entry.kind === kind).map((entry) => entry.id);
  if (of("container").length > 0) await docker(["rm", "-f", "-v", ...of("container")]);
  for (const id of of("network")) await docker(["network", "rm", id]);
  if (of("volume").length > 0) await docker(["volume", "rm", "-f", ...of("volume")]);
};
