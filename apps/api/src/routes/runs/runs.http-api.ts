import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  createRun,
  getRun,
  getRunChanges,
  getRunEvent,
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
    .handle("getRun", ({ params, query }) => getRun(params.runId, query.ownerUserId))
    .handle("updateRun", ({ params, payload }) => updateRun({ runId: params.runId, payload }))
    .handle("getRunTimeline", ({ params, query }) => getRunTimeline({ runId: params.runId, query }))
    .handle("getRunEvent", ({ params, query }) =>
      getRunEvent({
        runId: params.runId,
        sequence: params.sequence,
        ownerUserId: query.ownerUserId,
      }),
    )
    .handle("getRunScrollback", ({ params, query }) =>
      getRunScrollback({ runId: params.runId, query }),
    )
    .handle("getRunLoss", ({ params, query }) => getRunLoss(params.runId, query.ownerUserId))
    .handle("getRunChanges", ({ params, query }) => getRunChanges(params.runId, query.ownerUserId));
});
