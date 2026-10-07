import {
  WorkspaceConflictError,
  WorkspaceInternalServerError,
  WorkspaceNotFoundError,
} from "@sealant/api-contracts";
import { ConnectedAccountRepo, type ConnectedAccount } from "@sealant/db";
import { Effect } from "effect";

/**
 * Resolve one explicitly selected connected account, the way workspace create and a credential
 * put both do: a value starting with "cacc_" is an account id, anything else an account name
 * under the provider. Unknown, someone else's, wrong-provider and archived accounts are one uniform
 * 404 (`connected-account-missing`); the caller named this account, so one that is not `active` is
 * a 409 (`connected-account-invalid`: reconnect it) rather than a silent omission. Both name the
 * provider, so a caller can say which login is missing without reading the words.
 */
export const resolveSelectedConnectedAccount = (input: {
  readonly ownerUserId: string;
  readonly provider: ConnectedAccount["provider"];
  readonly selection: string;
}) =>
  Effect.gen(function* () {
    const connectedAccountRepo = yield* ConnectedAccountRepo;
    const lookup = input.selection.startsWith("cacc_")
      ? connectedAccountRepo.getById(input.selection)
      : connectedAccountRepo.getByOwnerProviderName({
          ownerUserId: input.ownerUserId,
          provider: input.provider,
          name: input.selection,
        });
    const account = yield* lookup.pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceInternalServerError({
            message: error instanceof Error ? error.message : "Failed to load connected account.",
          }),
      ),
    );

    if (
      account === undefined ||
      account.ownerUserId !== input.ownerUserId ||
      account.provider !== input.provider ||
      account.archivedAt !== null
    ) {
      return yield* new WorkspaceNotFoundError({
        message: `No ${input.provider} connected account matches "${input.selection}".`,
        code: "connected-account-missing",
        provider: input.provider,
      });
    }

    if (account.status !== "active") {
      return yield* new WorkspaceConflictError({
        message: `Connected ${input.provider} account "${account.name}" is invalid — reconnect it.`,
        code: "connected-account-invalid",
        provider: input.provider,
      });
    }

    return account;
  });
