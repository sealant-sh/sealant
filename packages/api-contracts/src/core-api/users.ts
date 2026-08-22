/**
 * Users wire contracts — identity rows for products that own their own login.
 *
 * A SERVICE PRINCIPAL (Mend) provisions one Sealant user per person and then acts on their behalf
 * through the `ownerUserId` every owned endpoint carries. `ensureUser` is idempotent on email so
 * the caller can run it on every sign-in without bookkeeping; the id is the owner id to use from
 * then on. Sign-in credentials are never part of this surface — better-auth (web) owns those.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());

export const userSchema = Schema.Struct({
  userId: NonEmptyString,
  email: NonEmptyString,
  name: NonEmptyString,
  createdAt: Schema.String,
});
export type UserWire = typeof userSchema.Type;

export const ensureUserRequestSchema = Schema.Struct({
  /** Matched case-insensitively; the stored form is lower-cased. */
  email: NonEmptyString,
  name: NonEmptyString,
  /** Caller-chosen id for a NEW user (`usr_…`); ignored when the email already exists. */
  userId: Schema.optional(NonEmptyString),
});
export type EnsureUserRequest = typeof ensureUserRequestSchema.Type;

export const ensureUserResponseSchema = Schema.Struct({
  ...userSchema.fields,
  /** True when this call created the user. */
  created: Schema.Boolean,
});
export type EnsureUserResponse = typeof ensureUserResponseSchema.Type;

export class UserBadRequestError extends Schema.TaggedErrorClass<UserBadRequestError>()(
  "UserBadRequestError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class UserNotFoundError extends Schema.TaggedErrorClass<UserNotFoundError>()(
  "UserNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class UserInternalServerError extends Schema.TaggedErrorClass<UserInternalServerError>()(
  "UserInternalServerError",
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

const userIdParams = Schema.Struct({ userId: NonEmptyString });

export const UsersGroup = HttpApiGroup.make("users")
  .add(
    HttpApiEndpoint.post("ensureUser", "/", {
      payload: ensureUserRequestSchema,
      success: ensureUserResponseSchema,
      error: [UserBadRequestError, UserInternalServerError],
    }),
  )
  .add(
    HttpApiEndpoint.get("getUser", "/:userId", {
      params: userIdParams,
      success: userSchema,
      error: [UserNotFoundError, UserInternalServerError],
    }),
  )
  .annotate(
    OpenApi.Description,
    "Identity rows for products that own their own login and act on behalf of their users.",
  );
