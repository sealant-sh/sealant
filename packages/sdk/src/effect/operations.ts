/**
 * Effect operations over the derived control-plane client. Thin: each yields the client and calls one
 * contract endpoint, returning the WIRE type. The facade maps wire -> public types and the runtime
 * maps the typed Effect failure -> a plain `SealantError`. Keeping these here (rather than inline in
 * the facade) keeps the wire surface in one place and unit-testable.
 */
import type {
  CreateRunRequest,
  CreateWorkspaceRequest,
  ExecWorkspaceRequest,
  ExpireWorkspaceRequest,
  GetRunScrollbackQuery,
  GetRunTimelineQuery,
  InferenceRespondRequest,
  ListRunsQuery,
  ListWorkspacesQuery,
  RestartWorkspaceRequest,
  StopWorkspaceRequest,
  UpdateRunRequest,
} from "@sealant/api-contracts";
import { Effect } from "effect";

import { SealantApiClient } from "./api-client.js";

// ---- workspaces ----

export const createWorkspaceOp = (payload: CreateWorkspaceRequest, idempotencyKey?: string) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.workspaces.createWorkspace({
      payload,
      headers: idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey },
    }),
  );

export const getWorkspaceOp = (workspaceId: string) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.workspaces.getWorkspace({ params: { workspaceId } }),
  );

export const listWorkspacesOp = (query: ListWorkspacesQuery) =>
  Effect.flatMap(SealantApiClient, (client) => client.workspaces.listWorkspaces({ query }));

export const execWorkspaceOp = (workspaceId: string, payload: ExecWorkspaceRequest) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.workspaces.execWorkspace({ params: { workspaceId }, payload }),
  );

export const stopWorkspaceOp = (workspaceId: string, payload: StopWorkspaceRequest) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.workspaces.stopWorkspace({ params: { workspaceId }, payload }),
  );

export const restartWorkspaceOp = (workspaceId: string, payload: RestartWorkspaceRequest) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.workspaces.restartWorkspace({ params: { workspaceId }, payload }),
  );

export const expireWorkspaceOp = (workspaceId: string, payload: ExpireWorkspaceRequest) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.workspaces.expireWorkspace({ params: { workspaceId }, payload }),
  );

// ---- runs ----

export const createRunOp = (payload: CreateRunRequest) =>
  Effect.flatMap(SealantApiClient, (client) => client.runs.createRun({ payload }));

export const getRunOp = (runId: string) =>
  Effect.flatMap(SealantApiClient, (client) => client.runs.getRun({ params: { runId } }));

export const listRunsOp = (query: ListRunsQuery) =>
  Effect.flatMap(SealantApiClient, (client) => client.runs.listRuns({ query }));

export const updateRunOp = (runId: string, payload: UpdateRunRequest) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.runs.updateRun({ params: { runId }, payload }),
  );

export const getRunTimelineOp = (runId: string, query: GetRunTimelineQuery) =>
  Effect.flatMap(SealantApiClient, (client) =>
    Effect.map(client.runs.getRunTimeline({ params: { runId }, query }), (r) => r.items),
  );

export const getRunScrollbackOp = (runId: string, query: GetRunScrollbackQuery) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.runs.getRunScrollback({ params: { runId }, query }),
  );

export const getRunLossOp = (runId: string) =>
  Effect.flatMap(SealantApiClient, (client) => client.runs.getRunLoss({ params: { runId } }));

export const getRunChangesOp = (runId: string) =>
  Effect.flatMap(SealantApiClient, (client) => client.runs.getRunChanges({ params: { runId } }));

// ---- inference ----

export const inferenceRespondOp = (payload: InferenceRespondRequest) =>
  Effect.flatMap(SealantApiClient, (client) => client.inference.respond({ payload }));
