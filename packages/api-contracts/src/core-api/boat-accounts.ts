/**
 * Boat accounts wire contracts — the Boat API keys an install keeps beside its default one.
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

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());
/**
 * A key is checked only for being there: a check that failed on its value would print it in the
 * client's encoding error. The control plane refuses a malformed key without naming it.
 */
const SecretString = Schema.String.check(Schema.isNonEmpty());
const BoatAccountId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
);

export const boatAccountSchema = Schema.Struct({
  boatAccountId: BoatAccountId,
  label: NonEmptyString,
  /** `active`: workspaces may run in it. `removing`: its removal was asked; none may. */
  state: Schema.Literals(["active", "removing"]),
  createdAt: Schema.String,
  /** When its key was last replaced; null when it still has the key it was created with. */
  keyRotatedAt: Schema.NullOr(Schema.String),
});
export type BoatAccountWire = typeof boatAccountSchema.Type;

export const createBoatAccountRequestSchema = Schema.Struct({
  /** The caller's name for the account (an organization's name, say). At most 200 characters. */
  label: NonEmptyString,
  /** The Boat API key. Checked with Boat by one read-only call before it is stored. */
  apiKey: SecretString,
});
export type CreateBoatAccountRequest = typeof createBoatAccountRequestSchema.Type;

export const rotateBoatAccountKeyRequestSchema = Schema.Struct({
  /** The new Boat API key, for the same Boat account: it must see every VM the account runs. */
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
 * Boat refused the key (`boat-key-refused`: it answered that the key is not valid), or did not
 * answer whether it is (`boat-key-unverified`: Boat was unreachable; try again). Nothing was
 * stored or changed. The message never names the key or any part of it.
 */
export class BoatAccountKeyRefusedError extends Schema.TaggedError<BoatAccountKeyRefusedError>()(
  "BoatAccountKeyRefusedError",
  {
    message: Schema.String,
    code: Schema.Literals(["boat-key-refused", "boat-key-unverified"]),
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
      params: boatAccountIdParams,
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
    // The removal's first step: the account takes no new workspace at once, and its saved images
    // are deleted from Boat by the worker before it is gone from the list.
    HttpApiEndpoint.delete("removeBoatAccount", "/:boatAccountId", {
      params: boatAccountIdParams,
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
    "The Boat API keys an install keeps beside its default one: one Boat account each, for the workspaces that name it.",
  );
