import {
  beginHomeWrite,
  planHomePut,
  pruneHome,
  recordLaunchHome,
  removalWork,
  settleHomeWrite,
  settleInDoubt,
  type HomeState,
  type HomeWriteOutcome,
  type PlacementAccount,
  type WorkspaceCredentialPlacement,
} from "@sealant/db";
import { describe, expect, it } from "vitest";

const key = { runId: "run_1", home: "/home/m4lice000" };

const placement = (
  id: string,
  overrides: Partial<WorkspaceCredentialPlacement> = {},
): WorkspaceCredentialPlacement => ({
  id,
  ...key,
  provider: "claude",
  accountId: "cacc_a",
  revision: 1,
  path: `${key.home}/.claude/.credentials.json`,
  login: { kind: "subscription" },
  state: "ready",
  createdAt: new Date("2026-10-25T00:00:00.000Z"),
  ...overrides,
});

const account = (id: string, overrides: Partial<PlacementAccount> = {}): PlacementAccount => ({
  id,
  name: id,
  ownerUserId: "alice",
  provider: "claude",
  revision: 1,
  status: "active",
  ...overrides,
});

const stateOf = (
  placements: readonly WorkspaceCredentialPlacement[],
  accounts: readonly PlacementAccount[] = [account("cacc_a"), account("cacc_b")],
  defaults: readonly string[] = [],
): HomeState => ({
  held: undefined,
  placements,
  accounts: new Map(accounts.map((row) => [row.id, row])),
  defaults: new Set(defaults),
});

const stateOfRows = (rows: ReturnType<typeof stateOf>["placements"]) =>
  rows.map(({ id, provider, accountId, revision, state }) => ({
    id,
    provider,
    accountId,
    revision,
    state,
  }));

let ids = 0;
const newId = () => `cpl_new_${String((ids += 1))}`;
const SUB = { kind: "subscription" } as const;
const KEY = { kind: "api-key", suffix: "FAKE" } as const;

const begin = (state: HomeState, accountId: string, revision = 1, reuse?: string) => {
  const began = beginHomeWrite(state, {
    key,
    onBehalfOfUserId: "alice",
    writes: [
      {
        provider: "claude",
        accountId,
        revision,
        login: SUB,
        reuse,
        id: reuse ?? newId(),
        path: `${key.home}/.claude/.credentials.json`,
      },
    ],
    removes: [],
    removedKeys: [],
  });
  if (began.kind !== "begun") throw new Error("the write did not begin");
  return began;
};

describe("planHomePut", () => {
  const ready = placement("cpl_a");

  it("writes every selection and removes every null for a caller without live placements", () => {
    const plan = planHomePut({
      placements: [ready, placement("cpl_g", { provider: "github" })],
      live: undefined,
      selected: [{ provider: "claude", accountId: "cacc_a", revision: 1, login: SUB }],
      removed: ["github"],
    });
    expect(plan).toEqual({
      writes: [
        { provider: "claude", accountId: "cacc_a", revision: 1, login: SUB, reuse: "cpl_a" },
      ],
      removes: ["github"],
      keptKeys: [],
      removedKeys: [],
      pinned: [],
    });
  });

  it("leaves a live slot alone for another account or revision, and writes it again for its own", () => {
    for (const selection of [
      { accountId: "cacc_b", revision: 1 },
      { accountId: "cacc_a", revision: 2 },
    ]) {
      expect(
        planHomePut({
          placements: [ready],
          live: ["cpl_a"],
          selected: [{ provider: "claude", login: SUB, ...selection }],
          removed: [],
        }),
      ).toEqual({ writes: [], keptKeys: [], removes: [], removedKeys: [], pinned: ["cpl_a"] });
    }
    expect(
      planHomePut({
        placements: [ready],
        live: ["cpl_a"],
        selected: [{ provider: "claude", accountId: "cacc_a", revision: 1, login: SUB }],
        removed: [],
      }).writes,
    ).toEqual([
      { provider: "claude", accountId: "cacc_a", revision: 1, login: SUB, reuse: "cpl_a" },
    ]);
  });

  it("never removes a live slot, and a live id that is not ready protects nothing", () => {
    expect(
      planHomePut({ placements: [ready], live: ["cpl_a"], selected: [], removed: ["claude"] }),
    ).toEqual({ writes: [], keptKeys: [], removes: [], removedKeys: [], pinned: ["cpl_a"] });
    expect(
      planHomePut({
        placements: [placement("cpl_a", { state: "removing" })],
        live: ["cpl_a"],
        selected: [{ provider: "claude", accountId: "cacc_b", revision: 1, login: SUB }],
        removed: [],
      }),
    ).toEqual({
      writes: [
        { provider: "claude", accountId: "cacc_b", revision: 1, login: SUB, reuse: undefined },
      ],
      removes: [],
      keptKeys: [],
      removedKeys: [],
      pinned: [],
    });
  });
});

