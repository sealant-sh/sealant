/**
 * Opening a session against a recording daemon and in-memory rows: the arguments reach sealantd as
 * the argv array they arrived as (no trimming, no shell string, the empty and the multi-line kept);
 * a daemon's refusal settles the run and the session; and an open whose answer was lost is never
 * taken for a refusal: the daemon is asked again, a leader it reports is the session's, and one it
 * cannot report about stays open for a close to find and stop. A service key is configured before
 * the dynamic import because runtime-env parses process.env at module load.
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
import {
  SealantControlError,
  SealantRuntime,
  TransportError,
  type SealantOpenSessionOptions,
  type SealantSessionSummary,
} from "@sealant/workspaces";
import { Effect, Exit, Layer, Stream } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

process.env["SEALANT_SERVICE_KEYS"] = "svc-test";

let sessionsModule: typeof import("./sessions.module.js");

beforeAll(async () => {
  sessionsModule = await import("./sessions.module.js");
});

const OWNER = "usr_alice";
const HEADERS = { authorization: "Bearer svc-test" };
const workspace = { id: "wks_1", ownerUserId: OWNER, latestRunId: "run_1" } as Workspace;

const LEADER = { sessionId: "dsess_1", processId: "proc_1", pid: 42 };

interface Row {
  id: string;
  runId: string;
  status: string;
  daemonSessionId: string | null;
  daemonProcessId: string | null;
  argv: readonly string[];
}

/** What the daemon does when asked: `list` sees every open it was asked for. */
interface Daemon {
  readonly open: (options: SealantOpenSessionOptions) => Effect.Effect<unknown, unknown>;
  readonly list: (opened: readonly SealantOpenSessionOptions[]) => Effect.Effect<unknown, unknown>;
}

const transportLost = () =>
  new TransportError({
    operation: "openSession",
    message: "connection closed",
    cause: new Error("connection closed"),
  });

/** The leader the daemon opened for the first open's run, as `listSessions` reports it. */
const listedLeader = (opened: readonly SealantOpenSessionOptions[]) =>
  Effect.succeed<readonly SealantSessionSummary[]>([
    {
      ...LEADER,
      cols: 80,
      rows: 24,
      mode: "pty",
      ...(opened[0]?.executionId === undefined ? {} : { executionId: opened[0].executionId }),
    },
  ]);

const harness = (daemon: Daemon) => {
  const recorded: {
    readonly opened: SealantOpenSessionOptions[];
    readonly closed: string[];
    readonly runCommands: unknown[];
    readonly stored: CreateWorkspaceSessionInput[];
    readonly settled: string[];
    row: Row | undefined;
  } = { opened: [], closed: [], runCommands: [], stored: [], settled: [], row: undefined };
  const rowView = (row: Row) => ({
    id: row.id,
    workspaceId: workspace.id,
    runId: row.runId,
    ownerUserId: OWNER,
    status: row.status,
    argv: row.argv.slice(0, 1),
    argCount: row.argv.length - 1,
    argLengths: row.argv.slice(1).map((word) => Buffer.byteLength(word)),
    cwd: "/workspace/repo",
    cols: 80,
    rows: 24,
    mode: "pty",
    daemonSessionId: row.daemonSessionId,
    daemonProcessId: row.daemonProcessId,
    exitCode: null,
    exitSignal: null,
    errorMessage: null,
    metadata: null,
    createdAt: new Date(0),
    endedAt: null,
  });
  const live = {
    capabilities: Effect.succeed({ supports: [] }),
    openSession: (options: SealantOpenSessionOptions) =>
      Effect.suspend(() => {
        recorded.opened.push(options);
        return daemon.open(options);
      }),
    listSessions: Effect.suspend(() => daemon.list(recorded.opened)),
    closeSession: (daemonSessionId: string) =>
      Effect.sync(() => {
        recorded.closed.push(daemonSessionId);
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
          recorded.settled.push(`run failed: ${input.errorMessage}`);
          return null;
        }),
      markRunCompleted: () =>
        Effect.sync(() => {
          recorded.settled.push("run completed");
          return null;
        }),
    } as unknown as RunRepoService),
    Layer.succeed(WorkspaceSessionRepo, {
      createSession: (input: CreateWorkspaceSessionInput) =>
        Effect.sync(() => {
          recorded.stored.push(input);
          recorded.row = {
            id: input.id,
            runId: input.runId,
            status: "starting",
            daemonSessionId: null,
            daemonProcessId: null,
            argv: input.argv,
          };
          return rowView(recorded.row);
        }),
      getSessionById: () =>
        Effect.sync(() => (recorded.row === undefined ? undefined : rowView(recorded.row))),
      markSessionRunning: (input: { daemonSessionId: string; daemonProcessId: string }) =>
        Effect.sync(() => {
          if (recorded.row === undefined) return null;
          recorded.row.status = "running";
          recorded.row.daemonSessionId = input.daemonSessionId;
          recorded.row.daemonProcessId = input.daemonProcessId;
          return rowView(recorded.row);
        }),
      markSessionEnded: (input: { status: string }) =>
        Effect.sync(() => {
          recorded.settled.push(`session ${input.status}`);
          if (recorded.row === undefined) return null;
          recorded.row.status = input.status;
          return rowView(recorded.row);
        }),
    } as never),
    Layer.succeed(TelemetryQuery, {
      hasEpoch: () => Effect.succeed(true),
      maxSequence: () => Effect.succeed(0n),
      // A closed leader's exit, once it has been closed.
      getTimeline: () =>
        Stream.fromIterable(
          recorded.closed.length === 0
            ? []
            : [{ processId: LEADER.processId, ref: { exitCode: 0 } }],
        ),
    } as never),
    Layer.succeed(SealantRuntime, { connect: () => Effect.succeed(live) } as never),
    Layer.succeed(AccessTokenRepo, {} as never),
  );
  return { layer, recorded };
};

