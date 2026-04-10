import { HttpApiBuilder, HttpApiScalar, HttpServer } from "@effect/platform";
import { ControlPlaneAPI } from "@sealant/api-contracts";
import { Effect, Layer } from "effect";

import type { AppRuntimeConfig } from "../../lib/types.js";
import { GitHubModuleService, makeGitHubModuleLayer } from "./github.module.js";

const GitHubHandlersLive = HttpApiBuilder.group(ControlPlaneAPI, "github", (handlers) => {
  return handlers
    .handle("listInstallations", ({ urlParams }) =>
      Effect.flatMap(GitHubModuleService, (github) => github.listInstallations(urlParams)),
    )
    .handle("listInstallationRepositories", ({ path, urlParams }) =>
      Effect.flatMap(GitHubModuleService, (github) =>
        github.listInstallationRepositories({
          installationId: path.installationId,
          query: urlParams,
        }),
      ),
    )
    .handle("syncInstallation", ({ path, urlParams }) =>
      Effect.flatMap(GitHubModuleService, (github) =>
        github.syncInstallation({
          installationId: path.installationId,
          query: urlParams,
        }),
      ),
    )
    .handle("importInstallation", ({ payload }) =>
      Effect.flatMap(GitHubModuleService, (github) => github.importInstallation(payload)),
    )
    .handle("handleWebhook", ({ headers, payload }) =>
      Effect.flatMap(GitHubModuleService, (github) =>
        github.handleWebhook({
          ...(headers["x-github-delivery"] === undefined
            ? {}
            : { deliveryIdHeader: headers["x-github-delivery"] }),
          ...(headers["x-github-event"] === undefined
            ? {}
            : { eventTypeHeader: headers["x-github-event"] }),
          ...(headers["x-hub-signature-256"] === undefined
            ? {}
            : { signatureHeader: headers["x-hub-signature-256"] }),
          payloadText: payload,
        }),
      ),
    );
});

export const createGitHubWebHandler = (_config?: AppRuntimeConfig) => {
  const GitHubApiLive = makeGitHubHttpApiLayer();

  const GitHubOpenApiLive = HttpApiBuilder.middlewareOpenApi({ path: "/openapi.json" }).pipe(
    Layer.provide(GitHubApiLive),
  );

  const GitHubDocsLive = HttpApiScalar.layer({
    path: "/docs",
    scalar: {
      theme: "saturn",
      layout: "classic",
      darkMode: true,
      defaultOpenAllTags: false,
    },
  }).pipe(Layer.provide(GitHubApiLive));

  const { handler } = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(GitHubApiLive, GitHubOpenApiLive, GitHubDocsLive, HttpServer.layerContext),
  );

  return handler;
};

export const makeGitHubHttpApiLayer = () => {
  return HttpApiBuilder.api(ControlPlaneAPI).pipe(
    Layer.provide(GitHubHandlersLive),
    Layer.provide(makeGitHubModuleLayer),
  );
};
