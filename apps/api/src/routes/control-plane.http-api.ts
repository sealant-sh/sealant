import { ControlPlaneAPI } from "@sealant/api-contracts";
import { Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { ConnectedAccountsHandlersLive } from "./connected-accounts/connected-accounts.http-api.js";
import { GitHubHandlersLive } from "./github/github.http-api.js";
import { InferenceHandlersLive } from "./inference/inference.http-api.js";
import { PackagesHandlersLive } from "./packages/packages.http-api.js";
import { ProfilesHandlersLive } from "./profiles/profiles.http-api.js";
import { RegistriesHandlersLive } from "./registries/registries.http-api.js";
import { RunsHandlersLive } from "./runs/runs.http-api.js";
import { SshKeysHandlersLive } from "./ssh-keys/ssh-keys.http-api.js";
import { SystemHandlersLive } from "./system/system.http-api.js";
import { WorkspacesHandlersLive } from "./workspaces/workspaces.http-api.js";

const ControlPlaneHandlersLive = Layer.mergeAll(
  SystemHandlersLive,
  PackagesHandlersLive,
  WorkspacesHandlersLive,
  SshKeysHandlersLive,
  ConnectedAccountsHandlersLive,
  ProfilesHandlersLive,
  InferenceHandlersLive,
  RunsHandlersLive,
  RegistriesHandlersLive,
  GitHubHandlersLive,
);

export const makeControlPlaneHttpApiLayer = () => {
  return HttpApiBuilder.layer(ControlPlaneAPI, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(ControlPlaneHandlersLive),
  );
};
