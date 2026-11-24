import { describe, expect, it } from "vitest";

import type { DockerCommandRunner } from "../runtime/docker-runtime-adapter.js";
import { instanceContainerName, RESOURCE_LABELS } from "./docker-resource-argv.js";
import { DockerResourceRuntime } from "./docker-resource-runtime.js";
import { instanceRecord } from "./resource.fixture.js";

interface FakeContainer {
  readonly id: string;
  readonly name: string;
  readonly instance: string;
  /** What `docker inspect` reads: the state `docker stop` waits on. */
  status: "running" | "exited";
  exitCode: number;
  /** What `docker ps` reads: Docker's container view, rewritten only after a stop is released. */
  listed: "running" | "exited";
}

/** A `--format` template filled in for one container, from the view the command reads. */
const render = (template: string, container: FakeContainer) =>
  template
    .replaceAll("{{.ID}}", container.id)
    .replaceAll(`{{.Label "${RESOURCE_LABELS.instance}"}}`, container.instance)
    .replaceAll(`{{index .Config.Labels "${RESOURCE_LABELS.instance}"}}`, container.instance)
    .replaceAll("{{.State}}", container.listed)
    .replaceAll(
      "{{.Status}}",
      container.listed === "running" ? "Up 2 minutes" : `Exited (${String(container.exitCode)})`,
    )
    .replaceAll("{{.State.Status}}", container.status)
    .replaceAll("{{.State.ExitCode}}", String(container.exitCode));
const format = (args: ReadonlyArray<string>) => args[args.indexOf("--format") + 1] ?? "";

/**
 * A Docker whose `stop` returns before its container view catches up, as the daemon can: it wakes
 * the stop's waiter (moby daemon/monitor.go, SetStopped) before it saves the container's new state
 * to the view `ps` reads (CheckpointTo). `inspect` reads the state itself.
 */
const dockerWithStaleList = (containers: FakeContainer[]): DockerCommandRunner => {
  return async (_command, args) => {
    const [verb] = args;
    if (verb === "stop") {
      const target = containers.find((container) => container.name === args.at(-1));
      if (target !== undefined) {
        target.status = "exited";
        target.exitCode = 0;
      }
      return { stdout: "", stderr: "" };
    }
    if (verb === "ps") {
      const lines = containers.map((container) => render(format(args), container));
      return { stdout: lines.map((line) => `${line}\n`).join(""), stderr: "" };
    }
    if (verb === "inspect") {
      const ids = new Set(args.slice(args.indexOf("--format") + 2));
      const lines = containers
        .filter((container) => ids.has(container.id) || ids.has(container.name))
        .map((container) => render(format(args), container));
      return { stdout: lines.map((line) => `${line}\n`).join(""), stderr: "" };
    }
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
};

const runtimeOver = (containers: FakeContainer[]) =>
  new DockerResourceRuntime({
    subnets: {
      allocate: () => Promise.reject(new Error("unused")),
      release: () => Promise.resolve(),
    },
    commandRunner: dockerWithStaleList(containers),
  });

describe("DockerResourceRuntime.observe", () => {
  it("says an instance is stopped once stop returns, while Docker's container list still says running", async () => {
    const db = instanceRecord();
    const cache = instanceRecord({ uuid: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" });
    const containers: FakeContainer[] = [db, cache].map((instance, index) => ({
      id: `c0ffee${String(index)}`,
      name: instanceContainerName(instance.id),
      instance: instance.id,
      status: "running",
      exitCode: 0,
      listed: "running",
    }));
    const runtime = runtimeOver(containers);

    await runtime.stop(db);
    const observed = await runtime.observe();

    expect(observed.get(db.id)).toEqual({ running: false, exitCode: 0 });
    expect(observed.get(cache.id)).toEqual({ running: true, exitCode: null });
  });
});

/** A Docker with one executor and no networks, refusing isolated gateways when told to. */
const reachDocker = (refuseIsolated: boolean) => {
  const creates: Array<ReadonlyArray<string>> = [];
  const networks = new Set<string>();
  const run: DockerCommandRunner = async (_command, args) => {
    if (args[0] === "container" && args[1] === "inspect") {
      return { stdout: "true\t0\t\n", stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      if (args.includes("{{.Id}}")) {
        if (networks.has(args.at(-1) ?? "")) return { stdout: "id\n", stderr: "" };
        throw new Error(`Error response from daemon: network ${args.at(-1) ?? ""} not found`);
      }
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "network" && args[1] === "create") {
      creates.push(args);
      if (refuseIsolated && args.some((arg) => arg.includes("gateway_mode_ipv4"))) {
        throw new Error(
          "Error response from daemon: failed to parse com.docker.network.bridge.gateway_mode_ipv4 value: isolated (unknown gateway mode isolated)",
        );
      }
      networks.add(args.at(-1) ?? "");
      return { stdout: "id\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerResourceRuntime({
    subnets: {
      allocate: ({ name }) =>
        Promise.resolve(name.endsWith("-1-reach") ? "10.231.0.0/27" : "10.231.0.32/27"),
      release: () => Promise.resolve(),
    },
    commandRunner: run,
  });
  return { runtime, creates };
};

describe("DockerResourceRuntime reach networks", () => {
  it("makes a reach network with no host gateway, and a plain internal one where the engine refuses that", async () => {
    const isolated = "com.docker.network.bridge.gateway_mode_ipv4=isolated";
    const modern = reachDocker(false);
    await modern.runtime.attachExecutor("sealant-run-1", []);
    expect(modern.creates).toHaveLength(1);
    expect(modern.creates[0]).toContain(isolated);

    const older = reachDocker(true);
    await older.runtime.attachExecutor("sealant-run-1", []);
    await older.runtime.attachExecutor("sealant-run-2", []);
    // Refused once, then a plain internal network; the next one is not asked with the option again.
    expect(older.creates.map((args) => args.includes(isolated))).toEqual([true, false, false]);
    expect(older.creates.every((args) => args.includes("--internal"))).toBe(true);
  });
});
