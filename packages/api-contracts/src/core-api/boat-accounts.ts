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
    userId: Schema.optional(Schema.String),
    login: Schema.optional(Schema.String),
    displayName: Schema.optional(Schema.String),
    serviceAccount: Schema.optional(Schema.Boolean),
    accountStatus: Schema.Literals(["active", "suspended", "closed", "unknown"]),
  }),
  /** A personal (account) key, or an organization's key. */
  keyKind: observedOr({ kind: Schema.Literals(["personal", "organization"]) }),
  /** Which wallet a VM started with the key bills (`GET /limits`). */
  wallet: observedOr({
    kind: Schema.Literals(["personal", "organization"]),
    organizationId: Schema.optional(Schema.String),
    organizationName: Schema.optional(Schema.String),
    role: Schema.optional(Schema.String),
  }),
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

export const boatAccountSchema = Schema.Struct({
  boatAccountId: BoatAccountId,
  label: NonEmptyString,
  /** `active`: workspaces may run in it. `removing`: its removal was asked; none may. */
  state: Schema.Literals(["active", "removing"]),
  createdAt: Schema.String,
  /** When its key was last replaced; null when it still has the key it was created with. */
  keyRotatedAt: Schema.NullOr(Schema.String),
  /** The Boat organization the account bills, sent on every request for it; null: none named. */
  organization: Schema.optional(Schema.NullOr(Schema.String)),
  /** The key's last report, with when it was observed; null until the key is checked. */
  report: Schema.optional(Schema.NullOr(boatKeyReportSchema)),
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
 * through this API.
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
    ]),
    liveRuns: Schema.optional(Schema.Int),
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
