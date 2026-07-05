import { ControlPlaneAPI } from "@sealant/api-contracts";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  listProfileCredentialBindings,
  listProfiles,
  setProfileCredentialBinding,
} from "./profiles.module.js";

export const ProfilesHandlersLive = HttpApiBuilder.group(
  ControlPlaneAPI,
  "profiles",
  (handlers) => {
    return handlers
      .handle("listProfiles", ({ query }) => listProfiles({ ownerUserId: query.ownerUserId }))
      .handle("listProfileCredentialBindings", ({ params, query }) =>
        listProfileCredentialBindings({
          profileId: params.profileId,
          ownerUserId: query.ownerUserId,
        }),
      )
      .handle("setProfileCredentialBinding", ({ params, payload }) =>
        setProfileCredentialBinding({
          profileId: params.profileId,
          payload,
        }),
      );
  },
);
