import {
  SystemInternalServerError,
  type SetupStateResponse,
  type SystemHealthResponse,
  type SystemIndexResponse,
} from "@sealant/api-contracts";
import { UserRepo } from "@sealant/db";
import { Effect } from "effect";

import packageJson from "../../../package.json" with { type: "json" };
import { resolveWorkspaceSshGatewayConfig } from "../../lib/workspace-ssh-gateway.js";

export const getIndex = () => {
  return Effect.succeed({
    name: "Sealant Control Plane API",
    version: packageJson.version,
    docsPath: "/docs",
    openApiPath: "/openapi.json",
    // What this control plane does that an older one does not (a self-built one reports 0.0.0,
    // so a client detects these rather than reading the version). `processUserRoutes`: the as-user
    // exec and session routes exist; each workspace's own `processUser` (its read) says whether
    // its sealantd can, and an exec or session as a user on one that cannot is refused there.
    // `processUser` stays false: SDKs from before the as-user routes read it as leave to send
    // `user` on the plain routes, which a control plane from before `user` runs as root.
    features: {
      processUser: false,
      processUserRoutes: true,
      dotfilesApply: true,
      credentialsPartialPut: true,
      credentialsPiOpencode: true,
      captureOwnerMap: true,
      workspaceSshUser: true,
    },
  } satisfies SystemIndexResponse);
};

export const health = () => {
  return Effect.succeed({
    status: "ok",
  } satisfies SystemHealthResponse);
};

export const ready = () => {
  return Effect.succeed({
    status: "ok",
  } satisfies SystemHealthResponse);
};

export const getSetupState = () => {
  return Effect.gen(function* () {
    const userRepo = yield* UserRepo;
    // Accounts, not users: the seeded SDK owner (usr_local) is a user row with no credentials and
    // must not count as "this deployment is set up".
    const hasAccounts = yield* userRepo
      .hasAnySignInAccounts()
      .pipe(Effect.mapError((error) => new SystemInternalServerError({ message: error.message })));
    const sshGateway = resolveWorkspaceSshGatewayConfig();

    return {
      needsSetup: !hasAccounts,
      sshGateway:
        sshGateway === undefined
          ? null
          : {
              host: sshGateway.host,
              // Same defaults as resolveWorkspaceRuntime; applied here so clients never hardcode them.
              port: sshGateway.port ?? 22,
              usernamePrefix:
                sshGateway.usernamePrefix === undefined || sshGateway.usernamePrefix.trim() === ""
                  ? "ws"
                  : sshGateway.usernamePrefix.trim(),
            },
    } satisfies SetupStateResponse;
  });
};
