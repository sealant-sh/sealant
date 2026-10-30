/**
 * The resource domain routes as the API serves them: the real contract and handlers, with the
 * principal the transport gate would have admitted and a repository that records every call.
 */
import {
  ResourceDomainRepo,
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
let decided: ResourceDomainMemberOutcome = { kind: "stale", current: standing };

const repo = Layer.succeed(ResourceDomainRepo, {
  ensure: (key) =>
    Effect.sync(() => {
      calls.push(`ensure ${key}`);
      const existing = domains.get(key);
      if (existing !== undefined) return { domain: existing, created: false };
      const domain = {
        id: `rdm:00000000-0000-4000-8000-00000000000${domains.size}`,
        key,
        createdAt: new Date(0),
      };
      domains.set(key, domain);
      return { domain, created: true };
    }),
  get: (id) =>
    Effect.sync(() => {
      calls.push(`get ${id}`);
      return [...domains.values()].find((domain) => domain.id === id);
    }),
  decideMember: (decision) =>
    Effect.sync(() => {
      calls.push(`decide ${decision.userId} ${decision.state} at ${decision.version}`);
      return decided;
    }),
  listMembers: (id) =>
    Effect.sync(() => {
      calls.push(`list ${id}`);
      return [];
    }),
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
    const updatedAt = new Date(0);
    decided = {
      kind: "decided",
      member: { userId: "usr_alice", state: "member", version: 1, updatedAt },
    };
    const granted = await send(service, "POST", `/${id}/members/usr_alice/grant`, {
      version: 1,
    });
    expect(granted).toEqual({
      status: 200,
      body: {
        userId: "usr_alice",
        state: "member",
        version: 1,
        updatedAt: updatedAt.toISOString(),
      },
    });
    await send(service, "POST", `/${id}/members/usr_alice/revoke`, { version: 2 });
    const listed = await send(service, "GET", `/${id}/members`);
    expect(listed).toEqual({ status: 200, body: { items: [] } });
    expect(calls).toEqual([
      `get ${id}`,
      "decide usr_alice member at 1",
      `get ${id}`,
      "decide usr_alice revoked at 2",
      `get ${id}`,
      `list ${id}`,
    ]);
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

  it("answers 404 for a person that does not exist, and for a domain before any decision", async () => {
    const id = await ensureDomain();
    decided = { kind: "no-such-person" };
    const person = await send(service, "POST", `/${id}/members/usr_nobody/grant`, {
      version: 1,
    });
    expect(person).toEqual({
      status: 404,
      body: { _tag: "ResourceDomainNotFoundError", message: "No person has this id." },
    });
    calls.length = 0;
    const missing = "rdm:00000000-0000-4000-8000-0000000000ff";
    const domain = await send(service, "POST", `/${missing}/members/usr_alice/grant`, {
      version: 1,
    });
    expect(domain.status).toBe(404);
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
});
