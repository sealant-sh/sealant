/**
 * `workspace.dotfiles.apply()` against a stub contract client (no live API): the options lower onto
 * `POST /v1/workspaces/:id/dotfiles` (a repository shorthand becomes its clone URL, archives as they
 * are, the workspace the client owner's); the call resolves once the run's record shows the
 * bootstrap started (the files are applied) or the run ended; `bootstrap.wait()` reads the
 * bootstrap's exit code and output from the record; a run that failed before any bootstrap rejects
 * with `dotfiles_failed` and the daemon's words.
 */
import type {
  ApplyWorkspaceDotfilesRequest,
  Run as WireRun,
  RunTimelineResponse,
} from "@sealant/api-contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { type ControlPlaneClient, SealantApiClient } from "./effect/api-client.js";
import type { SdkRuntime, SdkServices } from "./effect/runtime.js";
import { SealantError } from "./errors.js";
import type { SdkContext } from "./facade/context.js";
import { makeWorkspace } from "./facade/workspace.js";
import { resolveInternalConfig } from "./internal/config.js";

const wireRun = (status: WireRun["status"], overrides: Partial<WireRun> = {}): WireRun => ({
  runId: "run_dots",
  workspaceId: "ws_1",
  ownerUserId: "usr_owner",
  harnessId: "dotfiles",
  mode: "one-shot",
  status,
  createdAt: "2026-10-07T00:00:00.000Z",
  updatedAt: "2026-10-07T00:00:00.000Z",
  ...overrides,
});

const bootstrapStarted: RunTimelineResponse = {
  items: [
    {
      eventId: "evt_1",
      sequence: "1",
      kind: "processStarted",
      occurredAt: "1",
      summary: "/bin/sh (2 arguments not recorded)",
      ref: { executable: "/bin/sh" },
      processId: "proc_boot",
      captureMethod: 1,
      confidence: 1,
    },
  ],
};

/** The `index`th answer of `list`; the last repeats. */
const at = <A>(list: readonly A[], index: number): A => {
  const value = list[Math.min(index, list.length - 1)];
  if (value === undefined) throw new Error("the stub has nothing to answer");
  return value;
};

const makeStub = (script: {
  /** The run as each read finds it, in order; the last repeats. */
  readonly runs: readonly WireRun[];
  /** The timeline as each read finds it, in order; the last repeats. */
  readonly timelines: readonly RunTimelineResponse[];
}) => {
  const requests: ApplyWorkspaceDotfilesRequest[] = [];
  const reads = { run: 0, timeline: 0 };
  const client = {
    workspaces: {
      applyWorkspaceDotfiles: ({ payload }: { payload: ApplyWorkspaceDotfilesRequest }) => {
        requests.push(payload);
        return Effect.succeed(wireRun("queued"));
      },
    },
    runs: {
      getRun: () => Effect.sync(() => at(script.runs, reads.run++)),
      getRunTimeline: () => Effect.sync(() => at(script.timelines, reads.timeline++)),
      getRunScrollback: ({ query }: { query: { stream: "stdout" | "stderr" } }) =>
        Effect.succeed({
          processId: "proc_boot",
          stream: query.stream,
          byteCount: 1,
          contentBase64: Buffer.from(
            query.stream === "stdout" ? "installed zsh plugins\n" : "warning: no fzf\n",
          ).toString("base64"),
        }),
    },
  } as unknown as ControlPlaneClient;
  const ctx: SdkContext = {
    runtime: {
      run: <A, E, R extends SdkServices>(effect: Effect.Effect<A, E, R>): Promise<A> =>
        // The stub provides all of SdkServices; see run-lifecycle.test.ts for the same narrowing.
        Effect.runPromise(
          Effect.provideService(effect, SealantApiClient, client) as Effect.Effect<A, E>,
        ),
      dispose: () => Promise.resolve(),
    } satisfies SdkRuntime,
    config: resolveInternalConfig({ baseUrl: "http://stub.invalid", ownerUserId: "usr_owner" }),
  };
  const workspace = makeWorkspace(ctx, { id: "ws_1", name: "t", status: "ready" });
  return { workspace, requests, reads };
};

const ARCHIVE = Buffer.from("tarball").toString("base64");

describe("workspace.dotfiles.apply()", () => {
  it("resolves once the bootstrap started, and wait() reads its exit and output", async () => {
    const stub = makeStub({
      runs: [
        wireRun("queued"),
        wireRun("running"),
        wireRun("running"),
        wireRun("completed", { exitCode: 2 }),
      ],
      timelines: [{ items: [] }, bootstrapStarted],
    });
    const applied = await stub.workspace.dotfiles.apply({
      user: "m4lice000",
      home: "/home/m4lice000",
      repository: { url: "github.com/acme/dots", ref: "main", bootstrap: true },
      archives: [{ data: ARCHIVE, manager: "copy" }],
    });
    expect(stub.requests).toEqual([
      {
        ownerUserId: "usr_owner",
        user: "m4lice000",
        home: "/home/m4lice000",
        repository: { url: "https://github.com/acme/dots.git", ref: "main", bootstrap: true },
        archives: [{ data: ARCHIVE, manager: "copy" }],
      },
    ]);
    expect(applied).toMatchObject({
      user: "m4lice000",
      home: "/home/m4lice000",
      runId: "run_dots",
      bootstrap: { processId: "proc_boot" },
    });
    // A failing install.sh is a datum: wait() resolves with it.
    await expect(applied.bootstrap?.wait()).resolves.toEqual({
      exitCode: 2,
      stdout: "installed zsh plugins\n",
      stderr: "warning: no fzf\n",
    });
  });

  it("answers no bootstrap when the run completes without one", async () => {
    const stub = makeStub({
      runs: [wireRun("completed", { exitCode: 0 })],
      timelines: [{ items: [] }],
    });
    const applied = await stub.workspace.dotfiles.apply({
      user: "m4lice000",
      home: "/home/m4lice000",
      archives: [{ data: ARCHIVE }],
    });
    expect(applied.bootstrap).toBeNull();
  });

  it("rejects with dotfiles_failed and the daemon's words when the apply failed", async () => {
    const stub = makeStub({
      runs: [
        wireRun("failed", {
          errorMessage:
            "The dotfiles were not applied as m4lice000: dotfiles.apply as m4lice000: git clone of dotfiles exited with 128",
        }),
      ],
      timelines: [{ items: [] }],
    });
    const outcome = await stub.workspace.dotfiles
      .apply({ user: "m4lice000", home: "/home/m4lice000", archives: [{ data: ARCHIVE }] })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(outcome).toBeInstanceOf(SealantError);
    expect(outcome).toMatchObject({
      code: "dotfiles_failed",
      message: expect.stringMatching(/git clone of dotfiles exited with 128/),
    });
  });

  it("hands back a bootstrap whose wait() rejects when the bootstrap was stopped", async () => {
    const stub = makeStub({
      runs: [
        wireRun("failed", {
          errorMessage:
            "The dotfiles were applied as m4lice000; their bootstrap ran for more than 30 minutes and was stopped.",
        }),
      ],
      timelines: [bootstrapStarted],
    });
    const applied = await stub.workspace.dotfiles.apply({
      user: "m4lice000",
      home: "/home/m4lice000",
      archives: [{ data: ARCHIVE }],
    });
    await expect(applied.bootstrap?.wait()).rejects.toMatchObject({ code: "dotfiles_failed" });
  });
});