describe("a write's placements", () => {
  it("leave a pending write's slot for removal once the lock is held again", () => {
    expect(
      stateOfRows(
        settleInDoubt([
          placement("cpl_a"),
          placement("cpl_b", { accountId: "cacc_b", state: "pending" }),
          placement("cpl_g", { provider: "github", path: `${key.home}/.config/gh/hosts.yml` }),
        ]),
      ).map((row) => row.state),
    ).toEqual(["removing", "removing", "ready"]);
  });

  it("do not begin for an account that moved, was archived, or is someone else's", () => {
    for (const changed of [
      account("cacc_b", { revision: 2 }),
      account("cacc_b", { status: "archived" }),
      account("cacc_b", { ownerUserId: "bob" }),
      account("cacc_b", { provider: "codex" }),
    ]) {
      expect(
        beginHomeWrite(stateOf([], [changed]), {
          key,
          onBehalfOfUserId: "alice",
          writes: [
            {
              provider: "claude",
              accountId: "cacc_b",
              revision: 1,
              login: SUB,
              reuse: undefined,
              id: newId(),
              path: "/home/m4lice000/.claude/.credentials.json",
            },
          ],
          removes: [],
          removedKeys: [],
        }),
      ).toEqual({ kind: "accounts-moved" });
    }
  });

  it("retire the slot's previous placement only once the write landed", () => {
    const before = stateOf([placement("cpl_a")]);
    const began = begin(before, "cacc_b");
    expect(stateOfRows(began.placements).map((row) => row.state)).toEqual(["ready", "pending"]);
    const done = settleHomeWrite({ ...before, placements: began.placements }, began.intent, {
      kind: "done",
      written: ["claude"],
      kept: [],
    });
    expect(stateOfRows(done.placements).map((row) => [row.accountId, row.state])).toEqual([
      ["cacc_a", "removing"],
      ["cacc_b", "ready"],
    ]);
    expect(done.stale).toBe(false);
  });

  it("keep the working login when the write is refused before anything landed", () => {
    const before = stateOf([placement("cpl_a")]);
    const began = begin(before, "cacc_b");
    const refused = settleHomeWrite({ ...before, placements: began.placements }, began.intent, {
      kind: "refused",
      written: [],
    });
    expect(stateOfRows(refused.placements)).toEqual(stateOfRows([placement("cpl_a")]));
  });

  it("put back what a refused write meant to remove", () => {
    const before = stateOf([placement("cpl_a")]);
    const began = beginHomeWrite(before, {
      key,
      onBehalfOfUserId: "alice",
      writes: [],
      removes: ["claude"],
      removedKeys: [],
    });
    if (began.kind !== "begun") throw new Error("the write did not begin");
    expect(began.placements.map((row) => row.state)).toEqual(["removing"]);
    const outcome: HomeWriteOutcome = { kind: "refused", written: [] };
    expect(
      settleHomeWrite({ ...before, placements: began.placements }, began.intent, outcome)
        .placements,
    ).toEqual([placement("cpl_a")]);
    expect(
      settleHomeWrite({ ...before, placements: began.placements }, began.intent, {
        kind: "done",
        written: [],
        kept: [],
      }).placements,
    ).toEqual([]);
  });

  it("record no placement for a merged login the person's own login kept", () => {
    const pi = placement("cpl_pi", { provider: "pi", path: "/home/m4lice000/.pi/agent/auth.json" });
    const before = stateOf([pi], [account("cacc_c", { provider: "codex" })]);
    const began = beginHomeWrite(
      stateOf(
        [pi],
        [account("cacc_a", { provider: "codex" }), account("cacc_c", { provider: "codex" })],
      ),
      {
        key,
        onBehalfOfUserId: "alice",
        writes: [
          {
            provider: "pi",
            accountId: "cacc_c",
            revision: 1,
            login: SUB,
            reuse: undefined,
            id: newId(),
            path: pi.path,
          },
        ],
        removes: [],
        removedKeys: [],
      },
    );
    if (began.kind !== "begun") throw new Error("the write did not begin");
    const settled = settleHomeWrite({ ...before, placements: began.placements }, began.intent, {
      kind: "done",
      written: [],
      kept: ["pi"],
    });
    expect(stateOfRows(settled.placements)).toEqual([
      { id: "cpl_pi", provider: "pi", accountId: "cacc_a", revision: 1, state: "removing" },
    ]);
  });

  it("leave a write archive cancelled for removal, and say when the account moved past it", () => {
    const before = stateOf([]);
    const began = begin(before, "cacc_b");
    const archived = settleHomeWrite(
      {
        ...before,
        accounts: new Map([["cacc_b", account("cacc_b", { status: "archived" })]]),
        placements: began.placements.map((row) => ({ ...row, state: "removing" })),
      },
      began.intent,
      { kind: "done", written: ["claude"], kept: [] },
    );
    expect(archived.placements.map((row) => row.state)).toEqual(["removing"]);
    const moved = settleHomeWrite(
      {
        ...before,
        accounts: new Map([["cacc_b", account("cacc_b", { revision: 2 })]]),
        placements: began.placements,
      },
      began.intent,
      { kind: "done", written: ["claude"], kept: [] },
    );
    expect(moved).toMatchObject({ stale: true, placements: [{ state: "ready", revision: 1 }] });
  });

  it("bring a refreshed placement to its new revision under the same id", () => {
    const before = stateOf([placement("cpl_a")], [account("cacc_a", { revision: 2 })]);
    const began = begin(before, "cacc_a", 2, "cpl_a");
    expect(began.placements).toEqual([{ ...placement("cpl_a"), state: "pending" }]);
    const settled = settleHomeWrite({ ...before, placements: began.placements }, began.intent, {
      kind: "done",
      written: ["claude"],
      kept: [],
    });
    expect(settled.placements).toEqual([{ ...placement("cpl_a"), revision: 2 }]);
    const lost = settleHomeWrite({ ...before, placements: began.placements }, began.intent, {
      kind: "unconfirmed",
    });
    expect(settleInDoubt(lost.placements).map((row) => row.state)).toEqual(["removing"]);
  });
});

