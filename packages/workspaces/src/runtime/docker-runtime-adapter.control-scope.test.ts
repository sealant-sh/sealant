/**
 * A Docker workspace's control scope (SLNT-1332): the directory of the control root it mounts at
 * `/run/sealant`, named by its launch (`controlScope`) so the caller can bind `capture.sock` and
 * `session.sock` there first, and the channels `runtime.executorSockets` connects to them.
 */
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { cases } from "./docker-runtime-adapter.golden-fixture.js";
import { DockerRuntimeAdapter } from "./docker-runtime-adapter.js";
import {
  selectRuntimeAdapter,
  type RuntimeAdapter,
  type RuntimeAdapterLaunchInput,
} from "./runtime-adapter.js";

const RUNNING_STATE = '{"Status":"running","Running":true,"ExitCode":0,"Error":""}\n';
const EXITED_STATE = '{"Status":"exited","Running":false,"ExitCode":0,"Error":""}\n';
const SCOPE = "mend-exec-1";

const catalog = async () => ({ defaultRuntime: "runc", runtimes: new Set(["runc"]) });

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A Unix socket listening at `path` that answers each connection with `reply`. */
const listen = async (path: string, reply = "") => {
  const server = net.createServer((socket) => socket.end(reply));
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
};

const answers = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(path);
    let text = "";
    socket.on("data", (chunk) => (text += chunk.toString("utf8")));
    socket.once("end", () => resolve(text));
    socket.once("error", reject);
  });

/**
 * A control root where the caller has bound its two sockets in `scope`, and where sealantd's
 * `control.sock` answers (a stand-in for the daemon the launch waits on).
 */
