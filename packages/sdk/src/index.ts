/**
 * @sealant/sdk — the fluent public SDK for Sealant.
 *
 * Create a live sandbox around a real repository, run the harness you already use, stream progress
 * while it works, and keep the replayable execution record after the sandbox is gone:
 *
 *   import { Sealant, opencode } from "@sealant/sdk"
 *
 *   const sealant = new Sealant({ baseUrl: "http://localhost:8080" })
 *   const sandbox = await sealant.sandboxes.create({
 *     repository: "github.com/acme/billing-service",
 *     harness: opencode(),
 *   })
 *   const run = await sandbox.harness.run("Round invoice totals once, after applying the discount.")
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
