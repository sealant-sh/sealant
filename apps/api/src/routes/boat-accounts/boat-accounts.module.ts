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
} from "@sealant/api-contracts";
import { CredentialCipher } from "@sealant/credentials";
import { BoatAccountRepo, BoatKeyProofRepo, type BoatAccountRecord } from "@sealant/db";
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
  BoatDefaultOrganization,
  BoatKeyClients,
  type BoatKeyClient,
} from "../../services/boat-availability.js";

const toWire = (account: BoatAccountRecord, report: BoatKeyReport | null): BoatAccountWire => ({
  boatAccountId: account.id,
  label: account.label,
  state: account.removalRequestedAt === null ? "active" : "removing",
  createdAt: account.createdAt.toISOString(),
  keyRotatedAt: account.keyRotatedAt?.toISOString() ?? null,
  organization: account.organization,
  report,
});

/** The install's own key as `install-key` shows it: never listed, rotated or removed here. */
const installKeyWire = (report: BoatKeyReport | null): BoatInstallKeyWire => ({
  label: "This install's Boat key",
  report,
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

const runCheck = (client: BoatKeyClient, organization: string | null) =>
  Effect.promise(
    (): Promise<BoatKeyCheck> =>
      checkBoatKey(client, { organization }).catch(() => ({ kind: "unverified" as const })),
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
const acceptedKey = (credential: BoatSecret, organization: string | null, outcome: string) =>
  Effect.gen(function* () {
    const client = yield* openClient(credential, organization);
    const check = yield* runCheck(client, organization);
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
    const sealed = yield* seal(credential.reveal());
    const account = yield* (yield* BoatAccountRepo)
      .create({
        id: randomUUID(),
        label,
        sealedKey: sealed.sealed,
        keyId: sealed.keyId,
        ...(organization === null ? {} : { organization }),
      })
      .pipe(Effect.mapError(internal("Failed to store the Boat account.")));
    yield* saveReport(account.id, report);
    return toWire(account, report);
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
    return {
      items: accounts.map((account) => ({
        ...toWire(account, reportOf(account.id)),
        lastProof: proofOf(account.id),
      })),
    };
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
    return installKeyWire(storedReport(reports.get(BOAT_DEFAULT_ACCOUNT_ID)?.report));
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
    // The same observation as the scheduled refresh (`observeBoatKey`).
    const observed = yield* Effect.promise(() => observeBoatKey(client, { organization }));
    if (observed.kind === "kept")
      return yield* unverified(observed.failure, "the last report was kept.");
    yield* saveReport(account, observed.report);
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
    const client = yield* openClient(credential, account.organization);
    const proofs = yield* BoatKeyProofRepo;
    const proven = yield* Effect.tryPromise({
      try: () => proveBoatKey({ proofs, account: account.id, client }),
      catch: internal("Failed to record the Boat account's full check."),
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
    return toWire(account, report);
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
    // The organization the install's own key bills, named on the check as on every request.
    const organization = (yield* BoatDefaultOrganization) ?? null;
    const report = yield* recheck(key.value, organization, BOAT_DEFAULT_ACCOUNT_ID);
    const cleared = boatReopenableReasons(report);
    if (cleared.length > 0) yield* reopenQuarantine(yield* installDeployment, cleared);
    return installKeyWire(report);
  });

/**
 * How many of the VMs and saved images the account has now the new key cannot see. Only Boat's
 * own 404, or a VM that is not this account's, counts; Boat not answering is no answer.
 */
const unseenBy = (
  client: BoatKeyClient,
  account: BoatAccountRecord,
  holds: {
    readonly sandboxes: readonly { readonly sandboxId: string }[];
    readonly images: readonly string[];
  },
) =>
  Effect.gen(function* () {
    let unseen = 0;
    let unanswered = 0;
    for (const { sandboxId } of holds.sandboxes) {
      const id = boatSandboxIdSchema.safeParse(sandboxId);
      const read = id.success
        ? yield* Effect.promise(() => client.get(id.data).catch(() => undefined))
        : undefined;
      if (read === undefined) unanswered += 1;
      else if (read.ok) {
        if (read.value.labels?.["sealant-deployment"] !== account.deploymentId) unseen += 1;
      } else if (read.error.status === 404) unseen += 1;
      else unanswered += 1;
    }
    for (const name of holds.images) {
      const parsed = boatSnapshotNameSchema.safeParse(name);
      const read = parsed.success
        ? yield* Effect.promise(() => client.getSnapshot(parsed.data).catch(() => undefined))
        : undefined;
      if (read === undefined) unanswered += 1;
      else if (!read.ok) {
        if (read.error.status === 404) unseen += 1;
        else unanswered += 1;
      }
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
    );
    // A create whose VM is not on record yet can be found only with the key it was made under.
    const unresolved = yield* repo
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
    const { unseen, unanswered } = yield* unseenBy(client, account, { sandboxes, images });
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
    yield* saveReport(rotated.id, report);
    // A new key may be what a quarantined build was waiting for.
    yield* reopenQuarantine(rotated.deploymentId);
    return toWire(rotated, report);
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
