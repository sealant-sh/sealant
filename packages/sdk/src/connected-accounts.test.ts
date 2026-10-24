import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Sealant } from "./client.js";
import { SealantApiError } from "./errors.js";

const summary = (overrides: Record<string, unknown> = {}) => ({
  connectedAccountId: "cacc_work",
  ownerUserId: "usr_owner",
  provider: "claude",
  name: "work",
  kind: "oauth-token",
  status: "active",
  metadata: {},
  connectedAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
  lastUsedAt: null,
  lastSyncedAt: null,
  credential: {
    accessExpiresAt: null,
    refreshExpiresAt: null,
    lastRefreshAt: null,
    lastRefreshOutcome: null,
  },
  ...overrides,
});

let answer: { readonly status: number; readonly body: unknown } = { status: 500, body: {} };
let seen: Array<{ readonly method: string; readonly url: string; readonly body: unknown }> = [];

const answering = (status: number, body: unknown) => {
  answer = { status, body };
  seen = [];
};

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const text = await request.text();
      seen.push({
        method: request.method,
        url: request.url,
        body: text.length === 0 ? undefined : JSON.parse(text),
      });
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const client = () => new Sealant({ baseUrl: "http://stub.invalid", ownerUserId: "usr_owner" });

describe("connectedAccounts", () => {
  it("connect sends the account to replace and whether to make it the default", async () => {
    answering(201, summary({ isDefault: true, credentialRevision: 2 }));
    const sealant = client();
    const account = await sealant.connectedAccounts.connect({
      provider: "claude",
      secret: "sk-ant-oat01-fake",
      accountId: "cacc_work",
      makeDefault: true,
    });
    expect(seen[0]?.body).toEqual({
      ownerUserId: "usr_owner",
      provider: "claude",
      secret: "sk-ant-oat01-fake",
      accountId: "cacc_work",
      makeDefault: true,
    });
    expect(account).toMatchObject({ isDefault: true, credentialRevision: 2 });
    await sealant.close();
  });

  it("setDefault puts the owner's default for the provider", async () => {
    answering(200, summary({ isDefault: true, credentialRevision: 1 }));
    const sealant = client();
    const account = await sealant.connectedAccounts.setDefault({
      provider: "claude",
      accountId: "cacc_work",
    });
    expect(seen[0]).toEqual({
      method: "PUT",
      url: "http://stub.invalid/v1/connected-accounts/defaults/claude",
      body: { ownerUserId: "usr_owner", connectedAccountId: "cacc_work" },
    });
    expect(account.isDefault).toBe(true);
    await sealant.close();
  });

  it("markInvalid sends the revision and answers whether the credential had moved on", async () => {
    answering(200, summary({ outcome: "superseded", credentialRevision: 3 }));
    const sealant = client();
    const result = await sealant.connectedAccounts.markInvalid("cacc_work", { revision: 2 });
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "http://stub.invalid/v1/connected-accounts/cacc_work/mark-invalid",
      body: { ownerUserId: "usr_owner", revision: 2 },
    });
    expect(result.outcome).toBe("superseded");
    expect(result.account.credentialRevision).toBe(3);
    await sealant.close();
  });

  it("reads an older control plane's default from the account's name", async () => {
    answering(200, {
      items: [summary(), summary({ connectedAccountId: "cacc_d", name: "default" })],
    });
    const sealant = client();
    const accounts = await sealant.connectedAccounts.list();
    expect(accounts.map((account) => [account.connectedAccountId, account.isDefault])).toEqual([
      ["cacc_work", false],
      ["cacc_d", true],
    ]);
    expect(accounts[0]?.credentialRevision).toBeUndefined();
    await sealant.close();
  });

  it("throws the candidates of a connect that names no account while several exist", async () => {
    answering(409, {
      _tag: "ConnectedAccountConflictError",
      message: "Several claude accounts are connected.",
      code: "connected-account-ambiguous",
      candidateAccountIds: ["cacc_default", "cacc_work"],
    });
    const sealant = client();
    const failure = await sealant.connectedAccounts
      .connect({ provider: "claude", secret: "sk-ant-oat01-fake" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SealantApiError);
    expect(failure).toMatchObject({
      reason: "connected-account-ambiguous",
      candidateAccountIds: ["cacc_default", "cacc_work"],
    });
    await sealant.close();
  });
});