type Harness = ReturnType<typeof harness>;

const create = (argv: readonly string[], { layer }: Harness) =>
  Effect.runPromiseExit(
    sessionsModule
      .createSession({
        headers: HEADERS,
        payload: { workspaceId: workspace.id, ownerUserId: OWNER, argv },
      })
      .pipe(Effect.provide(layer)),
  );

const close = (sessionId: string, { layer }: Harness) =>
  Effect.runPromiseExit(
    sessionsModule
      .closeSession({ sessionId, headers: HEADERS, payload: { ownerUserId: OWNER } })
      .pipe(Effect.provide(layer)),
  );

describe("a session's arguments", () => {
  it("reach the daemon as an argv array, byte for byte", async () => {
    const argv = ["bash", "-lc", "\n echo hi\n  echo there\n", "", "  padded  "];
    const h = harness({ open: () => Effect.succeed(LEADER), list: () => Effect.succeed([]) });

    expect(Exit.isSuccess(await create(argv, h))).toBe(true);

    expect(h.recorded.opened).toHaveLength(1);
    expect(h.recorded.opened[0]?.shell).toBe("bash");
    expect(h.recorded.opened[0]?.args).toEqual([
      "-lc",
      "\n echo hi\n  echo there\n",
      "",
      "  padded  ",
    ]);
    // The repositories withhold everything after argv[0] (`describeArguments`); they are handed
    // the words unchanged, so the lengths they keep are the real ones.
    expect(h.recorded.runCommands).toEqual([
      { executable: "bash", args: argv.slice(1), cwd: "/workspace/repo" },
    ]);
    expect(h.recorded.stored[0]?.argv).toEqual(argv);
  });
});

describe("opening a session's leader", () => {
  it("settles the run and the session when the daemon refuses to start the program", async () => {
    const h = harness({
      open: () =>
        Effect.fail(
          new SealantControlError({
            operation: "openSession",
            code: 4,
            message: "/bin/true: Argument list too long (os error 7)",
          }),
        ),
      list: () => Effect.die("a refusal is not asked about again"),
    });

    const exit = await create(["/bin/true", "secret-argument"], h);

    expect(JSON.stringify(exit)).toContain("SessionBadGatewayError");
    expect(h.recorded.settled).toEqual([
      "run failed: Failed to open the pty session: /bin/true: Argument list too long (os error 7)",
      "session failed",
    ]);
  });

  it("takes the leader the daemon reports when the open's answer was lost", async () => {
    const h = harness({ open: () => Effect.fail(transportLost()), list: listedLeader });

    const exit = await create(["bash", "-lc", "sleep 600"], h);

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(h.recorded.row).toMatchObject({
      status: "running",
      daemonSessionId: LEADER.sessionId,
      daemonProcessId: LEADER.processId,
    });
    expect(h.recorded.settled).toEqual([]);
  });

  it("settles both when the answer was lost and the daemon reports no leader for the run", async () => {
    const h = harness({
      open: () => Effect.fail(transportLost()),
      list: () => Effect.succeed([]),
    });

    const exit = await create(["bash", "-lc", "true"], h);

    expect(JSON.stringify(exit)).toContain("SessionBadGatewayError");
    expect(h.recorded.settled).toEqual([
      "run failed: Failed to open the pty session: connection closed",
      "session failed",
    ]);
  });

  it("leaves both open when the daemon cannot say, and a close finds the leader and stops it", async () => {
    let reachable = false;
    const h = harness({
      open: () => Effect.fail(transportLost()),
      list: (opened) => (reachable ? listedLeader(opened) : Effect.fail(transportLost())),
    });

    const exit = await create(["bash", "-lc", "sleep 600"], h);

    expect(JSON.stringify(exit)).toContain("Whether it started is unknown");
    expect(h.recorded.settled).toEqual([]);
    expect(h.recorded.row).toMatchObject({ status: "starting", daemonSessionId: null });

    reachable = true;
    const closed = await close(h.recorded.row?.id ?? "", h);

    expect(Exit.isSuccess(closed)).toBe(true);
    expect(h.recorded.closed).toEqual([LEADER.sessionId]);
    expect(h.recorded.row).toMatchObject({
      status: "exited",
      daemonSessionId: LEADER.sessionId,
      daemonProcessId: LEADER.processId,
    });
  });
});
