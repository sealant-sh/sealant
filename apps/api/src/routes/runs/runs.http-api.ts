import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  createRun,
  getRun,
  getRunChanges,
  getRunLoss,
  getRunScrollback,
  getRunTimeline,
  listRuns,
  updateRun,
} from "./runs.module.js";

export const RunsHandlersLive = HttpApiBuilder.group(ControlPlaneAPI, "runs", (handlers) => {
  return handlers
    .handle("createRun", ({ payload }) => createRun(payload))
    .handle("listRuns", ({ query }) => listRuns(query))
    .handle("getRun", ({ params }) => getRun(params.runId))
    .handle("updateRun", ({ params, payload }) => updateRun({ runId: params.runId, payload }))
    .handle("getRunTimeline", ({ params, query }) =>
      getRunTimeline({ runId: params.runId, query }),
    )
    .handle("getRunScrollback", ({ params, query }) =>
      getRunScrollback({ runId: params.runId, query }),
    )
    .handle("getRunLoss", ({ params }) => getRunLoss(params.runId))
    .handle("getRunChanges", ({ params }) => getRunChanges(params.runId));
});
