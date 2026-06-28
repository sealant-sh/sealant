import { HttpApi, OpenApi } from "effect/unstable/httpapi";

import { GitHubGroup } from "./github.js";
import { PackagesGroup } from "./packages.js";
import { RegistriesGroup } from "./registries.js";
import { RunsGroup } from "./runs.js";
import { SandboxesGroup } from "./sandboxes.js";
import { SystemGroup } from "./system.js";

export const ControlPlaneAPI = HttpApi.make("sealantControlPlaneApi")
  .add(SystemGroup)
  .add(PackagesGroup.prefix("/v1/packages"))
  .add(SandboxesGroup.prefix("/v1/sandboxes"))
  .add(RunsGroup.prefix("/v1/runs"))
  .add(RegistriesGroup.prefix("/v1/registries"))
  .add(GitHubGroup.prefix("/v1/github"))
  .annotate(OpenApi.Title, "Sealant Control Plane API")
  .annotate(OpenApi.Version, "0.0.0")
  .annotate(OpenApi.Description, "Sealant control-plane HTTP API.");