const controlRoot = async (scope: string) => {
  const root = await mkdtemp(join(tmpdir(), "sealant-control-scope-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, scope);
  await mkdir(dir, { recursive: true });
  await listen(join(dir, "capture.sock"), "caller capture\n");
  await listen(join(dir, "session.sock"), "caller session\n");
  await listen(join(dir, "control.sock"));
  return { root, dir };
};

const recordingRunner = () => {
  const calls: string[][] = [];
  const runner = vi.fn(async (_command: string, args: string[]) => {
    calls.push([...args]);
    if (args[0] === "run") return { stdout: "container-id-123\n", stderr: "" };
    if (args[0] === "network") return { stdout: "", stderr: "" };
    return { stdout: RUNNING_STATE, stderr: "" };
  });
  return { calls, runner };
};

const withSockets = (
  input: RuntimeAdapterLaunchInput,
  executorSockets: { readonly capture: boolean; readonly session: boolean },
): RuntimeAdapterLaunchInput => ({
  ...input,
  blueprint: { ...input.blueprint, runtime: { ...input.blueprint.runtime, executorSockets } },
});

const workspaceRun = (calls: readonly string[][]) =>
  calls.find((args) => args[0] === "run" && args.includes("--name")) ?? [];

describe("DockerRuntimeAdapter · a control scope the launch names", () => {
  it("mounts that scope at /run/sealant and leaves the caller's sockets bound there", async () => {
    const { root, dir } = await controlRoot(SCOPE);
    const { calls, runner } = recordingRunner();
    const adapter = new DockerRuntimeAdapter({
      commandRunner: runner,
      runtimeCatalogLoader: catalog,
      controlSocketHostDir: root,
    });

    const result = await adapter.launch({ ...cases.capture, controlScope: SCOPE });

    const run = workspaceRun(calls);
    expect(run).toContain(`${dir}:/run/sealant`);
    expect(run).toContain(`sealant.control-scope=${SCOPE}`);
    expect(result).toMatchObject({
      controlScope: SCOPE,
      endpoint: `unix://${join(dir, "control.sock")}`,
    });
    // Still the caller's: the same listeners answer.
    expect(await answers(join(dir, "capture.sock"))).toBe("caller capture\n");
    expect(await answers(join(dir, "session.sock"))).toBe("caller session\n");
    // No session channel asked for: the scope stays its owner's alone.
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("reports the container's name as the scope when the launch names none", async () => {
    const { root } = await controlRoot("sealant-run-golden-4");
    const { runner } = recordingRunner();
    const adapter = new DockerRuntimeAdapter({
      commandRunner: runner,
      runtimeCatalogLoader: catalog,
      controlSocketHostDir: root,
    });
    const result = await adapter.launch(cases.capture);
    expect(result.controlScope).toBe("sealant-run-golden-4");
  });

  it("dials the caller's capture relay and opens the session channel to non-root processes", async () => {
    const { root, dir } = await controlRoot(SCOPE);
    const { calls, runner } = recordingRunner();
    const adapter = new DockerRuntimeAdapter({
      commandRunner: runner,
      runtimeCatalogLoader: catalog,
      controlSocketHostDir: root,
    });

    await adapter.launch({
      ...withSockets(cases.capture, { capture: true, session: true }),
      controlScope: SCOPE,
    });

    expect(workspaceRun(calls)).toContain("SEALANT_CAPTURE_DIAL=unix:/run/sealant/capture.sock");
    // Searchable, so `dev` reaches session.sock by name; never listable or writable by others.
    expect((await stat(dir)).mode & 0o777).toBe(0o711);
  });

  it("sets no capture dial when only the session channel is asked for", async () => {
    const { root } = await controlRoot(SCOPE);
    const { calls, runner } = recordingRunner();
    const adapter = new DockerRuntimeAdapter({
      commandRunner: runner,
      runtimeCatalogLoader: catalog,
      controlSocketHostDir: root,
    });
    await adapter.launch({
      ...withSockets(cases.capture, { capture: false, session: true }),
      controlScope: SCOPE,
    });
    expect(workspaceRun(calls).some((arg) => arg.startsWith("SEALANT_CAPTURE_DIAL="))).toBe(false);
  });

  it("refuses a scope or the caller's channels on a worker with no control root", async () => {
    const { calls, runner } = recordingRunner();
    const adapter = new DockerRuntimeAdapter({
      commandRunner: runner,
      runtimeCatalogLoader: catalog,
    });
    expect(adapter.hasControlScopes).toBe(false);
    await expect(adapter.launch({ ...cases.capture, controlScope: SCOPE })).rejects.toMatchObject({
      code: "runtime-requirement-unsupported",
    });
    await expect(
      adapter.launch(withSockets(cases.capture, { capture: true, session: false })),
    ).rejects.toMatchObject({ code: "runtime-requirement-unsupported" });
    expect(workspaceRun(calls)).toEqual([]);
  });

  it("waits, on a recovery, for the control socket in the scope the container was launched in", async () => {
    const { root, dir } = await controlRoot(SCOPE);
    let started = false;
    const runner = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "start") started = true;
      // The recovery's helper containers (its marker, the metadata guard).
      if (args[0] === "run" || args[0] === "create") return { stdout: "helper-id\n", stderr: "" };
      if (args[0] === "inspect" && args.includes("{{json .State}}")) {
        return { stdout: started ? RUNNING_STATE : EXITED_STATE, stderr: "" };
      }
      if (args[0] === "inspect" && args.some((arg) => arg.includes("sealant.control-scope"))) {
        return { stdout: `${SCOPE}\n`, stderr: "" };
      }
      if (args[0] === "inspect" && args.includes("{{.Name}}")) {
        return { stdout: "/sealant-run-golden-4\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const adapter = new DockerRuntimeAdapter({
      commandRunner: runner,
      runtimeCatalogLoader: catalog,
      controlSocketHostDir: root,
      readinessTimeoutMs: 1_000,
    });

    // Only the scope holds a control.sock: waiting under the container's name would time out.
    await expect(
      adapter.recover({ resourceId: "container-id-123", reference: "sealant-run-golden-4" }),
    ).resolves.toEqual({ outcome: "restarted" });
    expect(await answers(join(dir, "capture.sock"))).toBe("caller capture\n");
  });

  it("takes a launch a preferred Kubernetes runtime could not, as Docker, and launches it", async () => {
    const { root, dir } = await controlRoot(SCOPE);
    const { calls, runner } = recordingRunner();
    const docker = new DockerRuntimeAdapter({
      commandRunner: runner,
      runtimeCatalogLoader: catalog,
      controlSocketHostDir: root,
    });
    // Willing, but its executors mount no control scope.
    const kubernetes: RuntimeAdapter = {
      id: "k8s",
      supports: () => ({ supported: true }),
      launch: () => Promise.reject(new Error("never launched")),
      stop: () => Promise.reject(new Error("never stopped")),
    };
    const preferred = {
      ...cases.capture,
      controlScope: SCOPE,
      blueprint: {
        ...cases.capture.blueprint,
        target: {
          ...cases.capture.blueprint.target,
          runtime: { family: "k8s" as const, mode: "prefer" as const },
        },
      },
    };

    const selection = selectRuntimeAdapter({
      blueprint: preferred.blueprint,
      adapters: [kubernetes, docker],
      defaultAdapterId: "docker",
      controlScope: SCOPE,
    });
    expect(selection.adapterId).toBe("docker");
    expect(selection.blueprint.target.runtime.family).toBe("docker");

    // The real adapter refuses the preferred family; it takes the one selection hands it.
    await expect(docker.launch(preferred)).rejects.toMatchObject({ code: "unsupported-runtime" });
    const result = await docker.launch({ ...preferred, blueprint: selection.blueprint });
    expect(result).toMatchObject({ status: "ready", controlScope: SCOPE });
    expect(workspaceRun(calls)).toContain(`${dir}:/run/sealant`);
  });
});
