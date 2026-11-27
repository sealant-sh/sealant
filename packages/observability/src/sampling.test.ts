/**
 * Which traces a process starts: only a request, a job delivery or named work may be a trace's
 * root. A query, a layer's construction or a function-named helper that runs outside all three is
 * never sampled, and neither is anything beneath it, so Sentry never shows it as a trace alone.
 */
import { Effect, Tracer } from "effect";
import { describe, expect, it } from "vitest";

import { samplingTracer } from "./layer.js";

/** The spans `effect` makes through the sampling tracer, with their sampling decisions. */
const sampledSpans = async <A, E>(effect: Effect.Effect<A, E>) => {
  const made: Array<{ readonly name: string; readonly sampled: boolean }> = [];
  const recording = Tracer.make({
    span: (options) => {
      const span = Tracer.nativeTracer.span(options);
      made.push({ name: span.name, sampled: span.sampled });
      return span;
    },
  });
  await Effect.runPromise(effect.pipe(Effect.withTracer(samplingTracer(recording, 1))));
  return made;
};

const query = Effect.void.pipe(Effect.withSpan("postgres", { kind: "client" }));

describe("samplingTracer", () => {
  it("never samples a lone query, a layer build or a helper as a root, nor what it holds", async () => {
    const made = await sampledSpans(
      Effect.all([
        query,
        query.pipe(Effect.withSpan("PgDrizzle.make")),
        query.pipe(Effect.withSpan("syncBackWorkspaceCredentials")),
      ]),
    );
    expect(made).toEqual([
      { name: "postgres", sampled: false },
      { name: "PgDrizzle.make", sampled: false },
      { name: "postgres", sampled: false },
      { name: "syncBackWorkspaceCredentials", sampled: false },
      { name: "postgres", sampled: false },
    ]);
  });

  it("samples a request, a job delivery and named work, and the queries beneath them", async () => {
    const made = await sampledSpans(
      Effect.all([
        query.pipe(Effect.withSpan("GET", { kind: "server" })),
        query.pipe(Effect.withSpan("sealant.job.process", { kind: "consumer" })),
        query.pipe(Effect.withSpan("sealant.workspace.sweep_stranded_launches")),
      ]),
    );
    expect(made).toEqual([
      { name: "GET", sampled: true },
      { name: "postgres", sampled: true },
      { name: "sealant.job.process", sampled: true },
      { name: "postgres", sampled: true },
      { name: "sealant.workspace.sweep_stranded_launches", sampled: true },
      { name: "postgres", sampled: true },
    ]);
  });
});
