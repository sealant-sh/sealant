import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  archiveSshKey,
  createSshKey,
  listSshKeys,
  resolveSshPrincipal,
} from "./ssh-keys.module.js";

export const SshKeysHandlersLive = HttpApiBuilder.group(ControlPlaneAPI, "sshKeys", (handlers) => {
  return handlers
    .handle("createSshKey", ({ payload }) => createSshKey({ payload }))
    .handle("listSshKeys", ({ query }) => listSshKeys({ ownerUserId: query.ownerUserId }))
    .handle("archiveSshKey", ({ params, query }) =>
      archiveSshKey({
        sshKeyId: params.sshKeyId,
        ownerUserId: query.ownerUserId,
      }),
    )
    .handle("resolveSshPrincipal", ({ payload, headers }) =>
      resolveSshPrincipal({
        payload,
        headers,
      }),
    );
});
