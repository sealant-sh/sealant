import {
  WorkspaceBadRequestError,
  WorkspaceConflictError,
  WorkspaceInternalServerError,
  WorkspaceNotFoundError,
  WorkspaceServiceUnavailableError,
} from "@sealant/api-contracts";
import { BoatAccountRepo, createBoatWalletOf } from "@sealant/db";
import { BOAT_RUNTIME_ID } from "@sealant/validators";
import {
  BOAT_LAUNCH_REPORT_FRESH_MS,
  HttpBoatApi,
  boatLaunchRefusal,
  boatLaunchSupportOf,
  loadBoatCredential,
  type BoatKeyCheckClient,
  type BoatKeyProofClient,
  type BoatResult,
  type BoatSecret,
} from "@sealant/workspaces";
import { Context, Effect } from "effect";

import { env } from "../runtime-env.js";

/**
 * Whether the API can take part in Boat at all: it can open sealed Boat keys and run bearers
 * (`SEALANT_CREDENTIALS_KEY`). Whether Boat can launch is the worker's to say (`boatLaunchable`).
 */
export const BoatConfigured = Context.Reference<boolean>("@sealant/api/BoatConfigured", {
  defaultValue: () => env.SEALANT_CREDENTIALS_KEY !== undefined,
});

/** The Boat organization the install's own key bills (`SEALANT_BOAT_ORGANIZATION`), if named. */
export const BoatDefaultOrganization = Context.Reference<string | undefined>(
  "@sealant/api/BoatDefaultOrganization",
  { defaultValue: () => env.SEALANT_BOAT_ORGANIZATION },
);

const storeFailed = () =>
  new WorkspaceInternalServerError({ message: "Failed to read whether Boat can launch here." });

/** When this API process started (milliseconds since the epoch, by its own clock). */
const STARTED_AT = Date.now();
export const BoatApiStartedAt = Context.Reference<number>("@sealant/api/BoatApiStartedAt", {
  defaultValue: () => STARTED_AT,
});

/**
 * What the workers that reported in the last five minutes (by the database's clock) do for Boat
 * (`boat_launch_reports`), or `unknown`: none reported, and this API started too recently for a
 * worker started beside it to have reported yet (an upgrade, a restart). Unknown is not a refusal:
 * the create is accepted and waits for the worker, as it did before workers reported.
 */
const boatLaunchSupport = Effect.gen(function* () {
  const reports = yield* (yield* BoatAccountRepo)
    .launchReports(BOAT_LAUNCH_REPORT_FRESH_MS)
    .pipe(Effect.mapError(storeFailed));
  const support = boatLaunchSupportOf(reports);
  if (support.observedAt !== undefined) return support;
  return Date.now() - (yield* BoatApiStartedAt) < BOAT_LAUNCH_REPORT_FRESH_MS
    ? ("unknown" as const)
    : support;
});

/**
 * Whether this install can launch a Boat workspace, and why not: the one answer the create's
 * refusal and the runtime report both read. It is the worker's own: a worker launches Boat
 * workspaces and reports so (`boat_launch_reports`), with or without the install's own key; and
 * some account can run one, the install's own key on that worker or a stored account.
 */
export const boatLaunchRefusalNow = Effect.gen(function* () {
  if (!(yield* BoatConfigured))
    return "This install's API has no SEALANT_CREDENTIALS_KEY, so it cannot open Boat keys; the install's operator can set it.";
  const support = yield* boatLaunchSupport;
  if (support === "unknown") return undefined;
  const refusal = boatLaunchRefusal(support, { namesAccount: true, resources: "none" });
  if (refusal !== undefined || support.defaultAccount) return refusal;
  const stored = yield* (yield* BoatAccountRepo).list().pipe(Effect.mapError(storeFailed));
  return stored.some((account) => account.removalRequestedAt === null)
    ? undefined
    : "This install has no Boat key of its own and stores no Boat account, so no Boat workspace can be started. Store one (POST /v1/boat-accounts), or ask the install's operator to set SEALANT_BOAT_API_KEY.";
});

/**
 * Whether a worker that launches Boat workspaces has the resource gateway: what the runtime report
 * says of Boat's `resources`, from the same reports the create reads.
 */
export const boatResourceGateway = Effect.map(boatLaunchSupport, (support) =>
  support === "unknown" ? undefined : support.resourceGateway,
);

/** `boatLaunchable`: true when a Boat workspace can be launched here (see `boatLaunchRefusalNow`). */
export const boatLaunchable = Effect.map(boatLaunchRefusalNow, (refusal) => refusal === undefined);

/** The reads the API asks of Boat with a key: its check, and what a rotation must still see. */
export type BoatKeyClient = BoatKeyCheckClient &
  BoatKeyProofClient &
  Pick<HttpBoatApi, "get" | "getSnapshot">;

/**
 * How the API opens a Boat key into a client, naming the organization it bills when the account
 * names one: Boat's real API; a test's fake.
 */
export const BoatKeyClients = Context.Reference<
  (
    credential: BoatSecret,
    options?: { readonly organization?: string },
  ) => BoatResult<BoatKeyClient>
