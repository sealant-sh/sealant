import {
  WorkspaceConflictError,
  WorkspaceInternalServerError,
  WorkspaceNotFoundError,
} from "@sealant/api-contracts";
import type { ConnectedAccount } from "@sealant/db";
import { Effect } from "effect";

import {
  lookupConnectedAccount,
  missingAccountMessage,
} from "../../services/connected-account-lookup.js";

export const resolveSelectedConnectedAccount = (input: {
  readonly ownerUserId: string;
  readonly provider: ConnectedAccount["provider"];
  readonly selection: string;
}) =>
  Effect.gen(function* () {
    const lookup = yield* lookupConnectedAccount(input).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceInternalServerError({
            message: error instanceof Error ? error.message : "Failed to load connected account.",
          }),
      ),
    );

    switch (lookup.kind) {
      case "missing":
        return yield* new WorkspaceNotFoundError({
          message: missingAccountMessage(input.provider, input.selection),
          code: "connected-account-missing",
          provider: input.provider,
        });
      case "invalid":
        return yield* new WorkspaceConflictError({
          message: `Connected ${input.provider} account "${lookup.account.name}" is invalid — reconnect it.`,
          code: "connected-account-invalid",
          provider: input.provider,
        });
      case "found":
        return lookup.account;
    }
  });
