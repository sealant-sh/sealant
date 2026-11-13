/**
 * A Boat key checked against the fake Boat: what each kind of key and account reports, which keys
 * are refused, and that an account pinned to an organization names it on every request.
 */
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { BOAT_REQUIRED_PERMISSIONS, HttpBoatApi } from "../src/runtime/boat/api.js";
import { BoatSecret } from "../src/runtime/boat/config.js";
import { checkBoatKey, observeBoatKey } from "../src/runtime/boat/key-check.js";
import type { DockerResult } from "./docker.js";
import { FakeBoat, type FakeBoatAccount } from "./fake-boat.js";
import { BOAT_REFUSALS } from "./refusals.js";

const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const credential = "boat_live_fixture_key_0123456789abcd";
const now = () => new Date("2026-11-13T12:00:00.000Z");
const nextDay = () => new Date("2026-11-14T12:00:00.000Z");

let boat: FakeBoat | undefined;
afterEach(async () => {
  await boat?.stop();
  boat = undefined;
});

const start = async (account: FakeBoatAccount = {}, organization?: string) => {
  const fake = new FakeBoat({
    runId: "keycheck",
    credential,
    network: "unit",
    baseImage: "unit-base",
    docker: async (args) => (args[0] === "inspect" ? ok("192.0.10.5\n") : ok("running\n")),
  });
  boat = fake;
  fake.account = account;
  await fake.start();
  const secret = BoatSecret.parse(credential);
  if (!secret.ok) throw secret.error;
  const api = HttpBoatApi.create({
    credential: secret.value,
    baseUrl: fake.baseUrl,
    ...(organization === undefined ? {} : { organization }),
  });
  if (!api.ok) throw api.error;
  return { fake, api: api.value };
};

