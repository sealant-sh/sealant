/**
 * Live session output as Server-Sent Events — `GET /v1/sessions/:sessionId/output/stream`.
 *
 * Registered as a RAW streaming route (the schema-derived HttpApi cannot express an unbounded
 * `text/event-stream` body). Semantics mirror `getSessionOutput`, looped: replay from `?from=`
 * (byte-exact recorded history), then tail the durable record until the session settles.
 *
 * Wire shape per chunk:   `event: output` + `id: <sequence>` + `data: <base64>`
 * Terminal event:         `event: end` + `data: {"status":...,"exitCode":...}`
 * Keep-alive:             `: ping` comment every ~15s of silence.
 *
 * Reconnect: pass the last received SSE id (+1) as `?from=` — the id IS the durable telemetry
 * sequence, so a reconnecting client resumes byte-exact with no gap. Scope: `session:read`.
 */
import {
  SessionBadRequestError,
  SessionForbiddenError,
  SessionNotFoundError,
  SessionUnauthorizedError,
} from "@sealant/api-contracts";
import {
  RunRepo,
  WorkspaceRepo,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceSessionRepo,
  type WorkspaceSession,
} from "@sealant/db";
import { TelemetryQuery } from "@sealant/telemetry";
import { Effect, Option, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import {
  authorize,
  reconcileSession,
  requireSession,
  SESSION_OUTPUT_STREAM_KINDS,
} from "./sessions.module.js";

const POLL_INTERVAL_MS = 250;
const PING_INTERVAL_MS = 15_000;
const PAGE_LIMIT = 500;

const encoder = new TextEncoder();

const sseEvent = (event: string, id: string | undefined, data: string): Uint8Array =>
  encoder.encode(`event: ${event}\n${id === undefined ? "" : `id: ${id}\n`}data: ${data}\n\n`);

const ssePing = encoder.encode(": ping\n\n");

interface TailState {
  readonly session: WorkspaceSession;
  readonly from: bigint;
  readonly lastEmitAt: number;
}

const delay = (ms: number) => Effect.promise(() => new Promise((r) => setTimeout(r, ms)));

/** One poll step: read a page of recorded chunks, settle-check, emit SSE frames. */
const step = (state: TailState) =>
  Effect.gen(function* () {
    const query = yield* TelemetryQuery;
    const chunks = yield* query.scrollbackChunks(state.session.runId, SESSION_OUTPUT_STREAM_KINDS, {
      ...(state.session.daemonSessionId === null
        ? {}
        : { sessionId: state.session.daemonSessionId }),
      fromSequence: state.from,
      limit: PAGE_LIMIT,
    });

    if (chunks.length > 0) {
      const frames = chunks.map((chunk) =>
        sseEvent("output", chunk.sequence.toString(), Buffer.from(chunk.bytes).toString("base64")),
      );
      const last = chunks[chunks.length - 1];
      const nextFrom = last === undefined ? state.from : last.sequence + 1n;
      return [
        frames,
        Option.some<TailState>({ ...state, from: nextFrom, lastEmitAt: Date.now() }),
      ] as const;
    }

    // Nothing new — has the session settled? (DB-only check; exit evidence implies the tail is in.)
    const reconciled = yield* reconcileSession(state.session);
    if (reconciled.status === "exited" || reconciled.status === "failed") {
      const end = sseEvent(
        "end",
        undefined,
        JSON.stringify({
          status: reconciled.status,
          ...(reconciled.exitCode === null ? {} : { exitCode: reconciled.exitCode }),
          ...(reconciled.exitSignal === null ? {} : { exitSignal: reconciled.exitSignal }),
        }),
      );
      return [[end], Option.none<TailState>()] as const;
    }

    yield* delay(POLL_INTERVAL_MS);
    const needsPing = Date.now() - state.lastEmitAt >= PING_INTERVAL_MS;
    return [
      needsPing ? [ssePing] : [],
      Option.some<TailState>({
        ...state,
        session: reconciled,
        ...(needsPing ? { lastEmitAt: Date.now() } : {}),
      }),
    ] as const;
  });

export const SessionOutputStreamRoute = HttpRouter.add(
  "GET",
  "/v1/sessions/:sessionId/output/stream",
  (request) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const sessionId = params["sessionId"];
      if (sessionId === undefined) {
        return HttpServerResponse.text("missing sessionId", { status: 400 });
      }
      const url = new URL(request.url, "http://localhost");
      const fromRaw = url.searchParams.get("from") ?? undefined;
      const ownerUserId = url.searchParams.get("ownerUserId") ?? undefined;
      let from: bigint;
      try {
        from = fromRaw === undefined ? 0n : BigInt(fromRaw);
      } catch {
        return HttpServerResponse.text("from must be a decimal integer", { status: 400 });
      }

      const authorization = request.headers["authorization"];
      const outcome = yield* authorize({
        headers: authorization === undefined ? {} : { authorization },
        requiredScope: "session:read",
        assertedOwnerUserId: ownerUserId,
      }).pipe(
        Effect.flatMap((principal) => requireSession(sessionId, principal)),
        Effect.map((session) => ({ ok: true as const, session })),
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            status:
              error instanceof SessionUnauthorizedError
                ? 401
                : error instanceof SessionForbiddenError
                  ? 403
                  : error instanceof SessionNotFoundError
                    ? 404
                    : error instanceof SessionBadRequestError
                      ? 400
                      : 500,
            message: error.message,
          }),
        ),
      );
      if (!outcome.ok) {
        return HttpServerResponse.text(outcome.message, { status: outcome.status });
      }

      const initial: TailState = {
        session: outcome.session,
        from,
        lastEmitAt: Date.now(),
      };
      // The response body is pulled after this handler returns, outside the request's Effect
      // context — capture the context now and provide it into the stream.
      const context = yield* Effect.context<
        | TelemetryQuery
        | RunRepo
        | WorkspaceRepo
        | WorkspaceRuntimeInstanceRepo
        | WorkspaceSessionRepo
      >();
      // `paginate` emits each frame in the step's array as one stream element.
      const body = Stream.paginate(initial, step).pipe(
        Stream.provideContext(context),
        Stream.catchCause(() => Stream.empty),
      );

      return HttpServerResponse.stream(body, {
        contentType: "text/event-stream",
        headers: {
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    }),
);
