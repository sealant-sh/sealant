import {
  RunRepo,
  WorkspaceRepo,
  type RunRepoService,
  type WorkspaceRepoService,
} from "@sealant/db";
import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  bearerSubject,
  budgetMessage,
  budgetsOff,
  ceilingDecision,
  makeRateWindow,
  rateDecision,
  secondsUntilUtcMidnight,
  type BudgetLimits,
} from "./budgets.js";
import {
  requireActiveRunRoom,
  requireLiveWorkspaceRoom,
  spendOwnerLaunch,
} from "./owner-budgets.js";

const limits: BudgetLimits = {
  principalRequestsPerMinute: 3,
  ownerLaunchesPerMinute: 2,
  ownerLiveWorkspaces: 2,
  ownerActiveRuns: 2,
  ownerInferenceTokensPerDay: 100,
};

describe("rate windows (CORE-04)", () => {
  it("spends up to the limit, then says when there is room again", () => {
    const window = makeRateWindow();
    const take = (now: number) =>
      rateDecision(window, "principalRequestsPerMinute", "service:0", 3, now);
    expect([take(0), take(1_000), take(2_000)].every((decision) => decision.allowed)).toBe(true);
    const refused = take(3_000);
    expect(refused).toMatchObject({ allowed: false, limit: 3, retryAfterSeconds: 57 });
    // A refused request spends nothing: the window frees exactly when the oldest unit leaves.
    expect(take(59_999).allowed).toBe(false);
    expect(take(60_000).allowed).toBe(true);
  });

  it("keeps subjects apart, and 0 turns a budget off", () => {
    const window = makeRateWindow();
    expect(rateDecision(window, "principalRequestsPerMinute", "a", 1, 0).allowed).toBe(true);
    expect(rateDecision(window, "principalRequestsPerMinute", "a", 1, 1).allowed).toBe(false);
    expect(rateDecision(window, "principalRequestsPerMinute", "b", 1, 1).allowed).toBe(true);
    for (let i = 0; i < 50; i += 1) {
      expect(rateDecision(window, "principalRequestsPerMinute", "c", 0, i).allowed).toBe(true);
    }
  });

  it("forgets idle subjects on a timer, not on every request", () => {
    const window = makeRateWindow(1_000);
    for (let i = 0; i < 2_000; i += 1) window.take(`s${i}`, 5, 0);
    expect(window.subjects()).toBe(2_000);
    window.take("late", 5, 10_000);
    expect(window.subjects()).toBe(1);
  });

  it("counts subjects beyond the cap together, so distinct names cannot grow it without bound", () => {
    const window = makeRateWindow(60_000, 3);
    expect(window.take("a", 2, 0)).toBeNull();
    expect(window.take("b", 2, 0)).toBeNull();
    expect(window.take("c", 2, 0)).toBeNull();
    // Every further name shares one window: two units, then refused.
    expect(window.take("d", 2, 0)).toBeNull();
    expect(window.take("e", 2, 0)).toBeNull();
    expect(window.take("f", 2, 0)).not.toBeNull();
    expect(window.subjects()).toBe(4);
    // A subject already known keeps its own window.
    expect(window.take("a", 2, 0)).toBeNull();
  });

  it("names a bearer by a digest, never by the secret", () => {
    expect(bearerSubject("slt_secret")).toMatch(/^bearer:[0-9a-f]{16}$/);
    expect(bearerSubject("slt_secret")).not.toContain("slt_secret");
  });
});

describe("ceilings and words", () => {
  it("refuses at the ceiling, not before", () => {
    expect(ceilingDecision("ownerLiveWorkspaces", 1, 2, 30).allowed).toBe(true);
    expect(ceilingDecision("ownerLiveWorkspaces", 2, 2, 30).allowed).toBe(false);
    expect(ceilingDecision("ownerLiveWorkspaces", 99, 0, 30).allowed).toBe(true);
  });

  it("says what was refused and that nothing running was stopped", () => {
    const decision = ceilingDecision("ownerActiveRuns", 2, 2, 30);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(budgetMessage(decision)).toBe(
        "Budget reached: 2 active runs for this owner. Nothing that is running was stopped; retry in 30s.",
      );
    }
  });

  it("reports which budgets are off", () => {
    expect(budgetsOff(limits)).toEqual([]);
    expect(budgetsOff({ ...limits, ownerInferenceTokensPerDay: 0 })).toEqual([
      "ownerInferenceTokensPerDay",
    ]);
  });

  it("a daily budget has room again at the next UTC midnight", () => {
    expect(secondsUntilUtcMidnight(new Date("2026-09-17T23:59:30.000Z"))).toBe(30);
    expect(secondsUntilUtcMidnight(new Date("2026-09-17T00:00:00.000Z"))).toBe(86_400);
  });
});

/** Repositories that answer `live` workspaces and `active` runs for any owner. */
const counted = (live: number, active: number) =>
  Layer.mergeAll(
    Layer.succeed(WorkspaceRepo, {
      listWorkspaces: (input: { readonly ownerUserId?: string; readonly limit?: number }) =>
        Effect.succeed(
          Array.from({ length: Math.min(live, input.limit ?? live) }, (_, index) => ({
            id: `ws_${index}`,
            ownerUserId: input.ownerUserId,
          })),
        ),
    } as unknown as WorkspaceRepoService),
    Layer.succeed(RunRepo, {
      listRuns: (input: { readonly ownerUserId?: string; readonly limit?: number }) =>
        Effect.succeed(
          Array.from({ length: Math.min(active, input.limit ?? active) }, (_, index) => ({
            id: `run_${index}`,
            ownerUserId: input.ownerUserId,
          })),
        ),
    } as unknown as RunRepoService),
  );
const outcome = <A, E>(
  effect: Effect.Effect<A, E, WorkspaceRepo | RunRepo>,
  layer = counted(0, 0),
) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.result));

describe("per-owner budgets as handlers apply them", () => {
  it("an owner at the workspace ceiling is refused a new one with a 429 error", async () => {
    expect(
      Result.isSuccess(await outcome(requireLiveWorkspaceRoom("usr_a", { limits }), counted(1, 0))),
    ).toBe(true);
    const refused = await outcome(requireLiveWorkspaceRoom("usr_a", { limits }), counted(2, 0));
    expect(Result.isFailure(refused)).toBe(true);
    expect(String(refused)).toMatch(/BudgetExceededError/);
    expect(String(refused)).toMatch(/2 live workspaces for this owner/);
  });

  it("an owner at the run ceiling is refused a new run", async () => {
    expect(
      Result.isSuccess(await outcome(requireActiveRunRoom("usr_a", { limits }), counted(0, 1))),
    ).toBe(true);
    expect(
      Result.isFailure(await outcome(requireActiveRunRoom("usr_a", { limits }), counted(0, 5))),
    ).toBe(true);
  });

  it("launches are counted per owner", async () => {
    const window = makeRateWindow();
    const launch = (owner: string, now: number) =>
      outcome(spendOwnerLaunch(owner, { limits, window, now }));
    expect(Result.isSuccess(await launch("usr_a", 0))).toBe(true);
    expect(Result.isSuccess(await launch("usr_a", 1))).toBe(true);
    expect(Result.isFailure(await launch("usr_a", 2))).toBe(true);
    expect(Result.isSuccess(await launch("usr_b", 2))).toBe(true);
  });
});
