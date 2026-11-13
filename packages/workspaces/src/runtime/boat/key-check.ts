/**
 * Checks a Boat key against Boat by read-only calls, and reports what Boat showed of it: who it is,
 * which wallet it bills, its permissions and which of the ones Core needs are missing, when it
 * expires, whether the wallet can start a VM now and why not, and its snapshot slots. Each fact is
 * observed, or not observed with the reason; nothing is guessed. Nothing here creates, changes or
 * deletes anything in Boat.
 *
 * Boat's key list does not mark the caller's own entry: it is matched by its prefix and last four.
 * An organization key is refused the list, and a key limited to some VMs gets an empty one, so
 * their permissions stay not observed. (A live proof with a throwaway VM, SLNT-784, may fill that
 * in later; it is not made here.)
 */
import type { BoatKeyNotObserved, BoatKeyReport } from "@sealant/api-contracts";

import { BOAT_REQUIRED_PERMISSIONS, type HttpBoatApi } from "./api.js";
import type { BoatApiError, BoatResult } from "./config.js";
import type { BoatFailure } from "./failure.js";

/** The reads a key check makes. */
export type BoatKeyCheckClient = Pick<
  HttpBoatApi,
  "verifyCredential" | "me" | "orgs" | "limits" | "apiKeys" | "snapshotAllowance" | "isOwnKey"
>;

/**
 * `refused`: Boat refused the key itself (unknown, revoked, expired, another organization's).
 * `unverified`: Boat did not answer whether it accepts it. `checked`: Boat accepted it, and the
 * report says what it showed; `missingPermissions` are the permissions Core needs that the key
 * provably lacks (from its listed scope, or Boat's own refusal of a call that needs one).
 */
export type BoatKeyCheck =
  | { readonly kind: "refused"; readonly failure: BoatFailure }
  | { readonly kind: "unverified"; readonly failure?: BoatFailure }
  | {
      readonly kind: "checked";
      readonly report: BoatKeyReport;
      readonly missingPermissions: readonly string[];
    };

/** Refusals of the key itself: no later check with the same key can be accepted. */
const KEY_REFUSALS: ReadonlySet<BoatFailure["kind"]> = new Set([
  "key-refused",
  "key-expired",
  "organization-mismatch",
  "sandbox-outside-key",
]);

/** Refusals for the account, not the key: Boat authenticated the key to say so. */
const ACCOUNT_REFUSALS: ReadonlySet<BoatFailure["kind"]> = new Set([
  "account-suspended",
  "billing-required",
  "running-limit",
  "member-cap",
  "trial-restricted",
  "snapshot-allowance-full",
]);

const notObserved = (error: BoatApiError): BoatKeyNotObserved => {
  const failure = error.boat;
  if (error.code === "invalid_response")
    return {
      observed: false,
      reason: "unreadable",
      ...(failure === undefined ? {} : { boat: failure }),
    };
  if (failure === undefined || failure.kind === "no-answer")
    return {
      observed: false,
      reason: "no-answer",
      ...(failure === undefined ? {} : { boat: failure }),
    };
  return { observed: false, reason: "refused", boat: failure };
};

const settle = <A>(read: () => Promise<BoatResult<A>>): Promise<BoatResult<A> | undefined> =>
  read().catch(() => undefined);
const noAnswer: BoatKeyNotObserved = { observed: false, reason: "no-answer" };

/** Whether `held` grants `permission`: itself, `*`, or a `family.*` wildcard. */
const grants = (held: readonly string[], permission: string) =>
  held.includes("*") ||
  held.includes(permission) ||
  held.includes(`${permission.split(".")[0] ?? ""}.*`);

/** A key scope limited to some VMs or environments, as opposed to all (`*`) or unset. */
const limited = (scope: "*" | readonly string[] | undefined) =>
  scope !== undefined && scope !== "*";

const accountStatus = (user: {
  readonly accountStatus?: string | undefined;
  readonly suspended?: boolean | undefined;
  readonly closed?: boolean | undefined;
}) =>
  user.accountStatus === "active" ||
  user.accountStatus === "suspended" ||
  user.accountStatus === "closed"
    ? user.accountStatus
    : user.closed === true
      ? "closed"
      : user.suspended === true
        ? "suspended"
        : "unknown";

