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
import { Effect, Layer } from "effect";
import { vi } from "vitest";

import {
  SealantControlError,
  SealantRuntime,
  TransportError,
  type CaptureFlushReport,
  type CaptureFlushRequest,
  type SealantSession,
} from "../sealantd/runtime.js";

export type CaptureDaemonAnswer = CaptureFlushReport | "unreachable" | "refused";

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

const answerWith = (command: "flush" | "status", value: CaptureDaemonAnswer) => {
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
  return Effect.succeed(value);
};

export const fakeCaptureDaemon = (script: readonly CaptureDaemonAnswer[]) => {
  let index = 0;
  const next = (): CaptureDaemonAnswer => {
    const answer = script[Math.min(index, script.length - 1)] ?? "unreachable";
    index += 1;
    return answer;
  };
  const calls: Array<"flush" | "status"> = [];
  /** Every flush request as sent (`undefined` = no arguments). */
  const flushRequests: Array<CaptureFlushRequest | undefined> = [];

  const connect = vi.fn(() => {
    const value = next();
    if (value === "unreachable") {
      return Effect.fail(
        new TransportError({ operation: "open", message: "connection refused", cause: undefined }),
      );
    }
    const session = {
      captureFlush: (request?: CaptureFlushRequest) => {
        calls.push("flush");
        flushRequests.push(request);
        return answerWith("flush", value);
      },
      captureStatus: () => {
        calls.push("status");
        return answerWith("status", value);
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
