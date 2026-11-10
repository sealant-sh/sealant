/**
 * Known defects on main. A scenario that hits one is an expected failure: it passes only while it
 * fails with that defect's signature, and fails loudly once the defect is fixed. The fix's PR
 * removes the marker.
 *
 * Already fixed, with the harness confirming the flip:
 * - F1, masked permit refusals: #493.
 * - F2, missing relay recover/park routes: #493.
 * - S1 for launches that fail after allocation: #491.
 * - R1, the 30 s sweep winning a launch's exchange: #503.
 * - S3, a launch whose worker died: #494.
 * - S4, a lost create reply losing the launch: #508.
 * - C1, a failed launch's close waiting on the 30 s sweep: #508.
 * - S1 for launches that fail while Boat is `cloning`: #508.
 * - F3, the control bridge and sealantd rejecting each other: gone with the bridge (#515).
 * - S2, an established FINAL leaving the capture drain retained: passes on main 3a0d37ae.
 */
import type { Defect } from "./markers.js";

/**
 * Contracts F3: the control bridge and sealantd disagree about who may connect. The audit found
 * the bridge pins the PID 1 holder while sealantd is its child; the harness also sees sealantd
 * itself reject the bridge ("rejected control connection from unauthorized peer"). Core records
 * only `readiness` / `Error`, so the signature reads the guest evidence the harness attaches.
 */
export const PEER_PID: Defect = {
  id: "F3",
  title: "control bridge and sealantd reject each other's peer identity",
  // The launch itself ended at readiness (its outcome, not a later timeout), and the guest says why.
  failure: /^launch ended \w+ with [^\n]*\\"step\\":\\"readiness\\"/,
  evidence: /unauthorized peer|control-peer-changed/,
  owner: "thread A2 (readiness)",
};

/**
 * Found by this harness on main facc017d (after #491): a failed launch's close issues Boat's
 * DELETE, but records the removal only on a later 30 s sweep. Until then Mend reads `retained`,
 * so the terminal status can arrive after the 60 s the lifecycle promises. Seen both ways.
 */
export const SLOW_CLOSE: Defect = {
  id: "C1",
  title: "failed-launch close waits on the 30 s sweep, so Mend can read retained past 60 s",
  // Only the 60 s promise: the release checks after the scenario still require the close to end.
  failure:
    /^timed out after \d+s waiting for Mend to see a terminal workspace[^\n]*within 60 s; public status retained; runtime [^\n]*"allocation":"deleting"/,
  owner: "thread C (lifecycle)",
  intermittent: true,
};

/**
 * Found by this harness on main 3a0d37ae: a Boat session whose Stop keeps the VM (its FINAL could
 * not drain) is never parked, for two reasons:
 * - a: enrollment needs `workspace_capture_drains.retained_at`, and nothing on the Boat path
 *   writes it: the stop's canonical close returns `retained` and the stop worker only reports
 *   `kept` (`process-workspace-stop.ts`); API stop retains only rows already enrolled, and
 *   `BoatParking.retain` runs only for enrolled roots;
 * - b: with retention recorded (`BOAT_HARNESS_SIMULATE_RETENTION=1`), the Boat FINAL close keeps
 *   renewing its lease on the drain row (`lease_owner` `boat-final-…`), and the guard trigger
 *   refuses to enroll an occupied row; `BoatParking.reconcile` swallows that error.
 * The session waits with its VM forever.
 */
export const NEVER_PARKED: Defect = {
  id: "P1",
  title: "a retained Boat session is never enrolled for parking (nothing records retention)",
  failure: /^step (retention: parking never starts|parked: parking never enrolls): /,
  owner: "thread C (lifecycle) or D (parking)",
};

/** Whichever of several defects a timing-dependent scenario reaches first. */
export const firstOf = (...defects: readonly Defect[]): Defect => ({
  id: defects.map((defect) => defect.id).join(" or "),
  title: defects.map((defect) => defect.title).join("; or "),
  owner: [...new Set(defects.map((defect) => defect.owner))].join(", "),
  failure: /$^/,
  anyOf: defects,
});

/**
 * Which scenario is an expected failure on main, and why. `undefined` means it must pass.
 *
 * F3 was the Python guest's control bridge; the agent (sealant#512, #515) has no bridge, so the
 * scenarios it marked must pass now. `PEER_PID` stays exported for the record only.
 */
export const DEFECTS = {
  happyPath: undefined,
  parking: NEVER_PARKED,
  faults: {
    "bind slower than one sweep period": undefined,
    "create reply lost": undefined,
    "provisioning never finishes": undefined,
    "bind exits 1": undefined,
    "bind times out": undefined,
    "bind start reply lost": undefined,
    "agent stopped after bind": undefined,
    "agent answers 400 on launch": undefined,
    "agent answers 409 on launch": undefined,
    "agent answers 503 on launch": undefined,
    "gateway dnsmasq starts 8 s late": undefined,
    "gateway crashes before the guest joins": undefined,
    "UDP to the gateway blocked": undefined,
    "db stopped by a person": undefined,
    "worker killed after bind": undefined,
    "Stop after the launch": undefined,
    "deletion stuck in processing": undefined,
  },
} as const satisfies {
  readonly happyPath: Defect | undefined;
  readonly parking: Defect | undefined;
  readonly faults: Readonly<Record<string, Defect | undefined>>;
};
