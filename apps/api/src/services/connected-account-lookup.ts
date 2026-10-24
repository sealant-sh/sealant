import {
  ConnectedAccountRepo,
  type ConnectedAccount,
  type ConnectedAccountProvider,
  type ConnectedAccountRepoError,
} from "@sealant/db";
import { Effect } from "effect";

export const DEFAULT_ACCOUNT_SELECTOR = "default";

export const missingAccountMessage = (provider: ConnectedAccountProvider, selection: string) =>
  selection === DEFAULT_ACCOUNT_SELECTOR
    ? `No ${provider} connected account is chosen as the default.`
    : `No ${provider} connected account matches "${selection}".`;

export type ConnectedAccountLookup =
  | { readonly kind: "found"; readonly account: ConnectedAccount }
  | { readonly kind: "invalid"; readonly account: ConnectedAccount }
  | { readonly kind: "missing" };

export const lookupConnectedAccount = (input: {
  readonly ownerUserId: string;
  readonly provider: ConnectedAccountProvider;
  readonly selection: string;
}): Effect.Effect<ConnectedAccountLookup, ConnectedAccountRepoError, ConnectedAccountRepo> =>
  Effect.gen(function* () {
    const accounts = yield* ConnectedAccountRepo;
    const account =
      input.selection === DEFAULT_ACCOUNT_SELECTOR
        ? yield* accounts.getDefault({ ownerUserId: input.ownerUserId, provider: input.provider })
        : input.selection.startsWith("cacc_")
          ? yield* accounts.getById(input.selection)
          : yield* accounts.getByOwnerProviderName({
              ownerUserId: input.ownerUserId,
              provider: input.provider,
              name: input.selection,
            });

    if (
      account === undefined ||
      account.ownerUserId !== input.ownerUserId ||
      account.provider !== input.provider ||
      account.archivedAt !== null
    ) {
      return { kind: "missing" };
    }
    return account.status === "active" ? { kind: "found", account } : { kind: "invalid", account };
  });
