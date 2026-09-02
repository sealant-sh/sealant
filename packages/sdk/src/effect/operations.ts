/**
 * Effect operations over the derived control-plane client. Thin: each yields the client and calls one
 * contract endpoint, returning the WIRE type. The facade maps wire -> public types and the runtime
 * maps the typed Effect failure -> a plain `SealantError`. Keeping these here (rather than inline in
 * the facade) keeps the wire surface in one place and unit-testable.
 */
import type {
  BindWorkspaceRequest,
  CloseSessionRequest,
  CreateAccessTokenRequest,
  CreateConnectedAccountRequest,
  CreateSshKeyRequest,
  EnsureUserRequest,
  CreateRunRequest,
  CreateSessionRequest,
  CreateWorkspaceRequest,
  ExecWorkspaceRequest,
  ExpireWorkspaceRequest,
  GetRunScrollbackQuery,
  GetRunTimelineQuery,
  GetSessionOutputQuery,
  InferenceRespondRequest,
  ListRunsQuery,
  ListSessionsQuery,
  ListWorkspacesQuery,
  RestartWorkspaceRequest,
  SessionInputRequest,
  SessionResizeRequest,
  SessionSignalRequest,
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

export const getWorkspaceOp = (workspaceId: string, ownerUserId?: string) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.workspaces.getWorkspace({
      params: { workspaceId },
      query: ownerUserId === undefined ? {} : { ownerUserId },
    }),
  );

export const listWorkspacesOp = (query: ListWorkspacesQuery) =>
  Effect.flatMap(SealantApiClient, (client) => client.workspaces.listWorkspaces({ query }));

export const execWorkspaceOp = (workspaceId: string, payload: ExecWorkspaceRequest) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.workspaces.execWorkspace({ params: { workspaceId }, payload }),
  );

export const bindWorkspaceOp = (workspaceId: string, payload: BindWorkspaceRequest) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.workspaces.bindWorkspace({ params: { workspaceId }, payload }),
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

const ownerQuery = (ownerUserId: string | undefined) =>
  ownerUserId === undefined ? {} : { ownerUserId };

export const getRunOp = (runId: string, ownerUserId?: string) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.runs.getRun({ params: { runId }, query: ownerQuery(ownerUserId) }),
  );

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

export const getRunLossOp = (runId: string, ownerUserId?: string) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.runs.getRunLoss({ params: { runId }, query: ownerQuery(ownerUserId) }),
  );

export const getRunChangesOp = (runId: string, ownerUserId?: string) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.runs.getRunChanges({ params: { runId }, query: ownerQuery(ownerUserId) }),
  );

// ---- sessions ----

export const createSessionOp = (payload: CreateSessionRequest) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.sessions.createSession({ payload, headers: {} }),
  );

export const getSessionOp = (sessionId: string, ownerUserId?: string) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.sessions.getSession({
      params: { sessionId },
      headers: {},
      query: ownerUserId === undefined ? {} : { ownerUserId },
    }),
  );

export const listSessionsOp = (query: ListSessionsQuery) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.sessions.listSessions({ query, headers: {} }),
  );

export const getSessionOutputOp = (sessionId: string, query: GetSessionOutputQuery) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.sessions.getSessionOutput({ params: { sessionId }, headers: {}, query }),
  );

export const sendSessionInputOp = (sessionId: string, payload: SessionInputRequest) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.sessions.sendSessionInput({ params: { sessionId }, headers: {}, payload }),
  );

export const resizeSessionOp = (sessionId: string, payload: SessionResizeRequest) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.sessions.resizeSession({ params: { sessionId }, headers: {}, payload }),
  );

export const signalSessionOp = (sessionId: string, payload: SessionSignalRequest) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.sessions.signalSession({ params: { sessionId }, headers: {}, payload }),
  );

export const closeSessionOp = (sessionId: string, payload: CloseSessionRequest) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.sessions.closeSession({ params: { sessionId }, headers: {}, payload }),
  );

// ---- access tokens ----

export const createAccessTokenOp = (payload: CreateAccessTokenRequest) =>
  Effect.flatMap(SealantApiClient, (client) => client.accessTokens.createAccessToken({ payload }));

// ---- users ----

export const ensureUserOp = (payload: EnsureUserRequest) =>
  Effect.flatMap(SealantApiClient, (client) => client.users.ensureUser({ payload }));

export const getUserOp = (userId: string) =>
  Effect.flatMap(SealantApiClient, (client) => client.users.getUser({ params: { userId } }));

// ---- connected accounts ----

export const listConnectedAccountsOp = (ownerUserId: string) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.connectedAccounts.listConnectedAccounts({ query: { ownerUserId } }),
  );

export const createConnectedAccountOp = (payload: CreateConnectedAccountRequest) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.connectedAccounts.createConnectedAccount({ payload }),
  );

export const archiveConnectedAccountOp = (connectedAccountId: string, ownerUserId: string) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.connectedAccounts.archiveConnectedAccount({
      params: { connectedAccountId },
      query: { ownerUserId },
    }),
  );

// ---- inference ----

export const inferenceRespondOp = (payload: InferenceRespondRequest) =>
  Effect.flatMap(SealantApiClient, (client) => client.inference.respond({ payload }));

// ---- system ----

export const getSetupStateOp = () =>
  Effect.flatMap(SealantApiClient, (client) => client.system.getSetupState({}));

// ---- ssh keys ----

export const createSshKeyOp = (payload: CreateSshKeyRequest) =>
  Effect.flatMap(SealantApiClient, (client) => client.sshKeys.createSshKey({ payload }));

export const listSshKeysOp = (ownerUserId: string) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.sshKeys.listSshKeys({ query: { ownerUserId } }),
  );

export const archiveSshKeyOp = (sshKeyId: string, ownerUserId: string) =>
  Effect.flatMap(SealantApiClient, (client) =>
    client.sshKeys.archiveSshKey({ params: { sshKeyId }, query: { ownerUserId } }),
  );
