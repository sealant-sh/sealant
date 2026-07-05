import {
  ProfileBadRequestError,
  ProfileConflictError,
  ProfileInternalServerError,
  ProfileNotFoundError,
  type ListProfileCredentialBindingsResponse,
  type ListProfilesResponse,
  type ProfileSummary,
  type SetProfileCredentialBindingRequest,
} from "@sealant/api-contracts";
import { ConnectedAccountRepo, ProfileRepo } from "@sealant/db";
import { Context, Effect } from "effect";

import { toConnectedAccountSummary } from "../connected-accounts/connected-accounts.module.js";

/*
Minimal profiles surface: list a user's profiles and manage the per-provider connected-account
bindings (the credential "bundle"). Same trust model as ssh-keys/connected-accounts: the internal
API trusts the caller-supplied owner; ownership mismatches surface as uniform 404s.
*/

type ProfileRepoServiceShape = Context.Service.Shape<typeof ProfileRepo>;
type ProfileRecord = NonNullable<
  Effect.Success<ReturnType<ProfileRepoServiceShape["getProfileById"]>>
>;

const toErrorMessage = (error: unknown, fallback: string): string => {
  return error instanceof Error ? error.message : fallback;
};

const withInternalError = <A, E, R>(effect: Effect.Effect<A, E, R>, fallback: string) => {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new ProfileInternalServerError({
          message: toErrorMessage(error, fallback),
        }),
    ),
  );
};

const toProfileSummary = (profile: ProfileRecord): ProfileSummary => {
  return {
    profileId: profile.id,
    ownerUserId: profile.ownerUserId,
    slug: profile.slug,
    name: profile.name,
    description: profile.description,
    status: profile.status,
    activeRevisionId: profile.activeRevisionId,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
};

/** Uniform 404: unknown profile and someone else's profile look identical. */
const requireOwnedProfile = (input: {
  readonly profileId: string;
  readonly ownerUserId: string;
}) => {
  return Effect.gen(function* () {
    const profileRepo = yield* ProfileRepo;

    const profile = yield* withInternalError(
      profileRepo.getProfileById(input.profileId),
      "Failed to load profile.",
    );

    if (profile === undefined || profile.ownerUserId !== input.ownerUserId) {
      return yield* new ProfileNotFoundError({
        message: `Profile not found: ${input.profileId}`,
      });
    }

    return profile;
  });
};

const credentialBindingsResponse = (profileId: string) => {
  return Effect.gen(function* () {
    const connectedAccountRepo = yield* ConnectedAccountRepo;

    const bindings = yield* withInternalError(
      connectedAccountRepo.getBindingsForProfileWithAccounts(profileId),
      "Failed to list profile credential bindings.",
    );

    return {
      items: bindings.map(({ binding, account }) => {
        return {
          profileId: binding.profileId,
          provider: binding.provider,
          connectedAccountId: binding.connectedAccountId,
          account: toConnectedAccountSummary(account),
        };
      }),
    } satisfies ListProfileCredentialBindingsResponse;
  });
};

export const listProfiles = (input: { readonly ownerUserId: string }) => {
  return Effect.gen(function* () {
    const profileRepo = yield* ProfileRepo;

    const items = yield* withInternalError(
      profileRepo.listProfilesByOwner({ ownerUserId: input.ownerUserId }),
      "Failed to list profiles.",
    );

    return { items: items.map(toProfileSummary) } satisfies ListProfilesResponse;
  });
};

export const listProfileCredentialBindings = (input: {
  readonly profileId: string;
  readonly ownerUserId: string;
}) => {
  return Effect.gen(function* () {
    const profile = yield* requireOwnedProfile(input);

    return yield* credentialBindingsResponse(profile.id);
  });
};

export const setProfileCredentialBinding = (input: {
  readonly profileId: string;
  readonly payload: SetProfileCredentialBindingRequest;
}) => {
  return Effect.gen(function* () {
    const profile = yield* requireOwnedProfile({
      profileId: input.profileId,
      ownerUserId: input.payload.ownerUserId,
    });

    const connectedAccountRepo = yield* ConnectedAccountRepo;

    if (input.payload.connectedAccountId === null) {
      // null clears the binding for that provider; clearing a non-existent binding is a no-op.
      yield* withInternalError(
        connectedAccountRepo.clearProfileBinding({
          profileId: profile.id,
          provider: input.payload.provider,
        }),
        "Failed to clear profile credential binding.",
      );

      return yield* credentialBindingsResponse(profile.id);
    }

    const account = yield* withInternalError(
      connectedAccountRepo.getById(input.payload.connectedAccountId),
      "Failed to load connected account.",
    );

    // Uniform 404: unknown account and someone else's account look identical.
    if (account === undefined || account.ownerUserId !== input.payload.ownerUserId) {
      return yield* new ProfileNotFoundError({
        message: `Connected account not found: ${input.payload.connectedAccountId}`,
      });
    }

    if (account.provider !== input.payload.provider) {
      return yield* new ProfileBadRequestError({
        message: `Connected account ${account.id} is a ${account.provider} account and cannot be bound as ${input.payload.provider}.`,
      });
    }

    if (account.status !== "active" || account.archivedAt !== null) {
      return yield* new ProfileConflictError({
        message: `Connected ${account.provider} account "${account.name}" is ${account.status} — reconnect it before binding.`,
      });
    }

    yield* withInternalError(
      connectedAccountRepo.setProfileBinding({
        profileId: profile.id,
        provider: input.payload.provider,
        connectedAccountId: account.id,
      }),
      "Failed to set profile credential binding.",
    );

    return yield* credentialBindingsResponse(profile.id);
  });
};
