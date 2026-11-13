/**
 * Boat accounts route handlers — the install's stored Boat keys (see the contract's header).
 *
 * A key is checked with Boat, sealed with the install's credential cipher and stored; it is never
 * returned, logged or put in an error. Every Boat call here is a read: Boat is never asked to
 * create, change or delete anything from this module.
 */
import { randomUUID } from "node:crypto";

import {
  BOAT_DEFAULT_ACCOUNT_ID,
  BoatAccountBadRequestError,
  BoatAccountConflictError,
  BoatAccountInternalServerError,
  BoatAccountKeyRefusedError,
  BoatAccountNotFoundError,
  BoatAccountServiceUnavailableError,
  type BoatAccountWire,
  type BoatInstallKeyWire,
  type BoatFailure,
  type BoatKeyReport,
  boatKeyProofSchema,
  boatKeyReportSchema,
  type CreateBoatAccountRequest,
  type RotateBoatAccountKeyRequest,
  type SetBoatAccountOrganizationRequest,
} from "@sealant/api-contracts";
import { CredentialCipher } from "@sealant/credentials";
import {
  BoatAccountRepo,
  BoatKeyProofRepo,
  createBoatWalletOf,
  type BoatAccountRecord,
  type BoatObjectRef,
  type BoatUnreachableObjects,
} from "@sealant/db";
import type { NativeReopenReason } from "@sealant/validators";
import {
  BoatSecret,
  boatOrganizationSchema,
  boatSandboxIdSchema,
  boatSnapshotNameSchema,
  checkBoatKey,
  boatReopenableReasons,
  observeBoatKey,
  proveBoatKey,
  type BoatKeyCheck,
} from "@sealant/workspaces";
import { Effect, Option, Schema } from "effect";

import { env } from "../../runtime-env.js";
import {
  BoatConfigured,
  BoatDefaultKey,
  BoatKeyClients,
  type BoatKeyClient,
} from "../../services/boat-availability.js";

/** `unreachable`: the saved images Boat has in none of the key's wallets, by name. */
const unreachableWire = (unreachable: BoatUnreachableObjects | undefined) =>
  unreachable === undefined ||
  (unreachable.savedImages.length === 0 &&
    unreachable.runs.length === 0 &&
    unreachable.builds.length === 0)
    ? null
    : {
        savedImages: [...unreachable.savedImages],
        ...(unreachable.runs.length === 0 ? {} : { runs: [...unreachable.runs] }),
        ...(unreachable.builds.length === 0 ? {} : { builds: [...unreachable.builds] }),
      };

const toWire = (
  account: BoatAccountRecord,
  report: BoatKeyReport | null,
  unreachable?: BoatUnreachableObjects,
): BoatAccountWire => ({
  boatAccountId: account.id,
  label: account.label,
  state: account.removalRequestedAt === null ? "active" : "removing",
  createdAt: account.createdAt.toISOString(),
  keyRotatedAt: account.keyRotatedAt?.toISOString() ?? null,
  organization: account.organization,
  report,
  unreachable: unreachableWire(unreachable),
});

/** What the account made that sealant cannot reach in any wallet its key can bill. */
const unreachableOf = (account: BoatAccountRecord) =>
  Effect.flatMap(BoatAccountRepo, (repo) => repo.unreachable({ accountId: account.id })).pipe(
    Effect.mapError(internal("Failed to read the Boat account's objects.")),
  );

/** Whether sealant has not resolved the account's wallet yet (connected before accounts were pinned). */
const walletUnresolved = (account: BoatAccountRecord) =>
  createBoatWalletOf(account.organization, account.keyKind).kind === "unresolved";

/**
 * The pin a checked key gives an account sealant has not pinned: an organization's key's only
 * wallet, or the wallet a personal key bills now. Undefined: the report shows neither.
 */
const pinOf = (report: BoatKeyReport) =>
  report.keyKind.observed && report.keyKind.kind === "organization"
    ? { organization: null, keyKind: "organization" as const }
    : (() => {
        const wallet = walletId(report.wallet);
        return wallet === undefined
          ? undefined
          : {
              organization: wallet,
              keyKind: report.keyKind.observed ? report.keyKind.kind : null,
            };
      })();

/** The wallet an observed report's `wallet` is, as a pin names it: an organization's id, or `personal`. */
const walletId = (wallet: BoatKeyReport["wallet"]) =>
  !wallet.observed ? undefined : wallet.kind === "personal" ? "personal" : wallet.organizationId;

/** Records what the key is, as its check observed it. */
const recordKeyKind = (account: string, report: BoatKeyReport) =>
  report.keyKind.observed
    ? Effect.flatMap(BoatAccountRepo, (repo) => {
        const kind = report.keyKind.observed ? report.keyKind.kind : "personal";
        return repo.setKeyKind(account, kind);
      }).pipe(Effect.orElseSucceed(() => undefined))
    : Effect.void;

/** The install's own key as `install-key` shows it: never listed, rotated or removed here. */
const installKeyWire = (
  report: BoatKeyReport | null,
  unreachable?: BoatUnreachableObjects,
): BoatInstallKeyWire => ({
  label: "This install's Boat key",
  report,
  unreachable: unreachableWire(unreachable),
});

/** What the install's own key made that sealant cannot reach; nothing before it has a name. */
const installUnreachable = Effect.gen(function* () {
  const deploymentId = yield* installDeployment;
  if (deploymentId === undefined) return undefined;
  return yield* Effect.flatMap(BoatAccountRepo, (repo) =>
    repo.unreachable({ install: { deploymentId } }),
  ).pipe(Effect.orElseSucceed(() => undefined));
});

