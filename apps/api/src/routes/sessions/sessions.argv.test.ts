/**
 * A session's arguments reach the workspace's sealantd as the argv array they arrived as: no
 * trimming, no joining into a shell string, the empty and the multi-line kept. A service key is
 * configured before the dynamic import because runtime-env parses process.env at module load.
 */
import {
  AccessTokenRepo,
  RunRepo,
  WorkspaceAttemptRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceSessionRepo,
  type CreateWorkspaceSessionInput,
  type RunRepoService,
  type Workspace,
  type WorkspaceRepoService,
  type WorkspaceRuntimeInstanceRepoService,
} from "@sealant/db";
import { TelemetryQuery } from "@sealant/telemetry";
import { SealantRuntime, type SealantOpenSessionOptions } from "@sealant/workspaces";
import { Effect, Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

process.env["SEALANT_SERVICE_KEYS"] = "svc-test";

let sessionsModule: typeof import("./sessions.module.js");

beforeAll(async () => {
  sessionsModule = await import("./sessions.module.js");
});

const OWNER = "usr_alice";
const workspace = { id: "wks_1", ownerUserId: OWNER, latestRunId: "run_1" } as Workspace;

interface Recorded {
  readonly opened: SealantOpenSessionOptions[];
  readonly runCommands: unknown[];
  readonly stored: CreateWorkspaceSessionInput[];
  readonly settled: string[];
}

/** The repositories and a daemon whose `openSession` is `open`, recording what each was handed. */
const harness = (open: (options: SealantOpenSessionOptions) => Effect.Effect<unknown, unknown>) => {
  const recorded: Recorded = { opened: [], runCommands: [], stored: [], settled: [] };
  const daemon = {
    capabilities: Effect.succeed({ supports: [] }),
    openSession: (options: SealantOpenSessionOptions) =>
      Effect.suspend(() => {
        recorded.opened.push(options);
        return open(options);
      }),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(WorkspaceRepo, {
      getWorkspaceById: () => Effect.succeed(workspace),
    } as unknown as WorkspaceRepoService),
    Layer.succeed(WorkspaceRuntimeInstanceRepo, {
      getRuntimeInstanceByRunId: () =>
        Effect.succeed({
          runId: "run_1",
          status: "ready",
          adapter: "docker",
          resourceId: "container-1",
          reference: "container-1",
          endpoint: null,
        }),
    } as unknown as WorkspaceRuntimeInstanceRepoService),
    Layer.succeed(WorkspaceAttemptRepo, {
      getAttemptSnapshotByRunId: () => Effect.succeed(undefined),
    } as never),
    Layer.succeed(RunRepo, {
      createRun: (input: { command: unknown }) =>
        Effect.sync(() => {
          recorded.runCommands.push(input.command);
          return {};
        }),
      markRunRunning: () => Effect.succeed({}),
      markRunFailed: (input: { errorMessage: string }) =>
        Effect.sync(() => {
          recorded.settled.push(`run: ${input.errorMessage}`);
          return null;
        }),
    } as unknown as RunRepoService),
    Layer.succeed(WorkspaceSessionRepo, {
      createSession: (input: CreateWorkspaceSessionInput) =>
        Effect.sync(() => {
          recorded.stored.push(input);
          return {};
        }),
      markSessionEnded: (input: { status: string }) =>
        Effect.sync(() => {
          recorded.settled.push(`session: ${input.status}`);
          return null;
        }),
      markSessionRunning: () =>
        Effect.succeed({
          id: "sess_1",
          workspaceId: workspace.id,
          runId: "run_2",
          ownerUserId: OWNER,
          status: "running",
          argv: ["bash"],
          argCount: 4,
          argLengths: [3, 30, 0, 10],
          cwd: "/workspace/repo",
          cols: 80,
          rows: 24,
          mode: "pty",
          exitCode: null,
          exitSignal: null,
          errorMessage: null,
          metadata: null,
          createdAt: new Date(0),
          endedAt: null,
        }),
    } as never),
    Layer.succeed(TelemetryQuery, { hasEpoch: () => Effect.succeed(true) } as never),
    Layer.succeed(SealantRuntime, { connect: () => Effect.succeed(daemon) } as never),
    Layer.succeed(AccessTokenRepo, {} as never),
  );
  return { layer, recorded };
};

const create = (argv: readonly string[], layer: ReturnType<typeof harness>["layer"]) =>
  sessionsModule
    .createSession({
      headers: { authorization: "Bearer svc-test" },
      payload: { workspaceId: workspace.id, ownerUserId: OWNER, argv },
    })
    .pipe(Effect.provide(layer));

describe("a session's arguments", () => {
  it("reach the daemon as an argv array, byte for byte", async () => {
    const argv = ["bash", "-lc", "\n echo hi\n  echo there\n", "", "  padded  "];
    const { layer, recorded } = harness(() =>
      Effect.succeed({ sessionId: "dsess_1", processId: "proc_1", pid: 42 }),
    );

    await Effect.runPromise(create(argv, layer));

    expect(recorded.opened).toHaveLength(1);
    expect(recorded.opened[0]?.shell).toBe("bash");
    expect(recorded.opened[0]?.args).toEqual([
      "-lc",
      "\n echo hi\n  echo there\n",
      "",
      "  padded  ",
    ]);
    // The repositories withhold everything after argv[0] (`describeArguments`); they are handed
    // the words unchanged, so the lengths they keep are the real ones.
    expect(recorded.runCommands).toEqual([
      { executable: "bash", args: argv.slice(1), cwd: "/workspace/repo" },
    ]);
    expect(recorded.stored[0]?.argv).toEqual(argv);
  });

  it("settle the run and the session when the daemon cannot start the program", async () => {
    const { layer, recorded } = harness(() =>
      Effect.fail(new Error("/bin/true: Argument list too long (os error 7)")),
    );

    const exit = await Effect.runPromiseExit(create(["/bin/true", "secret-argument"], layer));

    expect(JSON.stringify(exit)).toContain("SessionBadGatewayError");
    expect(recorded.settled).toEqual([
      "run: Failed to open the pty session: /bin/true: Argument list too long (os error 7)",
      "session: failed",
    ]);
  });
});
