import { HttpApiBuilder } from "@effect/platform";
import { ControlPlaneAPI } from "@sealant/api-contracts";

import { getIndex, health, ready } from "./system.module.js";

export const SystemHandlersLive = HttpApiBuilder.group(ControlPlaneAPI, "system", (handlers) => {
  return handlers
    .handle("getIndex", () => getIndex())
    .handle("health", () => health())
    .handle("ready", () => ready());
});
