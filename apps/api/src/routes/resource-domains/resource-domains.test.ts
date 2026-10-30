/**
 * The resource domain routes as the API serves them: the real contract and handlers, with the
 * principal the transport gate would have admitted and a repository that records every call.
 */
import {
  ResourceDomainRepo,
  type ResourceDomainMemberLookup,
  type ResourceDomainMemberOutcome,
  type ResourceDomainRecord,
} from "@sealant/db";
import { Effect, Layer } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { RequestPrincipal } from "../../services/service-principals.js";
import { serveControlPlane } from "../control-plane.fixture.js";
import { ResourceDomainsHandlersLive } from "./resource-domains.http-api.js";

const KEY = "mend:install-1:project:prj_1";

const calls: string[] = [];
const domains = new Map<string, ResourceDomainRecord>();
const standing = {
  userId: "usr_alice",
  state: "revoked" as const,
  version: 9,
  updatedAt: new Date(0),
};
/** What the next decision answers; `written` writes what it was sent. */
let decided: ResourceDomainMemberOutcome | "written" = { kind: "stale", current: standing };
let looked: ResourceDomainMemberLookup = { kind: "no-decision" };

const repo = Layer.succeed(ResourceDomainRepo, {
  ensure: (key) =>
    Effect.sync(() => {
      calls.push(`ensure ${key}`);
      const existing = domains.get(key);
      if (existing !== undefined) return { kind: "ensured", domain: existing, created: false };
      const domain = {
        id: `rdm:00000000-0000-4000-8000-00000000000${domains.size}`,
        key,
        createdAt: new Date(0),
      };
      domains.set(key, domain);
      return { kind: "ensured", domain, created: true };
    }),
  get: (id) =>
    Effect.sync(() => {
      calls.push(`get ${id}`);
      return [...domains.values()].find((domain) => domain.id === id);
    }),
  decideMember: (decision) =>
    Effect.sync(() => {
      calls.push(`decide ${decision.userId} ${decision.state} at ${decision.version}`);
      return decided === "written"
        ? {
            kind: "decided" as const,
            member: {
              userId: decision.userId,
              state: decision.state,
              version: decision.version,
              updatedAt: new Date(0),
            },
          }
        : decided;
    }),
  getMember: (id, userId) =>
    Effect.sync(() => {
      calls.push(`read ${id} ${userId}`);
      return looked;
    }),
  listMembers: ({ resourceDomainId, after, limit }) =>
    Effect.sync(() => {
      calls.push(`list ${resourceDomainId} after ${after ?? "start"} limit ${limit}`);
      return { members: [standing], next: standing.userId };
    }),
  // Budgets run against Postgres (`resource-domain-budgets.db.test.ts`, `resource-domains.sdk.test.ts`).
  getBudget: () => Effect.die("unused"),
  setBudget: () => Effect.die("unused"),
  // Admission runs against Postgres (`services/resource-domain-admission.db.test.ts`).
  admit: () => Effect.die("unused"),
  record: () => Effect.die("unused"),
});

const serve = (principal: RequestPrincipal) =>
  serveControlPlane({
    handlers: ResourceDomainsHandlersLive,
    provides: repo,
    groups: ["resourceDomains"],
    principal,
  });

const servedWithoutRepository = () =>
  serveControlPlane({
    // @ts-expect-error ResourceDomainRepo is never provided.
    handlers: ResourceDomainsHandlersLive,
    provides: Layer.empty,
    groups: ["resourceDomains"],
  });

const service = serve({ kind: "service" });
const open = serve({ kind: "open" });
const gateway = serve({ kind: "gateway" });
afterAll(() => Promise.all([service.dispose(), open.dispose(), gateway.dispose()]));

