import { HttpApi, OpenApi } from "effect/unstable/httpapi";

import { ConnectedAccountsGroup } from "./connected-accounts.js";
import { GitHubGroup } from "./github.js";
import { InferenceGroup } from "./inference.js";
import { PackagesGroup } from "./packages.js";
import { ProfilesGroup } from "./profiles.js";
import { RegistriesGroup } from "./registries.js";
import { RunsGroup } from "./runs.js";
import { SshKeysGroup } from "./ssh-keys.js";
import { SystemGroup } from "./system.js";
import { WorkspacesGroup } from "./workspaces.js";

export const ControlPlaneAPI = HttpApi.make("sealantControlPlaneApi")
  .add(SystemGroup)
  .add(PackagesGroup.prefix("/v1/packages"))
  .add(WorkspacesGroup.prefix("/v1/workspaces"))
  .add(SshKeysGroup.prefix("/v1/ssh-keys"))
  .add(ConnectedAccountsGroup.prefix("/v1/connected-accounts"))
  .add(ProfilesGroup.prefix("/v1/profiles"))
  .add(InferenceGroup.prefix("/v1/inference"))
  .add(RunsGroup.prefix("/v1/runs"))
  .add(RegistriesGroup.prefix("/v1/registries"))
  .add(GitHubGroup.prefix("/v1/github"))
  .annotate(OpenApi.Title, "Sealant Control Plane API")
  .annotate(OpenApi.Version, "0.0.0")
  .annotate(OpenApi.Description, "Sealant control-plane HTTP API.");
