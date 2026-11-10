import { describe, expect, it } from "vitest";

import { HARNESS_LABEL, type DockerResult } from "./docker.js";
import {
  LOCK,
  LOCK_LABEL,
  acquireHostLock,
  cleanupPlan,
  reapRun,
  releaseLock,
  renewLock,
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
const conflict = (): DockerResult => ({
  code: 125,
  stdout: "",
  stderr: `Conflict. The container name "/${LOCK}" is already in use`,
  timedOut: false,
});

/** The lock container: its id, its holder's run, and whether its heartbeat still runs. */
interface FakeLock {
  readonly id: string;
  readonly holder: string;
  running: boolean;
}

interface FakeState {
  lock: FakeLock | undefined;
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
  /** Runs once, just before a `rm -f` of a lock: another run acting between this run's calls. */
  beforeLockRemoval: (() => void) | undefined;
}
type FakeHost = FakeState & { readonly deps: HostDeps };

const isLockRemoval = (args: readonly string[]) =>
  args.length === 3 && args[0] === "rm" && args[1] === "-f" && /^[0-9a-f]{64}$/.test(args[2] ?? "");
const lockId = (n: number) => n.toString(16).padStart(64, "0");
let nextId = 100;

const host = (setup: Partial<Pick<FakeState, "lock" | "livePids" | "runPids">> = {}): FakeHost => {
  const state: FakeState = {
    lock: setup.lock,
    livePids: setup.livePids ?? new Set(),
    runPids: setup.runPids ?? new Map(),
    labelled: new Map(),
    commands: [],
    killed: [],
    beforeLockRemoval: undefined,
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
      if (first === "run" && args.includes(LOCK)) {
        if (state.lock !== undefined) return conflict();
        const holder = args.find((arg) => arg.startsWith(`${LOCK_LABEL}=`))?.split("=")[1] ?? "";
        state.lock = { id: lockId(nextId++), holder, running: true };
        return ok(`${state.lock.id}\n`);
      }
      if (first === "container" && second === "inspect")
        return state.lock === undefined
          ? missing()
          : ok(`${state.lock.id} ${String(state.lock.running)} ${state.lock.holder}\n`);
      if (first === "exec")
        return state.lock !== undefined && state.lock.id === second && state.lock.running
          ? ok()
          : missing();
      if (isLockRemoval(args)) {
        const hook = state.beforeLockRemoval;
        state.beforeLockRemoval = undefined;
        hook?.();
        if (state.lock?.id === args[2]) state.lock = undefined;
        return ok();
      }
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

const leftovers = (state: FakeHost, run: string) =>
  state.labelled.set(`${HARNESS_LABEL}=${run}`, {
    containers: [`boat-harness-${run}-postgres`],
    networks: [`boat-harness-${run}`],
    volumes: [],
    images: [],
  });

describe("host lock", () => {
  it("does not take a running lock, even while its holder is between processes", async () => {
    // The holder took the lock and has spawned nothing yet; from this run's sandbox no process of
    // it is visible (another PID namespace) and it has created no object. Its heartbeat runs.
    const state = host({ lock: { id: lockId(1), holder: "abc12345", running: true } });
    await expect(acquireHostLock("def67890", () => {}, state.deps)).rejects.toThrow(/would wait/);
    expect(state.lock).toEqual({ id: lockId(1), holder: "abc12345", running: true });
    expect(state.commands.some((args) => args[0] === "rm")).toBe(false);
  });

  it("takes over a lock whose heartbeat stopped only when its run left nothing", async () => {
    const state = host({ lock: { id: lockId(1), holder: "abc12345", running: false } });
    const id = await acquireHostLock("def67890", () => {}, state.deps);
    expect(state.lock).toEqual({ id, holder: "def67890", running: true });
    expect(state.commands).toContainEqual(["rm", "-f", lockId(1)]);
  });

  it("refuses a stopped lock whose run left labelled objects, and names the cleanup", async () => {
    const state = host({ lock: { id: lockId(1), holder: "abc12345", running: false } });
    leftovers(state, "abc12345");
    await expect(acquireHostLock("def67890", () => {}, state.deps)).rejects.toThrow(
      /abc12345 ended without finishing its teardown and left 2 labelled objects.*cleanup\.ts/,
    );
    expect(state.lock?.holder).toBe("abc12345");
  });

  it("removes a stale lock by its id, so a newer holder's lock survives a race", async () => {
    const state = host({ lock: { id: lockId(1), holder: "abc12345", running: false } });
    // Another newcomer replaces the stale lock between this run's inspect and its removal.
    state.beforeLockRemoval = () => {
      state.lock = { id: lockId(2), holder: "0badc0de", running: true };
    };
    await expect(acquireHostLock("def67890", () => {}, state.deps)).rejects.toThrow(/would wait/);
    expect(state.lock).toEqual({ id: lockId(2), holder: "0badc0de", running: true });
  });

  it("renews only a running lock, and releases only its own", async () => {
    const state = host({ lock: { id: lockId(1), holder: "abc12345", running: true } });
    expect(await renewLock(lockId(1), state.deps)).toBe(true);
    expect(await renewLock(lockId(2), state.deps)).toBe(false);
    await releaseLock("def67890", state.deps);
    expect(state.lock?.holder).toBe("abc12345");
    await releaseLock("abc12345", state.deps);
    expect(state.lock).toBeUndefined();
  });
});

describe("cleanup", () => {
  it("leaves a run whose heartbeat runs (still building images, no network yet) and its lock alone", async () => {
    const state = host({ lock: { id: lockId(1), holder: "abc12345", running: true } });
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
    const state = host({ lock: { id: lockId(1), holder: "abc12345", running: false } });
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
    const state = host({
      lock: { id: lockId(1), holder: "abc12345", running: false },
      runPids: new Map([["abc12345", [4242]]]),
    });
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
      ["rm", "-f", lockId(1)],
    ]);
    // Every listing it acted on was filtered by the run's own label.
    for (const args of state.commands.filter((entry) => entry.includes("--filter")))
      expect(args[args.indexOf("--filter") + 1]).toBe(`label=${HARNESS_LABEL}=abc12345`);
    expect(state.killed).toEqual([4242]);
  });
});

describe("reaper", () => {
  it("reaps when the parent dies, even before the run's network existed", async () => {
    const state = host({ lock: { id: lockId(1), holder: "abc12345", running: true } });
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
