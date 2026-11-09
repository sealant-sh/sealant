/**
 * Known defects on main, from the 2026-11-09 Boat audits. A scenario that hits one is an expected
 * failure: it passes only while it fails with this signature, and fails loudly once the defect is
 * fixed, so each fix flips exactly one marker. Remove the marker in the fix's PR.
 */
import type { Defect } from "./scenario.js";

/** Contracts F1: the receiver's `__main__` Refusal is not the imported one, so policy refusals become 400. */
export const PERMIT_MASKING: Defect = {
  id: "F1",
  title: "receiver policy refusals masked as 400 invalid-request",
  signature: /receiver-permit[\s\S]*400|400[\s\S]*invalid-request/,
  owner: "thread A (contracts)",
};

/** Contracts F2: the relay forwards neither /sealant/bootstrap/recover nor /park. */
export const RELAY_ROUTES: Defect = {
  id: "F2",
  title: "relay has no recover/park routes (404 before the receiver)",
  signature: /\/sealant\/bootstrap\/(recover|park) 404/,
  owner: "thread A (contracts)",
};

/**
 * Contracts F3: the control bridge and sealantd disagree about who may connect. The audit found
 * the bridge pins the PID 1 holder while sealantd is its child; the harness also sees sealantd
 * itself reject the bridge ("rejected control connection from unauthorized peer"). Core records
 * only `readiness` / `Error`, so the signature reads the guest evidence the harness attaches.
 */
export const PEER_PID: Defect = {
  id: "F3",
  title: "control bridge and sealantd reject each other's peer identity",
  signature: /unauthorized peer|control-peer-changed/,
  owner: "thread A (contracts)",
};

/** Lifecycle S1: positive removal loses to the historical launch-retained error. */
export const DELETED_VM_KEPT: Defect = {
  id: "S1",
  title: "removed Boat runtime still reads retained (deleted VM 'kept')",
  signature: /public status retained|terminal workspace[\s\S]*retained/,
  owner: "thread C (lifecycle)",
};

/**
 * Lifecycle S4: create is persisted `issued` before send, and a lost reply fails the launch at
 * once instead of adopting the VM through discovery. (The sweep later finds and deletes that VM,
 * so on facc017d nothing leaks; the launch itself is still lost.)
 */
export const ISSUED_ALLOCATION: Defect = {
  id: "S4",
  title: "a lost create reply fails the launch instead of adopting the VM",
  signature: /"allocation":"issued"/,
  owner: "thread C (lifecycle)",
};

/** Lifecycle S3: a launch whose worker dies has no successor; Boat is excluded from stranded-launch adoption. */
export const LOST_LAUNCH: Defect = {
  id: "S3",
  title: "a launch whose worker died is never adopted or closed",
  signature: /waiting for a ready or terminal launch/,
  owner: "thread C (lifecycle)",
};

/** Lifecycle S2: established FINAL closes resources but never ends capture retention. */
export const STUCK_DRAINS: Defect = {
  id: "S2",
  title: "established FINAL leaves the capture drain retained (stuck stopping)",
  signature: /"retained":true|drain (kept|retained)|capture drain not terminal/,
  owner: "thread C (lifecycle)",
};

/**
 * Found by this harness, not in the audits: the worker's 30 s Boat sweep drives bound allocations
 * through `execution.exchange` (and resources through the host lock) while their launch is still
 * running. When the sweep wins the CAS, the launch fails with `stale-transition` (or the tunnel
 * store's try-lock refuses with `operation-held`) instead of adopting the result.
 */
export const SWEEP_RACE: Defect = {
  id: "R1",
  title: "launch fails when the 30 s Boat sweep wins its exchange (stale-transition)",
  signature: /stale-transition|lost the exchange race/,
  owner: "unassigned (found by the harness)",
};

/**
 * Found by this harness on main facc017d (after #491): a failed launch's close issues Boat's
 * DELETE, but records the removal only on a later 30 s sweep. Until then Mend reads `retained`,
 * so the terminal status can arrive after the 60 s the lifecycle promises. Seen both ways.
 */
export const SLOW_CLOSE: Defect = {
  id: "C1",
  title: "failed-launch close waits on the 30 s sweep, so Mend can read retained past 60 s",
  signature: /within 60 s; public status retained;[^\n]*"allocation":"deleting"/,
  owner: "unassigned (found by the harness)",
  intermittent: true,
};

/** Whichever of several defects a timing-dependent scenario reaches first. */
export const firstOf = (...defects: readonly Defect[]): Defect => ({
  id: defects.map((defect) => defect.id).join(" or "),
  title: defects.map((defect) => defect.title).join("; or "),
  signature: new RegExp(defects.map((defect) => defect.signature.source).join("|")),
  owner: [...new Set(defects.map((defect) => defect.owner))].join(", "),
});

/** Which scenario is an expected failure on main, and why. `undefined` means it must pass. */
export const DEFECTS = {
  happyPath: firstOf(SWEEP_RACE, PEER_PID),
  faults: {
    "bind slower than one sweep period": SWEEP_RACE,
    "create reply lost": ISSUED_ALLOCATION,
    "provisioning never finishes": DELETED_VM_KEPT,
    "bind exits 1": SLOW_CLOSE,
    "bind times out": SLOW_CLOSE,
    "bind start reply lost": SLOW_CLOSE,
    "receiver socket absent behind a live relay": SLOW_CLOSE,
    "receiver answers 400 on permit": SLOW_CLOSE,
    "receiver answers 409 on permit": SLOW_CLOSE,
    "receiver answers 503 on permit": SLOW_CLOSE,
    "gateway dnsmasq starts 8 s late": firstOf(SWEEP_RACE, PEER_PID),
    "gateway crashes before the guest joins": SLOW_CLOSE,
    "UDP to the gateway blocked": SLOW_CLOSE,
    "db stopped by a person": firstOf(SWEEP_RACE, PEER_PID),
    "worker killed after bind": firstOf(LOST_LAUNCH, DELETED_VM_KEPT),
    "Stop after the launch": firstOf(PEER_PID, STUCK_DRAINS),
    "deletion stuck in processing": SLOW_CLOSE,
  },
} as const satisfies {
  readonly happyPath: Defect | undefined;
  readonly faults: Readonly<Record<string, Defect | undefined>>;
};
