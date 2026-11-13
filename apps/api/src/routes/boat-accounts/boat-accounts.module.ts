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
  type BoatFailure,
  type BoatKeyReport,
  boatKeyReportSchema,
  type CreateBoatAccountRequest,
  type RotateBoatAccountKeyRequest,
} from "@sealant/api-contracts";
import { CredentialCipher } from "@sealant/credentials";
import { BoatAccountRepo, type BoatAccountRecord } from "@sealant/db";
import {
  BoatSecret,
  boatKeyRefusedReport,
  boatOrganizationSchema,
  boatSandboxIdSchema,
  boatSnapshotNameSchema,
  checkBoatKey,
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

const toWire = (account: BoatAccountRecord, report: BoatKeyReport | null): BoatAccountWire => ({
  boatAccountId: account.id,
  label: account.label,
  state: account.removalRequestedAt === null ? "active" : "removing",
  createdAt: account.createdAt.toISOString(),
  keyRotatedAt: account.keyRotatedAt?.toISOString() ?? null,
  source: "stored",
  organization: account.organization,
  report,
});

/** When this process first served the install's own key: the env key has no creation time. */
const SERVING_SINCE = new Date().toISOString();
/** The install's own key as `list` and `check` show it: it cannot be rotated or removed here. */
const defaultWire = (report: BoatKeyReport | null): BoatAccountWire => ({
  boatAccountId: BOAT_DEFAULT_ACCOUNT_ID,
  label: "This install's Boat key",
  state: "active",
  createdAt: SERVING_SINCE,
  keyRotatedAt: null,
  source: "environment",
  organization: null,
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

/** Stored accounts need Boat itself (the env key) and somewhere to seal keys. */
const requireBoatAccounts = Effect.gen(function* () {
  if (!(yield* BoatConfigured))
    return yield* new BoatAccountServiceUnavailableError({
      message:
        "Boat accounts need Boat configured on this install: SEALANT_BOAT_API_KEY (or SEALANT_BOAT_API_KEY_FILE) and SEALANT_BOAT_DEPLOYMENT_ID.",
    });
  const key = env.SEALANT_CREDENTIALS_KEY?.trim();
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
 * A pasted key as Core keeps it: whitespace around it trimmed, then refused by its shape alone if
 * it is not a Boat key. The key's value never reaches an error.
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
 * itself, when it provably lacks a permission Core needs (named), or when Boat does not answer.
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
        message: `The key lacks Boat permissions Core needs: ${check.missingPermissions.join(", ")}; ${outcome}`,
        missingPermissions: check.missingPermissions,
        report: check.report,
      });
    return { client, report: check.report };
  });

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
 * `GET /v1/boat-accounts`: the install's own key first (`default`), then every stored account not
 * removed, each with its key's last report; never a key.
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
    return {
      items: [
        defaultWire(reportOf(BOAT_DEFAULT_ACCOUNT_ID)),
        ...accounts.map((account) => toWire(account, reportOf(account.id))),
      ],
    };
  });

/**
 * `POST /v1/boat-accounts/:id/check`: checks the account's key with Boat again (read-only; `default`
 * for the install's own key) and stores the report. A key Boat now refuses, or one that lacks a
 * permission, is reported, not refused: nothing changes but the report. Boat not answering keeps
 * the last report.
 */
export const checkBoatAccount = (boatAccountId: string) =>
  Effect.gen(function* () {
    yield* requireBoatAccounts;
    const repo = yield* BoatAccountRepo;
    let credential: BoatSecret;
    let organization: string | null = null;
    let account: BoatAccountRecord | undefined;
    if (boatAccountId === BOAT_DEFAULT_ACCOUNT_ID) {
      const key = (yield* BoatDefaultKey)();
      if (!key.ok)
        return yield* new BoatAccountServiceUnavailableError({
          message: "The install's own Boat key could not be read from its environment.",
        });
      credential = key.value;
    } else {
      account = yield* repo
        .get(boatAccountId)
        .pipe(Effect.mapError(internal("Failed to read the Boat account.")));
      if (account === undefined || account.removedAt !== null)
        return yield* notFound(boatAccountId);
      organization = account.organization;
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
      credential = parsed.value;
    }
    const client = yield* openClient(credential, organization);
    const check = yield* runCheck(client, organization);
    if (check.kind === "unverified")
      return yield* unverified(check.failure, "the last report was kept.");
    const report =
      check.kind === "refused"
        ? boatKeyRefusedReport(check.failure, { organization })
        : check.report;
    yield* saveReport(account?.id ?? BOAT_DEFAULT_ACCOUNT_ID, report);
    return account === undefined ? defaultWire(report) : toWire(account, report);
  });

const notFound = (boatAccountId: string) =>
  new BoatAccountNotFoundError({ message: `No Boat account ${boatAccountId} on this install.` });
const removing = (boatAccountId: string) =>
  new BoatAccountConflictError({
    code: "boat-account-removing",
    message: `Boat account ${boatAccountId} is being removed.`,
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
 * everything the account has in Boat now: every VM of its live runs and every saved image Core
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
                : error.code === "stale-revision"
                  ? new BoatAccountConflictError({
                      code: "boat-account-changed",
                      message: `Boat account ${boatAccountId}'s key was replaced by another call meanwhile; nothing was changed.`,
                    })
                  : new BoatAccountInternalServerError({ message: "Failed to store the new key." }),
        ),
      );
    yield* saveReport(rotated.id, report);
    return toWire(rotated, report);
  });

/**
 * `DELETE /v1/boat-accounts/:id`: refused while the account has runs whose VMs Boat may still hold
 * or an image build in flight. Otherwise no new workspace runs in it from now on, and the worker
 * deletes the saved images Core built in it before the account, and its key, are gone.
 */
export const removeBoatAccount = (boatAccountId: string) =>
  Effect.gen(function* () {
    yield* requireBoatAccounts;
    if (boatAccountId === BOAT_DEFAULT_ACCOUNT_ID) return yield* environmentKey("remove");
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
