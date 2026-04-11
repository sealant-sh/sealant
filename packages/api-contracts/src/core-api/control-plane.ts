import { HttpApi, OpenApi } from "@effect/platform";

import { GitHubGroup } from "./github.js";

export const ControlPlaneAPI = HttpApi.make("sealantControlPlaneApi")
  .add(GitHubGroup.prefix("/v1/github"))
  .annotate(OpenApi.Title, "Sealant Control Plane API")
  .annotate(OpenApi.Version, "0.0.0")
  .annotate(OpenApi.Description, "Sealant control-plane HTTP API.");
