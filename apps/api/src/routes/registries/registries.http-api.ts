import { HttpApiBuilder } from "@effect/platform";
import { ControlPlaneAPI } from "@sealant/api-contracts";

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
      .handle("getRegistry", ({ path }) => getRegistry(path.registryId))
      .handle("pingRegistry", ({ path }) => pingRegistry(path.registryId))
      .handle("listRegistryExtensions", ({ path }) => listRegistryExtensions(path.registryId))
      .handle("listRegistryTags", ({ path, urlParams }) =>
        listRegistryTags({
          registryId: path.registryId,
          query: urlParams,
        }),
      )
      .handle("getRegistryManifest", ({ path, urlParams }) =>
        getRegistryManifest({
          registryId: path.registryId,
          query: urlParams,
        }),
      );
  },
);
