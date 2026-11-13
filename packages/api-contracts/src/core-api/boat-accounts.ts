/**
 * Boat accounts wire contracts — the Boat keys an install keeps beside its default one.
 *
 * An install's default Boat account is its env key (`SEALANT_BOAT_API_KEY`). A product that serves
 * several organizations (Mend) stores one more account per organization, so each organization's
 * Boat VMs run in, and are billed to, that organization's own Boat account. Core has no notion of
 * organizations: it knows the account by id, and the caller keeps the mapping.
 *
 * A workspace names its account at create (`spec.runtime.boatAccountId`; SDK `boatAccountId`) and
 * every run of it stays in that account. Install-scoped: a caller that reached this surface holds
 * a service key. A key goes in and never comes out: no answer, error or log carries it.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";

import { boatFailureSchema } from "./boat-failures.js";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());
/**
 * A key is checked only for being there: a check that failed on its value would print it in the
 * client's encoding error. The control plane refuses a malformed key without naming it.
 */
const SecretString = Schema.String.check(Schema.isNonEmpty());
const BoatAccountId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
);

/**
 * The install's own Boat key (its env key), as rotation and removal refuse it
 * (`boat-account-environment`). It is read through `install-key`, never listed: `list` answers
 * stored accounts only, with ids every released client decodes.
 */
export const BOAT_DEFAULT_ACCOUNT_ID = "default";
const BoatAccountRef = Schema.Union([BoatAccountId, Schema.Literal(BOAT_DEFAULT_ACCOUNT_ID)]);

/**
 * A fact Boat did not let Core observe, and why. `refused`: Boat refused the read (`boat` says
 * how; an organization key is refused Boat's key list). `no-answer`: Boat did not answer.
 * `not-listed`: Boat's key list did not include this key (a key limited to some VMs gets an empty
 * list), or included more than one that could be it. `unreadable`: Boat answered with something
 * Core could not read. Core never guesses a fact it did not observe.
 */
export const boatKeyNotObservedSchema = Schema.Struct({
  observed: Schema.Literal(false),
  reason: Schema.Literals(["refused", "no-answer", "not-listed", "unreadable"]),
  boat: Schema.optional(boatFailureSchema),
});
export type BoatKeyNotObserved = typeof boatKeyNotObservedSchema.Type;
const observedOr = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Union([
    Schema.Struct({ observed: Schema.Literal(true), ...fields }),
    boatKeyNotObservedSchema,
  ]);

/** A wallet a VM can bill: a person's own Boat account, or one of their Boat organizations. */
const boatWalletFields = {
  kind: Schema.Literals(["personal", "organization"]),
  organizationId: Schema.optional(Schema.String),
  organizationName: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
};
export const boatWalletSchema = Schema.Struct(boatWalletFields);
export type BoatWallet = typeof boatWalletSchema.Type;

/**
 * One wallet the key's Boat account can bill (`GET /orgs`): its own (`personal`), or an
 * organization it belongs to, with the account's role there. `active`: the account's active wallet,
 * which an unpinned personal key bills. `id` is what a pin names: an organization's id, or
 * `personal` for the account's own wallet.
 */
export const boatKeyWalletChoiceSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["personal", "organization"]),
  name: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  active: Schema.Boolean,
});
export type BoatKeyWalletChoice = typeof boatKeyWalletChoiceSchema.Type;

/**
 * Whether the account's requests name the wallet to bill. `pinned`: every request names
 * `organization` (an organization's id or name, or `personal`), so the bill never follows the key's
 * active wallet. `key-organization`: an organization's Boat key, which bills that organization and
 * nothing else; there is nothing to choose. `active-wallet`: a personal key with no pin, which bills
 * whichever wallet its Boat account has active, and that the person can change in Boat at any time
 * (a stored account is in it only until Core pins it, right after an upgrade);
 * `walletChanged` says the wallet it bills now is not the one an earlier report saw (`from`), first
 * seen at `observedAt`, and stays while the wallet stays.
 */
export const boatKeyBillingSchema = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("pinned"), organization: Schema.String }),
  Schema.Struct({ mode: Schema.Literal("key-organization") }),
  Schema.Struct({
    mode: Schema.Literal("active-wallet"),
    walletChanged: Schema.optional(
      Schema.Struct({ from: boatWalletSchema, observedAt: Schema.String }),
    ),
  }),
]);
export type BoatKeyBilling = typeof boatKeyBillingSchema.Type;

