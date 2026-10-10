import { isIPv4, isIPv6 } from "node:net";

/*
Limits before login, modelled on OpenSSH's sshd: anyone who can reach the gateway's port can open
connections and offer keys, and every key the gateway does not know costs a lookup in the API. So
until a connection has logged in it is held to:

- a login grace time (sshd `LoginGraceTime`): the connection is dropped if it has not logged in by
  then, whatever it sent;
- a cap on connections not yet logged in, overall and per source (sshd `MaxStartups`,
  `PerSourceMaxStartups`): one more is dropped as it arrives;
- a cap on refused authentication attempts per connection (sshd `MaxAuthTries`);
- a key lookup budget per source (the role of sshd `PerSourcePenalties`): a source that spends it
  gets no more lookups, and its new connections are dropped, until it refills. One address cannot
  spend the API's budget the people already using the gateway rely on.

A source is an IPv4 address, or an IPv6 /64 (one host is routinely handed a whole /64, so a
per-address limit would be none at all; sshd's `PerSourceNetBlockSize` does the same).
*/

export interface AdmissionLimits {
  /** How long a connection has from arrival to a completed login. */
  readonly loginGraceMs: number;
  /** Refused authentication attempts one connection may make before it is dropped. */
  readonly maxAuthTries: number;
  /** Connections not yet logged in, across every source. */
  readonly maxStartups: number;
  /** Connections not yet logged in from one source. */
  readonly perSourceMaxStartups: number;
  /** Key lookups one source may cost per minute; it refills at that rate. */
  readonly perSourceKeyLookupsPerMinute: number;
}

export const DEFAULT_ADMISSION_LIMITS: AdmissionLimits = {
  loginGraceMs: 30_000,
  maxAuthTries: 6,
  maxStartups: 100,
  perSourceMaxStartups: 10,
  perSourceKeyLookupsPerMinute: 60,
};

/** Sources tracked at once; past it a sweep runs, and a new source is refused if it frees none. */
const MAX_TRACKED_SOURCES = 100_000;

const expandIpv6 = (address: string): ReadonlyArray<string> | undefined => {
  const withoutZone = address.split("%")[0] ?? address;
  const halves = withoutZone.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] === "" || halves[0] === undefined ? [] : halves[0].split(":");
  const tail =
    halves.length === 1 || halves[1] === "" || halves[1] === undefined ? [] : halves[1].split(":");
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return undefined;
  return [...head, ...Array.from({ length: missing }, () => "0"), ...tail];
};

/**
 * The source a connection is counted against: an IPv4 address (an IPv4-mapped IPv6 address
 * included), or the /64 an IPv6 address is in. Anything else counts as itself.
 */
export const sourceOf = (address: string | undefined): string => {
  if (address === undefined || address.length === 0) return "unknown";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1] !== undefined) return mapped[1];
  if (isIPv4(address)) return address;
  if (isIPv6(address)) {
    const groups = expandIpv6(address);
    if (groups === undefined) return address.toLowerCase();
    return `${groups
      .slice(0, 4)
      .map((group) => Number.parseInt(group, 16).toString(16))
      .join(":")}::/64`;
  }
  return address;
};

interface SourceState {
  /** Connections from this source not yet logged in. */
  startups: number;
  /** Key lookups left, refilled continuously up to the per-minute budget. */
  lookups: number;
  refilledAt: number;
  /** Whether the refusal for a spent budget was logged since it last had lookups. */
  reported: boolean;
}

/** One connection's standing before login, from the moment it arrives. */
export interface AdmissionTicket {
  readonly source: string;
  /** Spends one key lookup from the source's budget; false: none left, ask nothing. */
  readonly takeKeyLookup: () => boolean;
  /** Records a refused authentication attempt; true: the connection has used all it may. */
  readonly refusedAttempt: () => boolean;
  /** The connection logged in: it stops counting as a startup and its grace timer stops. */
  readonly loggedIn: () => void;
  /** The connection closed, logged in or not. */
  readonly closed: () => void;
}

