import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  connectCredential,
  getCredential,
  listCredentials,
  revokeCredential,
} from "./credentials.module.js";

export const CredentialsHandlersLive = HttpApiBuilder.group(
  ControlPlaneAPI,
  "credentials",
  (handlers) => {
    return handlers
      .handle("connectCredential", ({ payload }) => connectCredential(payload))
      .handle("listCredentials", ({ query }) => listCredentials(query))
      .handle("getCredential", ({ params, query }) =>
        getCredential({ credentialId: params.credentialId, query }),
      )
      .handle("revokeCredential", ({ params, query }) =>
        revokeCredential({ credentialId: params.credentialId, query }),
      );
  },
);
