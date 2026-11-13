/**
 * Which quarantined builds a key check reopens (SLNT-783 review): only those whose own cause the
 * report shows cleared, never on a fact the report did not observe.
 */
import type { BoatKeyReport } from "@sealant/api-contracts";
import { describe, expect, it } from "vitest";

import { boatKeyRefusedReport } from "./key-check.js";
import { boatReopenableReasons } from "./key-refresh.js";

/** A report that observed nothing: what a key Boat refused outright records. */
const nothing = boatKeyRefusedReport(
  { kind: "key-expired", retryable: false, code: "api_key_expired" },
  { organization: null },
);
const report = (overrides: Partial<BoatKeyReport>): BoatKeyReport => ({ ...nothing, ...overrides });
const canStart = {
  observed: true as const,
  canStart: true,
  runningVms: 0,
  allowedVms: 2,
};

describe("boatReopenableReasons", () => {
  it("reopens nothing on a report that observed nothing", () => {
    expect(boatReopenableReasons(nothing)).toEqual([]);
  });

  it("a wallet that can start clears billing, but not a full snapshot allowance or a missing permission", () => {
    const reasons = boatReopenableReasons(
      report({ start: canStart, snapshots: { observed: true, used: 10, included: 10 } }),
    );
    expect(reasons).toContain("native-boat-billing-required");
    expect(reasons).not.toContain("native-boat-snapshot-allowance-full");
    expect(reasons).not.toContain("native-boat-permission-missing");
  });

  it("a free snapshot slot clears the allowance; held permissions clear a missing one", () => {
    expect(
      boatReopenableReasons(report({ snapshots: { observed: true, used: 9, included: 10 } })),
    ).toEqual(["native-boat-snapshot-allowance-full"]);
    const permissions = boatReopenableReasons(
      report({
        permissions: { observed: true, held: ["*"], missing: [], limitedToSandboxes: false },
      }),
    );
    expect(permissions).toEqual([
      "native-boat-sandbox-outside-key",
      "native-boat-permission-missing",
    ]);
    expect(
      boatReopenableReasons(
        report({
          permissions: {
            observed: true,
            held: ["exec"],
            missing: ["snapshot.write"],
            limitedToSandboxes: false,
          },
        }),
      ),
    ).not.toContain("native-boat-permission-missing");
  });

  it("a key Boat accepts again clears the key's own refusals; an active account clears suspension", () => {
    const reasons = boatReopenableReasons(
      report({ identity: { observed: true, accountStatus: "active" } }),
    );
    expect(reasons).toEqual(
      expect.arrayContaining([
        "native-boat-key-refused",
        "native-boat-key-expired",
        "native-boat-organization-mismatch",
        "native-boat-account-suspended",
      ]),
    );
    expect(
      boatReopenableReasons(report({ identity: { observed: true, accountStatus: "suspended" } })),
    ).not.toContain("native-boat-account-suspended");
  });
});
