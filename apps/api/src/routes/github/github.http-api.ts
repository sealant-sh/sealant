import { ControlPlaneAPI } from "@sealant/api-contracts";
import { Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  handleWebhook,
  importInstallation,
  listInstallationRepositories,
  listInstallations,
  syncInstallation,
} from "./github.module.js";

export const GitHubHandlersLive = HttpApiBuilder.group(ControlPlaneAPI, "github", (handlers) => {
  return handlers
    .handle("listInstallations", ({ query }) => listInstallations(query))
    .handle("listInstallationRepositories", ({ params, query }) =>
      listInstallationRepositories({
        installationId: params.installationId,
        query,
      }),
    )
    .handle("syncInstallation", ({ params, query }) =>
      syncInstallation({
        installationId: params.installationId,
        query,
      }),
    )
    .handle("importInstallation", ({ payload }) => importInstallation(payload))
    .handle("handleWebhook", ({ headers, payload }) =>
      handleWebhook({
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
    );
});

export const makeGitHubHttpApiLayer = () => {
  return HttpApiBuilder.layer(ControlPlaneAPI, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(GitHubHandlersLive),
  );
};