const decodeReport = Schema.decodeUnknownOption(boatKeyReportSchema);
const storedReport = (value: unknown): BoatKeyReport | null => {
  const decoded = decodeReport(value);
  return Option.isSome(decoded) ? decoded.value : null;
};

const environmentKey = (verb: string) =>
  new BoatAccountConflictError({
    code: "boat-account-environment",
    message: `The install's own Boat key is set in its environment (SEALANT_BOAT_API_KEY or SEALANT_BOAT_API_KEY_FILE); ${verb} it there, not through this API.`,
  });

const internal = (message: string) => () => new BoatAccountInternalServerError({ message });

/**
 * Stored accounts need somewhere to seal keys, and nothing else: an install runs Boat from them
 * with or without a key of its own in its environment.
 */
const requireBoatAccounts = Effect.gen(function* () {
  const key = (yield* BoatConfigured) ? env.SEALANT_CREDENTIALS_KEY?.trim() : undefined;
  if (key === undefined || key.length === 0)
    return yield* new BoatAccountServiceUnavailableError({
      message: "Boat accounts require SEALANT_CREDENTIALS_KEY to be configured.",
    });
});

/** Boat's words for a refused key, by its reason. Never the key or any part of it. */
const refusedWords = (failure: BoatFailure) =>
  failure.kind === "key-expired"
    ? "Boat answered that the key has expired"
    : failure.kind === "organization-mismatch"
      ? "Boat answered that the key belongs to another organization than the one named"
      : failure.kind === "sandbox-outside-key"
        ? "Boat answered that the key is limited to other VMs"
        : "Boat refused the key";

/**
 * A pasted key as sealant keeps it: whitespace around it trimmed, then refused by its shape alone
 * if it is not a Boat key. The key's value never reaches an error.
 */
const parseKey = (apiKey: string) => {
  const credential = BoatSecret.parse(apiKey.trim());
  return credential.ok
    ? Effect.succeed(credential.value)
    : Effect.fail(
        new BoatAccountBadRequestError({
          message:
            "apiKey is not a Boat key: it must be 16 to 4096 characters of letters, digits and . _ ~ -.",
        }),
      );
};

/** Opens a key into a client that names the account's organization on every request. */
const openClient = (credential: BoatSecret, organization: string | null) =>
  Effect.gen(function* () {
    const opened = (yield* BoatKeyClients)(
      credential,
      organization === null ? undefined : { organization },
    );
    if (!opened.ok)
      return yield* new BoatAccountInternalServerError({
        message: "Failed to prepare a Boat client.",
      });
    return opened.value;
  });

const runCheck = (client: BoatKeyClient, organization: string | null, previous?: unknown) =>
  Effect.promise(
    (): Promise<BoatKeyCheck> =>
      checkBoatKey(client, { organization, previous }).catch(() => ({
        kind: "unverified" as const,
      })),
  );

const unverified = (failure: BoatFailure | undefined, outcome: string) =>
  new BoatAccountKeyRefusedError({
    code: "boat-key-unverified",
    message: `Boat did not answer whether it accepts the key; ${outcome} Try again.`,
    ...(failure === undefined ? {} : { boat: failure }),
  });

/**
 * Checks a key with Boat by read-only calls before it is stored: refused when Boat refuses the key
 * itself, when it provably lacks a permission sealant needs (named), or when Boat does not answer.
 * Otherwise answers the client and the key's report.
 */
const acceptedKey = (
  credential: BoatSecret,
  organization: string | null,
  outcome: string,
  previous?: unknown,
) =>
  Effect.gen(function* () {
    const client = yield* openClient(credential, organization);
    const check = yield* runCheck(client, organization, previous);
    if (check.kind === "unverified") return yield* unverified(check.failure, outcome);
    if (check.kind === "refused")
      return yield* new BoatAccountKeyRefusedError({
        code: "boat-key-refused",
        message: `${refusedWords(check.failure)} (${check.failure.code ?? check.failure.kind}); ${outcome}`,
        boat: check.failure,
      });
    if (check.missingPermissions.length > 0)
      return yield* new BoatAccountKeyRefusedError({
        code: "boat-key-missing-permissions",
        message: `The key lacks Boat permissions sealant needs: ${check.missingPermissions.join(", ")}; ${outcome}`,
        missingPermissions: check.missingPermissions,
        report: check.report,
      });
    return { client, report: check.report };
  });

/**
 * The account's quarantined builds a person may have fixed are tried again on the next launch:
 * every one after a rotation, and after a check only those whose own cause the report shows
 * cleared (`boatReopenableReasons`). A failure to reopen loses nothing but the reopen; the next
 * check tries again.
 */
const reopenQuarantine = (deploymentId: string, reasons?: readonly NativeReopenReason[]) =>
  Effect.flatMap(BoatAccountRepo, (repo) =>
    repo.reopenQuarantined({
      deploymentId,
      at: new Date(),
      ...(reasons === undefined ? {} : { reasons }),
    }),
  ).pipe(Effect.orElseSucceed(() => 0));

/** The install's own deployment label, as the worker names its VMs and images with it. */
const installDeployment = Effect.flatMap(BoatAccountRepo, (repo) =>
  repo.installDeployment(env.SEALANT_BOAT_DEPLOYMENT_ID),
).pipe(
  Effect.map((stored) => env.SEALANT_BOAT_DEPLOYMENT_ID ?? stored),
  Effect.mapError(internal("Failed to read the install's Boat deployment.")),
);

