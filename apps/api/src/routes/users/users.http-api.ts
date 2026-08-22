import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { ensureUser, getUser } from "./users.module.js";

export const UsersHandlersLive = HttpApiBuilder.group(ControlPlaneAPI, "users", (handlers) => {
  return handlers
    .handle("ensureUser", ({ payload }) => ensureUser(payload))
    .handle("getUser", ({ params }) => getUser(params.userId));
});