>("@sealant/api/BoatKeyClients", {
  defaultValue: () => (credential, options) =>
    HttpBoatApi.create({
      credential,
      ...(options?.organization === undefined ? {} : { organization: options.organization }),
    }),
});

/**
 * The install's own Boat key (`SEALANT_BOAT_API_KEY` or its file), for its check; never returned.
 * `undefined`: the install has none.
 */
export const BoatDefaultKey = Context.Reference<() => BoatResult<BoatSecret> | undefined>(
  "@sealant/api/BoatDefaultKey",
  {
    defaultValue: () => () =>
      env.SEALANT_BOAT_API_KEY === undefined && env.SEALANT_BOAT_API_KEY_FILE === undefined
        ? undefined
        : loadBoatCredential({
            value: env.SEALANT_BOAT_API_KEY,
            file: env.SEALANT_BOAT_API_KEY_FILE,
          }),
  },
);

/**
 * Boat where no worker launches it, or where no account can run it, is refused at create with the
 * sentence that says who can change it, under the code of any unregistered runtime.
 */
export const requireBoatConfigured = Effect.gen(function* () {
  const refusal = yield* boatLaunchRefusalNow;
  if (refusal === undefined) return;
  return yield* new WorkspaceServiceUnavailableError({
    code: "unsupported-runtime",
    message: refusal,
  });
});

/**
 * The Boat account a workspace's spec names (`runtime.boatAccountId`) is one it may run in: the
 * workspace runs on Boat, and the account is stored on this install and not being removed. A spec
 * that names none runs in the install's own account, which a launching worker must have
 * (`boat-account-required`). A spec that reaches project resources needs a launching worker with
 * the resource gateway (`gateway-unavailable`). Each is what the worker would refuse after the
 * create; it is refused here, before anything is reserved.
 */
export const requireBoatAccount = (
  spec: {
    readonly runtime: {
      readonly boatAccountId?: string | undefined;
      readonly resources?: string | undefined;
    };
  },
  runtimeFamily: string,
) =>
  Effect.gen(function* () {
    const accountId = spec.runtime.boatAccountId;
    const support =
      runtimeFamily === BOAT_RUNTIME_ID && (yield* BoatConfigured)
        ? yield* boatLaunchSupport
        : ("unknown" as const);
    if (support !== "unknown") {
      const refusal = boatLaunchRefusal(support, {
        namesAccount: accountId !== undefined,
        resources: spec.runtime.resources,
      });
      if (refusal !== undefined)
        return yield* new WorkspaceServiceUnavailableError({
          code: !support.launches
            ? "unsupported-runtime"
            : accountId === undefined && !support.defaultAccount
              ? "boat-account-required"
              : "gateway-unavailable",
          message: refusal,
        });
    }
    if (accountId === undefined) {
      if (runtimeFamily !== BOAT_RUNTIME_ID) return;
      // The install's own key, before Core has seen which wallet it bills: it creates nothing.
      const install = yield* (yield* BoatAccountRepo)
        .installWallet()
        .pipe(Effect.mapError(storeFailed));
      if (
        install !== undefined &&
        createBoatWalletOf(install.organization, install.keyKind).kind === "unresolved"
      )
        return yield* new WorkspaceConflictError({
          code: "boat-account-wallet-unresolved",
          message:
            "This install's own Boat key is not pinned to a Boat wallet yet: Core has not seen which wallet it bills (its check needs the key's account.read permission, and Boat to answer). No workspace starts in it until a worker has; set SEALANT_BOAT_ORGANIZATION, or give the key account.read, and try again in a minute.",
        });
      return;
    }
    if (runtimeFamily !== BOAT_RUNTIME_ID)
      return yield* new WorkspaceBadRequestError({
        message: `spec.runtime.boatAccountId names a Boat account, and this workspace runs on ${runtimeFamily}, not Boat. Name a Boat account only for a workspace on the Boat runtime.`,
      });
    const account = yield* (yield* BoatAccountRepo)
      .get(accountId)
      .pipe(
        Effect.mapError(
          () =>
            new WorkspaceInternalServerError({ message: "Failed to read the named Boat account." }),
        ),
      );
    if (account === undefined || account.removedAt !== null)
      return yield* new WorkspaceNotFoundError({
        message: `No Boat account ${accountId} is stored on this install (spec.runtime.boatAccountId).`,
      });
    if (account.removalRequestedAt !== null)
      return yield* new WorkspaceConflictError({
        message: `Boat account ${accountId} is being removed: no new workspace runs in it.`,
      });
    // Connected before Core pinned accounts, and not pinned yet: it creates nothing until the
    // worker has found where its things are (right after an upgrade).
    if (createBoatWalletOf(account.organization, account.keyKind).kind === "unresolved")
      return yield* new WorkspaceConflictError({
        code: "boat-account-wallet-unresolved",
        message:
          "The Boat account this workspace names was connected before Core pinned accounts to a wallet, and Core is still finding which Boat wallet its VMs and saved images are in: no new workspace starts in it until it is pinned, usually within a minute of an upgrade. If its key lacks Boat's account.read permission, Core cannot see the wallet: rotate it to a key that has it.",
      });
  });
