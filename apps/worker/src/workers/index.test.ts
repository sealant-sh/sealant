import type { WorkerEnv } from "@sealant/validators/env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(async () => {}),
}));
const telemetry = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(async () => {}),
}));

vi.mock("./workspaces.js", () => ({ startWorkspaceWorker: workspace.start }));
vi.mock("./telemetry.js", () => ({ startTelemetryWorker: telemetry.start }));

const { startWorkers } = await import("./index.js");

// The env is passed through untouched; nothing here reads it.
const env = {} as WorkerEnv;

describe("startWorkers", () => {
  beforeEach(() => {
    workspace.start.mockReset();
    telemetry.start.mockReset();
    telemetry.start.mockResolvedValue({ stop: telemetry.stop });
  });

  it("hands the workspace worker's Boat control to the telemetry worker, so a Boat session records", async () => {
    // VM 131 run 6: the recorder never attached to a Boat run (no control target without it).
    const boatConnectMaterial = vi.fn();
    workspace.start.mockResolvedValue({ stop: workspace.stop, boatConnectMaterial });
    const workers = await startWorkers(env);
    expect(telemetry.start).toHaveBeenCalledWith(env, { boatConnectMaterial });
    await workers.stop();
    expect(telemetry.stop).toHaveBeenCalledOnce();
    expect(workspace.stop).toHaveBeenCalledOnce();
  });

  it("starts the telemetry worker without Boat control when the deployment has no Boat", async () => {
    workspace.start.mockResolvedValue({ stop: workspace.stop, boatConnectMaterial: undefined });
    await startWorkers(env);
    expect(telemetry.start).toHaveBeenCalledWith(env, {});
  });
});
