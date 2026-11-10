import { spawn } from "node:child_process";

/**
 * Every container, network, volume and image a harness run creates carries
 * `sh.sealant.boat-harness=<run>`, including what Core creates for it (see `bin/docker`). That label
 * is the only ownership evidence teardown, the reaper and `cleanup.ts` act on.
 */
export const HARNESS_LABEL = "sh.sealant.boat-harness";
/** Cached images carry this instead, so nothing that inherits their labels looks like a run's. */
export const CACHE_LABEL = `${HARNESS_LABEL}.cache=true`;

export interface DockerResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export type DockerOptions = { readonly input?: string | Buffer; readonly timeoutMs?: number };
/** The docker CLI, injectable so the ownership and lock logic can be tested without Docker. */
export type DockerRunner = (
  args: readonly string[],
  options?: DockerOptions,
) => Promise<DockerResult>;

/** Runs one docker CLI command. Never throws for a non-zero exit; callers decide. */
export const docker: DockerRunner = (args, options = {}) =>
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

/** Like a runner, but a non-zero exit is an error carrying stderr. */
export const okWith =
  (run: DockerRunner) =>
  async (args: readonly string[], options: DockerOptions = {}): Promise<string> => {
    const result = await run(args, options);
    if (result.code !== 0)
      throw new Error(
        `docker ${args.slice(0, 3).join(" ")} failed (${result.code}): ${result.stderr.slice(-2000)}`,
      );
    return result.stdout;
  };

export const dockerOk = okWith(docker);

export interface LabelledObjects {
  readonly containers: readonly string[];
  readonly networks: readonly string[];
  readonly volumes: readonly string[];
  readonly images: readonly string[];
}

const lines = (text: string) => text.split("\n").filter((line) => line.length > 0);

/** Lists every Docker object carrying `label` (a `key` or `key=value` filter). */
export const listLabelled = async (
  label: string,
  run: DockerRunner = docker,
): Promise<LabelledObjects> => {
  const ok = okWith(run);
  return {
    containers: lines(
      await ok(["ps", "-a", "--filter", `label=${label}`, "--format", "{{.Names}}"]),
    ),
    networks: lines(
      await ok(["network", "ls", "--filter", `label=${label}`, "--format", "{{.Name}}"]),
    ),
    volumes: lines(
      await ok(["volume", "ls", "--filter", `label=${label}`, "--format", "{{.Name}}"]),
    ),
    images: lines(
      await ok([
        "image",
        "ls",
        "--filter",
        `label=${label}`,
        "--format",
        "{{.Repository}}:{{.Tag}}",
      ]),
    ).filter((name) => !name.includes("<none>")),
  };
};

/** Removes exactly the objects carrying `label`, after listing them. Returns what it removed. */
export const removeLabelled = async (
  label: string,
  options: { readonly images?: boolean } = {},
  run: DockerRunner = docker,
): Promise<LabelledObjects> => {
  const found = await listLabelled(label, run);
  if (found.containers.length > 0) await run(["rm", "-f", "-v", ...found.containers]);
  for (const network of found.networks) await run(["network", "rm", network]);
  if (found.volumes.length > 0) await run(["volume", "rm", "-f", ...found.volumes]);
  if (options.images === true && found.images.length > 0)
    await run(["image", "rm", "-f", ...found.images]);
  return found;
};

/** Labels Core puts on the Docker objects it creates for resources and Boat gateways. */
export const CORE_LABELS = [
  "sealant.resource-instance",
  "sealant.resource-domain",
  "sealant.resource-network",
  "sealant.boat-tunnel",
] as const;

/** Names of Core-labelled objects on the host, for the preflight. They are never removed. */
export const listCoreObjectNames = async (run: DockerRunner = docker): Promise<string[]> => {
  const ok = okWith(run);
  const names = new Set<string>();
  for (const label of CORE_LABELS)
    for (const args of [
      ["ps", "-a", "--filter", `label=${label}`, "--format", "{{.Names}}"],
      ["network", "ls", "--filter", `label=${label}`, "--format", "{{.Name}}"],
      ["volume", "ls", "--filter", `label=${label}`, "--format", "{{.Name}}"],
    ])
      for (const name of lines(await ok(args))) names.add(name);
  return [...names];
};