describe("pruneHome and removalWork", () => {
  it("keep live and default placements, and never remove a path a ready placement holds", () => {
    const rows = [
      placement("cpl_live", { provider: "codex", path: "/home/m4lice000/.codex/auth.json" }),
      placement("cpl_default"),
      placement("cpl_other", {
        provider: "github",
        accountId: "cacc_g",
        path: "/home/m4lice000/.config/gh/hosts.yml",
      }),
      placement("cpl_old", { accountId: "cacc_b", state: "removing" }),
    ];
    const pruned = pruneHome(stateOf(rows, [account("cacc_a")], ["cacc_a"]), ["cpl_live"]);
    expect(pruned.map((row) => [row.id, row.state])).toEqual([
      ["cpl_live", "ready"],
      ["cpl_default", "ready"],
      ["cpl_other", "removing"],
      ["cpl_old", "removing"],
    ]);
    expect(removalWork(pruned)).toEqual({
      removes: ["github"],
      removedKeys: [],
      forget: ["cpl_other", "cpl_old"],
    });
  });
});

describe("recordLaunchHome", () => {
  it("records the login and revision the launch resolved, whatever the account says since", () => {
    const codexKey = { kind: "api-key", suffix: "wxyz" } as const;
    const reconnected = stateOf([], [account("cacc_c", { provider: "codex", revision: 2 })]);
    const recorded = recordLaunchHome(reconnected, {
      key,
      newId: () => "cpl_launch",
      logins: [
        {
          provider: "codex",
          accountId: "cacc_c",
          path: `${key.home}/.codex/auth.json`,
          login: codexKey,
          revision: 1,
        },
      ],
    });
    expect(
      recorded.map(({ id, revision, login, state }) => ({ id, revision, login, state })),
    ).toEqual([{ id: "cpl_launch", revision: 1, login: codexKey, state: "ready" }]);
    const plan = planHomePut({
      placements: recorded,
      live: [],
      selected: [{ provider: "codex", accountId: "cacc_c", revision: 2, login: SUB }],
      removed: [],
    });
    expect(plan.writes).toEqual([
      { provider: "codex", accountId: "cacc_c", revision: 2, login: SUB, reuse: undefined },
    ]);
  });
});

describe("pruneHome and a rotated default", () => {
  it("keeps only the placement at the default's current revision", () => {
    const keyAt = (id: string, revision: number) =>
      placement(id, { revision, login: KEY, path: `${key.home}/.sealant/keys/${id}` });
    const pruned = pruneHome(
      stateOf(
        [keyAt("cpl_rev1", 1), keyAt("cpl_rev2", 2)],
        [account("cacc_a", { revision: 2 })],
        ["cacc_a"],
      ),
      [],
    );
    expect(pruned.map((row) => [row.id, row.state])).toEqual([
      ["cpl_rev1", "removing"],
      ["cpl_rev2", "ready"],
    ]);
  });
});