/** The key's last stored report, as stored (`undefined`: none). */
const lastReport = (account: string) =>
  Effect.flatMap(BoatAccountRepo, (repo) => repo.reports()).pipe(
    Effect.map((reports): unknown => reports.get(account)?.report),
    Effect.mapError(internal("Failed to read the Boat keys' reports.")),
  );

const saveReport = (account: string, report: BoatKeyReport) =>
  Effect.flatMap(BoatAccountRepo, (repo) =>
    repo.saveReport({ account, report, observedAt: new Date(report.observedAt) }),
  ).pipe(Effect.mapError(internal("Failed to store the Boat key's report.")));

const seal = (apiKey: string) =>
  Effect.flatMap(CredentialCipher, (cipher) => cipher.encrypt(apiKey)).pipe(
    Effect.mapError(internal("Failed to seal the Boat API key.")),
  );

/**
 * `POST /v1/boat-accounts`: checks the key with Boat (read-only), seals it and stores the account
 * with its organization, if named, and the key's report.
 */
export const createBoatAccount = (payload: CreateBoatAccountRequest) =>
  Effect.gen(function* () {
    yield* requireBoatAccounts;
    const label = payload.label.trim();
    if (label.length > 200)
      return yield* new BoatAccountBadRequestError({
        message: "label must be at most 200 characters.",
      });
    const organization = payload.organization?.trim() ?? null;
    if (organization !== null && !boatOrganizationSchema.safeParse(organization).success)
      return yield* new BoatAccountBadRequestError({
        message:
          "organization must be a Boat organization's id or name: up to 128 letters, digits, spaces and . _ -.",
      });
    const credential = yield* parseKey(payload.apiKey);
    const { report } = yield* acceptedKey(credential, organization, "nothing was stored.");
    // A personal key is pinned at connect: to the wallet named, or else to the one it bills now,
    // as Boat answered, so the account never follows the key's active wallet. An organization's
    // key has one wallet. Kept as Boat's id, never a name another organization may take later.
    const keyKind = report.keyKind.observed ? report.keyKind.kind : null;
    const pin = keyKind === "organization" ? null : walletId(report.wallet);
    if (keyKind !== "organization" && pin === undefined)
      return yield* new BoatAccountKeyRefusedError({
        code: "boat-key-unverified",
        message:
          "Boat did not show which wallet the key bills, so sealant cannot pin the account to it (sealant reads it with the key's account.read permission); nothing was stored. Use a key that has account.read, or try again.",
        ...(!report.wallet.observed && report.wallet.boat !== undefined
          ? { boat: report.wallet.boat }
          : {}),
      });
    const kept: BoatKeyReport =
      pin === null || pin === undefined
        ? report
        : { ...report, organization: pin, billing: { mode: "pinned", organization: pin } };
    const sealed = yield* seal(credential.reveal());
    const account = yield* (yield* BoatAccountRepo)
      .create({
        id: randomUUID(),
        label,
        sealedKey: sealed.sealed,
        keyId: sealed.keyId,
        keyKind,
        ...(pin === null || pin === undefined ? {} : { organization: pin }),
      })
      .pipe(Effect.mapError(internal("Failed to store the Boat account.")));
    yield* saveReport(account.id, kept);
    return toWire(account, kept);
  });

/**
 * `GET /v1/boat-accounts`: every stored account not removed, each with its key's last report;
 * never a key. The install's own key is not listed (`install-key`): every id here is an account's
 * UUID, as every released client decodes it.
 */
export const listBoatAccounts = () =>
  Effect.gen(function* () {
    yield* requireBoatAccounts;
    const repo = yield* BoatAccountRepo;
    const accounts = yield* repo
      .list()
      .pipe(Effect.mapError(internal("Failed to list Boat accounts.")));
    const reports = yield* repo
      .reports()
      .pipe(Effect.mapError(internal("Failed to read the Boat keys' reports.")));
    const reportOf = (account: string) => storedReport(reports.get(account)?.report);
    // Each account's last full check, beside its report.
    const proofs = yield* (yield* BoatKeyProofRepo)
      .latest()
      .pipe(Effect.mapError(internal("Failed to read the Boat accounts' full checks.")));
    const proofOf = (account: string) => {
      const decoded = decodeProof(proofs.get(account)?.result);
      return Option.isSome(decoded) ? decoded.value : null;
    };
    const items: BoatAccountWire[] = [];
    for (const account of accounts)
      items.push({
        ...toWire(account, reportOf(account.id), yield* unreachableOf(account)),
        lastProof: proofOf(account.id),
      });
    return { items };
  });

/** An install that runs Boat from stored keys alone has no key of its own to show or check. */
const noInstallKey = () =>
  new BoatAccountServiceUnavailableError({
    message:
      "This install has no Boat key of its own (SEALANT_BOAT_API_KEY or SEALANT_BOAT_API_KEY_FILE); it runs Boat from its stored accounts.",
  });

/** `GET /v1/boat-accounts/install-key`: the install's own key's last report; never the key. */
export const getBoatInstallKey = () =>
  Effect.gen(function* () {
    yield* requireBoatAccounts;
    if ((yield* BoatDefaultKey)() === undefined) return yield* noInstallKey();
    const reports = yield* (yield* BoatAccountRepo)
      .reports()
      .pipe(Effect.mapError(internal("Failed to read the Boat keys' reports.")));
    return installKeyWire(
      storedReport(reports.get(BOAT_DEFAULT_ACCOUNT_ID)?.report),
      yield* installUnreachable,
    );
  });