const send = async (
  served: typeof service,
  method: string,
  path: string,
  body?: Record<string, unknown>,
) => {
  const response = await served.handler(
    new Request(`http://localhost/v1/resource-domains${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

beforeEach(() => {
  calls.length = 0;
  domains.clear();
  decided = { kind: "stale", current: standing };
  looked = { kind: "no-decision" };
});

/** The answer to a decision the stub wrote as it was sent. */
const written = (state: string, version: number) => ({
  status: 200,
  body: { userId: "usr_alice", state, version, updatedAt: new Date(0).toISOString() },
});

const ensureDomain = async () => {
  const { body } = await send(service, "POST", "/", { key: KEY });
  calls.length = 0;
  return String(body["resourceDomainId"]);
};

describe("resource domains", () => {
  it("cannot be served without their repository: the handlers' layer does not compile", () => {
    expect(servedWithoutRepository).toBeTypeOf("function");
  });

  it("ensures one domain per key and reads it back", async () => {
    const first = await send(service, "POST", "/", { key: KEY });
    expect(first).toMatchObject({ status: 200, body: { key: KEY, created: true } });
    const again = await send(service, "POST", "/", { key: KEY });
    expect(again.body).toEqual({ ...first.body, created: false });
    const read = await send(service, "GET", `/${String(first.body["resourceDomainId"])}`);
    expect(read).toEqual({
      status: 200,
      body: {
        resourceDomainId: first.body["resourceDomainId"],
        key: KEY,
        createdAt: new Date(0).toISOString(),
      },
    });
  });

  it("answers 404 for a domain that does not exist", async () => {
    const read = await send(service, "GET", "/rdm:00000000-0000-4000-8000-0000000000ff");
    expect(read.status).toBe(404);
  });

  it("refuses a key without an application prefix before anything is written", async () => {
    const refused = await send(service, "POST", "/", { key: "project-1" });
    expect(refused.status).toBe(400);
    expect(String(refused.body["message"])).not.toContain("project-1");
    expect(calls).toEqual([]);
  });

  it.each([
    ["an owner", { ownerUserId: "usr_alice" }],
    ["a person to act for", { onBehalfOfUserId: "usr_alice" }],
    ["credentials", { credentials: { claude: "default" } }],
  ])("refuses %s smuggled into ensure, instead of dropping it", async (_what, extra) => {
    const refused = await send(service, "POST", "/", { key: KEY, ...extra });
    expect(refused).toEqual({
      status: 400,
      body: { _tag: "RequestRefusedError", message: "[…] is not allowed" },
    });
    expect(calls).toEqual([]);
  });

  it.each([
    ["into a budget change", "PUT", `/${"rdm:00000000-0000-4000-8000-000000000000"}/budget`, {}],
    ["into ensure's budget", "POST", "/", { key: KEY }],
  ] as const)(
    "refuses an owner smuggled %s, instead of dropping it",
    async (_what, method, path, base) => {
      const limits = { cpuMillicores: 1, memoryBytes: 1, storageBytes: 1 };
      const body =
        method === "PUT"
          ? { ...limits, revision: 1, ownerUserId: "usr_alice" }
          : { ...base, budget: { ...limits, ownerUserId: "usr_alice" } };
      expect(await send(service, method, path, body)).toEqual({
        status: 400,
        body: {
          _tag: "RequestRefusedError",
          message: expect.stringMatching(/\[…\] is not allowed$/),
        },
      });
      expect(calls).toEqual([]);
    },
  );

  it("serves a deployment run without authentication, as every credential route does", async () => {
    const ensured = await send(open, "POST", "/", { key: KEY });
    expect(ensured).toMatchObject({ status: 200, body: { key: KEY, created: true } });
  });

  it("answers 403 to the gateway's secret, before the repository is asked", async () => {
    const ensured = await send(gateway, "POST", "/", { key: KEY });
    const read = await send(gateway, "GET", "/rdm:00000000-0000-4000-8000-000000000000");
    expect([ensured.status, read.status]).toEqual([403, 403]);
    expect(ensured.body).toEqual({
      _tag: "ResourceDomainForbiddenError",
      message: "A service key is required to manage resource domains.",
    });
    expect(calls).toEqual([]);
  });

  it("grants and revokes a member at the application's version", async () => {
    const id = await ensureDomain();
    decided = "written";
    expect(await send(service, "POST", `/${id}/members/usr_alice/grant`, { version: 1 })).toEqual(
      written("member", 1),
    );
    expect(await send(service, "POST", `/${id}/members/usr_alice/revoke`, { version: 2 })).toEqual(
      written("revoked", 2),
    );
  });

  it("refuses a stale decision with the decision that stands, quoting nothing it was sent", async () => {
    const id = await ensureDomain();
    const refused = await send(service, "POST", `/${id}/members/usr_alice/grant`, {
      version: 7,
    });
    expect(refused).toEqual({
      status: 409,
      body: {
        _tag: "ResourceDomainMemberVersionConflictError",
        message:
          "A decision at least as new about this person stands, so this one changed nothing.",
        current: { state: "revoked", version: 9 },
      },
    });
  });

  it("answers 404 for a person that does not exist, and checks the domain before deciding", async () => {
    const id = await ensureDomain();
    decided = { kind: "no-such-person" };
    const person = await send(service, "POST", `/${id}/members/usr_nobody/grant`, {
      version: 1,
    });
    expect(person).toEqual({
      status: 404,
      body: { _tag: "ResourceDomainPersonNotFoundError", message: "No person has this id." },
    });
    calls.length = 0;
    const missing = "rdm:00000000-0000-4000-8000-0000000000ff";
    const domain = await send(service, "POST", `/${missing}/members/usr_alice/grant`, {
      version: 1,
    });
    expect(domain).toEqual({
      status: 404,
      body: { _tag: "ResourceDomainNotFoundError", message: "Resource domain not found." },
    });
    expect(calls).toEqual([`get ${missing}`]);
  });

  it.each([
    ["an owner", { version: 1, ownerUserId: "usr_alice" }],
    ["a state", { version: 1, state: "member" }],
    ["version 0", { version: 0 }],
    ["a fractional version", { version: 1.5 }],
    ["the version it replaces instead", { expectedVersion: 1 }],
    ["no version", {}],
  ])("refuses a member decision with %s before anything is read", async (_what, body) => {
    const id = await ensureDomain();
    const refused = await send(service, "POST", `/${id}/members/usr_alice/grant`, body);
    expect(refused.status).toBe(400);
    expect(refused.body["_tag"]).toBe("RequestRefusedError");
    expect(calls).toEqual([]);
  });

  it("answers 403 to the gateway's secret on the member routes, before the repository is asked", async () => {
    const id = "rdm:00000000-0000-4000-8000-000000000000";
    const statuses = await Promise.all([
      send(gateway, "POST", `/${id}/members/usr_alice/grant`, { version: 1 }),
      send(gateway, "POST", `/${id}/members/usr_alice/revoke`, { version: 1 }),
      send(gateway, "GET", `/${id}/members`),
    ]);
    expect(statuses.map(({ status }) => status)).toEqual([403, 403, 403]);
    expect(calls).toEqual([]);
  });

  it("reads one member, and tells no decision, no such person and no such domain apart", async () => {
    const id = await ensureDomain();
    const read = () => send(service, "GET", `/${id}/members/usr_alice`);
    looked = { kind: "found", member: standing };
    expect(await read()).toEqual({
      status: 200,
      body: {
        userId: "usr_alice",
        state: "revoked",
        version: 9,
        updatedAt: new Date(0).toISOString(),
      },
    });
    looked = { kind: "no-decision" };
    expect((await read()).body["_tag"]).toBe("ResourceDomainMemberNotFoundError");
    looked = { kind: "no-such-person" };
    expect((await read()).body["_tag"]).toBe("ResourceDomainPersonNotFoundError");
    const elsewhere = await send(
      service,
      "GET",
      "/rdm:00000000-0000-4000-8000-0000000000ff/members/usr_alice",
    );
    expect(elsewhere.body["_tag"]).toBe("ResourceDomainNotFoundError");
  });

  it("pages the members with a limit and the previous page's cursor", async () => {
    const id = await ensureDomain();
    const page = await send(service, "GET", `/${id}/members?limit=1&cursor=usr_aaron`);
    expect(page).toEqual({
      status: 200,
      body: {
        items: [
          {
            userId: "usr_alice",
            state: "revoked",
            version: 9,
            updatedAt: new Date(0).toISOString(),
          },
        ],
        nextCursor: "usr_alice",
      },
    });
    expect(calls).toEqual([`get ${id}`, `list ${id} after usr_aaron limit 1`]);
  });

  it.each(["0", "501", "1.5", "many"])(
    "refuses a page limit of %s before anything is read",
    async (limit) => {
      const id = await ensureDomain();
      const refused = await send(service, "GET", `/${id}/members?limit=${limit}`);
      expect(refused.status).toBe(400);
      expect(calls).toEqual([]);
    },
  );
});
