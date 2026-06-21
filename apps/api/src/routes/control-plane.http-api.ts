import { ControlPlaneAPI } from "@sealant/api-contracts";
import { Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { GitHubHandlersLive } from "./github/github.http-api.js";
import { PackagesHandlersLive } from "./packages/packages.http-api.js";
import { RegistriesHandlersLive } from "./registries/registries.http-api.js";
import { SandboxesHandlersLive } from "./sandboxes/sandboxes.http-api.js";
import { SystemHandlersLive } from "./system/system.http-api.js";

const ControlPlaneHandlersLive = Layer.mergeAll(
  SystemHandlersLive,
  PackagesHandlersLive,
  SandboxesHandlersLive,
  RegistriesHandlersLive,
  GitHubHandlersLive,
);

export const makeControlPlaneHttpApiLayer = () => {
  return HttpApiBuilder.layer(ControlPlaneAPI, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(ControlPlaneHandlersLive),
  );
};
