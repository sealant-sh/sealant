import { describe, expect, it } from "vitest";

import {
  connectAccountRequestSchema,
  createConnectedAccountRequestSchema,
  listConnectedAccountsResponseSchema,
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

describe("the login class", () => {
  it("is carried on a connect, a summary and the list, and checked", () => {
    expect(
      createConnectedAccountRequestSchema.safeParse({ ...request, login: "api-key" }).success,
    ).toBe(true);
    expect(
      createConnectedAccountRequestSchema.safeParse({ ...request, login: "key" }).success,
    ).toBe(false);
    const summary = {
      connectedAccountId: "cacc_1",
      ownerUserId: "user_1",
      provider: "codex",
      name: "api-key",
      kind: "api-key",
      status: "active",
      metadata: {},
      connectedAt: "2026-10-25T00:00:00.000Z",
      updatedAt: "2026-10-25T00:00:00.000Z",
      lastUsedAt: null,
      lastSyncedAt: null,
      login: { kind: "api-key", suffix: "wxyz" },
    };
    expect(
      listConnectedAccountsResponseSchema.parse({ items: [summary], hasApiKeyHistory: true }),
    ).toEqual({ items: [summary], hasApiKeyHistory: true });
  });
});
