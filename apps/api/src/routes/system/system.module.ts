import {
  SystemInternalServerError,
  type SetupStateResponse,
  type SystemHealthResponse,
  type SystemIndexResponse,
} from "@sealant/api-contracts";
import { UserRepo } from "@sealant/db";
import { Effect } from "effect";

import packageJson from "../../../package.json" with { type: "json" };
import { resolveSandboxSshGatewayConfig } from "../../lib/sandbox-ssh-gateway.js";

export const getIndex = () => {
  return Effect.succeed({
    name: "Sealant Control Plane API",
    version: packageJson.version,
    docsPath: "/docs",
    openApiPath: "/openapi.json",
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
    const sshGateway = resolveSandboxSshGatewayConfig();

    return {
      needsSetup: !hasAccounts,
      sshGateway:
        sshGateway === undefined
          ? null
          : {
              host: sshGateway.host,
              // Same defaults as resolveSandboxRuntime; applied here so clients never hardcode them.
              port: sshGateway.port ?? 22,
              usernamePrefix:
                sshGateway.usernamePrefix === undefined || sshGateway.usernamePrefix.trim() === ""
                  ? "sbx"
                  : sshGateway.usernamePrefix.trim(),
            },
    } satisfies SetupStateResponse;
  });
};
