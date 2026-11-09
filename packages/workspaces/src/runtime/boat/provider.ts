import type { BoatAllocationRecord } from "@sealant/validators";
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
export const boatAllocationLabels = (record: BoatAllocationRecord) => ({
  "sealant-runtime": "boat",
  "sealant-deployment": record.input.deploymentId,
  "sealant-workspace": record.input.workspaceId,
  "sealant-run": record.input.consumer.runId,
  "sealant-instance": record.input.consumer.runtimeInstanceId,
  "sealant-attempt": record.input.launchAttemptId,
  "sealant-source": record.input.publication.publicationId,
});
export const boatAllocationMatches = (record: BoatAllocationRecord, sandbox: BoatSandbox) =>
  Object.entries(boatAllocationLabels(record)).every(
    ([key, value]) => sandbox.labels?.[key] === value,
  );
