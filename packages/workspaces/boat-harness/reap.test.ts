import { describe, expect, it } from "vitest";

import { HARNESS_LABEL, type DockerResult } from "./docker.js";
import {
  LOCK,
  LOCK_LABEL,
  acquireHostLock,
  cleanupPlan,
  reapRun,
  releaseLock,
  watchAndReap,
  type HostDeps,
} from "./reap.js";

const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const missing = (): DockerResult => ({
  code: 1,
  stdout: "",
  stderr: "No such object",
  timedOut: false,
});

interface FakeState {
  /** The lock as `<run> <pid>`, or undefined when free. */
  lock: string | undefined;
  networks: Set<string>;
  livePids: Set<number>;
  /** Processes carrying `RUN_ENV=<run>`, by run. */
  runPids: Map<string, number[]>;
  /** Labelled objects by kind, as `docker ... --filter label=<label>` would list them. */
  labelled: Map<
    string,
    { containers: string[]; networks: string[]; volumes: string[]; images: string[] }
  >;
  commands: string[][];
  killed: number[];
}
type FakeHost = FakeState & { readonly deps: HostDeps };

const host = (
  setup: Partial<Pick<FakeState, "lock" | "networks" | "livePids" | "runPids">> = {},
): FakeHost => {
  const state: FakeState = {
    lock: setup.lock,
    networks: setup.networks ?? new Set(),
    livePids: setup.livePids ?? new Set(),
    runPids: setup.runPids ?? new Map(),
    labelled: new Map(),
    commands: [],
    killed: [],
  };
  const listed = (
    args: readonly string[],
    kind: "containers" | "networks" | "volumes" | "images",
  ) => {
    const filter = args[args.indexOf("--filter") + 1] ?? "";
    const label = filter.replace(/^label=/, "");
    if (label === HARNESS_LABEL)
      return ok([...state.labelled.keys()].map((key) => key.split("=")[1]).join("\n"));
    return ok((state.labelled.get(label)?.[kind] ?? []).join("\n"));
  };
  const deps: HostDeps = {
    docker: async (args) => {
      state.commands.push([...args]);
      const [first, second] = args;
      if (first === "create" && args.includes(LOCK)) {
        if (state.lock !== undefined) return missing();
        const run = args.find((arg) => arg.startsWith(`${LOCK_LABEL}=`))?.split("=")[1] ?? "";
        const pid = args.find((arg) => arg.startsWith(`${LOCK_LABEL}.pid=`))?.split("=")[1] ?? "";
        state.lock = `${run} ${pid}`;
        return ok();
      }
      if (first === "container" && second === "inspect")
        return state.lock === undefined ? missing() : ok(state.lock);
      if (first === "rm" && args[1] === LOCK) {
        state.lock = undefined;
        return ok();
      }
      if (first === "network" && second === "inspect")
        return state.networks.has(args[2] ?? "") ? ok("[]") : missing();
      if (first === "ps") return listed(args, "containers");
      if (first === "network" && second === "ls") return listed(args, "networks");
      if (first === "volume" && second === "ls") return listed(args, "volumes");
      if (first === "image" && second === "ls") return listed(args, "images");
      return ok();
    },
    processAlive: async (pid) => state.livePids.has(pid),
    runProcesses: async (runId) => state.runPids.get(runId) ?? [],
    kill: (pid) => {
      state.killed.push(pid);
    },
    sleep: async () => {
      throw new Error("would wait");
    },
    now: () => 0,
  };
  return Object.assign(state, { deps });
};

describe("host lock", () => {
  it("does not take a lock from a live run: its test process, or its reaper still at work", async () => {
    for (const setup of [
      { lock: "abc12345 100", livePids: new Set([100]) },
      { lock: "abc12345 100", runPids: new Map([["abc12345", [300]]]) },
    ]) {
      const state = host(setup);
      await expect(acquireHostLock("def67890", 200, () => {}, state.deps)).rejects.toThrow(
        /would wait/,
      );
      expect(state.lock).toBe("abc12345 100");
    }
  });

  it("takes over once every process of the holder's run is gone, whatever objects it left", async () => {
    // The reaper died with its parent (a process-tree kill): the run's network is still there.
    const state = host({ lock: "abc12345 100", networks: new Set(["boat-harness-abc12345"]) });
    await acquireHostLock("def67890", 200, () => {}, state.deps);
    expect(state.lock).toBe("def67890 200");
  });

  it("releases only its own lock", async () => {
    const state = host({ lock: "abc12345 100" });
    await releaseLock("def67890", state.deps);
    expect(state.lock).toBe("abc12345 100");
    await releaseLock("abc12345", state.deps);
    expect(state.lock).toBeUndefined();
  });
});

describe("cleanup", () => {
  it("leaves a run that is still building images (no network yet, process alive) and its lock alone", async () => {
    const state = host({ lock: "abc12345 100", livePids: new Set([100]) });
    state.labelled.set(`${HARNESS_LABEL}=abc12345`, {
      containers: ["boat-harness-abc12345-postgres"],
      networks: [],
      volumes: [],
      images: [],
    });
    const plan = await cleanupPlan(state.deps);
    expect(plan).toEqual({ reap: [], live: "abc12345", staleLock: undefined });
  });

  it("reaps a dead run and flags its lock as stale", async () => {
    const state = host({ lock: "abc12345 100" });
    state.labelled.set(`${HARNESS_LABEL}=abc12345`, {
      containers: ["x"],
      networks: [],
      volumes: [],
      images: [],
    });
    expect(await cleanupPlan(state.deps)).toEqual({
      reap: ["abc12345"],
      live: undefined,
      staleLock: "abc12345",
    });
  });

  it("removes only objects labelled with the run, never by creation time", async () => {
    const state = host({ lock: "abc12345 100", runPids: new Map([["abc12345", [4242]]]) });
    state.labelled.set(`${HARNESS_LABEL}=abc12345`, {
      containers: ["boat-tunnel-0123", "sealres-own"],
      networks: ["boat-harness-abc12345"],
      volumes: ["sealres-own-data"],
      images: ["sealant-boat-twin-snapshot:abc12345-x"],
    });
    await reapRun("abc12345", state.deps);
    const removals = state.commands.filter((args) => args.includes("rm"));
    expect(removals).toEqual([
      ["rm", "-f", "-v", "boat-tunnel-0123", "sealres-own"],
      ["network", "rm", "boat-harness-abc12345"],
      ["volume", "rm", "-f", "sealres-own-data"],
      ["image", "rm", "-f", "sealant-boat-twin-snapshot:abc12345-x"],
      ["rm", LOCK],
    ]);
    // Every listing it acted on was filtered by the run's own label.
    for (const args of state.commands.filter((entry) => entry.includes("--filter")))
      expect(args[args.indexOf("--filter") + 1]).toBe(`label=${HARNESS_LABEL}=abc12345`);
    expect(state.killed).toEqual([4242]);
  });
});

describe("reaper", () => {
  it("reaps when the parent dies, even before the run's network existed", async () => {
    const state = host({ lock: "abc12345 100" });
    state.labelled.set(`${HARNESS_LABEL}=abc12345`, {
      containers: [],
      networks: [],
      volumes: [],
      images: ["sealant-boat-harness-run:abc12345"],
    });
    const reaped = await watchAndReap("abc12345", 100, state.deps);
    expect(reaped.labelled).toBe(1);
    expect(state.commands).toContainEqual([
      "image",
      "rm",
      "-f",
      "sealant-boat-harness-run:abc12345",
    ]);
    expect(state.lock).toBeUndefined();
  });
});