/**
 * A full check, which makes a VM, of an account sealant has not pinned yet: one connected before
 * sealant pinned accounts, whose key cannot show the wallet it bills (no `account.read`), or that
 * the worker has not reached yet. A code every released client decodes.
 */
const unpinned = (boatAccountId: string) =>
  new BoatAccountConflictError({
    code: "boat-account-in-use",
    message: `sealant has not pinned Boat account ${boatAccountId} to a Boat wallet yet, so nothing new is started with its key; nothing was changed. Replace the account's key with one that has the account.read permission (rotate it), and sealant pins the account to the wallet that key bills.`,
  });

const notFound = (boatAccountId: string) =>
  new BoatAccountNotFoundError({ message: `No Boat account ${boatAccountId} on this install.` });
const removing = (boatAccountId: string) =>
  new BoatAccountConflictError({
    code: "boat-account-removing",
    message: `Boat account ${boatAccountId} is being removed.`,
  });

/**
 * Checks a key with Boat again and stores the report under `account`. A key Boat now refuses, or
 * one that lacks a permission, is reported, not refused: nothing changes but the report. Boat not
 * answering (or asking to wait) keeps the last report.
 */
const recheck = (credential: BoatSecret, organization: string | null, account: string) =>
  Effect.gen(function* () {
    const client = yield* openClient(credential, organization);
    const previous = yield* lastReport(account);
    // The same observation as the scheduled refresh (`observeBoatKey`).
    const observed = yield* Effect.promise(() =>
      observeBoatKey(client, { organization, previous }),
    );
    if (observed.kind === "kept")
      return yield* unverified(observed.failure, "the last report was kept.");
    yield* saveReport(account, observed.report);
    yield* recordKeyKind(account, observed.report);
    return observed.report;
  });

/** A stored account not removed, and its key opened; never the key's value in an error. */
const openStoredAccount = (boatAccountId: string) =>
  Effect.gen(function* () {
    const repo = yield* BoatAccountRepo;
    const account = yield* repo
      .get(boatAccountId)
      .pipe(Effect.mapError(internal("Failed to read the Boat account.")));
    if (account === undefined || account.removedAt !== null) return yield* notFound(boatAccountId);
    const sealed = yield* repo
      .sealedKey(boatAccountId)
      .pipe(Effect.mapError(internal("Failed to read the Boat account.")));
    if (sealed === undefined) return yield* notFound(boatAccountId);
    const opened = yield* Effect.flatMap(CredentialCipher, (cipher) =>
      cipher.decrypt(sealed.sealedKey),
    ).pipe(Effect.mapError(internal("Failed to open the Boat account's key.")));
    const parsed = BoatSecret.parse(opened);
    if (!parsed.ok)
      return yield* new BoatAccountInternalServerError({
        message: "The Boat account's stored key is not a Boat key.",
      });
    return { account, credential: parsed.value };
  });

const decodeProof = Schema.decodeUnknownOption(boatKeyProofSchema);

/**
 * What the account's full checks may still hold in Boat, as a sentence naming each thing and
 * where; `undefined` when none may. An account with one keeps the key that can clean it up: it is
 * not rotated or removed until sealant has deleted them (or the owner has, in Boat).
 */
const proofLeftovers = (boatAccountId: string) =>
  Effect.gen(function* () {
    const rows = yield* (yield* BoatKeyProofRepo)
      .outstanding(boatAccountId)
      .pipe(Effect.mapError(internal("Failed to read the Boat account's full checks.")));
    if (rows.length === 0) return undefined;
    const parts = rows.map((row) => {
      const things = [
        ...(row.createIssuedAt !== null && row.vmDeletedAt === null
          ? [
              row.sandboxId === null
                ? `a VM labelled sealant-key-proof=${row.createKey}`
                : `VM ${row.sandboxId}`,
            ]
          : []),
        ...(row.saveIssuedAt !== null && row.snapshotDeletedAt === null
          ? [`saved snapshot ${row.snapshotName}`]
          : []),
      ];
      const when =
        row.finishedAt === null
          ? ` (the check is running, or stopped halfway; sealant takes it over from ${row.claimedUntil.toISOString()})`
          : "";
      return `full check ${row.id}: ${things.length === 0 ? "nothing created yet" : things.join(" and ")}${when}`;
    });
    return `Boat may still hold what a full check of this account made: ${parts.join("; ")}. sealant keeps deleting it with this account's key. Try again once it is gone, or delete it in Boat yourself; nothing was changed.`;
  });

/**
 * `POST /v1/boat-accounts/:id/prove`: a full check of a stored account's key with a throwaway VM
 * (`proveBoatKey`): started, used, and deleted with the snapshot it saved, on every path. One per
 * account at a time; the result is kept for `list` (`lastProof`).
 */
export const proveBoatAccount = (boatAccountId: string) =>
  Effect.gen(function* () {
    yield* requireBoatAccounts;
    const { account, credential } = yield* openStoredAccount(boatAccountId);
    if (account.removalRequestedAt !== null) return yield* removing(boatAccountId);
    // What it would make belongs to the wallet the account is leaving: it waits for the change.
    if (walletUnresolved(account)) return yield* unpinned(boatAccountId);
    const client = yield* openClient(credential, account.organization);
    const proofs = yield* BoatKeyProofRepo;
    // Recorded in the wallet the client names, and started only if the account creates there now.
    const proven = yield* Effect.tryPromise({
      try: () =>
        proveBoatKey({ proofs, account: account.id, client, wallet: account.organization }),
      catch: internal("Failed to record the Boat account's full check."),
    });
    if (proven.kind === "wallet-changed")
      return yield* new BoatAccountConflictError({
        code: "boat-account-in-use",
        message: `Boat account ${boatAccountId} was pointed at another Boat wallet meanwhile; nothing was started. Try the full check again.`,
      });
    if (proven.kind === "running")
      return yield* new BoatAccountConflictError({
        code: "boat-proof-running",
        message: `A full check of Boat account ${boatAccountId} is already running, or what it made in Boat is still being removed; try again once it has finished.`,
      });
    return proven.proof;
  });

