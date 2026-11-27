/**
 * A launch's trace, as later work on its executor points back at it. The launch records its span's
 * W3C context on the runtime instance row (`launch_traceparent`). A sweep, a reaper, a restart or a
 * recovery that acts on the executor afterwards runs in a trace of its own, one per executor it
 * handles, with a span link to the launch: the launch's trace ended with the launch, so nothing is
 * parented under it and no trace stays open for the executor's life.
 */
import type { WorkspaceRuntimeInstance } from "@sealant/db";
import { parentOf } from "@sealant/observability";
import { Effect, Option, type Tracer } from "effect";

type LaunchRecord = Pick<WorkspaceRuntimeInstance, "launchTraceparent" | "launchTracestate">;

/** The link to the launch `instance` recorded, when it recorded one that parses. */
export const launchLinkOf = (instance: LaunchRecord | undefined): Tracer.SpanLink | undefined => {
  const traceparent = instance?.launchTraceparent ?? null;
  if (traceparent === null) return undefined;
  const tracestate = instance?.launchTracestate ?? null;
  const span = parentOf({ traceparent, ...(tracestate === null ? {} : { tracestate }) });
  return span === undefined ? undefined : { span, attributes: { "sealant.link": "launch" } };
};

/**
 * `effect` as one unit of a sweep's work on an executor: a trace of its own named `name`
 * (`sealant.workspace.<operation>`), linked to the executor's launch when `instance` recorded it.
 */
export const asLaunchFollowUp =
  (
    name: string,
    instance: LaunchRecord | undefined,
    attributes: Readonly<Record<string, string>>,
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const link = launchLinkOf(instance);
    return Effect.withSpan(effect, name, {
      root: true,
      links: link === undefined ? [] : [link],
      attributes,
      captureStackTrace: false,
    });
  };

/**
 * Link the current span to `instance`'s launch: for work that already has a trace of its own (a
 * request, a job delivery) and acts on an executor another trace launched.
 */
export const linkToLaunch = (instance: LaunchRecord | undefined): Effect.Effect<void> => {
  const link = launchLinkOf(instance);
  if (link === undefined) return Effect.void;
  return Effect.currentSpan.pipe(
    Effect.option,
    Effect.map(Option.map((span) => span.addLinks([link]))),
    Effect.asVoid,
  );
};
