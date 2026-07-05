import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import {
  connectedAccountProviderSchema,
  connectedAccountSummarySchema,
} from "./connected-accounts.js";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty(), Schema.isTrimmed());

/*
Minimal profiles surface: list a user's profiles and manage the per-provider connected-account
bindings that bundle credentials into a profile. Same trust model as ssh-keys/connected-accounts:
the internal API trusts the caller-supplied `ownerUserId` (web tRPC proxy and CLI inject it).
Bindings embed account summaries only — never secret material.
*/

export const profileStatusSchema = Schema.Literals(["active", "archived"]);
export type ProfileStatus = typeof profileStatusSchema.Type;

export const profileSummarySchema = Schema.Struct({
  profileId: NonEmptyString,
  ownerUserId: NonEmptyString,
  slug: NonEmptyString,
  name: NonEmptyString,
  description: Schema.NullOr(Schema.String),
  status: profileStatusSchema,
  activeRevisionId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ProfileSummary = typeof profileSummarySchema.Type;

export const listProfilesQuerySchema = Schema.Struct({
  ownerUserId: NonEmptyString,
});
export type ListProfilesQuery = typeof listProfilesQuerySchema.Type;

export const listProfilesResponseSchema = Schema.Struct({
  items: Schema.Array(profileSummarySchema),
});
export type ListProfilesResponse = typeof listProfilesResponseSchema.Type;

export const profileCredentialBindingWithAccountSchema = Schema.Struct({
  profileId: NonEmptyString,
  provider: connectedAccountProviderSchema,
  connectedAccountId: NonEmptyString,
  account: connectedAccountSummarySchema,
});
export type ProfileCredentialBindingWithAccount =
  typeof profileCredentialBindingWithAccountSchema.Type;

export const listProfileCredentialBindingsResponseSchema = Schema.Struct({
  items: Schema.Array(profileCredentialBindingWithAccountSchema),
});
export type ListProfileCredentialBindingsResponse =
  typeof listProfileCredentialBindingsResponseSchema.Type;

export const setProfileCredentialBindingRequestSchema = Schema.Struct({
  ownerUserId: NonEmptyString,
  provider: connectedAccountProviderSchema,
  // null clears the binding for that provider; the profile id travels in the URL.
  connectedAccountId: Schema.NullOr(NonEmptyString),
});
export type SetProfileCredentialBindingRequest =
  typeof setProfileCredentialBindingRequestSchema.Type;

export class ProfileBadRequestError extends Schema.TaggedErrorClass<ProfileBadRequestError>()(
  "ProfileBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class ProfileNotFoundError extends Schema.TaggedErrorClass<ProfileNotFoundError>()(
  "ProfileNotFoundError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class ProfileConflictError extends Schema.TaggedErrorClass<ProfileConflictError>()(
  "ProfileConflictError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class ProfileInternalServerError extends Schema.TaggedErrorClass<ProfileInternalServerError>()(
  "ProfileInternalServerError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {}

const profileIdParams = Schema.Struct({ profileId: NonEmptyString });

export const ProfilesGroup = HttpApiGroup.make("profiles")
  .add(
    HttpApiEndpoint.get("listProfiles", "/", {
      query: listProfilesQuerySchema,
      success: listProfilesResponseSchema,
      error: [ProfileInternalServerError],
    }),
  )
  .add(
    // Uniform 404 for "profile does not exist" and "profile is not yours".
    HttpApiEndpoint.get("listProfileCredentialBindings", "/:profileId/credential-bindings", {
      params: profileIdParams,
      query: listProfilesQuerySchema,
      success: listProfileCredentialBindingsResponseSchema,
      error: [ProfileNotFoundError, ProfileInternalServerError],
    }),
  )
  .add(
    // Upserts the (profile, provider) binding (null clears it) and returns the updated list.
    HttpApiEndpoint.put("setProfileCredentialBinding", "/:profileId/credential-bindings", {
      params: profileIdParams,
      payload: setProfileCredentialBindingRequestSchema,
      success: listProfileCredentialBindingsResponseSchema,
      error: [
        ProfileBadRequestError,
        ProfileNotFoundError,
        ProfileConflictError,
        ProfileInternalServerError,
      ],
    }),
  )
  .annotate(
    OpenApi.Description,
    "Profiles and their per-provider connected-account credential bindings.",
  );
