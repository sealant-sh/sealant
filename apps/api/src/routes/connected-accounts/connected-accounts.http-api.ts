import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  archiveConnectedAccount,
  createConnectedAccount,
  listConnectedAccounts,
  markConnectedAccountInvalid,
} from "./connected-accounts.module.js";

export const ConnectedAccountsHandlersLive = HttpApiBuilder.group(
  ControlPlaneAPI,
  "connectedAccounts",
  (handlers) => {
    return handlers
      .handle("createConnectedAccount", ({ payload }) => createConnectedAccount({ payload }))
      .handle("listConnectedAccounts", ({ query }) =>
        listConnectedAccounts({ ownerUserId: query.ownerUserId }),
      )
      .handle("archiveConnectedAccount", ({ params, query }) =>
        archiveConnectedAccount({
          connectedAccountId: params.connectedAccountId,
          ownerUserId: query.ownerUserId,
        }),
      )
      .handle("markConnectedAccountInvalid", ({ params, payload }) =>
        markConnectedAccountInvalid({
          connectedAccountId: params.connectedAccountId,
          ownerUserId: payload.ownerUserId,
        }),
      );
  },
);
