/** A status the daemon reports after a FINAL flush that saved everything. */
export const savedStatus = (overrides: Partial<CaptureFlushReport> = {}): CaptureFlushReport => ({
  epoch: 1,
  worktreeId: "wt_1",
  pending: 0,
  stagedBytes: 0,
  uploadedObjects: 0,
  uploadedBytes: 0,
  registered: 0,
  fenced: false,
  paused: false,
  refused: [],
  complete: true,
  ...overrides,
});

/**
 * A scripted sealantd for drain tests: each `capture.flush` / `capture.status` round trip takes
 * the next answer from the script (the last one repeats). `unreachable` fails the connection the
 * way a dead daemon or a dropped bridge does; `refused` answers with a control error.
 */
import { Deferred, Effect, Layer } from "effect";
import { vi } from "vitest";

import {
  SealantControlError,
  SealantRuntime,
  SealantUnexpectedError,
  TransportError,
  type CaptureFlushReport,
  type CaptureFlushRequest,
  type SealantSession,
} from "../sealantd/runtime.js";

/**
 * `closed`: the connection opens and the request goes out, then the connection closes before any
 * answer (a FINAL's sweep killed the relay that carried it).
 */
export type CaptureDaemonAnswer = CaptureFlushReport | "unreachable" | "refused" | "closed";

/**
 * An answer the daemon holds until the test lets it go: `reached` completes when the daemon is
 * asked for it (the drain is inside this round trip, its claim held), and the answer goes out
 * once `open` is completed. A test that needs "while the drain is under way" waits on `reached`
 * instead of a wall-clock pause, and the drain runs for exactly as long as the test holds `open`.
 */
export interface GatedCaptureDaemonAnswer {
  readonly gated: CaptureDaemonAnswer;
  readonly reached: Deferred.Deferred<void>;
  readonly open: Deferred.Deferred<void>;
}

export type CaptureDaemonScriptEntry = CaptureDaemonAnswer | GatedCaptureDaemonAnswer;

const isGated = (entry: CaptureDaemonScriptEntry): entry is GatedCaptureDaemonAnswer =>
  typeof entry === "object" && "gated" in entry;

export const captureStatus = (overrides: Partial<CaptureFlushReport> = {}): CaptureFlushReport => ({
  epoch: 1,
  worktreeId: "wt_1",
  pending: 0,
  stagedBytes: 0,
  uploadedObjects: 0,
  uploadedBytes: 0,
  registered: 0,
  fenced: false,
  paused: false,
  refused: [],
  ...overrides,
});

const answerWith = (
  command: "flush" | "status",
  value: CaptureDaemonAnswer,
): Effect.Effect<CaptureFlushReport, SealantControlError | SealantUnexpectedError> => {
  if (value === "refused") {
    return Effect.fail(
      new SealantControlError({
        operation: command === "flush" ? "captureFlush" : "captureStatus",
        code: 9,
        message: "capture is not configured on this daemon",
      }),
    );
  }
  if (value === "unreachable") {
    return Effect.die("unreachable answers fail at connect");
  }
  if (value === "closed") {
    return Effect.fail(
      new SealantUnexpectedError({
        operation: command === "flush" ? "captureFlush" : "captureStatus",
        message: "connection closed",
        cause: new Error("connection closed"),
      }),
    );
  }
  return Effect.succeed(value);
};

export const fakeCaptureDaemon = (script: readonly CaptureDaemonScriptEntry[]) => {
  let index = 0;
  const next = (): CaptureDaemonScriptEntry => {
    const answer = script[Math.min(index, script.length - 1)] ?? "unreachable";
    index += 1;
    return answer;
  };
  const calls: Array<"flush" | "status"> = [];
  /** Every flush request as sent (`undefined` = no arguments). */
  const flushRequests: Array<CaptureFlushRequest | undefined> = [];

  const connect = vi.fn(() => {
    const entry = next();
    const value = isGated(entry) ? entry.gated : entry;
    if (value === "unreachable") {
      return Effect.fail(
        new TransportError({ operation: "open", message: "connection refused", cause: undefined }),
      );
    }
    const answer = (command: "flush" | "status") =>
      isGated(entry)
        ? Deferred.succeed(entry.reached, undefined).pipe(
            Effect.andThen(Deferred.await(entry.open)),
            Effect.andThen(answerWith(command, value)),
          )
        : answerWith(command, value);
    const session = {
      captureFlush: (request?: CaptureFlushRequest) => {
        calls.push("flush");
        flushRequests.push(request);
        return answer("flush");
      },
      captureStatus: () => {
        calls.push("status");
        return answer("status");
      },
    };
    // Only the capture commands are scripted; any other use is a test bug and dies loudly.
    return Effect.succeed(
      new Proxy(session, {
        get: (target, property) =>
          property in target
            ? Reflect.get(target, property)
            : () => Effect.die(`unscripted daemon call ${String(property)}`),
      }) as unknown as SealantSession,
    );
  });

  return {
    calls,
    flushRequests,
    connect,
    layer: Layer.succeed(SealantRuntime, { connect }),
  };
};