describe("a Boat key's check", () => {
  it("derives the permissions sealant needs from its own calls, delete included", () => {
    expect(BOAT_REQUIRED_PERMISSIONS).toEqual([
      // `/me`, limits, organization discovery and the key list: which wallet a key bills.
      "account.read",
      "exec",
      "file.write",
      "host",
      "sandbox.create",
      "sandbox.delete",
      "sandbox.read",
      "sandbox.resume",
      "sandbox.stop",
      "snapshot.read",
      "snapshot.write",
    ]);
  });

  it("reports a personal * key: who, which wallet, permissions, expiry, start and snapshots", async () => {
    const { api } = await start({ allowance: { used: 7, included: 10 } });
    const check = await checkBoatKey(api, { organization: null, now });
    expect(check).toEqual({
      kind: "checked",
      missingPermissions: [],
      report: {
        observedAt: "2026-11-13T12:00:00.000Z",
        organization: null,
        identity: {
          observed: true,
          accountId: "usr_fake",
          login: "fake-owner",
          displayName: "Fake Owner",
          serviceAccount: false,
          accountStatus: "active",
        },
        keyKind: { observed: true, kind: "personal" },
        wallet: { observed: true, kind: "personal" },
        wallets: {
          observed: true,
          choices: [
            { id: "personal", kind: "personal", name: "personal", role: "owner", active: true },
            { id: "team_acme", kind: "organization", name: "acme", role: "admin", active: false },
          ],
        },
        billing: { mode: "active-wallet" },
        requiredPermissions: [...BOAT_REQUIRED_PERMISSIONS],
        permissions: { observed: true, held: ["*"], missing: [], limitedToSandboxes: false },
        expiry: { observed: true, expiresAt: null, expired: false, expiringSoon: false },
        start: {
          observed: true,
          canStart: true,
          billingStatus: "active",
          runningVms: 0,
          allowedVms: 2,
        },
        snapshots: { observed: true, used: 7, included: 10 },
      },
    });
    expect(JSON.stringify(check)).not.toContain(credential);
  });

  it("names a permission a personal key lacks: sandbox.delete-own is not sandbox.delete", async () => {
    const { api } = await start({
      key: {
        actions: [
          "sandbox.create",
          "sandbox.read",
          "sandbox.stop",
          "sandbox.resume",
          "sandbox.delete-own",
          "exec",
          "file.write",
          "host",
          "snapshot.read",
          "snapshot.write",
          "account.read",
        ],
        expiresAt: "2027-02-11T00:00:00.000Z",
        expiringSoon: false,
      },
    });
    const check = await checkBoatKey(api, { organization: null, now });
    expect(check).toMatchObject({
      kind: "checked",
      missingPermissions: ["sandbox.delete"],
      report: {
        permissions: { observed: true, missing: ["sandbox.delete"] },
        expiry: { observed: true, expiresAt: "2027-02-11T00:00:00.000Z", expired: false },
      },
    });
  });

  it("names account.read for a key that holds every other permission sealant needs: without it, sealant cannot see which wallet the key bills", async () => {
    const { api } = await start({
      key: {
        actions: [
          "sandbox.create",
          "sandbox.read",
          "sandbox.stop",
          "sandbox.resume",
          "sandbox.delete",
          "exec",
          "file.write",
          "host",
          "snapshot.read",
          "snapshot.write",
        ],
      },
    });
    const check = await checkBoatKey(api, { organization: null, now });
    expect(check).toMatchObject({
      kind: "checked",
      missingPermissions: ["account.read"],
      report: { permissions: { observed: true, missing: ["account.read"] } },
    });
  });

  it("expands a preset the key holds and reports what it still lacks", async () => {
    const { api } = await start({ key: { actions: ["read-only"] } });
    const check = await checkBoatKey(api, { organization: null, now });
    expect(check.kind === "checked" ? check.missingPermissions : undefined).toEqual([
      "exec",
      "file.write",
      "host",
      "sandbox.create",
      "sandbox.delete",
      "sandbox.resume",
      "sandbox.stop",
      "snapshot.write",
    ]);
  });

  it("keeps an organization key Boat refuses its key list, its permissions not observed", async () => {
    const { api } = await start({ key: "organization" });
    const check = await checkBoatKey(api, { organization: null, now });
    expect(check).toMatchObject({
      kind: "checked",
      missingPermissions: [],
      report: {
        keyKind: { observed: true, kind: "organization" },
        permissions: {
          observed: false,
          reason: "refused",
          boat: { kind: "organization-mismatch", code: "api_key_org_forbidden" },
        },
        expiry: { observed: false, reason: "refused" },
        start: { observed: true, canStart: true },
      },
    });
  });

  it("does not guess a key limited to some VMs: an empty key list is not observed", async () => {
    const { api } = await start({ key: "limited" });
    const check = await checkBoatKey(api, { organization: null, now });
    expect(check).toMatchObject({
      kind: "checked",
      missingPermissions: [],
      report: {
        keyKind: { observed: false, reason: "not-listed" },
        permissions: { observed: false, reason: "not-listed" },
      },
    });
  });

  it("refuses an expired key with Boat's reason", async () => {
    const { fake, api } = await start();
    fake.faults = { refuse: () => BOAT_REFUSALS["key-expired"] };
    expect(await checkBoatKey(api, { organization: null, now })).toMatchObject({
      kind: "refused",
      failure: { kind: "key-expired", code: "api_key_expired", requestId: expect.any(String) },
    });
  });

  it("refuses a key Boat refuses outright, and is unverified when Boat does not answer", async () => {
    const { fake, api } = await start();
    fake.faults = { refuse: () => BOAT_REFUSALS["key-refused"] };
    expect(await checkBoatKey(api, { organization: null, now })).toMatchObject({
      kind: "refused",
      failure: { kind: "key-refused" },
    });
    fake.faults = { refuse: () => "no-answer" };
    expect(await checkBoatKey(api, { organization: null, now })).toMatchObject({
      kind: "unverified",
      failure: { kind: "no-answer" },
    });
  });

  it("does not read a rate limit, no machine or an unclassified refusal as a refused key", async () => {
    const { fake, api } = await start();
    for (const refusal of [
      BOAT_REFUSALS["rate-limited"],
      BOAT_REFUSALS["no-machine"],
      BOAT_REFUSALS.refused,
    ]) {
      fake.faults = { refuse: (call) => (call.path === "/sandboxes" ? refusal : undefined) };
      expect(await checkBoatKey(api, { organization: null, now })).toMatchObject({
        kind: "unverified",
        failure: { code: refusal.code },
      });
    }
  });

  it("goes on when Boat refuses for the account, not the key, and reports it", async () => {
    const { fake, api } = await start();
    fake.faults = {
      refuse: (call) =>
        call.path === "/sandboxes" ? BOAT_REFUSALS["billing-required"] : undefined,
    };
    expect(await checkBoatKey(api, { organization: null, now })).toMatchObject({
      kind: "checked",
      missingPermissions: [],
      report: { identity: { observed: true }, start: { observed: true } },
    });
  });

  it("names the permission Boat refused the inventory read for", async () => {
    const { fake, api } = await start();
    fake.faults = {
      refuse: (call) =>
        call.path === "/sandboxes"
          ? { ...BOAT_REFUSALS["permission-missing"], details: { action: "sandbox.read" } }
          : undefined,
    };
    expect(await checkBoatKey(api, { organization: null, now })).toMatchObject({
      kind: "checked",
      missingPermissions: ["sandbox.read"],
    });
  });

  it("reports a suspended account as observed, without refusing the key", async () => {
    const { api } = await start({ suspended: true });
    expect(await checkBoatKey(api, { organization: null, now })).toMatchObject({
      kind: "checked",
      report: {
        identity: { observed: true, accountStatus: "suspended" },
        start: { observed: false, reason: "refused", boat: { kind: "account-suspended" } },
      },
    });
  });

  it("reports a wallet that cannot start, and why", async () => {
    const { api } = await start({
      limits: () => ({
        canStart: false,
        startBlockedReason: "billing_required",
        billingStatus: "past_due",
        activeSandboxes: 2,
        maxActiveSandboxes: 2,
      }),
    });
    expect(await checkBoatKey(api, { organization: null, now })).toMatchObject({
      kind: "checked",
      report: {
        start: {
          observed: true,
          canStart: false,
          blockedReason: "billing_required",
          billingStatus: "past_due",
          runningVms: 2,
          allowedVms: 2,
        },
      },
    });
  });

  it("names a pinned organization on the limits read and on create, and reports its wallet", async () => {
    const { fake, api } = await start({}, "team_acme");
    const check = await checkBoatKey(api, { organization: "team_acme", now });
    expect(check).toMatchObject({
      kind: "checked",
      report: {
        organization: "team_acme",
        wallet: {
          observed: true,
          kind: "organization",
          organizationId: "team_acme",
          organizationName: "acme",
          role: "admin",
        },
      },
    });
    const created = await api.create({
      idempotencyKey: randomUUID(),
      marker: randomUUID(),
      purpose: "native-build",
      lifetime: { kind: "bounded" },
      requestVersion: 2,
    });
    expect(created.ok).toBe(true);
    expect(fake.organizationHeaders).toEqual(
      expect.arrayContaining([
        { method: "GET", path: "/limits", organization: "team_acme" },
        { method: "POST", path: "/sandboxes", organization: "team_acme" },
      ]),
    );
    // Every request named it, not only these two.
    expect(fake.events.filter((event) => event.kind === "api")).toHaveLength(
      fake.organizationHeaders.length,
    );
  });

  it("refuses an organization name that could carry a header", () => {
    const secret = BoatSecret.parse(credential);
    if (!secret.ok) throw secret.error;
    expect(
      HttpBoatApi.create({ credential: secret.value, organization: "acme\r\nX-Other: 1" }).ok,
    ).toBe(false);
  });

  describe("which wallet it bills", () => {
    const twoOrganizations: FakeBoatAccount["orgs"] = [
      { id: "usr_fake", name: "fake-owner", type: "personal", role: "owner", active: false },
      { id: "team_acme", name: "acme", type: "org", role: "admin", active: true },
      { id: "team_zeta", name: "zeta", type: "org", role: "member", active: false },
    ];

    it("lists the wallets of a personal key in two organizations, the active one marked, and says it is not pinned", async () => {
      const { api } = await start({ orgs: twoOrganizations, activeWallet: "team_acme" });
      const check = await checkBoatKey(api, { organization: null, now });
      expect(check).toMatchObject({
        kind: "checked",
        report: {
          organization: null,
          keyKind: { observed: true, kind: "personal" },
          wallet: { observed: true, kind: "organization", organizationId: "team_acme" },
          wallets: {
            observed: true,
            choices: [
              {
                id: "personal",
                kind: "personal",
                name: "fake-owner",
                role: "owner",
                active: false,
              },
              { id: "team_acme", kind: "organization", name: "acme", role: "admin", active: true },
              {
                id: "team_zeta",
                kind: "organization",
                name: "zeta",
                role: "member",
                active: false,
              },
            ],
          },
          billing: { mode: "active-wallet" },
        },
      });
    });

    it("says an unpinned key's wallet changed after its active wallet is switched, and keeps saying it", async () => {
      const { fake, api } = await start({ orgs: twoOrganizations, activeWallet: "team_acme" });
      const first = await observeBoatKey(api, { organization: null, now });
      if (first.kind !== "report") throw new Error("not reported");
      fake.account = { ...fake.account, activeWallet: "personal" };
      const second = await observeBoatKey(api, {
        organization: null,
        previous: first.report,
        now: nextDay,
      });
      if (second.kind !== "report") throw new Error("not reported");
      expect(second.report.wallet).toEqual({ observed: true, kind: "personal" });
      expect(second.report.billing).toEqual({
        mode: "active-wallet",
        walletChanged: {
          from: {
            kind: "organization",
            organizationId: "team_acme",
            organizationName: "acme",
            role: "admin",
          },
          observedAt: "2026-11-14T12:00:00.000Z",
        },
      });
      // The next report, on the same wallet, still says when it moved and from where.
      const third = await observeBoatKey(api, {
        organization: null,
        previous: second.report,
        now: () => new Date("2026-11-15T12:00:00.000Z"),
      });
      if (third.kind !== "report") throw new Error("not reported");
      expect(third.report.billing).toEqual(second.report.billing);
      // A pinned report is never compared: its wallet is the pin's.
      const pinned = await observeBoatKey(api, {
        organization: "personal",
        previous: first.report,
        now,
      });
      if (pinned.kind !== "report") throw new Error("not reported");
      expect(pinned.report.billing).toEqual({ mode: "pinned", organization: "personal" });
    });

    it("keeps billing the personal wallet when pinned to it, after the active wallet is switched", async () => {
      const { fake, api } = await start({ orgs: twoOrganizations }, "personal");
      fake.account = { ...fake.account, activeWallet: "team_zeta" };
      const check = await checkBoatKey(api, { organization: "personal", now });
      expect(check).toMatchObject({
        kind: "checked",
        report: {
          wallet: { observed: true, kind: "personal" },
          billing: { mode: "pinned", organization: "personal" },
        },
      });
      const created = await api.create({
        idempotencyKey: randomUUID(),
        marker: randomUUID(),
        purpose: "native-build",
        lifetime: { kind: "bounded" },
        requestVersion: 2,
      });
      if (!created.ok) throw new Error("not created");
      expect(fake.heldIn("personal").sandboxes).toHaveLength(1);
      expect(fake.heldIn("team_zeta").sandboxes).toEqual([]);
    });

    it("says an organization's key bills its own organization, with nothing to choose", async () => {
      const { api } = await start({ key: "organization", keyOrganization: "team_acme" });
      const check = await checkBoatKey(api, { organization: null, now });
      expect(check).toMatchObject({
        kind: "checked",
        report: {
          keyKind: { observed: true, kind: "organization" },
          wallet: { observed: true, kind: "organization", organizationId: "team_acme" },
          billing: { mode: "key-organization" },
        },
      });
    });
  });

  it("keeps each wallet's VMs and saved snapshots apart: another wallet's are not found", async () => {
    const { fake, api } = await start({}, "team_acme");
    const created = await api.create({
      idempotencyKey: randomUUID(),
      marker: randomUUID(),
      purpose: "native-build",
      lifetime: { kind: "bounded" },
      requestVersion: 2,
    });
    if (!created.ok) throw new Error("not created");
    const secret = BoatSecret.parse(credential);
    if (!secret.ok) throw secret.error;
    const personal = HttpBoatApi.create({ credential: secret.value, baseUrl: fake.baseUrl });
    if (!personal.ok) throw personal.error;
    const seen = await personal.value.get(created.value.id);
    expect(seen.ok ? "seen" : seen.error.status).toBe(404);
    const own = await api.get(created.value.id);
    expect(own.ok ? "seen" : [own.error.status, own.error.code]).toBe("seen");
    expect(fake.heldIn("team_acme").sandboxes).toEqual([created.value.id]);
  });
});
