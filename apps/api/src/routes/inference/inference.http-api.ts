import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/http-api";

import { respond } from "./inference.module.js";

export const InferenceHandlersLive = HttpApiBuilder.group(
  ControlPlaneAPI,
  "inference",
  (handlers) => {
    return handlers.handle("respond", ({ payload }) => respond(payload));
  },
);
