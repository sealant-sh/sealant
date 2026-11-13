/**
 * `boatAccounts` and Boat key reports (SLNT-781): the organization a create names, a re-check of
 * the install's own key, and a refusal's missing permissions and report on `SealantApiError`.
 * Driven against a stubbed `fetch`, in a file of its own: the SDK's HTTP client keeps the first
 * `fetch` it sees for the process.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sealant } from "./client.js";
import { SealantApiError } from "./errors.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const account = {
  boatAccountId: "00000000-0000-4000-8000-0000000000a1",
  label: "Organization A",
  state: "active",
  createdAt: "2026-11-12T00:00:00.000Z",
  keyRotatedAt: null,
};

const report = {
  observedAt: "2026-11-13T12:00:00.000Z",
  organization: "team_acme",
  identity: { observed: true, login: "owner", accountStatus: "active" },
  keyKind: { observed: true, kind: "personal" },
  wallet: { observed: true, kind: "organization", organizationId: "team_acme" },
  requiredPermissions: ["sandbox.create"],
  permissions: { observed: false, reason: "not-listed" },
  expiry: { observed: true, expiresAt: null, expired: false, expiringSoon: false },
  start: {
    observed: true,
    canStart: false,
    blockedReason: "billing_required",
    runningVms: 0,
    allowedVms: 2,
  },
  snapshots: { observed: true, used: 7, included: 10 },
};

describe("Boat key reports", () => {
  it("names the organization, checks a key again, and reads a refusal's missing permissions", async () => {
    const seen: Array<{ readonly path: string; readonly method: string; readonly body: unknown }> =
      [];
    let refuse = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const text = await request.text();
        seen.push({
          path: new URL(request.url).pathname,
          method: request.method,
          body: text === "" ? undefined : JSON.parse(text),
        });
        if (refuse)
          return new Response(
            JSON.stringify({
              _tag: "BoatAccountKeyRefusedError",
              code: "boat-key-missing-permissions",
              message:
                "The key lacks Boat permissions Core needs: sandbox.delete; nothing was stored.",
              missingPermissions: ["sandbox.delete"],
              report,
            }),
            { status: 422, headers: { "content-type": "application/json" } },
          );
        const installKey = new URL(request.url).pathname.endsWith("/install-key");
        return new Response(
          JSON.stringify(
            installKey
              ? { label: "This install's Boat key", report }
              : { ...account, organization: "team_acme", report },
          ),
          {
            status: request.method === "POST" && text !== "" ? 201 : 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );
    const sealant = new Sealant({ baseUrl: "http://stub.invalid", ownerUserId: "usr_owner" });
    const created = await sealant.boatAccounts.create({
      label: "Organization A",
      apiKey: "fixture-boat-key-not-real",
      organization: "team_acme",
    });
    expect(created).toMatchObject({ organization: "team_acme", report });
    const checked = await sealant.boatAccounts.checkInstallKey();
    expect(checked).toEqual({ label: "This install's Boat key", report });
    expect(await sealant.boatAccounts.installKey()).toEqual(checked);
    refuse = true;
    const error: unknown = await sealant.boatAccounts
      .create({ label: "B", apiKey: "fixture-boat-key-other" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SealantApiError);
    expect(error).toMatchObject({
      reason: "boat-key-missing-permissions",
      missingPermissions: ["sandbox.delete"],
      boatKeyReport: report,
    });
    expect(JSON.stringify(error)).not.toContain("fixture-boat-key-other");
    expect(seen.slice(0, 3)).toEqual([
      {
        path: "/v1/boat-accounts",
        method: "POST",
        body: {
          label: "Organization A",
          apiKey: "fixture-boat-key-not-real",
          organization: "team_acme",
        },
      },
      { path: "/v1/boat-accounts/install-key", method: "POST", body: undefined },
      { path: "/v1/boat-accounts/install-key", method: "GET", body: undefined },
    ]);
    await sealant.close();
  });
});