describe("Claude key placements", () => {
  const subscription = placement("cpl_sub");
  const keyRow = (id: string, overrides: Partial<WorkspaceCredentialPlacement> = {}) =>
    placement(id, {
      accountId: "cacc_k",
      login: KEY,
      path: `${key.home}/.sealant/keys/${id}`,
      ...overrides,
    });
  const keySelection = {
    provider: "claude",
    accountId: "cacc_k",
    revision: 1,
    login: KEY,
  } as const;

  it("are written beside a live subscription and never pinned, and a put of the same key reuses its file", () => {
    expect(
      planHomePut({
        placements: [subscription],
        live: ["cpl_sub"],
        selected: [keySelection],
        removed: [],
      }),
    ).toEqual({
      writes: [{ ...keySelection, reuse: undefined }],
      keptKeys: [],
      removes: [],
      removedKeys: [],
      pinned: [],
    });
    expect(
      planHomePut({
        placements: [subscription, keyRow("cpl_k")],
        live: ["cpl_k"],
        selected: [keySelection],
        removed: [],
      }),
    ).toMatchObject({ writes: [], keptKeys: [{ ...keySelection, id: "cpl_k" }] });
    expect(
      planHomePut({
        placements: [keyRow("cpl_k")],
        live: ["cpl_k"],
        selected: [{ provider: "claude", accountId: "cacc_a", revision: 1, login: SUB }],
        removed: [],
      }),
    ).toEqual({
      writes: [
        { provider: "claude", accountId: "cacc_a", revision: 1, login: SUB, reuse: undefined },
      ],
      keptKeys: [],
      removes: [],
      removedKeys: [],
      pinned: [],
    });
  });

  it("are removed with a null Claude selection unless live, which keeps them unpinned", () => {
    expect(
      planHomePut({
        placements: [subscription, keyRow("cpl_k1"), keyRow("cpl_k2", { revision: 2 })],
        live: ["cpl_k2"],
        selected: [],
        removed: ["claude"],
      }),
    ).toEqual({
      writes: [],
      keptKeys: [],
      removes: ["claude"],
      removedKeys: ["cpl_k1"],
      pinned: [],
    });
  });

  it("stay ready when a put keeps one, so an unconfirmed put never leaves it for removal", () => {
    const before = stateOf([subscription, keyRow("cpl_k")], [account("cacc_a"), account("cacc_k")]);
    const plan = planHomePut({
      placements: before.placements,
      live: ["cpl_k"],
      selected: [keySelection],
      removed: [],
    });
    const began = beginHomeWrite(before, {
      key,
      onBehalfOfUserId: "alice",
      writes: [],
      keptKeys: plan.keptKeys,
      removes: [],
      removedKeys: [],
    });
    if (began.kind !== "begun") throw new Error("the write did not begin");
    const inDoubt = settleInDoubt(began.placements);
    expect(inDoubt.map((row) => [row.id, row.state])).toEqual([
      ["cpl_sub", "ready"],
      ["cpl_k", "ready"],
    ]);
    expect(removalWork(inDoubt)).toEqual({ removes: [], removedKeys: [], forget: [] });
    expect(
      beginHomeWrite(
        stateOf(before.placements, [account("cacc_a"), account("cacc_k", { revision: 2 })]),
        {
          key,
          onBehalfOfUserId: "alice",
          writes: [],
          keptKeys: plan.keptKeys,
          removes: [],
          removedKeys: [],
        },
      ).kind,
    ).toBe("accounts-moved");
  });

  it("leave the subscription's file alone when one lands, is in doubt, or is removed", () => {
    const before = stateOf([subscription], [account("cacc_a"), account("cacc_k")]);
    const began = beginHomeWrite(before, {
      key,
      onBehalfOfUserId: "alice",
      writes: [{ ...keySelection, reuse: undefined, id: "cpl_k", path: keyRow("cpl_k").path }],
      removes: [],
      removedKeys: [],
    });
    if (began.kind !== "begun") throw new Error("the write did not begin");
    expect(settleInDoubt(began.placements).map((row) => [row.id, row.state])).toEqual([
      ["cpl_sub", "ready"],
      ["cpl_k", "removing"],
    ]);
    const done = settleHomeWrite({ ...before, placements: began.placements }, began.intent, {
      kind: "done",
      written: ["claude"],
      kept: [],
    });
    expect(done.placements.map((row) => [row.id, row.state, row.login])).toEqual([
      ["cpl_sub", "ready", SUB],
      ["cpl_k", "ready", KEY],
    ]);
    const removed = done.placements.map((row) =>
      row.id === "cpl_k" ? { ...row, state: "removing" as const } : row,
    );
    expect(removalWork(removed)).toEqual({
      removes: [],
      removedKeys: ["cpl_k"],
      forget: ["cpl_k"],
    });
  });
});
