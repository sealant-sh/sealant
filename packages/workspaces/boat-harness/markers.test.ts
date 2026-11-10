import { describe, expect, it } from "vitest";

import { DEFECTS, PEER_PID, SLOW_CLOSE } from "./defects.js";
import { defectMatches, expectDefect, runScenario, type BodyOutcome } from "./markers.js";

/** The runtime view the harness prints, with a readiness launch error. */
const runtime = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    status: "failed",
    error_code: "launch-retained",
    error: 'Boat runtime: launch-held; diagnostic {"step":"readiness","errorClass":"Error"}',
    removed: false,
    allocation: "bound",
    ...extra,
  });
const peer =
  "; guest: WARN sealant_control::server: rejected control connection from unauthorized peer";
const terminalTimeout = (view: string) =>
  `timed out after 60s waiting for Mend to see a terminal workspace (stopped or failed, never retained) within 60 s; public status retained; runtime ${view}`;

describe("expected-failure markers", () => {
  it("name F3 at the launch outcome, never at a later timeout that still shows the old error", () => {
    expect(defectMatches(PEER_PID, `launch ended retained with ${runtime()}${peer}`)).toBe(true);
    // The review's repro: a later cleanup timeout with the earlier readiness error in the row.
    expect(defectMatches(PEER_PID, terminalTimeout(runtime()) + peer)).toBe(false);
    // Without the guest's evidence, a readiness failure is not F3.
    expect(defectMatches(PEER_PID, `launch ended retained with ${runtime()}`)).toBe(false);
  });

  it("hold a step-named marker to its step", () => {
    // How F3 was held to the happy path's ready step while it was expected there.
    const atReady = {
      ...PEER_PID,
      failure: /^step ready: launch ended \w+ with [^\n]*\\"step\\":\\"readiness\\"/,
    };
    const ready = `step ready: launch ended retained with ${runtime()}${peer}`;
    expect(defectMatches(atReady, ready)).toBe(true);
    expect(defectMatches(atReady, `step shell: exit 1: boom${peer}`)).toBe(false);
    expect(
      defectMatches(
        atReady,
        `step FINAL, deletion and release: ${terminalTimeout(runtime())}${peer}`,
      ),
    ).toBe(false);
    // The agent has no control bridge: the happy path must pass outright.
    expect(DEFECTS.happyPath).toBeUndefined();
  });

  it("let C1 excuse only the 60 s terminal timeout of a close in progress", () => {
    expect(defectMatches(SLOW_CLOSE, terminalTimeout(runtime({ allocation: "deleting" })))).toBe(
      true,
    );
    expect(
      defectMatches(
        SLOW_CLOSE,
        `left behind: live VM; runtime ${runtime({ allocation: "deleting" })}`,
      ),
    ).toBe(false);
    expect(defectMatches(SLOW_CLOSE, terminalTimeout(runtime({ allocation: "bound" })))).toBe(
      false,
    );
  });

  it("fail a scenario that no longer fails, and keep a different failure's message", async () => {
    await expect(expectDefect(PEER_PID, async () => {})).rejects.toThrow(/no longer reproduces/);
    await expect(
      expectDefect(PEER_PID, async () => {
        throw new Error("step shell: exit 1: boom");
      }),
    ).rejects.toThrow(/not the expected F3 .*step shell: exit 1/);
    await expect(expectDefect(SLOW_CLOSE, async () => {})).resolves.toBeUndefined();
  });

  it("never excuse a leak, even when the named failure matched", async () => {
    // The review's repro: a stuck delete with a held pin and a live VM. The marker excuses the
    // 60 s timeout; the release checks that follow still fail the scenario.
    const excused = async () => {
      throw new Error(terminalTimeout(runtime({ allocation: "deleting", pin: "pending" })));
    };
    await expect(
      runScenario(SLOW_CLOSE, excused, async () => [
        "publication pin pending",
        "live VM bx_23456789:idle",
      ]),
    ).rejects.toThrow(/left behind: publication pin pending/);
    await expect(runScenario(SLOW_CLOSE, excused, async () => [])).resolves.toBeUndefined();
    await expect(
      runScenario(
        undefined,
        async () => {},
        async () => ["tunnel slot still reserved"],
      ),
    ).rejects.toThrow(/tunnel slot still reserved/);
  });

  it("tell the release checks whether the body threw, even when a marker excused it", async () => {
    const seen: BodyOutcome[] = [];
    const record = async (outcome: BodyOutcome) => {
      seen.push(outcome);
      return [];
    };
    await runScenario(undefined, async () => {}, record);
    await runScenario(
      SLOW_CLOSE,
      async () => {
        throw new Error(terminalTimeout(runtime({ allocation: "deleting" })));
      },
      record,
    );
    await expect(
      runScenario(
        undefined,
        async () => {
          throw new Error("step shell: exit 1");
        },
        record,
      ),
    ).rejects.toThrow(/step shell/);
    expect(seen).toEqual([
      { bodyFailed: false, excusedBy: undefined },
      { bodyFailed: true, excusedBy: SLOW_CLOSE },
      { bodyFailed: true, excusedBy: undefined },
    ]);
  });
});