/** `POST /v1/boat-accounts/:id/check`: checks a stored account's key again (read-only). */
export const checkBoatAccount = (boatAccountId: string) =>
  Effect.gen(function* () {
    yield* requireBoatAccounts;
    const repo = yield* BoatAccountRepo;
    const account = yield* repo
      .get(boatAccountId)
      .pipe(Effect.mapError(internal("Failed to read the Boat account.")));
    if (account === undefined || account.removedAt !== null) return yield* notFound(boatAccountId);
    const sealed = yield* repo
      .sealedKey(boatAccountId)
      .pipe(Effect.mapError(internal("Failed to read the Boat account.")));
    if (sealed === undefined) return yield* notFound(boatAccountId);
    const opened = yield* Effect.flatMap(CredentialCipher, (cipher) =>
      cipher.decrypt(sealed.sealedKey),
    ).pipe(Effect.mapError(internal("Failed to open the Boat account's key.")));
    const parsed = BoatSecret.parse(opened);
    if (!parsed.ok)
      return yield* new BoatAccountInternalServerError({
        message: "The Boat account's stored key is not a Boat key.",
      });
    const report = yield* recheck(parsed.value, account.organization, account.id);
    yield* reopenQuarantine(account.deploymentId, boatReopenableReasons(report));
    return toWire(account, report, yield* unreachableOf(account));
  });

/** `POST /v1/boat-accounts/install-key`: checks the install's own key with Boat now (read-only). */
export const checkBoatInstallKey = () =>
  Effect.gen(function* () {
    yield* requireBoatAccounts;
    const key = (yield* BoatDefaultKey)();
    if (key === undefined) return yield* noInstallKey();
    if (!key.ok)
      return yield* new BoatAccountServiceUnavailableError({
        message: "The install's own Boat key could not be read from its environment.",
      });
    // The wallet the install's own key names on every request (`boat_install`: its setting once
    // applied, or what sealant observed); none while the worker has not resolved it.
    const stored = yield* (yield* BoatAccountRepo)
      .installWallet()
      .pipe(Effect.mapError(internal("Failed to read the install's Boat wallet.")));
    const organization = stored?.organization ?? null;
    const report = yield* recheck(key.value, organization, BOAT_DEFAULT_ACCOUNT_ID);
    const cleared = boatReopenableReasons(report);
    if (cleared.length > 0) yield* reopenQuarantine(yield* installDeployment, cleared);
    return installKeyWire(report, yield* installUnreachable);
  });

/**
 * How many of the VMs and saved images the account has now the new key cannot see. Each is read in
 * the wallet it was made in. One made before sealant recorded wallets is read under every wallet the
 * new key can bill, which Boat answers whichever wallet is named (observed 2026-11-13): found under
 * one, that is recorded; under several, a saved image is recorded in the wallet the account creates
 * in (`createWallet`), anything else left unknown; found in none, it counts as unseen, unless both
 * keys are the same Boat account's (`sameAccount`): then Boat's 404 under every wallet of a complete
 * list proves it gone (a saved image is recorded removed; a VM's own read records it), and without
 * the list it is recorded unreachable. Only Boat's own 404, or a VM that is not this account's,
 * counts; Boat not answering is no answer.
 */
const unseenBy = (
  account: BoatAccountRecord,
  holds: {
    readonly sandboxes: readonly {
      readonly sandboxId: string;
      readonly wallet: string | null | undefined;
    }[];
    readonly images: readonly {
      readonly name: string;
      readonly wallet: string | null | undefined;
    }[];
  },
  /** The new key's client naming `wallet` (null: none). */
  clientIn: (wallet: string | null) => BoatKeyClient | undefined,
  /** Every wallet the new key can bill, as its report lists them; undefined: no list. */
  wallets: readonly string[] | undefined,
  sameAccount: boolean,
  /** The wallet the account creates in now (null: none named), if it has one. */
  createWallet: string | null | undefined,
) =>
  Effect.gen(function* () {
    let unseen = 0;
    let unanswered = 0;
    type Seen = "found" | "absent" | "unanswered";
    const where = (
      wallet: string | null | undefined,
      read: (client: BoatKeyClient) => Promise<Seen>,
      ref: BoatObjectRef,
    ) =>
      Effect.gen(function* () {
        const ask = (each: string | null) => {
          const client = clientIn(each);
          return client === undefined
            ? Promise.resolve<Seen>("unanswered")
            : read(client).catch((): Seen => "unanswered");
        };
        if (wallet !== undefined) return yield* Effect.promise(() => ask(wallet));
        const seen = yield* Effect.promise(() =>
          Promise.all((wallets ?? []).map(async (each) => [each, await ask(each)] as const)),
        );
        const found = seen.filter(([, answer]) => answer === "found");
        const record = (located: { readonly wallet: string | null } | "unreachable" | "gone") =>
          Effect.flatMap(BoatAccountRepo, (repo) =>
            repo.recordObjectWallet({ accountId: account.id }, ref, located),
          ).pipe(Effect.orElseSucceed(() => undefined));
        if (found.length === 1 && found[0] !== undefined) {
          yield* record({ wallet: found[0][0] });
          return "found" as const;
        }
        if (found.length > 1) {
          if ("snapshot" in ref && createWallet !== undefined)
            yield* record({ wallet: createWallet });
          return "found" as const;
        }
        if (seen.some(([, answer]) => answer === "unanswered")) return "unanswered" as const;
        if (!sameAccount) return "absent" as const;
        // The same Boat account's key: under a complete list Boat's 404 is its word that it is gone.
        yield* record(wallets === undefined ? "unreachable" : "gone");
        return "found" as const;
      });
    for (const { sandboxId, wallet } of holds.sandboxes) {
      const id = boatSandboxIdSchema.safeParse(sandboxId);
      if (!id.success) {
        unanswered += 1;
        continue;
      }
      const seen = yield* where(
        wallet,
        async (client) => {
          const read = await client.get(id.data);
          if (read.ok)
            return read.value.labels?.["sealant-deployment"] === account.deploymentId
              ? "found"
              : "absent";
          return read.error.status === 404 ? "absent" : "unanswered";
        },
        { sandbox: sandboxId },
      );
      if (seen === "absent") unseen += 1;
      else if (seen === "unanswered") unanswered += 1;
    }
    for (const { name, wallet } of holds.images) {
      const parsed = boatSnapshotNameSchema.safeParse(name);
      if (!parsed.success) {
        unanswered += 1;
        continue;
      }
      const seen = yield* where(
        wallet,
        async (client) => {
          const read = await client.getSnapshot(parsed.data);
          return read.ok ? "found" : read.error.status === 404 ? "absent" : "unanswered";
        },
        { snapshot: name },
      );
      if (seen === "absent") unseen += 1;
      else if (seen === "unanswered") unanswered += 1;
    }
    return { unseen, unanswered };
  });

