import { describe, expect, it } from "vitest";

import { accountDetails, formatDate, makePalette, renderTable, visibleWidth } from "./render.js";
import type { ConnectedAccountSummary } from "./schemas.js";

const plain = makePalette(false);
const colored = makePalette(true);

const account = (
  overrides: Partial<ConnectedAccountSummary> & Pick<ConnectedAccountSummary, "provider">,
): ConnectedAccountSummary => ({
  connectedAccountId: "cacc_1",
  ownerUserId: "usr_local",
  name: "default",
  kind: "oauth-token",
  status: "active",
  metadata: {},
  connectedAt: "2026-07-05T12:00:00.000Z",
  updatedAt: "2026-07-05T12:00:00.000Z",
  lastUsedAt: null,
  lastSyncedAt: null,
  ...overrides,
});

describe("makePalette", () => {
  it("is a no-op when disabled", () => {
    expect(plain.red("x")).toBe("x");
  });

  it("wraps with ANSI codes when enabled", () => {
    expect(colored.green("ok")).toBe("\u001B[32mok\u001B[39m");
  });
});

describe("visibleWidth", () => {
  it("ignores ANSI styling", () => {
    expect(visibleWidth(colored.bold(colored.red("abc")))).toBe(3);
  });
});

describe("renderTable", () => {
  it("aligns columns with a two-space gutter", () => {
    const table = renderTable(
      ["A", "BB"],
      [
        ["x", "y"],
        ["longer", "z"],
      ],
      plain,
    );
    expect(table).toBe(["A       BB", "x       y", "longer  z"].join("\n"));
  });

  it("keeps alignment when cells carry ANSI styling", () => {
    const table = renderTable(["A", "B"], [[colored.green("x"), "y"]], colored);
    const lines = table.split("\n");
    expect(visibleWidth(lines[0] ?? "")).toBe(visibleWidth(lines[1] ?? ""));
  });
});

describe("formatDate", () => {
  it("truncates ISO timestamps to the date", () => {
    expect(formatDate("2026-07-05T12:00:00.000Z")).toBe("2026-07-05");
  });

  it("passes through short strings", () => {
    expect(formatDate("n/a")).toBe("n/a");
  });
});

describe("accountDetails", () => {
  it("shows the claude token suffix", () => {
    expect(accountDetails(account({ provider: "claude", metadata: { tokenSuffix: "abcd" } }))).toBe(
      "token …abcd",
    );
  });

  it("prefers the codex email over the account id", () => {
    expect(
      accountDetails(
        account({ provider: "codex", metadata: { email: "dev@example.com", accountId: "acc_1" } }),
      ),
    ).toBe("dev@example.com");
    expect(accountDetails(account({ provider: "codex", metadata: { accountId: "acc_1" } }))).toBe(
      "acc_1",
    );
  });

  it("combines github login and scopes", () => {
    expect(
      accountDetails(
        account({
          provider: "github",
          metadata: { login: "octocat", scopes: ["repo", "workflow"] },
        }),
      ),
    ).toBe("octocat (repo, workflow)");
  });

  it("degrades to an empty string without metadata", () => {
    expect(accountDetails(account({ provider: "claude" }))).toBe("");
  });
});
