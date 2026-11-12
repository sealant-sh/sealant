/**
 * Boat accounts route handlers — the install's stored Boat keys (see the contract's header).
 *
 * A key is checked with Boat, sealed with the install's credential cipher and stored; it is never
 * returned, logged or put in an error. Every Boat call here is a read: Boat is never asked to
 * create, change or delete anything from this module.
 */
import { randomUUID } from "node:crypto";

import {
  BoatAccountBadRequestError,
  BoatAccountConflictError,
  BoatAccountInternalServerError,
  BoatAccountKeyRefusedError,
  BoatAccountNotFoundError,
  BoatAccountServiceUnavailableError,
  type BoatAccountWire,
  type CreateBoatAccountRequest,
  type RotateBoatAccountKeyRequest,
} from "@sealant/api-contracts";
import { CredentialCipher } from "@sealant/credentials";
import { BoatAccountRepo, type BoatAccountRecord } from "@sealant/db";
import {
  BoatSecret,
  boatSandboxIdSchema,
  boatSnapshotNameSchema,
  type BoatApiError,
} from "@sealant/workspaces";
import { Effect } from "effect";

import { env } from "../../runtime-env.js";
import {
  BoatConfigured,
  BoatKeyClients,
  type BoatKeyClient,
} from "../../services/boat-availability.js";

const toWire = (account: BoatAccountRecord): BoatAccountWire => ({
  boatAccountId: account.id,
  label: account.label,
  state: account.removalRequestedAt === null ? "active" : "removing",
  createdAt: account.createdAt.toISOString(),
  keyRotatedAt: account.keyRotatedAt?.toISOString() ?? null,
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

/** Boat's answer that the key itself is not accepted, as opposed to Boat not answering. */
const keyRefusedByBoat = (error: BoatApiError) => error.status === 401 || error.status === 403;

/**
 * Opens a key into a client and asks Boat, by one read-only call, whether it accepts it. The key's
 * value never reaches an error: a malformed one is refused by its shape alone.
 */
const checkedClient = (apiKey: string) =>
  Effect.gen(function* () {
    const credential = BoatSecret.parse(apiKey);
    if (!credential.ok)
      return yield* new BoatAccountBadRequestError({
        message:
          "apiKey is not a Boat API key: it must be 16 to 4096 characters of letters, digits and . _ ~ -.",
      });
    const opened = (yield* BoatKeyClients)(credential.value);
    if (!opened.ok)
      return yield* new BoatAccountInternalServerError({
        message: "Failed to prepare a Boat client.",
      });
    const client = opened.value;
    const verified = yield* Effect.promise(() =>
      client.verifyCredential().catch(() => ({ ok: false as const, error: undefined })),
    );
    if (!verified.ok)
      return yield* new BoatAccountKeyRefusedError(
        verified.error !== undefined && keyRefusedByBoat(verified.error)
          ? { code: "boat-key-refused", message: "Boat refused the API key; nothing was stored." }
          : {
              code: "boat-key-unverified",
              message:
                "Boat did not answer whether it accepts the API key; nothing was stored. Try again.",
            },
      );
    return client;
  });

const seal = (apiKey: string) =>
  Effect.flatMap(CredentialCipher, (cipher) => cipher.encrypt(apiKey)).pipe(
    Effect.mapError(internal("Failed to seal the Boat API key.")),
  );

/** `POST /v1/boat-accounts`: checks the key with Boat, seals it and stores the account. */
export const createBoatAccount = (payload: CreateBoatAccountRequest) =>
  Effect.gen(function* () {
    yield* requireBoatAccounts;
    const label = payload.label.trim();
    if (label.length > 200)
      return yield* new BoatAccountBadRequestError({
        message: "label must be at most 200 characters.",
      });
    yield* checkedClient(payload.apiKey);
    const sealed = yield* seal(payload.apiKey);
    const account = yield* (yield* BoatAccountRepo)
      .create({ id: randomUUID(), label, sealedKey: sealed.sealed, keyId: sealed.keyId })
      .pipe(Effect.mapError(internal("Failed to store the Boat account.")));
    return toWire(account);
  });

/** `GET /v1/boat-accounts`: every account not removed; never a key. */
export const listBoatAccounts = () =>
  Effect.gen(function* () {
    yield* requireBoatAccounts;
    const accounts = yield* (yield* BoatAccountRepo)
      .list()
      .pipe(Effect.mapError(internal("Failed to list Boat accounts.")));
    return { items: accounts.map(toWire) };
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
    const repo = yield* BoatAccountRepo;
    const account = yield* repo
      .get(boatAccountId)
      .pipe(Effect.mapError(internal("Failed to read the Boat account.")));
    if (account === undefined || account.removedAt !== null) return yield* notFound(boatAccountId);
    if (account.removalRequestedAt !== null) return yield* removing(boatAccountId);
    const client = yield* checkedClient(payload.apiKey);
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
    const sealed = yield* seal(payload.apiKey);
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
    return toWire(rotated);
  });

/**
 * `DELETE /v1/boat-accounts/:id`: refused while the account has runs whose VMs Boat may still hold
 * or an image build in flight. Otherwise no new workspace runs in it from now on, and the worker
 * deletes the saved images Core built in it before the account, and its key, are gone.
 */
export const removeBoatAccount = (boatAccountId: string) =>
  Effect.gen(function* () {
    yield* requireBoatAccounts;
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
    return toWire(request.account);
  });
