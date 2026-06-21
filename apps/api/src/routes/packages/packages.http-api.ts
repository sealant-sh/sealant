import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { resolvePackage } from "./packages.module.js";

export const PackagesHandlersLive = HttpApiBuilder.group(
  ControlPlaneAPI,
  "packages",
  (handlers) => {
    return handlers.handle("resolvePackage", ({ query }) => resolvePackage(query));
  },
);
