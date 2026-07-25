import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { createAccessToken, listAccessTokens, revokeAccessToken } from "./access-tokens.module.js";

export const AccessTokensHandlersLive = HttpApiBuilder.group(
  ControlPlaneAPI,
  "accessTokens",
  (handlers) => {
    return handlers
      .handle("createAccessToken", ({ payload }) => createAccessToken(payload))
      .handle("listAccessTokens", ({ query }) => listAccessTokens(query.ownerUserId))
      .handle("revokeAccessToken", ({ params, payload }) =>
        revokeAccessToken({ tokenId: params.tokenId, ownerUserId: payload.ownerUserId }),
      );
  },
);