/**
 * `PUT /v1/boat-accounts/:id/key`: replaces the account's key with one Boat accepts and that sees
 * everything the account has in Boat now: every VM of its live runs and every saved image sealant
 * built there that is not deleted yet. Refused while a launch's create is unresolved. Every later Boat call for the account's runs uses the new key; each run stays in
 * the account it was created in.
 */
export const rotateBoatAccountKey = (boatAccountId: string, payload: RotateBoatAccountKeyRequest) =>
  Effect.gen(function* () {
    yield* requireBoatAccounts;
    if (boatAccountId === BOAT_DEFAULT_ACCOUNT_ID) return yield* environmentKey("rotate");
    const repo = yield* BoatAccountRepo;
    const account = yield* repo
      .get(boatAccountId)
      .pipe(Effect.mapError(internal("Failed to read the Boat account.")));
    if (account === undefined || account.removedAt !== null) return yield* notFound(boatAccountId);
    if (account.removalRequestedAt !== null) return yield* removing(boatAccountId);
    // A key of another Boat wallet could not delete what a full check made with this one.
    const leftovers = yield* proofLeftovers(boatAccountId);
    if (leftovers !== undefined)
      return yield* new BoatAccountConflictError({
        code: "boat-proof-running",
        message: leftovers,
      });
    const credential = yield* parseKey(payload.apiKey);
    // The new key bills the organization the account was stored with, like the old one.
    const { client, report } = yield* acceptedKey(
      credential,
      account.organization,
      "nothing was changed.",
      yield* lastReport(account.id),
    );
    // Both keys the same Boat account's, as each key's `/me` showed it: the new one sees what the
    // old one could. (An old key without `account.read` never showed it.)
    const before = storedReport(yield* lastReport(account.id));
    const sameAccount =
      before?.identity.observed === true &&
      report.identity.observed &&
      before.identity.accountId !== undefined &&
      before.identity.accountId === report.identity.accountId;
    // A create whose VM is not on record yet can be found only with the key it was made under,
    // unless the new key is the same Boat account's.
    const unresolved = sameAccount
      ? 0
      : yield* repo
          .unresolvedCreates(boatAccountId)
          .pipe(Effect.mapError(internal("Failed to read the Boat account's runs.")));
    if (unresolved > 0)
      return yield* new BoatAccountConflictError({
        code: "boat-account-in-use",
        liveRuns: unresolved,
        message: `Boat account ${boatAccountId} has ${String(unresolved)} launch${unresolved === 1 ? "" : "es"} whose VM Boat has not reported yet, which only the current key can find; nothing was changed. Try again once ${unresolved === 1 ? "it is" : "they are"} resolved.`,
      });
    const sandboxes = yield* repo
      .liveSandboxes(boatAccountId)
      .pipe(Effect.mapError(internal("Failed to read the Boat account's runs.")));
    const images = yield* repo
      .heldImages(boatAccountId)
      .pipe(Effect.mapError(internal("Failed to read the Boat account's images.")));
    const clients = yield* BoatKeyClients;
    const { unseen, unanswered } = yield* unseenBy(
      account,
      { sandboxes, images },
      (wallet) => {
        if (wallet === account.organization) return client;
        const opened = clients(credential, wallet === null ? undefined : { organization: wallet });
        return opened.ok ? opened.value : undefined;
      },
      report.wallets?.observed === true ? report.wallets.choices.map((each) => each.id) : undefined,
      sameAccount,
      // Where the account creates once rotated: its pin, or the one this rotation gives it.
      account.organization ??
        (account.keyKind === "organization" ? null : pinOf(report)?.organization),
    );
    if (unseen > 0)
      return yield* new BoatAccountConflictError({
        code: "boat-key-cannot-see",
        unseen,
        message: `The new key cannot see ${String(unseen)} of the VMs and saved images Boat account ${boatAccountId} has now, so it is most likely another Boat account's key; nothing was changed.`,
      });
    if (unanswered > 0)
      return yield* new BoatAccountKeyRefusedError({
        code: "boat-key-unverified",
        message: `Boat did not answer whether the new key sees everything the account has (${String(unanswered)} reads unanswered); nothing was changed. Try again.`,
      });
    const sealed = yield* seal(credential.reveal());
    const rotated = yield* repo
      .rotate(boatAccountId, {
        sealedKey: sealed.sealed,
        keyId: sealed.keyId,
        revision: account.keyRevision,
      })
      .pipe(
        Effect.mapError(
          (
            error,
          ): BoatAccountNotFoundError | BoatAccountConflictError | BoatAccountInternalServerError =>
            error.code === "not-found"
              ? notFound(boatAccountId)
              : error.code === "removing"
                ? removing(boatAccountId)
                : error.code === "proof-outstanding"
                  ? new BoatAccountConflictError({
                      code: "boat-proof-running",
                      message: `A full check of Boat account ${boatAccountId} started meanwhile and Boat may hold what it made; nothing was changed. Try again once it has finished.`,
                    })
                  : error.code === "stale-revision"
                    ? new BoatAccountConflictError({
                        code: "boat-account-changed",
                        message: `Boat account ${boatAccountId}'s key was replaced by another call meanwhile; nothing was changed.`,
                      })
                    : new BoatAccountInternalServerError({
                        message: "Failed to store the new key.",
                      }),
        ),
      );
    // An account sealant had not pinned (its old key could not show the wallet it bills) is pinned
    // with the new one, to the wallet it bills now. Nothing it made before waits for that.
    const pin = walletUnresolved(rotated) ? pinOf(report) : undefined;
    const pinned =
      pin === undefined
        ? rotated
        : ((yield* repo
            .resolveWallets({ accountId: rotated.id }, { runs: [], images: [], proofs: [], pin })
            .pipe(
              Effect.flatMap(() => repo.get(rotated.id)),
              Effect.mapError(internal("Failed to pin the Boat account.")),
            )) ?? rotated);
    yield* saveReport(pinned.id, {
      ...report,
      ...(pin === undefined || pin.organization === null
        ? {}
        : {
            organization: pin.organization,
            billing: { mode: "pinned", organization: pin.organization },
          }),
    });
    // A new key may be what a quarantined build was waiting for.
    yield* reopenQuarantine(rotated.deploymentId);
    return toWire(pinned, report, yield* unreachableOf(pinned));
  });

