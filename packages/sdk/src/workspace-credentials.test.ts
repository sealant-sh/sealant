/**
 * `workspace.credentials`: put, release and list lower onto `/v1/workspaces/:id/credentials` the way
 * create's credentials do (`true` is the account named `default`, `null` removes a provider, `false`
 * leaves it out), the workspace stays the client owner's, and the answer is the home as it is.
 * Driven against a stub contract client (no live API).
 */
import type {
  ListWorkspaceCredentialsQuery,
  PutWorkspaceCredentialsRequest,
  ReleaseWorkspaceCredentialsQuery,
} from "@sealant/api-contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { type ControlPlaneClient, SealantApiClient } from "./effect/api-client.js";
import type { SdkRuntime, SdkServices } from "./effect/runtime.js";
import type { SdkContext } from "./facade/context.js";
import { makeWorkspace } from "./facade/workspace.js";
import { resolveInternalConfig } from "./internal/config.js";

const home = {
  home: "/home/m4ria0000",
  onBehalfOfUserId: "usr_maria",
  accounts: { claude: { connectedAccountId: "cacc_maria", name: "default" } },
};

// The derived `ControlPlaneClient` surface is far wider; the narrowing cast is test-only.
const makeStub = () => {
  const requests: Array<{ readonly op: string; readonly body: unknown }> = [];
  const workspaces = {
    putWorkspaceCredentials: (request: {
      params: { workspaceId: string };
      payload: PutWorkspaceCredentialsRequest;
    }) => {
      requests.push({ op: "put", body: request });
      return Effect.succeed({ workspaceId: "ws_1", runId: "run_1", home });
    },
    releaseWorkspaceCredentials: (request: {
      params: { workspaceId: string };
      query: ReleaseWorkspaceCredentialsQuery;
    }) => {
      requests.push({ op: "release", body: request });
      return Effect.succeed({
        workspaceId: "ws_1",
        runId: "run_1",
        home: request.query.home,
        released: true,
      });
    },
    listWorkspaceCredentials: (request: {
      params: { workspaceId: string };
      query: ListWorkspaceCredentialsQuery;
    }) => {
      requests.push({ op: "list", body: request });
      return Effect.succeed({ workspaceId: "ws_1", runId: "run_1", homes: [home] });
    },
  };
  return { client: { workspaces } as unknown as ControlPlaneClient, requests };
};

const makeCtx = (client: ControlPlaneClient): SdkContext => ({
  runtime: {
    run: <A, E, R extends SdkServices>(effect: Effect.Effect<A, E, R>): Promise<A> =>
      // The stub provides all of SdkServices; see run-lifecycle.test.ts for the same narrowing.
      Effect.runPromise(
        Effect.provideService(effect, SealantApiClient, client) as Effect.Effect<A, E>,
      ),
    dispose: () => Promise.resolve(),
  } satisfies SdkRuntime,
  config: resolveInternalConfig({ baseUrl: "http://stub.invalid", ownerUserId: "usr_owner" }),
});

const workspaceOver = (client: ControlPlaneClient) =>
  makeWorkspace(makeCtx(client), { id: "ws_1", name: "t", status: "ready" });

describe("workspace.credentials", () => {
  it("puts a person's logins into a home: `true` is `default`, `null` removes, `false` is left out", async () => {
    const { client, requests } = makeStub();
    const answered = await workspaceOver(client).credentials.put({
      home: "/home/m4ria0000",
      onBehalfOf: "usr_maria",
      claude: true,
      codex: null,
      github: false,
    });

    expect(requests).toEqual([
      {
        op: "put",
        body: {
          params: { workspaceId: "ws_1" },
          payload: {
            ownerUserId: "usr_owner",
            onBehalfOfUserId: "usr_maria",
            home: "/home/m4ria0000",
            claude: "default",
            codex: null,
          },
        },
      },
    ]);
    expect(answered).toEqual({
      home: "/home/m4ria0000",
      onBehalfOf: "usr_maria",
      accounts: { claude: { connectedAccountId: "cacc_maria", name: "default" } },
    });
  });

  it("releases a home and lists the homes, as the client's owner", async () => {
    const { client, requests } = makeStub();
    const workspace = workspaceOver(client);

    expect(await workspace.credentials.release("/run/mend/conv/ses_1")).toEqual({ released: true });
    expect(await workspace.credentials.list()).toEqual([
      {
        home: "/home/m4ria0000",
        onBehalfOf: "usr_maria",
        accounts: { claude: { connectedAccountId: "cacc_maria", name: "default" } },
      },
    ]);
    expect(requests).toEqual([
      {
        op: "release",
        body: {
          params: { workspaceId: "ws_1" },
          query: { ownerUserId: "usr_owner", home: "/run/mend/conv/ses_1" },
        },
      },
      {
        op: "list",
        body: { params: { workspaceId: "ws_1" }, query: { ownerUserId: "usr_owner" } },
      },
    ]);
  });

  it("lowers pi's and opencode's logins onto the person's Codex accounts and maps them back", async () => {
    const { client, requests } = makeStub();
    await workspaceOver(client).credentials.put({
      home: "/home/m4ria0000",
      onBehalfOf: "usr_maria",
      pi: true,
      opencode: "work",
    });
    expect(requests[0]?.body).toMatchObject({
      payload: { pi: "default", opencode: "work" },
    });
    const withPi = {
      ...home,
      accounts: { ...home.accounts, pi: { connectedAccountId: "cacc_codex", name: "default" } },
    };
    const listed = await workspaceOver({
      workspaces: {
        listWorkspaceCredentials: () =>
          Effect.succeed({ workspaceId: "ws_1", runId: "run_1", homes: [withPi] }),
      },
    } as unknown as ControlPlaneClient).credentials.list();
    expect(listed[0]?.accounts.pi).toEqual({ connectedAccountId: "cacc_codex", name: "default" });
  });
});
