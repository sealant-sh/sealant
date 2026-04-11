import { HttpApiBuilder } from "@effect/platform";
import { ControlPlaneAPI } from "@sealant/api-contracts";

import { resolvePackage } from "./packages.module.js";

export const PackagesHandlersLive = HttpApiBuilder.group(
  ControlPlaneAPI,
  "packages",
  (handlers) => {
    return handlers.handle("resolvePackage", ({ urlParams }) => resolvePackage(urlParams));
  },
);
