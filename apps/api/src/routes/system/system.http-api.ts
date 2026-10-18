import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/http-api";

import { getIndex, getSetupState, health, ready } from "./system.module.js";

export const SystemHandlersLive = HttpApiBuilder.group(ControlPlaneAPI, "system", (handlers) => {
  return handlers
    .handle("getIndex", () => getIndex())
    .handle("health", () => health())
    .handle("ready", () => ready())
    .handle("getSetupState", () => getSetupState());
});
