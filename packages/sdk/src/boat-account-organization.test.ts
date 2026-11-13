/**
 * `boatAccounts.setOrganization`: it sends the wallet to bill to
 * `PUT /v1/boat-accounts/:id/organization` without a key; it reads a report's wallets and billing
 * and what the control plane cannot reach; and a refusal's reason reaches `SealantApiError`.
 * Against a stubbed `fetch`, in a file of its own: the SDK's HTTP client keeps the first `fetch` it
 * sees.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sealant } from "./client.js";
import { SealantApiError } from "./errors.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const account = {
  boatAccountId: "00000000-0000-4000-8000-0000000000b2",
  label: "Organization B",
  state: "active",
  createdAt: "2026-11-12T00:00:00.000Z",
  keyRotatedAt: null,
};
const report = {
  observedAt: "2026-11-13T12:00:00.000Z",
  organization: "team_acme",
  identity: { observed: true, accountStatus: "active" },
  keyKind: { observed: true, kind: "personal" },
  wallet: { observed: true, kind: "organization", organizationId: "team_acme" },
  wallets: {
    observed: true,
    choices: [
      { id: "personal", kind: "personal", name: "owner", role: "owner", active: false },
      { id: "team_acme", kind: "organization", name: "acme", role: "admin", active: true },
    ],
  },
  billing: { mode: "pinned", organization: "team_acme" },
  requiredPermissions: ["sandbox.create"],
  permissions: { observed: false, reason: "not-listed" },
  expiry: { observed: false, reason: "not-listed" },
  start: { observed: true, canStart: true, runningVms: 0, allowedVms: 2 },
  snapshots: { observed: true, used: 1, included: 10 },
};

describe("a Boat account's organization", () => {
  it("is changed without a key, reads what the control plane cannot reach, and reads a refusal", async () => {
    const seen: Array<{ readonly path: string; readonly method: string; readonly body: unknown }> =
      [];
    let refuse = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const text = await request.text();
        const body: unknown = text === "" ? undefined : JSON.parse(text);
        seen.push({ path: new URL(request.url).pathname, method: request.method, body });
        if (refuse)
          return new Response(
            JSON.stringify({
              _tag: "BoatAccountConflictError",
              code: "boat-account-in-use",
              liveRuns: 1,
              unsettledRuns: 0,
              buildsInFlight: 0,
              message: `Boat account ${account.boatAccountId} still has 1 run whose VM Boat may still hold in the wallet it names now; nothing was changed. Stop its workspaces and try again.`,
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        const named =
          typeof body === "object" && body !== null && "organization" in body
            ? body.organization
            : null;
        return new Response(
          JSON.stringify({
            ...account,
            organization: named === "acme" ? "team_acme" : named,
            report,
            unreachable: { savedImages: ["sealant-lost"] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const sealant = new Sealant({ baseUrl: "http://stub.invalid", ownerUserId: "usr_owner" });
    const pinned = await sealant.boatAccounts.setOrganization(account.boatAccountId, "acme");
    expect(pinned).toMatchObject({
      organization: "team_acme",
      unreachable: { savedImages: ["sealant-lost"] },
      report: { wallets: { observed: true }, billing: { mode: "pinned" } },
    });
    const personal = await sealant.boatAccounts.setOrganization(account.boatAccountId, "personal");
    expect(personal.organization).toBe("personal");
    refuse = true;
    const error: unknown = await sealant.boatAccounts
      .setOrganization(account.boatAccountId, "personal")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SealantApiError);
    expect(error).toMatchObject({
      reason: "boat-account-in-use",
      message: expect.stringContaining("1 run whose VM Boat may still hold"),
    });
    expect(seen.map((each) => [each.method, each.path, each.body])).toEqual([
      ["PUT", `/v1/boat-accounts/${account.boatAccountId}/organization`, { organization: "acme" }],
      [
        "PUT",
        `/v1/boat-accounts/${account.boatAccountId}/organization`,
        { organization: "personal" },
      ],
      [
        "PUT",
        `/v1/boat-accounts/${account.boatAccountId}/organization`,
        { organization: "personal" },
      ],
    ]);
    await sealant.close();
  });
});
