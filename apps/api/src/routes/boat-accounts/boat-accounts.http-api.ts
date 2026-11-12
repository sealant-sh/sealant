import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/http-api";

import {
  createBoatAccount,
  listBoatAccounts,
  removeBoatAccount,
  rotateBoatAccountKey,
} from "./boat-accounts.module.js";

export const BoatAccountsHandlersLive = HttpApiBuilder.group(
  ControlPlaneAPI,
  "boatAccounts",
  (handlers) =>
    handlers
      .handle("createBoatAccount", ({ payload }) => createBoatAccount(payload))
      .handle("listBoatAccounts", () => listBoatAccounts())
      .handle("rotateBoatAccountKey", ({ params, payload }) =>
        rotateBoatAccountKey(params.boatAccountId, payload),
      )
      .handle("removeBoatAccount", ({ params }) => removeBoatAccount(params.boatAccountId)),
);
