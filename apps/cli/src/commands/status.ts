import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { ControlPlaneClientService, toApiSettings } from "../api-client.js";
import { currentSettings } from "../config.js";
import {
  accountDetails,
  formatDate,
  isColorEnabled,
  makePalette,
  renderTable,
  statusCell,
} from "../render.js";

export const authStatusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const settings = yield* currentSettings;
    const client = yield* ControlPlaneClientService;
    const palette = makePalette(isColorEnabled());

    const accounts = yield* client.listConnectedAccounts(toApiSettings(settings));

    if (accounts.length === 0) {
      yield* Console.log("No connected accounts yet.");
      yield* Console.log(
        palette.dim(
          "Connect one with `sealant auth claude`, `sealant auth codex`, or `sealant auth github`.",
        ),
      );
      return;
    }

    const rows = accounts.map((account) => [
      account.provider,
      account.name,
      statusCell(account.status, palette),
      account.kind,
      formatDate(account.connectedAt),
      accountDetails(account),
    ]);
    yield* Console.log(
      renderTable(["PROVIDER", "NAME", "STATUS", "KIND", "CONNECTED", "DETAILS"], rows, palette),
    );
  }),
).pipe(Command.withDescription("List connected accounts"));