/**
 * `DELETE /v1/boat-accounts/:id`: refused while the account has runs whose VMs Boat may still hold
 * or an image build in flight. Otherwise no new workspace runs in it from now on, and the worker
 * deletes the saved images sealant built in it before the account, and its key, are gone.
 */
export const removeBoatAccount = (boatAccountId: string) =>
  Effect.gen(function* () {
    yield* requireBoatAccounts;
    if (boatAccountId === BOAT_DEFAULT_ACCOUNT_ID) return yield* environmentKey("remove");
    // The key is what deletes what a full check made: the account keeps it until that is gone.
    // (The worker's removal waits for it too, for a check that starts after this read.)
    const leftovers = yield* proofLeftovers(boatAccountId);
    if (leftovers !== undefined)
      return yield* new BoatAccountConflictError({
        code: "boat-proof-running",
        message: leftovers,
      });
    const request = yield* (yield* BoatAccountRepo)
      .requestRemoval(boatAccountId)
      .pipe(
        Effect.mapError((error): BoatAccountNotFoundError | BoatAccountInternalServerError =>
          error.code === "not-found"
            ? notFound(boatAccountId)
            : new BoatAccountInternalServerError({ message: "Failed to remove the Boat account." }),
        ),
      );
    if (request.kind === "in-use") {
      const parts = [
        ...(request.liveRuns === 0
          ? []
          : [
              `${String(request.liveRuns)} run${request.liveRuns === 1 ? "" : "s"} whose VM${request.liveRuns === 1 ? "" : "s"} Boat may still hold`,
            ]),
        ...(request.buildsInFlight === 0
          ? []
          : [
              `${String(request.buildsInFlight)} image build${request.buildsInFlight === 1 ? "" : "s"} in flight`,
            ]),
      ];
      return yield* new BoatAccountConflictError({
        code: "boat-account-in-use",
        liveRuns: request.liveRuns,
        buildsInFlight: request.buildsInFlight,
        message: `Boat account ${boatAccountId} still has ${parts.join(" and ")}; stop its workspaces and try again.`,
      });
    }
    const reports = yield* (yield* BoatAccountRepo)
      .reports()
      .pipe(Effect.orElseSucceed(() => new Map()));
    return toWire(request.account, storedReport(reports.get(request.account.id)?.report));
  });

/**
 * `PUT /v1/boat-accounts/:id/organization`: points a stored account with a personal key at another
 * wallet (an organization's id or name, or `personal`), without its key. The key is checked with
 * Boat (read-only) under the wallet it names now (which wallets it can bill) and under the new one.
 * There is no unpin (null is refused), an organization's key has nothing to choose, and an account
 * sealant has not pinned yet waits until the worker has found where its things are.
 *
 * Every object sealant makes in Boat is recorded with the wallet it was made in, and every request
 * about it names that wallet. So the change is refused, with the counts, only while the account
 * has something in Boat that lives in the wallet it names now and that a request names through
 * the account: a run whose VM Boat may hold, a run still being settled, an image build in flight
 * or being cleaned up, a full check Boat may hold something of. Otherwise it names the new wallet
 * at once, nothing is deleted first, and no workspace is refused for it. New images are built in
 * the new wallet at the next launch. The ones made in the old wallet stay recorded there; the
 * worker removes each with requests that name it.
 */
