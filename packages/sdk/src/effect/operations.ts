/**
 * Effect operations over the derived control-plane client. Thin: each yields the client and calls one
 * contract endpoint, returning the WIRE type. The facade maps wire -> public types and the runtime
 * maps the typed Effect failure -> a plain `SealantError`. Keeping these here (rather than inline in
 * the facade) keeps the wire surface in one place and unit-testable.
 */
import type {
  CreateRunRequest,
  CreateSandboxRequest,
  GetRunScrollbackQuery,
  GetRunTimelineQuery,
  ListRunsQuery,
  ListSandboxesQuery,
  Run as WireRun,
  RunChangesResponse,
  RunLossReport,
  RunScrollbackResponse,
  SandboxDetails,
  TimelineEntry as WireTimelineEntry,
  UpdateRunRequest,
} from "@sealant/api-contracts";
import { Effect } from "effect";

import { SealantApiClient } from "./api-client.js";

// ---- sandboxes ----

export const createSandboxOp = (payload: CreateSandboxRequest, idempotencyKey?: string) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.sandboxes.createSandbox({
      payload,
      headers: idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey },
    }),
  );

export const getSandboxOp = (
  sandboxId: string,
): Effect.Effect<SandboxDetails, unknown, SealantApiClient> =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.sandboxes.getSandbox({ params: { sandboxId } }),
  );

export const listSandboxesOp = (query: ListSandboxesQuery) =>
  Effect.flatMap(SealantApiClient, (client) => client.sandboxes.listSandboxes({ query }));

// ---- runs ----

export const createRunOp = (
  payload: CreateRunRequest,
): Effect.Effect<WireRun, unknown, SealantApiClient> =>
  Effect.flatMap(SealantApiClient, (client) => client.runs.createRun({ payload }));

export const getRunOp = (runId: string): Effect.Effect<WireRun, unknown, SealantApiClient> =>
  Effect.flatMap(SealantApiClient, (client) => client.runs.getRun({ params: { runId } }));

export const listRunsOp = (query: ListRunsQuery) =>
  Effect.flatMap(SealantApiClient, (client) => client.runs.listRuns({ query }));

export const updateRunOp = (
  runId: string,
  payload: UpdateRunRequest,
): Effect.Effect<WireRun, unknown, SealantApiClient> =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.runs.updateRun({ params: { runId }, payload }),
  );

export const getRunTimelineOp = (
  runId: string,
  query: GetRunTimelineQuery,
): Effect.Effect<readonly WireTimelineEntry[], unknown, SealantApiClient> =>
  Effect.flatMap(SealantApiClient, (client) =>
    Effect.map(client.runs.getRunTimeline({ params: { runId }, query }), (r) => r.items),
  );

export const getRunScrollbackOp = (
  runId: string,
  query: GetRunScrollbackQuery,
): Effect.Effect<RunScrollbackResponse, unknown, SealantApiClient> =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.runs.getRunScrollback({ params: { runId }, query }),
  );

export const getRunLossOp = (
  runId: string,
): Effect.Effect<RunLossReport, unknown, SealantApiClient> =>
  Effect.flatMap(SealantApiClient, (client) => client.runs.getRunLoss({ params: { runId } }));

export const getRunChangesOp = (
  runId: string,
): Effect.Effect<RunChangesResponse, unknown, SealantApiClient> =>
  Effect.flatMap(SealantApiClient, (client) => client.runs.getRunChanges({ params: { runId } }));