/**
 * What Core observed of a Boat key, from Boat's own answers, at `observedAt`. Each fact is
 * `observed: true` with its value, or `observed: false` with the reason Boat did not show it.
 */
export const boatKeyReportSchema = Schema.Struct({
  observedAt: Schema.String,
  /** The Boat organization the account bills (`X-Boat-Org` on every request), or null. */
  organization: Schema.NullOr(Schema.String),
  /** Who the key is (`GET /me`). */
  identity: observedOr({
    /**
     * Boat's id for the account the key belongs to (`GET /me` `user.id`). A Boat account, never a
     * Sealant person: it is not a `PersonId` and names no one on this install.
     */
    accountId: Schema.optional(Schema.String),
    login: Schema.optional(Schema.String),
    displayName: Schema.optional(Schema.String),
    serviceAccount: Schema.optional(Schema.Boolean),
    accountStatus: Schema.Literals(["active", "suspended", "closed", "unknown"]),
  }),
  /** A personal (account) key, or an organization's key. */
  keyKind: observedOr({ kind: Schema.Literals(["personal", "organization"]) }),
  /** Which wallet a VM started with the key bills (`GET /limits`). */
  wallet: observedOr(boatWalletFields),
  /**
   * The wallets the key's Boat account can bill (`GET /orgs`), the active one marked. Absent in
   * reports made before Core read them.
   */
  wallets: Schema.optional(observedOr({ choices: Schema.Array(boatKeyWalletChoiceSchema) })),
  /**
   * Whether the account names the wallet it bills, or follows the key's active wallet. Absent in
   * reports made before Core said so.
   */
  billing: Schema.optional(boatKeyBillingSchema),
  /** The permissions Core needs of every key, from the Boat calls it makes. */
  requiredPermissions: Schema.Array(Schema.String),
  /** The key's permissions (`GET /api-keys`), and which of the required ones it lacks. */
  permissions: observedOr({
    held: Schema.Array(Schema.String),
    missing: Schema.Array(Schema.String),
    /** The key is limited to some VMs or environments: it cannot reach VMs Core creates. */
    limitedToSandboxes: Schema.Boolean,
  }),
  /** When the key expires; `expiresAt` null: it never does. */
  expiry: observedOr({
    expiresAt: Schema.NullOr(Schema.String),
    expired: Schema.Boolean,
    expiringSoon: Schema.Boolean,
  }),
  /** Whether the wallet can start a VM now, why not, and its running and allowed VMs. */
  start: observedOr({
    canStart: Schema.Boolean,
    blockedReason: Schema.optional(Schema.String),
    billingStatus: Schema.optional(Schema.String),
    runningVms: Schema.Int,
    allowedVms: Schema.Int,
  }),
  /** Saved snapshot slots of the wallet (`GET /saved-snapshots`). */
  snapshots: observedOr({ used: Schema.Int, included: Schema.Int }),
});
export type BoatKeyReport = typeof boatKeyReportSchema.Type;

/** The steps of a Boat key's full check, in order: the last two are also its cleanup. */
export const BOAT_KEY_PROOF_STEPS = [
  "start-vm",
  "run-command",
  "publish-port",
  "save-snapshot",
  "delete-snapshot",
  "delete-vm",
] as const;
export type BoatKeyProofStepName = (typeof BOAT_KEY_PROOF_STEPS)[number];

/**
 * One step of a full check. `passed`: Boat did it. `refused`: Boat refused it, `boat` says why.
 * `no-answer`: Boat did not answer (the step may have happened; cleanup assumes it did).
 * `not-reached`: an earlier step stopped the check, and this one was not tried.
 */
export const boatKeyProofStepSchema = Schema.Struct({
  step: Schema.Literals(BOAT_KEY_PROOF_STEPS),
  outcome: Schema.Literals(["passed", "refused", "no-answer", "not-reached"]),
  boat: Schema.optional(boatFailureSchema),
});
export type BoatKeyProofStep = typeof boatKeyProofStepSchema.Type;

