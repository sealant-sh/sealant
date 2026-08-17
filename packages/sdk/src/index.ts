/**
 * @sealant/sdk — the fluent public SDK for Sealant.
 *
 * Create a live workspace around a real repository, run the harness you already use, stream progress
 * while it works, and keep the replayable execution record after the workspace is gone:
 *
 *   import { Sealant, opencode } from "@sealant/sdk"
 *
 *   const sealant = new Sealant({ baseUrl: "http://localhost:8080" })
 *   const workspace = await sealant.workspaces.create({
 *     repository: "github.com/acme/billing-service",
 *     harness: opencode(),
 *   })
 *   const run = await workspace.harness.run("Round invoice totals once, after applying the discount.")
 *   await run.record.replay()
 */
export { Sealant } from "./client.js";
export { claudeCode, codex, customHarness, opencode } from "./harness.js";
export {
  SealantApiError,
  SealantError,
  SealantNotImplementedError,
  SealantRuntimeError,
} from "./errors.js";
export type * from "./types.js";
// The workspace environment policy (`CreateOptions.env` validation) is public API: downstream
// products validate at their own boundaries with the exact rules the platform enforces.
export {
  findWorkspaceEnvReservedRule,
  findWorkspaceSecretEnvReservedRule,
  formatWorkspaceEnvIssue,
  parseWorkspaceEnv,
  parseWorkspaceSecretEnv,
  WORKSPACE_ENV_MAX_ENTRIES,
  WORKSPACE_ENV_MAX_NAME_LENGTH,
  WORKSPACE_ENV_MAX_TOTAL_BYTES,
  WORKSPACE_ENV_MAX_VALUE_BYTES,
  WORKSPACE_ENV_NAME_PATTERN,
  WORKSPACE_ENV_SECRET_MARKERS,
} from "@sealant/api-contracts/workspace-environment";
export type {
  WorkspaceEnvIssue,
  WorkspaceEnvParseResult,
  WorkspaceEnvReservedRule,
} from "@sealant/api-contracts/workspace-environment";
