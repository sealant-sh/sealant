import type { BoatRun } from "@sealant/validators";
import { Context } from "effect";

import type { BoatApi, BoatSandbox } from "./api.js";

/** The composition root chooses provider access and deployment, never an ambient credential. */
export class BoatAllocationProvider extends Context.Service<
  BoatAllocationProvider,
  {
    readonly deploymentId: string;
    readonly api: Pick<
      BoatApi,
      "create" | "discover" | "get" | "getSnapshot" | "execute" | "hostControl"
    >;
  }
>()("@sealant/workspaces/boat/BoatAllocationProvider") {}

/** The exact labels create stamps on a launch's VM; discovery and every read require all of them. */
export const boatRunLabels = (run: BoatRun) => ({
  "sealant-runtime": "boat",
  "sealant-deployment": run.deploymentId,
  "sealant-workspace": run.workspaceId,
  "sealant-run": run.runId,
  "sealant-instance": run.runId,
  "sealant-attempt": run.launchAttemptId,
  "sealant-source": run.publicationId,
});
export const boatRunMatches = (run: BoatRun, sandbox: BoatSandbox) =>
  Object.entries(boatRunLabels(run)).every(([key, value]) => sandbox.labels?.[key] === value);