/**
 * A full check of a Boat key: Core started the smallest VM, ran a command in it, published a port,
 * saved a snapshot, then deleted the snapshot and the VM, and says how far it got. `outcome`:
 * `passed` (every step), `refused` (Boat refused a step; the first refused or unanswered step
 * says why), or `interrupted` (the check stopped before it finished; what it made was removed by
 * the sweep). `starts`: how many VM starts it asked Boat for (0 or 1). `leftBehind`: what Boat
 * may still hold of it when the answer was given. `removalConfirmed` true: Core saw Boat delete
 * everything it made. False: the worker's sweep owns what is left and keeps deleting it, with
 * `vm` (an id) and `snapshot` (a name) naming what is known; `vm` is null when a VM may exist
 * whose id Boat never answered (the sweep finds it by its label). Until the sweep has finished,
 * the account's key is neither rotated nor removed.
 */
export const boatKeyProofSchema = Schema.Struct({
  proofId: Schema.String,
  startedAt: Schema.String,
  finishedAt: Schema.String,
  outcome: Schema.Literals(["passed", "refused", "interrupted"]),
  steps: Schema.Array(boatKeyProofStepSchema),
  starts: Schema.Int,
  leftBehind: Schema.Struct({
    vm: Schema.NullOr(Schema.String),
    snapshot: Schema.NullOr(Schema.String),
    removalConfirmed: Schema.Boolean,
  }),
});
export type BoatKeyProof = typeof boatKeyProofSchema.Type;

export const boatAccountSchema = Schema.Struct({
  boatAccountId: BoatAccountId,
  label: NonEmptyString,
  /** `active`: workspaces may run in it. `removing`: its removal was asked; none may. */
  state: Schema.Literals(["active", "removing"]),
  createdAt: Schema.String,
  /** When its key was last replaced; null when it still has the key it was created with. */
  keyRotatedAt: Schema.NullOr(Schema.String),
  /**
   * The wallet the account bills, named (`X-Boat-Org`) on every request it makes: an
   * organization's id, or `personal`. Every personal key is pinned (to the wallet it billed when it
   * was connected, unless the caller named another). Null: an organization's key, which has one
   * wallet, or an account connected before Core pinned accounts that the worker has not pinned yet.
   */
  organization: Schema.optional(Schema.NullOr(Schema.String)),
  /** The key's last report, with when it was observed; null until the key is checked. */
  report: Schema.optional(Schema.NullOr(boatKeyReportSchema)),
  /** The account's last full check (`prove`), kept beside its report; null until it is proven. */
  lastProof: Schema.optional(Schema.NullOr(boatKeyProofSchema)),
  /**
   * What the account made in Boat that Core cannot reach: Core looked under every wallet the key
   * can bill and Boat has it in none (it was made before Core recorded wallets, and since deleted
   * in Boat, or left in an organization the key's account has left). Core keeps it recorded and
   * never removes it; look for it under Saved snapshots in Boat, in each organization the key's
   * account has been in. Null or absent: nothing.
   */
  unreachable: Schema.optional(
    Schema.NullOr(Schema.Struct({ savedImages: Schema.Array(Schema.String) })),
  ),
});
export type BoatAccountWire = typeof boatAccountSchema.Type;

/**
 * The install's own Boat key (`SEALANT_BOAT_API_KEY`), which workspaces run in when they name no
 * account: never its value, only its last report. It is set in the install's environment, so it
 * cannot be rotated or removed through this API.
 */
export const boatInstallKeySchema = Schema.Struct({
  label: NonEmptyString,
  /** The key's last report, with when it was observed; null until it is checked. */
  report: Schema.NullOr(boatKeyReportSchema),
});
export type BoatInstallKeyWire = typeof boatInstallKeySchema.Type;

export const createBoatAccountRequestSchema = Schema.Struct({
  /** The caller's name for the account (an organization's name, say). At most 200 characters. */
  label: NonEmptyString,
  /** The Boat key. Checked with Boat by read-only calls before it is stored; whitespace around it is trimmed. */
  apiKey: SecretString,
  /**
   * For a personal key: the Boat organization to bill (its id or name), sent as `X-Boat-Org` on
   * every request for the account, so billing never follows the key's active wallet.
   */
  organization: Schema.optional(NonEmptyString),
});
export type CreateBoatAccountRequest = typeof createBoatAccountRequestSchema.Type;

export const setBoatAccountOrganizationRequestSchema = Schema.Struct({
  /**
   * The wallet to bill from now on: an organization's id (or name) from the key report's
   * `wallets`, or `personal` for the key's own Boat account. Only a personal key can be pointed at
   * a wallet. Null is refused: a personal key's account is never unpinned.
   */
  organization: Schema.NullOr(NonEmptyString),
});
export type SetBoatAccountOrganizationRequest = typeof setBoatAccountOrganizationRequestSchema.Type;