export const setBoatAccountOrganization = (
  boatAccountId: string,
  payload: SetBoatAccountOrganizationRequest,
) =>
  Effect.gen(function* () {
    yield* requireBoatAccounts;
    if (boatAccountId === BOAT_DEFAULT_ACCOUNT_ID)
      return yield* new BoatAccountConflictError({
        code: "boat-account-environment",
        message:
          "The install's own Boat key is set in its environment, and so is the organization it bills (SEALANT_BOAT_ORGANIZATION); change it there, not through this API.",
      });
    const requested = payload.organization?.trim() ?? null;
    if (requested === null)
      return yield* new BoatAccountBadRequestError({
        message:
          "A Boat account with a personal key always names the wallet it bills, so its bill never follows the key's active wallet: name another wallet (an organization from the report's wallets, or personal) instead of none.",
      });
    if (!boatOrganizationSchema.safeParse(requested).success)
      return yield* new BoatAccountBadRequestError({
        message:
          "organization must be a Boat organization's id or name, or personal: up to 128 letters, digits, spaces and . _ -.",
      });
    const { account, credential } = yield* openStoredAccount(boatAccountId);
    if (account.removalRequestedAt !== null) return yield* removing(boatAccountId);
    const outcome = "nothing was changed.";
    const organizationKey = new BoatAccountConflictError({
      code: "boat-key-organization",
      message: `Boat account ${boatAccountId} has a Boat organization's key, which bills that organization and nothing else; there is no wallet to choose, and nothing was changed.`,
    });
    if (account.keyKind === "organization" && account.organization === null)
      return yield* organizationKey;
    // An account connected before sealant pinned accounts is pinned here as well as by the worker;
    // what it made before stays where it is, and nothing of it waits. A key that cannot list its
    // wallets (no `account.read`) is refused below.
    const previous = yield* lastReport(account.id);
    /** A check under `organization`, refused as a pin is: an organization's key, a refused key. */
    const checked = (organization: string | null) =>
      Effect.gen(function* () {
        const check = yield* runCheck(
          yield* openClient(credential, organization),
          organization,
          previous,
        );
        if (check.kind === "unverified") return yield* unverified(check.failure, outcome);
        if (check.kind === "refused") {
          if (check.failure.kind === "organization-mismatch") return yield* organizationKey;
          return yield* new BoatAccountKeyRefusedError({
            code: "boat-key-refused",
            message: `${refusedWords(check.failure)} (${check.failure.code ?? check.failure.kind}); ${outcome}`,
            boat: check.failure,
          });
        }
        if (check.report.keyKind.observed && check.report.keyKind.kind === "organization")
          return yield* organizationKey;
        return check.report;
      });

    // The key as the account uses it now: the wallets it can bill.
    const now = yield* checked(account.organization);
    const choices = now.wallets?.observed === true ? now.wallets.choices : undefined;
    if (choices === undefined)
      return yield* new BoatAccountKeyRefusedError({
        code: "boat-key-unverified",
        message: `Boat did not show which wallets the key can bill; ${outcome} Try again.`,
        ...(now.wallets?.observed === false && now.wallets.boat !== undefined
          ? { boat: now.wallets.boat }
          : {}),
      });
    const lowered = requested.toLowerCase();
    const choice =
      lowered === "personal"
        ? { id: "personal" }
        : choices.find((each) => each.id === requested || each.name?.toLowerCase() === lowered);
    if (choice === undefined)
      return yield* new BoatAccountBadRequestError({
        message: `${requested} is not one of the wallets this key's Boat account can bill (${choices.map((each) => each.id).join(", ")}); ${outcome}`,
      });
    // Kept as Boat lists it: the organization's id, never a name another may take later.
    const organization = choice.id;
    const repo = yield* BoatAccountRepo;
    if (organization === account.organization)
      return toWire(account, storedReport(previous), yield* unreachableOf(account));
    // The key under the new wallet: Boat accepts it there.
    const target = yield* checked(organization);
    if (walletId(target.wallet) !== organization)
      return yield* new BoatAccountKeyRefusedError({
        code: "boat-key-unverified",
        message: `Boat did not show the key billing ${organization} when a request names it; ${outcome} Try again.`,
        ...(!target.wallet.observed && target.wallet.boat !== undefined
          ? { boat: target.wallet.boat }
          : {}),
      });

    const change = yield* repo
      .changeOrganization(
        { accountId: boatAccountId },
        { organization, expected: account.organization },
      )
      .pipe(
        Effect.mapError(
          (
            error,
          ): BoatAccountNotFoundError | BoatAccountConflictError | BoatAccountInternalServerError =>
            error.code === "not-found"
              ? notFound(boatAccountId)
              : error.code === "removing"
                ? removing(boatAccountId)
                : error.code === "stale-revision"
                  ? new BoatAccountConflictError({
                      code: "boat-account-changed",
                      message: `Boat account ${boatAccountId}'s organization was changed by another call meanwhile; ${outcome}`,
                    })
                  : new BoatAccountInternalServerError({
                      message: "Failed to change the Boat account's organization.",
                    }),
        ),
      );
    const changed = change.account ?? account;
    const kept: BoatKeyReport = {
      ...target,
      organization,
      billing: { mode: "pinned", organization },
    };
    yield* saveReport(account.id, kept);
    return toWire(changed, kept, yield* unreachableOf(changed));
  });