export const checkBoatKey = async (
  client: BoatKeyCheckClient,
  options: { readonly organization: string | null; readonly now?: () => Date },
): Promise<BoatKeyCheck> => {
  const verified = await settle(() => client.verifyCredential());
  if (verified === undefined) return { kind: "unverified" };
  // Proof of one missing permission: Boat refused the inventory read for it.
  const provenMissing: string[] = [];
  if (!verified.ok) {
    const failure = verified.error.boat;
    if (failure === undefined) return { kind: "unverified" };
    if (KEY_REFUSALS.has(failure.kind)) return { kind: "refused", failure };
    if (failure.kind === "permission-missing")
      provenMissing.push(failure.permission ?? "sandbox.read");
    // Boat accepted the key and refused for the account (suspended, billing, a limit, a trial):
    // the check goes on, and the report shows it. Anything else (a rate limit, no machine, no
    // answer, a refusal Core does not classify) says nothing about the key: unverified.
    else if (!ACCOUNT_REFUSALS.has(failure.kind)) return { kind: "unverified", failure };
  }
  const [me, orgs, limits, keys, allowance] = await Promise.all([
    settle(() => client.me()),
    settle(() => client.orgs()),
    settle(() => client.limits()),
    settle(() => client.apiKeys()),
    settle(() => client.snapshotAllowance()),
  ]);

  const identity: BoatKeyReport["identity"] =
    me === undefined
      ? noAnswer
      : me.ok
        ? {
            observed: true,
            ...(me.value.id === undefined ? {} : { userId: me.value.id }),
            ...(me.value.login === undefined ? {} : { login: me.value.login }),
            ...(me.value.displayName == null ? {} : { displayName: me.value.displayName }),
            ...(me.value.serviceAccount === undefined
              ? {}
              : { serviceAccount: me.value.serviceAccount }),
            accountStatus:
              !verified.ok && verified.error.boat?.kind === "account-suspended"
                ? "suspended"
                : accountStatus(me.value),
          }
        : notObserved(me.error);

  const own = keys?.ok === true ? keys.value.apiKeys.filter((entry) => client.isOwnKey(entry)) : [];
  const entry = own.length === 1 ? own[0] : undefined;
  const keysNotObserved: BoatKeyNotObserved =
    keys === undefined
      ? noAnswer
      : !keys.ok
        ? notObserved(keys.error)
        : { observed: false, reason: "not-listed" };

  const keyKind: BoatKeyReport["keyKind"] =
    entry !== undefined
      ? { observed: true, kind: entry.teamId == null ? "personal" : "organization" }
      : keys?.ok === false && keys.error.code === "api_key_org_forbidden"
        ? { observed: true, kind: "organization" }
        : keysNotObserved;

  const presets = keys?.ok === true ? (keys.value.catalog?.presets ?? {}) : {};
  const actions = entry?.scope?.actions;
  const held =
    actions === undefined
      ? undefined
      : [
          ...new Set(
            actions.flatMap((action) =>
              Object.hasOwn(presets, action) ? [action, ...(presets[action] ?? [])] : [action],
            ),
          ),
        ].toSorted();
  const missing = [
    ...new Set([
      ...provenMissing,
      ...(held === undefined
        ? []
        : BOAT_REQUIRED_PERMISSIONS.filter((permission) => !grants(held, permission))),
    ]),
  ].toSorted();
  const permissions: BoatKeyReport["permissions"] =
    entry === undefined || held === undefined
      ? entry === undefined
        ? keysNotObserved
        : { observed: false, reason: "unreadable" }
      : {
          observed: true,
          held,
          missing,
          limitedToSandboxes: limited(entry.scope?.sandboxes) || limited(entry.scope?.environments),
        };

  const now = (options.now ?? (() => new Date()))();
  const expiresAt =
    entry === undefined
      ? undefined
      : entry.neverExpires === true
        ? null
        : (entry.expiresAt ?? entry.scope?.expiresAt ?? null);
  const expiry: BoatKeyReport["expiry"] =
    entry === undefined || expiresAt === undefined
      ? keysNotObserved
      : {
          observed: true,
          expiresAt,
          expired: entry.expired ?? (expiresAt !== null && Date.parse(expiresAt) <= now.getTime()),
          expiringSoon: entry.expiringSoon ?? false,
        };

  const organizations = orgs?.ok === true ? orgs.value : [];
  const wallet: BoatKeyReport["wallet"] =
    limits === undefined
      ? noAnswer
      : !limits.ok
        ? notObserved(limits.error)
        : limits.value.teamId === undefined
          ? { observed: true, kind: "personal" }
          : (() => {
              const team = organizations.find((org) => org.id === limits.value.teamId);
              return {
                observed: true as const,
                kind: "organization" as const,
                organizationId: limits.value.teamId,
                ...(team?.name === undefined ? {} : { organizationName: team.name }),
                ...(limits.value.teamRole === undefined
                  ? team?.role === undefined
                    ? {}
                    : { role: team.role }
                  : { role: limits.value.teamRole }),
              };
            })();
  const blocked =
    limits?.ok === true ? (limits.value.startBlockedReason ?? limits.value.blockedReason) : null;
  const start: BoatKeyReport["start"] =
    limits === undefined
      ? noAnswer
      : !limits.ok
        ? notObserved(limits.error)
        : {
            observed: true,
            canStart: limits.value.canStart,
            ...(blocked == null ? {} : { blockedReason: blocked }),
            ...(limits.value.billingStatus === undefined
              ? {}
              : { billingStatus: limits.value.billingStatus }),
            runningVms: limits.value.activeSandboxes,
            allowedVms: limits.value.maxActiveSandboxes,
          };
  const snapshots: BoatKeyReport["snapshots"] =
    allowance === undefined
      ? noAnswer
      : allowance.ok
        ? { observed: true, used: allowance.value.used, included: allowance.value.included }
        : notObserved(allowance.error);

  return {
    kind: "checked",
    missingPermissions: missing,
    report: {
      observedAt: now.toISOString(),
      organization: options.organization,
      identity,
      keyKind,
      wallet,
      requiredPermissions: [...BOAT_REQUIRED_PERMISSIONS],
      permissions,
      expiry,
      start,
      snapshots,
    },
  };
};

/**
 * The report of a key Boat refused outright: every fact not observed, each with Boat's refusal
 * (`api_key_expired`, `unauthorized`). What a re-check of a key that stopped working records.
 */
export const boatKeyRefusedReport = (
  failure: BoatFailure,
  options: { readonly organization: string | null; readonly now?: () => Date },
): BoatKeyReport => {
  const refused: BoatKeyNotObserved = { observed: false, reason: "refused", boat: failure };
  return {
    observedAt: (options.now ?? (() => new Date()))().toISOString(),
    organization: options.organization,
    identity: refused,
    keyKind: refused,
    wallet: refused,
    requiredPermissions: [...BOAT_REQUIRED_PERMISSIONS],
    permissions: refused,
    expiry: refused,
    start: refused,
    snapshots: refused,
  };
};
