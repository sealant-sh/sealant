import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/http-api";

import {
  checkBoatAccount,
  checkBoatInstallKey,
  createBoatAccount,
  getBoatInstallKey,
  listBoatAccounts,
  proveBoatAccount,
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
      .handle("checkBoatAccount", ({ params }) => checkBoatAccount(params.boatAccountId))
      .handle("getBoatInstallKey", () => getBoatInstallKey())
      .handle("checkBoatInstallKey", () => checkBoatInstallKey())
      .handle("proveBoatAccount", ({ params }) => proveBoatAccount(params.boatAccountId))
      .handle("removeBoatAccount", ({ params }) => removeBoatAccount(params.boatAccountId)),
);
