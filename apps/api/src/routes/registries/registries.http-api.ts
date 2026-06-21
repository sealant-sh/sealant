import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  getRegistry,
  getRegistryManifest,
  listRegistryExtensions,
  listRegistryTags,
  pingRegistry,
} from "./registries.module.js";

export const RegistriesHandlersLive = HttpApiBuilder.group(
  ControlPlaneAPI,
  "registries",
  (handlers) => {
    return handlers
      .handle("getRegistry", ({ params }) => getRegistry(params.registryId))
      .handle("pingRegistry", ({ params }) => pingRegistry(params.registryId))
      .handle("listRegistryExtensions", ({ params }) => listRegistryExtensions(params.registryId))
      .handle("listRegistryTags", ({ params, query }) =>
        listRegistryTags({
          registryId: params.registryId,
          query,
        }),
      )
      .handle("getRegistryManifest", ({ params, query }) =>
        getRegistryManifest({
          registryId: params.registryId,
          query,
        }),
      );
  },
);
