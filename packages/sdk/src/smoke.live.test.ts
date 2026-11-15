/**
 * Live smoke test: proves the contract-DERIVED control-plane client actually reaches a running
 * control-plane API and decodes the response. Gated on `SEALANT_SMOKE_BASE_URL` so the default test
 * run (no live API) skips it. Run with:
 *
 *   SEALANT_SMOKE_BASE_URL=http://127.0.0.1:4000 pnpm --filter @sealant/sdk test
 */
import { Effect, Predicate } from "effect";
import { describe, expect, it } from "vitest";

import { SealantApiClient } from "./effect/api-client.js";
import { getWorkspaceOp } from "./effect/operations.js";
import { makeSdkRuntime } from "./effect/runtime.js";
import { opencode, Sealant } from "./index.js";
import { resolveInternalConfig } from "./internal/config.js";

const SMOKE_BASE_URL = process.env["SEALANT_SMOKE_BASE_URL"];
const baseUrl = SMOKE_BASE_URL ?? "http://127.0.0.1:4000";
// GitHub's own sample repository: public, tiny, and kept by GitHub (the SDK examples use it too).
const SMOKE_REPOSITORY = "github.com/octocat/Hello-World";

// Created via `POST /v1/runs`; requires the seeded FK parents `usr_local` + `ws_test`. Answers the
// run id, or why none was made.
const createRunViaApi = async (): Promise<
  { readonly runId: string } | { readonly refused: string }
> => {
  const response = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: "ws_test",
      ownerUserId: "usr_local",
      harnessId: "opencode",
      prompt: "smoke",
    }),
  });
  if (!response.ok) {
    return { refused: `POST /v1/runs answered ${response.status}` };
  }
  const body: unknown = await response.json();
  const runId = Predicate.isObject(body) ? body["runId"] : undefined;
  return typeof runId === "string" ? { runId } : { refused: "POST /v1/runs answered no runId" };
};

/**
 * The caller's env of the workspace as the control plane stored it: `spec.runtime.userEnv`, where
 * the SDK's `env` lands (the blueprint's `env` is the legacy, unvalidated field).
 */
const storedEnv = async (workspaceId: string): Promise<unknown> => {
  const config = resolveInternalConfig({ baseUrl });
  const runtime = makeSdkRuntime(config);
  try {
    // The owner the facade sends on this read: the host-local default the workspace was made for.
    const details = await runtime.run(getWorkspaceOp(workspaceId, config.hostLocal.ownerUserId));
    const spec: unknown = details.spec;
    const specRuntime = Predicate.isObject(spec) ? spec["runtime"] : undefined;
    return Predicate.isObject(specRuntime) ? specRuntime["userEnv"] : undefined;
  } finally {
    await runtime.dispose();
  }
};

describe.skipIf(SMOKE_BASE_URL === undefined)("@sealant/sdk live smoke (control-plane API)", () => {
  it("derives a working client from the contract and reaches /healthz", async () => {
    const runtime = makeSdkRuntime(resolveInternalConfig({ baseUrl }));
    try {
      const health = await runtime.run(
        Effect.flatMap(SealantApiClient, (client) => client.system.health()),
      );
      expect(health).toBeTruthy();
      expect(health.status).toBe("ok");
    } finally {
      await runtime.dispose();
    }
  });

  it("reads a run and its (empty) record through the fluent facade", async (ctx) => {
    const created = await createRunViaApi();
    if ("refused" in created) {
      // The FK parents are not seeded here: say so as a skip, never pass with nothing asserted.
      ctx.skip(`no run to read (${created.refused}); seed usr_local and ws_test`);
      return;
    }
    const { runId } = created;
    const sealant = new Sealant({ baseUrl });
    try {
      const run = await sealant.runs.get(runId);
      expect(run.id).toBe(runId);
      expect(run.result.status).toBe("queued");
      expect(run.result.outcome).toBe("failed"); // not yet completed

      const loss = await run.record.loss();
      expect(loss.complete).toBe(true);

      const summary = await run.record.summary();
      expect(summary.entries).toBe(0);

      const replay = await run.record.replay();
      expect(replay.entries).toEqual([]);
      expect(replay.at(0n)).toBeUndefined();
    } finally {
      await sealant.close();
    }
  });

  it("creates a workspace (enqueues a build) through the fluent facade", async () => {
    const sealant = new Sealant({ baseUrl });
    try {
      const workspace = await sealant.workspaces.create({
        repository: SMOKE_REPOSITORY,
        harness: opencode(),
        wait: false,
      });
      expect(workspace.id).toBeTruthy();
      const status = await workspace.status();
      expect(["queued", "running", "ready"]).toContain(status);
    } finally {
      await sealant.close();
    }
  });

  it("keeps `env` from create in the stored spec, read again for a handle from workspaces.get()", async () => {
    const sealant = new Sealant({ baseUrl });
    try {
      const workspace = await sealant.workspaces.create({
        repository: SMOKE_REPOSITORY,
        harness: opencode(),
        env: { WORKSPACE_ENV_PROOF: "sdk-smoke-canary" },
        wait: false,
      });
      expect(workspace.id).toBeTruthy();
      const reacquired = await sealant.workspaces.get(workspace.id);
      expect(reacquired.id).toBe(workspace.id);
      expect(await storedEnv(reacquired.id)).toEqual({ WORKSPACE_ENV_PROOF: "sdk-smoke-canary" });
    } finally {
      await sealant.close();
    }
  });

  // The heavyweight full proof: wait for the build, exec inside the live workspace through the
  // PUBLIC facade, and read the created-with env back — on the original handle AND on one
  // reacquired via workspaces.get(). First build on a cold stack can take minutes; opt in with
  // SEALANT_SMOKE_FULL=1 alongside SEALANT_SMOKE_BASE_URL.
  it.skipIf(process.env["SEALANT_SMOKE_FULL"] !== "1")(
    "a live workspace's processes inherit the created-with env (original + reacquired handle)",
    async () => {
      const sealant = new Sealant({ baseUrl });
      let workspace;
      try {
        workspace = await sealant.workspaces.create({
          repository: SMOKE_REPOSITORY,
          harness: opencode(),
          env: { WORKSPACE_ENV_PROOF: "sdk-smoke-canary" },
        });

        const direct = await workspace.exec(["/bin/sh", "-c", 'printf %s "$WORKSPACE_ENV_PROOF"']);
        expect(direct.exitCode).toBe(0);
        expect(direct.stdout).toBe("sdk-smoke-canary");

        const reacquired = await sealant.workspaces.get(workspace.id);
        const viaReacquired = await reacquired.exec([
          "/bin/sh",
          "-c",
          'printf %s "$WORKSPACE_ENV_PROOF"',
        ]);
        expect(viaReacquired.exitCode).toBe(0);
        expect(viaReacquired.stdout).toBe("sdk-smoke-canary");
      } finally {
        await workspace?.stop().catch(() => {});
        await sealant.close();
      }
    },
    600_000,
  );
});