export type AdmissionDecision =
  | { readonly kind: "admitted"; readonly ticket: AdmissionTicket }
  | {
      readonly kind: "refused";
      readonly reason:
        | "max-startups"
        | "per-source-startups"
        | "lookups-spent"
        | "too-many-sources";
      readonly source: string;
    };

export interface Admission {
  /**
   * Decides on a connection as it arrives. Admitted, `onGraceExpired` runs if it has not logged in
   * within the grace time (the caller drops the connection).
   */
  readonly admit: (
    remoteAddress: string | undefined,
    onGraceExpired: () => void,
  ) => AdmissionDecision;
  /** Connections not yet logged in, overall. */
  readonly startups: () => number;
  /** Forgets sources with nothing open and a full budget. */
  readonly sweep: () => void;
}

export const createAdmission = (
  limits: AdmissionLimits,
  options: {
    readonly now?: () => number;
    readonly setTimer?: (callback: () => void, ms: number) => { readonly cancel: () => void };
    readonly log?: (message: string, details: Record<string, unknown>) => void;
  } = {},
): Admission => {
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      timer.unref();
      return { cancel: () => clearTimeout(timer) };
    });
  const log =
    options.log ??
    ((message: string, details: Record<string, unknown>) => {
      console.warn(message, details);
    });
  const budget = limits.perSourceKeyLookupsPerMinute;
  const perMs = budget / 60_000;
  const sources = new Map<string, SourceState>();
  let startups = 0;

  const refill = (state: SourceState) => {
    const at = now();
    state.lookups = Math.min(budget, state.lookups + (at - state.refilledAt) * perMs);
    state.refilledAt = at;
    if (state.lookups >= 1) state.reported = false;
  };

  const sweep = () => {
    for (const [source, state] of sources) {
      refill(state);
      if (state.startups === 0 && state.lookups >= budget) sources.delete(source);
    }
  };

  const admit = (
    remoteAddress: string | undefined,
    onGraceExpired: () => void,
  ): AdmissionDecision => {
    const source = sourceOf(remoteAddress);
    let state = sources.get(source);
    if (state === undefined) {
      if (sources.size >= MAX_TRACKED_SOURCES) sweep();
      if (sources.size >= MAX_TRACKED_SOURCES) {
        return { kind: "refused", reason: "too-many-sources", source };
      }
      state = { startups: 0, lookups: budget, refilledAt: now(), reported: false };
      sources.set(source, state);
    }
    refill(state);
    if (startups >= limits.maxStartups) {
      return { kind: "refused", reason: "max-startups", source };
    }
    if (state.startups >= limits.perSourceMaxStartups) {
      return { kind: "refused", reason: "per-source-startups", source };
    }
    // A source that spent its lookups waits for them to refill: a connection now could only be
    // refused, and would hold a startup slot while it was.
    if (budget > 0 && state.lookups < 1) {
      return { kind: "refused", reason: "lookups-spent", source };
    }

    const sourceState = state;
    startups += 1;
    sourceState.startups += 1;
    let counted = true;
    let attempts = 0;
    const release = () => {
      if (!counted) return;
      counted = false;
      startups -= 1;
      sourceState.startups -= 1;
      grace.cancel();
    };
    const grace = setTimer(() => {
      if (counted) onGraceExpired();
    }, limits.loginGraceMs);

    const ticket: AdmissionTicket = {
      source,
      takeKeyLookup: () => {
        if (budget === 0) return true;
        refill(sourceState);
        if (sourceState.lookups < 1) {
          if (!sourceState.reported) {
            sourceState.reported = true;
            log("[ssh-gateway] a source spent its key lookups; refusing it until they refill", {
              source,
              perMinute: budget,
            });
          }
          return false;
        }
        sourceState.lookups -= 1;
        return true;
      },
      refusedAttempt: () => {
        attempts += 1;
        return attempts >= limits.maxAuthTries;
      },
      loggedIn: release,
      closed: release,
    };
    return { kind: "admitted", ticket };
  };

  return { admit, startups: () => startups, sweep };
};
