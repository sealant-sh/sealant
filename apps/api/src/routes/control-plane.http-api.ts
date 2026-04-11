import { HttpApiBuilder } from "@effect/platform";
import { ControlPlaneAPI } from "@sealant/api-contracts";
import { Layer } from "effect";

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
  return HttpApiBuilder.api(ControlPlaneAPI).pipe(Layer.provide(ControlPlaneHandlersLive));
};
