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
let features: Record<string, boolean> = {};

const currentControlPlane = {
  processUser: false,
  connectedAccountDefaults: true,
  connectedAccountLoginClass: true,
};
/** Chooses defaults, and drops a connect's `login` unread. */
const defaultsOnlyControlPlane = { processUser: false, connectedAccountDefaults: true };
const olderControlPlane = { processUser: false };

const answering = (
  status: number,
  body: unknown,
  reported: Record<string, boolean> = currentControlPlane,
) => {
  answer = { status, body };
  features = reported;
  seen = [];
};

const index = () => ({
  name: "Sealant Control Plane API",
  version: "0.0.0",
  docsPath: "/docs",
  openApiPath: "/openapi.json",
  features,
});

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/") {
        return new Response(JSON.stringify(index()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
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

  it("connect sends the login class it expects, and reads each account's class back", async () => {
    answering(201, summary({ kind: "api-key", login: { kind: "api-key", suffix: "wxyz" } }));
    const sealant = client();
    const account = await sealant.connectedAccounts.connect({
      provider: "codex",
      secret: "sk-proj-FAKEcodexkey0000wxyz",
      login: "api-key",
    });
    expect(seen[0]?.body).toEqual({
      ownerUserId: "usr_owner",
      provider: "codex",
      secret: "sk-proj-FAKEcodexkey0000wxyz",
      login: "api-key",
    });
    expect(account.login).toEqual({ kind: "api-key", suffix: "wxyz" });
    await sealant.close();
  });

  it("listWithHistory says whether the owner ever connected a key", async () => {
    answering(200, {
      items: [summary({ login: { kind: "subscription" } })],
      hasApiKeyHistory: true,
    });
    const sealant = client();
    const listed = await sealant.connectedAccounts.listWithHistory();
    expect(listed.hasApiKeyHistory).toBe(true);
    expect(listed.accounts.map((account) => account.login)).toEqual([{ kind: "subscription" }]);

    answering(200, { items: [summary()] });
    const older = await sealant.connectedAccounts.listWithHistory();
    expect(older).not.toHaveProperty("hasApiKeyHistory");
    expect(older.accounts[0]).not.toHaveProperty("login");
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

describe("connectedAccounts against a control plane that chooses defaults but reads no login class", () => {
  it("sends no connect that expects a login class, which it would store unchecked", async () => {
    answering(201, summary(), defaultsOnlyControlPlane);
    const sealant = client();
    await expect(
      sealant.connectedAccounts.connect({
        provider: "codex",
        secret: JSON.stringify({ tokens: { refresh_token: "rt-fake" } }),
        login: "api-key",
      }),
    ).rejects.toMatchObject({ code: "connected-account-login-class-unsupported" });
    expect(seen).toEqual([]);

    await sealant.connectedAccounts.connect({
      provider: "claude",
      secret: "sk-ant-oat01-fake",
      accountId: "cacc_work",
      makeDefault: true,
    });
    expect(seen.map((call) => call.method)).toEqual(["POST"]);
    expect(seen[0]?.body).not.toHaveProperty("login");
    await sealant.close();
  });

  it("lists without a key history it does not report", async () => {
    answering(200, { items: [summary()] }, defaultsOnlyControlPlane);
    const sealant = client();
    const listed = await sealant.connectedAccounts.listWithHistory();
    expect(listed).toEqual({ accounts: [expect.objectContaining({ name: "work" })] });
    await sealant.close();
  });
});

describe("connectedAccounts against a control plane from before chosen defaults", () => {
  const refusal = { code: "connected-account-defaults-unsupported" };

  it("sends no connect that targets an account or a default, which it would drop", async () => {
    answering(201, summary(), olderControlPlane);
    const sealant = client();
    await expect(
      sealant.connectedAccounts.connect({
        provider: "claude",
        secret: "sk-ant-oat01-fake",
        accountId: "cacc_work",
      }),
    ).rejects.toMatchObject(refusal);
    await expect(
      sealant.connectedAccounts.connect({
        provider: "claude",
        secret: "sk-ant-oat01-fake",
        name: "work",
        makeDefault: true,
      }),
    ).rejects.toMatchObject(refusal);
    expect(seen).toEqual([]);

    await sealant.connectedAccounts.connect({
      provider: "claude",
      secret: "sk-ant-oat01-fake",
      name: "work",
    });
    expect(seen.map((call) => call.method)).toEqual(["POST"]);
    await sealant.close();
  });

  it("sends no setDefault and no mark-invalid that names a revision", async () => {
    answering(200, summary(), olderControlPlane);
    const sealant = client();
    await expect(
      sealant.connectedAccounts.setDefault({ provider: "claude", accountId: "cacc_work" }),
    ).rejects.toMatchObject(refusal);
    await expect(
      sealant.connectedAccounts.markInvalid("cacc_work", { revision: 1 }),
    ).rejects.toMatchObject(refusal);
    expect(seen).toEqual([]);

    const marked = await sealant.connectedAccounts.markInvalid("cacc_work");
    expect(marked.outcome).toBe("marked");
    expect(seen.map((call) => call.method)).toEqual(["POST"]);
    await sealant.close();
  });
});
