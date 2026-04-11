import type { SystemHealthResponse, SystemIndexResponse } from "@sealant/api-contracts";
import { Effect } from "effect";

import packageJson from "../../../package.json" with { type: "json" };

export const getIndex = () => {
  return Effect.succeed({
    name: "Sealant Control Plane API",
    version: packageJson.version,
    docsPath: "/docs",
    openApiPath: "/openapi.json",
  } satisfies SystemIndexResponse);
};

export const health = () => {
  return Effect.succeed({
    status: "ok",
  } satisfies SystemHealthResponse);
};

export const ready = () => {
  return Effect.succeed({
    status: "ok",
  } satisfies SystemHealthResponse);
};
