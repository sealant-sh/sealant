import { describe, expect, it } from "vitest";

import {
  connectAccountRequestSchema,
  createConnectedAccountRequestSchema,
} from "./connected-accounts.js";

const request = { ownerUserId: "user_1", provider: "claude", secret: "sk-ant-oat01-x" } as const;

describe("createConnectedAccountRequestSchema", () => {
  it("accepts a name or an accountId alone", () => {
    expect(
      createConnectedAccountRequestSchema.safeParse({ ...request, name: "work" }).success,
    ).toBe(true);
    expect(
      createConnectedAccountRequestSchema.safeParse({ ...request, accountId: "cacc_1" }).success,
    ).toBe(true);
  });

  it("refuses a name and an accountId together", () => {
    const both = { ...request, name: "work", accountId: "cacc_1" };
    expect(createConnectedAccountRequestSchema.safeParse(both).success).toBe(false);
    const { ownerUserId: _ownerUserId, ...withoutOwner } = both;
    expect(connectAccountRequestSchema.safeParse(withoutOwner).success).toBe(false);
  });
});
