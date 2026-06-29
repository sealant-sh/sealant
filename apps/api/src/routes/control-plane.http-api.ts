import { ControlPlaneAPI } from "@sealant/api-contracts";
import { Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { CredentialsHandlersLive } from "./credentials/credentials.http-api.js";
import { GitHubHandlersLive } from "./github/github.http-api.js";
import { PackagesHandlersLive } from "./packages/packages.http-api.js";
import { RegistriesHandlersLive } from "./registries/registries.http-api.js";
import { RunsHandlersLive } from "./runs/runs.http-api.js";
import { SandboxesHandlersLive } from "./sandboxes/sandboxes.http-api.js";
import { SystemHandlersLive } from "./system/system.http-api.js";

const ControlPlaneHandlersLive = Layer.mergeAll(
  SystemHandlersLive,
  PackagesHandlersLive,
  SandboxesHandlersLive,
  RunsHandlersLive,
  RegistriesHandlersLive,
  GitHubHandlersLive,
  CredentialsHandlersLive,
);

export const makeControlPlaneHttpApiLayer = () => {
  return HttpApiBuilder.layer(ControlPlaneAPI, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(ControlPlaneHandlersLive),
  );
};