export const rotateBoatAccountKeyRequestSchema = Schema.Struct({
  /** The new Boat key, for the same Boat account: it must see every VM the account runs. */
  apiKey: SecretString,
});
export type RotateBoatAccountKeyRequest = typeof rotateBoatAccountKeyRequestSchema.Type;

export const listBoatAccountsResponseSchema = Schema.Struct({
  items: Schema.Array(boatAccountSchema),
});
export type ListBoatAccountsResponse = typeof listBoatAccountsResponseSchema.Type;

export class BoatAccountBadRequestError extends Schema.TaggedError<BoatAccountBadRequestError>()(
  "BoatAccountBadRequestError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/**
 * Boat refused the key (`boat-key-refused`: it answered that the key is not valid, has expired or
 * belongs to another organization; `boat` says which), the key provably lacks permissions Core
 * needs (`boat-key-missing-permissions`, named in `missingPermissions`), or Boat did not answer
 * whether it is valid (`boat-key-unverified`: try again). Nothing was stored or changed. The
 * message never names the key or any part of it.
 */
export class BoatAccountKeyRefusedError extends Schema.TaggedError<BoatAccountKeyRefusedError>()(
  "BoatAccountKeyRefusedError",
  {
    message: Schema.String,
    code: Schema.Literals([
      "boat-key-refused",
      "boat-key-unverified",
      "boat-key-missing-permissions",
    ]),
    missingPermissions: Schema.optional(Schema.Array(Schema.String)),
    boat: Schema.optional(boatFailureSchema),
    report: Schema.optional(boatKeyReportSchema),
  },
  { httpApiStatus: 422 },
) {}

export class BoatAccountNotFoundError extends Schema.TaggedError<BoatAccountNotFoundError>()(
  "BoatAccountNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/**
 * The account is in a state that refuses the call. `boat-account-in-use`: a removal while it still
 * has runs whose VMs Boat may hold (`liveRuns`) or an image build in flight (`buildsInFlight`), or
 * a rotation while a launch's create is unresolved (`liveRuns`: only the current key can find
 * its VM).
 * `boat-key-cannot-see`: a rotation to a key that cannot see VMs or saved images the account has
 * now (`unseen`), so it is most likely another Boat account's key. `boat-account-removing`: the
 * account's removal was asked. `boat-account-changed`: another rotation won; read and try again.
 * `boat-account-environment`: the install's own key (`default`) is set in its environment, not
 * through this API. `boat-proof-running`: a full check of the account is running, or Boat may
 * still hold what one made (the message names the VM and the snapshot): a second check, a key
 * rotation, a removal and a change of organization wait until Core has deleted it.
 * `boat-key-organization`: a change of organization for an organization's Boat key, which bills
 * its own organization and nothing else. `boat-account-wallet-unresolved`: a change of organization
 * for an account connected before Core pinned accounts, while Core is still finding where its
 * VMs and images are (a key rotation or a full check then answers `boat-account-in-use`). A change
 * of organization is also refused
 * `boat-account-in-use` while the account has runs whose VMs Boat may hold (`liveRuns`), runs
 * still being settled (`unsettledRuns`) or image builds in flight or being cleaned up
 * (`buildsInFlight`).
 */
export class BoatAccountConflictError extends Schema.TaggedError<BoatAccountConflictError>()(
  "BoatAccountConflictError",
  {
    message: Schema.String,
    code: Schema.Literals([
      "boat-account-in-use",
      "boat-key-cannot-see",
      "boat-account-removing",
      "boat-account-changed",
      "boat-account-environment",
      "boat-proof-running",
      "boat-key-organization",
      "boat-account-wallet-unresolved",
    ]),
    liveRuns: Schema.optional(Schema.Int),
    unsettledRuns: Schema.optional(Schema.Int),
    buildsInFlight: Schema.optional(Schema.Int),
    unseen: Schema.optional(Schema.Int),
  },
  { httpApiStatus: 409 },
) {}

/** The install serves no Boat (no env key), or keeps no credentials (`SEALANT_CREDENTIALS_KEY`). */
export class BoatAccountServiceUnavailableError extends Schema.TaggedError<BoatAccountServiceUnavailableError>()(
  "BoatAccountServiceUnavailableError",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

export class BoatAccountInternalServerError extends Schema.TaggedError<BoatAccountInternalServerError>()(
  "BoatAccountInternalServerError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

const boatAccountIdParams = Schema.Struct({ boatAccountId: BoatAccountId });
/** Rotation and removal also take `default`, to refuse it by name (`boat-account-environment`). */
const boatAccountRefParams = Schema.Struct({ boatAccountId: BoatAccountRef });

export const BoatAccountsGroup = HttpApiGroup.make("boatAccounts")
  .add(
    HttpApiEndpoint.post("createBoatAccount", "/", {
      payload: createBoatAccountRequestSchema,
      success: boatAccountSchema.pipe(HttpApiSchema.status(201)),
      error: [
        BoatAccountBadRequestError,
        BoatAccountKeyRefusedError,
        BoatAccountServiceUnavailableError,
        BoatAccountInternalServerError,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.get("listBoatAccounts", "/", {
      success: listBoatAccountsResponseSchema,
      error: [BoatAccountServiceUnavailableError, BoatAccountInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.put("rotateBoatAccountKey", "/:boatAccountId/key", {
      params: boatAccountRefParams,
      payload: rotateBoatAccountKeyRequestSchema,
      success: boatAccountSchema,
      error: [
        BoatAccountBadRequestError,
        BoatAccountKeyRefusedError,
        BoatAccountNotFoundError,
        BoatAccountConflictError,
        BoatAccountServiceUnavailableError,
        BoatAccountInternalServerError,
      ],
    }),
  )
  .add(
    // Points the account at another wallet, without its key. What it made stays recorded in the
    // wallet it was made in; its saved images there are removed with requests that name it.
    HttpApiEndpoint.put("setBoatAccountOrganization", "/:boatAccountId/organization", {
      params: boatAccountRefParams,
      payload: setBoatAccountOrganizationRequestSchema,
      success: boatAccountSchema,
      error: [
        BoatAccountBadRequestError,
        BoatAccountKeyRefusedError,
        BoatAccountNotFoundError,
        BoatAccountConflictError,
        BoatAccountServiceUnavailableError,
        BoatAccountInternalServerError,
      ],
    }),
  )
  .add(
    // The install's own key's last report (never the key).
    HttpApiEndpoint.get("getBoatInstallKey", "/install-key", {
      success: boatInstallKeySchema,
      error: [BoatAccountServiceUnavailableError, BoatAccountInternalServerError],
    }),
  )
  .add(
    // Checks the install's own key with Boat now (read-only) and stores the report it answers.
    HttpApiEndpoint.post("checkBoatInstallKey", "/install-key", {
      success: boatInstallKeySchema,
      error: [
        BoatAccountKeyRefusedError,
        BoatAccountServiceUnavailableError,
        BoatAccountInternalServerError,
      ],
    }),
  )
  .add(
    // Checks a stored account's key with Boat again (read-only) and stores the report it answers.
    HttpApiEndpoint.post("checkBoatAccount", "/:boatAccountId/check", {
      params: boatAccountIdParams,
      success: boatAccountSchema,
      error: [
        BoatAccountKeyRefusedError,
        BoatAccountNotFoundError,
        BoatAccountServiceUnavailableError,
        BoatAccountInternalServerError,
      ],
    }),
  )
  .add(
    // A full check: a throwaway VM is started, used and deleted, with a snapshot saved and
    // deleted; whatever it made is removed on every path. One per account at a time.
    HttpApiEndpoint.post("proveBoatAccount", "/:boatAccountId/prove", {
      params: Schema.Struct({ boatAccountId: BoatAccountId }),
      success: boatKeyProofSchema,
      error: [
        BoatAccountNotFoundError,
        BoatAccountConflictError,
        BoatAccountServiceUnavailableError,
        BoatAccountInternalServerError,
      ],
    }),
  )
  .add(
    // The removal's first step: the account takes no new workspace at once, and its saved images
    // are deleted from Boat by the worker before it is gone from the list.
    HttpApiEndpoint.delete("removeBoatAccount", "/:boatAccountId", {
      params: boatAccountRefParams,
      success: boatAccountSchema,
      error: [
        BoatAccountNotFoundError,
        BoatAccountConflictError,
        BoatAccountServiceUnavailableError,
        BoatAccountInternalServerError,
      ],
    }),
  )
  .annotate(
    OpenApi.Description,
    "The Boat keys an install keeps beside its default one: one Boat account each, for the workspaces that name it.",
  );
