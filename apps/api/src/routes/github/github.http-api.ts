import { HttpApiBuilder } from "@effect/platform";
import { ControlPlaneAPI } from "@sealant/api-contracts";
import { Layer } from "effect";

import {
  handleWebhook,
  importInstallation,
  listInstallationRepositories,
  listInstallations,
  syncInstallation,
} from "./github.module.js";

export const GitHubHandlersLive = HttpApiBuilder.group(ControlPlaneAPI, "github", (handlers) => {
  return handlers
    .handle("listInstallations", ({ urlParams }) => listInstallations(urlParams))
    .handle("listInstallationRepositories", ({ path, urlParams }) =>
      listInstallationRepositories({
        installationId: path.installationId,
        query: urlParams,
      }),
    )
    .handle("syncInstallation", ({ path, urlParams }) =>
      syncInstallation({
        installationId: path.installationId,
        query: urlParams,
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
  return HttpApiBuilder.api(ControlPlaneAPI).pipe(Layer.provide(GitHubHandlersLive));
};
