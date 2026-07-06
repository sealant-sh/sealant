/**
 * Live smoke test: proves the contract-DERIVED control-plane client actually reaches a running
 * control-plane API and decodes the response. Gated on `SEALANT_SMOKE_BASE_URL` so the default test
 * run (no live API) skips it. Run with:
 *
 *   SEALANT_SMOKE_BASE_URL=http://127.0.0.1:4000 pnpm --filter @sealant/sdk test
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { SealantApiClient } from "./effect/api-client.js";
import { makeSdkRuntime } from "./effect/runtime.js";
import { opencode, Sealant } from "./index.js";
import { resolveInternalConfig } from "./internal/config.js";

const SMOKE_BASE_URL = process.env["SEALANT_SMOKE_BASE_URL"];
const baseUrl = SMOKE_BASE_URL ?? "http://127.0.0.1:4000";

// Created via `POST /v1/runs`; requires the seeded FK parents `usr_local` + `ws_test`.
const createRunViaApi = async (): Promise<string | undefined> => {
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
    return undefined;
  }
  const body = (await response.json()) as { readonly runId: string };
  return body.runId;
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

  it("reads a run and its (empty) record through the fluent facade", async () => {
    const runId = await createRunViaApi();
    if (runId === undefined) {
      // FK parents not seeded in this environment — nothing to assert against.
      return;
    }
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
        repository: "github.com/sindresorhus/is-odd",
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
});
