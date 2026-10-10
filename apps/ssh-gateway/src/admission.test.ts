import { describe, expect, it } from "vitest";

import { createAdmission, sourceOf, type AdmissionLimits } from "./admission.js";

const LIMITS: AdmissionLimits = {
  loginGraceMs: 30_000,
  maxAuthTries: 3,
  maxStartups: 4,
  perSourceMaxStartups: 2,
  perSourceKeyLookupsPerMinute: 5,
};

/** An admission on a clock and timers the test moves by hand. */
const harness = (limits: AdmissionLimits = LIMITS) => {
  let clock = 0;
  const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];
  const admission = createAdmission(limits, {
    now: () => clock,
    setTimer: (callback, ms) => {
      const timer = { at: clock + ms, callback, cancelled: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
    log: () => undefined,
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const timer of timers) {
      if (!timer.cancelled && timer.at <= clock) {
        timer.cancelled = true;
        timer.callback();
      }
    }
  };
  const admit = (address: string, onGraceExpired: () => void = () => undefined) => {
    const decision = admission.admit(address, onGraceExpired);
    if (decision.kind !== "admitted") throw new Error(`refused: ${decision.reason}`);
    return decision.ticket;
  };
  return { admission, advance, admit };
};

describe("sourceOf", () => {
  it("counts an IPv4 address as itself, mapped or not", () => {
    expect(sourceOf("203.0.113.7")).toBe("203.0.113.7");
    expect(sourceOf("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("counts an IPv6 address by its /64, so one host cannot be many sources", () => {
    expect(sourceOf("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(sourceOf("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
    expect(sourceOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(sourceOf("::1")).toBe("0:0:0:0::/64");
    expect(sourceOf("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });
});

describe("limits before login", () => {
  it("drops a connection that has not logged in by its grace time, and not one that has", () => {
    const { advance, admit } = harness();
    let idleDropped = false;
    let loggedInDropped = false;
    admit("203.0.113.1", () => {
      idleDropped = true;
    });
    const ticket = admit("203.0.113.2", () => {
      loggedInDropped = true;
    });
    advance(10_000);
    ticket.loggedIn();
    advance(20_001);
    expect(idleDropped).toBe(true);
    expect(loggedInDropped).toBe(false);
  });

  it("caps connections not yet logged in per source, and frees a slot at login or close", () => {
    const { admission, admit } = harness();
    const first = admit("203.0.113.1");
    const second = admit("203.0.113.1");
    expect(admission.admit("203.0.113.1", () => undefined)).toMatchObject({
      kind: "refused",
      reason: "per-source-startups",
    });
    // Another address is not held to the first one's count.
    admit("203.0.113.2");
    first.loggedIn();
    second.closed();
    admit("203.0.113.1");
    admit("203.0.113.1");
  });

  it("caps connections not yet logged in across every source", () => {
    const { admission, admit } = harness();
    for (const address of ["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4"]) {
      admit(address);
    }
    expect(admission.admit("203.0.113.5", () => undefined)).toMatchObject({
      kind: "refused",
      reason: "max-startups",
    });
    expect(admission.startups()).toBe(4);
  });

  it("ends a connection at its last allowed refused attempt", () => {
    const { admit } = harness();
    const ticket = admit("203.0.113.1");
    expect(ticket.refusedAttempt()).toBe(false);
    expect(ticket.refusedAttempt()).toBe(false);
    expect(ticket.refusedAttempt()).toBe(true);
  });

  it("holds each source to its own key lookups: one that spent them leaves another's whole", () => {
    const { admission, advance, admit } = harness();
    const outsider = admit("198.51.100.9");
    let spent = 0;
    while (outsider.takeKeyLookup()) spent += 1;
    expect(spent).toBe(5);
    // Its new connections are refused until the budget refills.
    expect(admission.admit("198.51.100.9", () => undefined)).toMatchObject({
      kind: "refused",
      reason: "lookups-spent",
    });

    const person = admit("203.0.113.1");
    for (let lookup = 0; lookup < 5; lookup += 1) {
      expect(person.takeKeyLookup()).toBe(true);
    }

    // A fifth of a minute refills one lookup at five a minute.
    advance(12_000);
    expect(admission.admit("198.51.100.9", () => undefined).kind).toBe("admitted");
  });

  it("gives back a lookup that found a registered key: only unknown keys cost", () => {
    const { admission, admit } = harness();
    // Far more logins from one address than the budget, each looking its key up once.
    for (let login = 0; login < 20; login += 1) {
      const ticket = admit("203.0.113.1");
      expect(ticket.takeKeyLookup()).toBe(true);
      ticket.refundKeyLookup();
      ticket.loggedIn();
      ticket.closed();
    }
    expect(admission.admit("203.0.113.1", () => undefined).kind).toBe("admitted");
  });

  it("asks nothing of a lookup budget of 0 (off)", () => {
    const { admit } = harness({ ...LIMITS, perSourceKeyLookupsPerMinute: 0 });
    const ticket = admit("203.0.113.1");
    for (let lookup = 0; lookup < 100; lookup += 1) {
      expect(ticket.takeKeyLookup()).toBe(true);
    }
  });
});
