/**
 * `sealant.scopes`: the requests it sends and the SDK shapes it answers, against a stubbed `fetch`,
 * and a client acting as a scope that has no method reaching a credential or a harness (the
 * `@ts-expect-error` lines fail typecheck the day one appears).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Sealant } from "./client.js";
import { SealantApiError } from "./errors.js";
import type { ScopeClient } from "./scopes.js";

const SCOPE = "rdm:6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const CREATED_AT = "2026-10-30T00:00:00.000Z";
const member = { userId: "usr_alice", state: "member", version: 1, updatedAt: CREATED_AT };

type Answer = (path: string) => { readonly status: number; readonly body: unknown };
let answer: Answer = () => ({ status: 500, body: {} });
let seen: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> = [];

// The client's fetch is read once per process, so one stub answers every test.
beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname);
      const text = await request.text();
      seen.push({
        method: request.method,
        path: `${path}${url.search}`,
        body: text === "" ? undefined : JSON.parse(text),
      });
      const { status, body } = answer(path);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const stub = (answering: Answer) => {
  answer = answering;
  seen = [];
};

describe("scopes", () => {
  it("map the resource domain routes to scope shapes, without the client's owner", async () => {
    stub((path) => ({
      status: 200,
      body: path.endsWith("/members")
        ? { items: [member], nextCursor: "usr_alice" }
        : path.includes("/members/")
          ? member
          : {
              resourceDomainId: SCOPE,
              key: "mend:i:project:p",
              createdAt: CREATED_AT,
              created: true,
            },
    }));
    const sealant = new Sealant({ baseUrl: "http://stub.invalid", ownerUserId: "usr_owner" });
    const scope = { id: SCOPE, key: "mend:i:project:p", createdAt: CREATED_AT };

    expect(await sealant.scopes.ensure({ key: "mend:i:project:p" })).toEqual({
      ...scope,
      created: true,
    });
    const project = sealant.scopes.actAs(SCOPE);
    expect(await project.get()).toEqual(scope);
    expect(await project.members.grant("usr_alice", { version: 1 })).toEqual(member);
    await project.members.revoke("usr_alice", { version: 2 });
    expect(await project.members.get("usr_alice")).toEqual(member);
    expect(await project.members.list()).toEqual({ items: [member], nextCursor: "usr_alice" });
    await project.members.list({ limit: 1, cursor: "usr_aaron" });

    expect(seen).toEqual([
      { method: "POST", path: "/v1/resource-domains", body: { key: "mend:i:project:p" } },
      { method: "GET", path: `/v1/resource-domains/${SCOPE}`, body: undefined },
      {
        method: "POST",
        path: `/v1/resource-domains/${SCOPE}/members/usr_alice/grant`,
        body: { version: 1 },
      },
      {
        method: "POST",
        path: `/v1/resource-domains/${SCOPE}/members/usr_alice/revoke`,
        body: { version: 2 },
      },
      { method: "GET", path: `/v1/resource-domains/${SCOPE}/members/usr_alice`, body: undefined },
      { method: "GET", path: `/v1/resource-domains/${SCOPE}/members`, body: undefined },
      {
        method: "GET",
        path: `/v1/resource-domains/${SCOPE}/members?limit=1&cursor=usr_aaron`,
        body: undefined,
      },
    ]);
    await sealant.close();
  });

  it("reject a stale member version as the control plane's conflict", async () => {
    stub(() => ({
      status: 409,
      body: {
        _tag: "ResourceDomainMemberVersionConflictError",
        message: "moved",
        current: { state: "revoked", version: 4 },
      },
    }));
    const sealant = new Sealant({ baseUrl: "http://stub.invalid" });
    const refused = sealant.scopes.actAs(SCOPE).members.grant("usr_alice", { version: 3 });
    await expect(refused).rejects.toBeInstanceOf(SealantApiError);
    await expect(refused).rejects.toMatchObject({
      code: "ResourceDomainMemberVersionConflictError",
    });
    await sealant.close();
  });

  it("reach members only through the client acting as the scope", () => {
    const sealant = new Sealant({ baseUrl: "http://stub.invalid" });
    expect(Object.keys(sealant.scopes).toSorted()).toEqual(["actAs", "ensure", "get"]);
    // @ts-expect-error Members are reached through actAs(id).members.
    expect(sealant.scopes.members).toBeUndefined();
  });

  it("act as a scope with no workspace, run, inference or credential method", () => {
    const sealant = new Sealant({ baseUrl: "http://stub.invalid" });
    const project: ScopeClient = sealant.scopes.actAs(SCOPE);
    const calls = [
      // @ts-expect-error A scope has no workspaces.
      () => project.workspaces.list(),
      // @ts-expect-error A scope has no runs.
      () => project.runs.get("run_1"),
      // @ts-expect-error A scope never runs inference.
      () => project.inference.respond({ prompt: "hello" }),
      // @ts-expect-error A scope holds no connected account.
      () => project.connectedAccounts.list(),
      // @ts-expect-error A scope mints no access token.
      () => project.accessTokens.create({ scopes: ["session:read"] }),
      // @ts-expect-error A scope has no SSH keys.
      () => project.sshKeys.list(),
      // @ts-expect-error A scope provisions no users.
      () => project.users.get("usr_alice"),
    ];
    for (const call of calls) expect(call).toThrow(TypeError);
    // @ts-expect-error A scope's client is not a Sealant client.
    const asSealant: Sealant = project;
    expect(asSealant).toBe(project);
  });
});
