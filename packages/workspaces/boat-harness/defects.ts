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
  // Readiness failed (the runtime row says so) and the guest says why.
  failure: /\\"step\\":\\"readiness\\"/,
  evidence: /unauthorized peer|control-peer-changed/,
  owner: "thread A2 (readiness)",
};

/** F3 on the happy path: named at its own `ready` step, so a later step's failure is real. */
const PEER_PID_AT_READY: Defect = {
  ...PEER_PID,
  failure: /^step ready: launch ended \w+ with [^\n]*\\"step\\":\\"readiness\\"/,
};

/**
 * Lifecycle S1, the part #491 left: a launch that fails while Boat still reports `cloning`
 * (`observe-sandbox` / `allocation-pending`) is deleted correctly, but its public status stays
 * `retained`.
 */
export const DELETED_VM_KEPT: Defect = {
  id: "S1",
  title: "a launch failed in `cloning` is deleted but still reads retained",
  // Mend still reads retained although Core removed the runtime and deleted the VM.
  failure:
    /terminal workspace[^\n]*; public status retained; runtime [^\n]*"removed":true[^\n]*"allocation":"deleted"/,
  owner: "thread C (lifecycle)",
};

/**
 * Lifecycle S4: create is persisted `issued` before send, and a lost reply fails the launch at
 * once instead of adopting the VM through discovery. The sweep later finds and deletes that VM,
 * so nothing leaks; the launch itself is lost.
 */
export const ISSUED_ALLOCATION: Defect = {
  id: "S4",
  title: "a lost create reply loses the launch (no leak)",
  // The launch ends at `create` with the allocation still `issued`.
  failure: /^launch ended \w+ with [^\n]*\\"step\\":\\"create\\"[^\n]*"allocation":"issued"/,
  owner: "thread C (lifecycle)",
};

/** Lifecycle S2: established FINAL closes resources but never ends capture retention. */
export const STUCK_DRAINS: Defect = {
  id: "S2",
  title: "established FINAL leaves the capture drain retained (stuck stopping)",
  // After Stop, Mend still reads retained while the capture drain stays kept.
  failure: /public status retained; runtime [^\n]*"drain":"kept"/,
  owner: "thread C (lifecycle)",
};

/**
 * Found by this harness on main facc017d (after #491): a failed launch's close issues Boat's
 * DELETE, but records the removal only on a later 30 s sweep. Until then Mend reads `retained`,
 * so the terminal status can arrive after the 60 s the lifecycle promises. Seen both ways.
 */
export const SLOW_CLOSE: Defect = {
  id: "C1",
  title: "failed-launch close waits on the 30 s sweep, so Mend can read retained past 60 s",
  failure: /within 60 s; public status retained; runtime [^\n]*"allocation":"deleting"/,
  owner: "thread C (lifecycle)",
  intermittent: true,
};

/** Whichever of several defects a timing-dependent scenario reaches first. */
export const firstOf = (...defects: readonly Defect[]): Defect => ({
  id: defects.map((defect) => defect.id).join(" or "),
  title: defects.map((defect) => defect.title).join("; or "),
  owner: [...new Set(defects.map((defect) => defect.owner))].join(", "),
  failure: /$^/,
  anyOf: defects,
});

/** Which scenario is an expected failure on main, and why. `undefined` means it must pass. */
export const DEFECTS = {
  happyPath: PEER_PID_AT_READY,
  faults: {
    "bind slower than one sweep period": PEER_PID,
    "create reply lost": ISSUED_ALLOCATION,
    "provisioning never finishes": firstOf(DELETED_VM_KEPT, SLOW_CLOSE),
    "bind exits 1": SLOW_CLOSE,
    "bind times out": SLOW_CLOSE,
    "bind start reply lost": SLOW_CLOSE,
    "receiver socket absent behind a live relay": SLOW_CLOSE,
    "receiver answers 400 on permit": SLOW_CLOSE,
    "receiver answers 409 on permit": SLOW_CLOSE,
    "receiver answers 503 on permit": SLOW_CLOSE,
    "gateway dnsmasq starts 8 s late": PEER_PID,
    "gateway crashes before the guest joins": SLOW_CLOSE,
    "UDP to the gateway blocked": SLOW_CLOSE,
    "db stopped by a person": PEER_PID,
    "worker killed after bind": undefined,
    "Stop after the launch": firstOf(PEER_PID, STUCK_DRAINS),
    "deletion stuck in processing": SLOW_CLOSE,
  },
} as const satisfies {
  readonly happyPath: Defect | undefined;
  readonly faults: Readonly<Record<string, Defect | undefined>>;
};
