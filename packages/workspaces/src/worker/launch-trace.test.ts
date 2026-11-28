import { describe, expect, it } from "@effect/vitest";
import { runtimeInstanceRow } from "@sealant/db/testing/rows";
import { Effect, Option, Tracer } from "effect";

import { asLaunchFollowUp, linkToLaunch } from "./launch-trace.js";

const LAUNCH = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

/** Every span `effect` makes, as the exporter would see it. */
const spansOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const made: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        made.push(span);
        return span;
      },
    });
    yield* effect.pipe(Effect.withTracer(tracer));
    return made;
  });

const linkedTo = (span: Tracer.NativeSpan | undefined) =>
  span?.links.map((link) => `${link.span.traceId}-${link.span.spanId}`);

describe("a launch's follow-up work", () => {
  it.effect("is a trace of its own, linked to the launch, even inside another span", () =>
    Effect.gen(function* () {
      const instance = runtimeInstanceRow({ runId: "run_1", launchTraceparent: LAUNCH });
      const [sweep, followUp] = yield* spansOf(
        Effect.void.pipe(
          asLaunchFollowUp("sealant.workspace.reap_runtime", instance, {
            "sealant.run_id": "run_1",
          }),
          Effect.withSpan("sealant.workspace.sweep"),
        ),
      );
      expect(followUp?.name).toBe("sealant.workspace.reap_runtime");
      expect(Option.isNone(followUp?.parent ?? Option.some(sweep))).toBe(true);
      expect(followUp?.traceId).not.toBe(sweep?.traceId);
      expect(linkedTo(followUp)).toEqual(["0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331"]);
    }),
  );

  it.effect("links nothing when the launch recorded no trace, or one that does not parse", () =>
    Effect.gen(function* () {
      const spans = yield* spansOf(
        Effect.all([
          Effect.void.pipe(
            asLaunchFollowUp("sealant.workspace.recover_executor", runtimeInstanceRow(), {}),
          ),
          Effect.void.pipe(
            asLaunchFollowUp(
              "sealant.workspace.recover_executor",
              runtimeInstanceRow({ launchTraceparent: "00-not-a-trace-01" }),
              {},
            ),
          ),
        ]),
      );
      expect(spans.map((span) => span.links.length)).toEqual([0, 0]);
    }),
  );

  it.effect("links a request or a delivery that acts on the executor to its launch", () =>
    Effect.gen(function* () {
      const [restart] = yield* spansOf(
        linkToLaunch(runtimeInstanceRow({ launchTraceparent: LAUNCH })).pipe(
          Effect.withSpan("sealant.workspace.restart"),
        ),
      );
      expect(linkedTo(restart)).toEqual(["0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331"]);
    }),
  );
});
