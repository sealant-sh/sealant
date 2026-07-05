import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { ControlPlaneClientService, toApiSettings } from "../api-client.js";
import { currentSettings } from "../config.js";
import { CliFailure } from "../errors.js";
import { abortedByUser, confirmStep } from "../prompts.js";
import { isColorEnabled, makePalette } from "../render.js";
import { CONNECTED_ACCOUNT_PROVIDERS } from "../schemas.js";

export const authRemoveCommand = Command.make(
  "remove",
  {
    provider: Argument.choice("provider", CONNECTED_ACCOUNT_PROVIDERS),
    name: Flag.string("name").pipe(
      Flag.withDefault("default"),
      Flag.withDescription("Account name to remove"),
    ),
    yes: Flag.boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("Skip the confirmation prompt"),
    ),
  },
  ({ name, provider, yes }) =>
    Effect.gen(function* () {
      const settings = yield* currentSettings;
      const client = yield* ControlPlaneClientService;
      const palette = makePalette(isColorEnabled());

      const accounts = yield* client.listConnectedAccounts(toApiSettings(settings));
      const account = accounts.find(
        (candidate) => candidate.provider === provider && candidate.name === name,
      );
      if (account === undefined) {
        const names = accounts
          .filter((candidate) => candidate.provider === provider)
          .map((candidate) => candidate.name);
        return yield* Effect.fail(
          new CliFailure({
            message: `No ${provider} account named "${name}".`,
            hint:
              names.length > 0
                ? `Connected ${provider} accounts: ${names.join(", ")}.`
                : `Nothing to remove — no ${provider} accounts are connected.`,
          }),
        );
      }

      const consent = yield* confirmStep({
        message: `Remove ${provider}/${name} (${account.connectedAccountId})? Profiles bound to it will lose access.`,
        yes,
      });
      if (!consent) {
        return yield* Effect.fail(abortedByUser());
      }

      const removed = yield* client.removeConnectedAccount(
        toApiSettings(settings),
        account.connectedAccountId,
      );
      yield* Console.log(
        `${palette.green("✓")} Removed ${palette.bold(`${removed.provider}/${removed.name}`)}`,
      );
    }),
).pipe(Command.withDescription("Disconnect a connected account"));
