import { Context, Effect, Layer } from "effect";
import type { z } from "zod";

import { CliFailure, describeUnknown } from "./errors.js";
import {
  connectedAccountSummarySchema,
  listConnectedAccountsResponseSchema,
  listProfileCredentialBindingsResponseSchema,
  listProfilesResponseSchema,
  type ConnectedAccountProvider,
  type ConnectedAccountSummary,
  type ProfileCredentialBinding,
  type ProfileSummary,
} from "./schemas.js";

/*
 * Control-plane REST client. Same trust model as the web server proxy: the caller supplies
 * `ownerUserId` and the API trusts it inside the deployment's trust boundary. Plain fetch + zod,
 * mirroring apps/web's CoreApiClient. No endpoint ever returns secret material.
 */

export interface ApiSettings {
  readonly apiUrl: string;
  readonly ownerUserId: string;
}

export interface ControlPlaneClient {
  readonly createConnectedAccount: (
    settings: ApiSettings,
    input: {
      readonly provider: ConnectedAccountProvider;
      readonly name: string;
      readonly secret: string;
    },
  ) => Effect.Effect<ConnectedAccountSummary, CliFailure>;
  readonly listConnectedAccounts: (
    settings: ApiSettings,
  ) => Effect.Effect<ReadonlyArray<ConnectedAccountSummary>, CliFailure>;
  readonly removeConnectedAccount: (
    settings: ApiSettings,
    connectedAccountId: string,
  ) => Effect.Effect<ConnectedAccountSummary, CliFailure>;
  readonly listProfiles: (
    settings: ApiSettings,
  ) => Effect.Effect<ReadonlyArray<ProfileSummary>, CliFailure>;
  readonly listProfileCredentialBindings: (
    settings: ApiSettings,
    profileId: string,
  ) => Effect.Effect<ReadonlyArray<ProfileCredentialBinding>, CliFailure>;
  readonly setProfileCredentialBinding: (
    settings: ApiSettings,
    input: {
      readonly profileId: string;
      readonly provider: ConnectedAccountProvider;
      readonly connectedAccountId: string | null;
    },
  ) => Effect.Effect<ReadonlyArray<ProfileCredentialBinding>, CliFailure>;
}

export class ControlPlaneClientService extends Context.Service<
  ControlPlaneClientService,
  ControlPlaneClient
>()("@sealant/cli/ControlPlaneClientService") {}

/* ----------------------------------- live implementation ----------------------------------- */

const normalizeBaseUrl = (apiUrl: string): string => (apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);

const extractErrorMessage = (payload: unknown): string | undefined => {
  if (
    payload !== null &&
    typeof payload === "object" &&
    "message" in payload &&
    typeof payload.message === "string" &&
    payload.message.trim() !== ""
  ) {
    return payload.message;
  }
  return undefined;
};

interface RequestOptions<TOutput> {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly schema: z.ZodType<TOutput>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

const requestJson = <TOutput>(
  settings: ApiSettings,
  options: RequestOptions<TOutput>,
): Effect.Effect<TOutput, CliFailure> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => {
        const built = new URL(options.path, normalizeBaseUrl(settings.apiUrl));
        for (const [key, value] of Object.entries(options.query ?? {})) {
          built.searchParams.set(key, value);
        }
        return built;
      },
      catch: () =>
        new CliFailure({
          message: `Invalid API URL "${settings.apiUrl}".`,
          hint: "Fix it with `sealant config set apiUrl <url>` or --api-url.",
        }),
    });

    const requestInit: RequestInit =
      options.body === undefined
        ? { method: options.method }
        : {
            method: options.method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(options.body),
          };
    const response = yield* Effect.tryPromise({
      try: () => fetch(url, requestInit),
      catch: (cause) =>
        new CliFailure({
          message: `Could not reach the control plane at ${settings.apiUrl} (${describeUnknown(cause)}).`,
          hint: "Is the Sealant API running? Point the CLI at it with --api-url or `sealant config set apiUrl <url>`.",
        }),
    });

    const payload: unknown = yield* Effect.promise(() => response.json().catch(() => null));

    if (!response.ok) {
      const message =
        extractErrorMessage(payload) ?? `${response.status} ${response.statusText}`.trim();
      return yield* Effect.fail(
        new CliFailure({
          message: `Control plane request failed (${response.status}): ${message}`,
        }),
      );
    }

    const parsed = options.schema.safeParse(payload);
    if (!parsed.success) {
      return yield* Effect.fail(
        new CliFailure({
          message: `Unexpected response shape from ${options.method} /${options.path}.`,
          hint: "The control-plane API and this CLI may be out of sync.",
        }),
      );
    }
    return parsed.data;
  });

const makeControlPlaneClient = (): ControlPlaneClient => ({
  createConnectedAccount: (settings, input) =>
    requestJson(settings, {
      method: "POST",
      path: "v1/connected-accounts",
      schema: connectedAccountSummarySchema,
      body: {
        ownerUserId: settings.ownerUserId,
        provider: input.provider,
        name: input.name,
        secret: input.secret,
      },
    }),
  listConnectedAccounts: (settings) =>
    Effect.map(
      requestJson(settings, {
        method: "GET",
        path: "v1/connected-accounts",
        schema: listConnectedAccountsResponseSchema,
        query: { ownerUserId: settings.ownerUserId },
      }),
      (response) => response.items,
    ),
  removeConnectedAccount: (settings, connectedAccountId) =>
    requestJson(settings, {
      method: "DELETE",
      path: `v1/connected-accounts/${encodeURIComponent(connectedAccountId)}`,
      schema: connectedAccountSummarySchema,
      query: { ownerUserId: settings.ownerUserId },
    }),
  listProfiles: (settings) =>
    Effect.map(
      requestJson(settings, {
        method: "GET",
        path: "v1/profiles",
        schema: listProfilesResponseSchema,
        query: { ownerUserId: settings.ownerUserId },
      }),
      (response) => response.items,
    ),
  listProfileCredentialBindings: (settings, profileId) =>
    Effect.map(
      requestJson(settings, {
        method: "GET",
        path: `v1/profiles/${encodeURIComponent(profileId)}/credential-bindings`,
        schema: listProfileCredentialBindingsResponseSchema,
        query: { ownerUserId: settings.ownerUserId },
      }),
      (response) => response.items,
    ),
  setProfileCredentialBinding: (settings, input) =>
    Effect.map(
      requestJson(settings, {
        method: "PUT",
        path: `v1/profiles/${encodeURIComponent(input.profileId)}/credential-bindings`,
        schema: listProfileCredentialBindingsResponseSchema,
        body: {
          ownerUserId: settings.ownerUserId,
          provider: input.provider,
          connectedAccountId: input.connectedAccountId,
        },
      }),
      (response) => response.items,
    ),
});

export const ControlPlaneClientLive: Layer.Layer<ControlPlaneClientService> = Layer.sync(
  ControlPlaneClientService,
  makeControlPlaneClient,
);

/** Narrow resolved settings down to what the API client needs. */
export const toApiSettings = (settings: {
  readonly apiUrl: { readonly value: string };
  readonly ownerUserId: { readonly value: string };
}): ApiSettings => ({
  apiUrl: settings.apiUrl.value,
  ownerUserId: settings.ownerUserId.value,
});
