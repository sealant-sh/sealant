/**
 * Whether this install can launch a Boat workspace, and in which accounts: the one answer the API
 * and the worker share. The worker says what it does (`boat_launch_reports`, renewed every minute)
 * and the API reads the reports observed recently, so a create the worker could not serve is
 * refused at create, with a sentence, instead of accepted and left to fail.
 */
import type { BoatLaunchReportRecord } from "@sealant/db";

/** How recent a worker's report must be for the API to count it: five renewals. */
export const BOAT_LAUNCH_REPORT_FRESH_MS = 5 * 60_000;

/** What the workers that reported recently do for Boat, together. */
export interface BoatLaunchSupport {
  /** Some worker launches Boat workspaces. */
  readonly launches: boolean;
  /** A launching worker has the install's own key: a workspace may name no stored account. */
  readonly defaultAccount: boolean;
  /** A launching worker has the resource gateway: a Boat workspace may reach project resources. */
  readonly resourceGateway: boolean;
  /** The newest report counted; absent when no worker reported recently. */
  readonly observedAt: Date | undefined;
}

/** The answer from the reports observed at or after `now - BOAT_LAUNCH_REPORT_FRESH_MS`. */
export const boatLaunchSupportOf = (
  reports: readonly BoatLaunchReportRecord[],
): BoatLaunchSupport => {
  const launching = reports.filter((report) => report.launches);
  const newest = reports.reduce<Date | undefined>(
    (latest, report) =>
      latest === undefined || report.observedAt > latest ? report.observedAt : latest,
    undefined,
  );
  return {
    launches: launching.length > 0,
    defaultAccount: launching.some((report) => report.defaultAccount),
    resourceGateway: launching.some((report) => report.resourceGateway),
    observedAt: newest,
  };
};

/**
 * Why a Boat workspace cannot be served here, as a sentence that says who can change it, or
 * `undefined` when it can. `namesAccount`: the spec names a stored Boat account. `resources`: the
 * spec's `runtime.resources` (anything but `"none"` reaches the project's resources through the
 * gateway).
 */
export const boatLaunchRefusal = (
  support: BoatLaunchSupport,
  spec: { readonly namesAccount: boolean; readonly resources: string | undefined },
): string | undefined => {
  if (!support.launches)
    return support.observedAt === undefined
      ? "No worker of this install has reported launching Boat workspaces in the last five minutes, so a Boat workspace cannot be started. The install's operator can turn Boat on for the worker (SEALANT_BOAT_STATE_DIRECTORY with SEALANT_CREDENTIALS_KEY) or start the worker."
      : "This install's worker runs without Boat (SEALANT_BOAT_STATE_DIRECTORY is not set), so a Boat workspace cannot be started. The install's operator can turn it on.";
  if (!spec.namesAccount && !support.defaultAccount)
    return "This install has no Boat key of its own, or sealant has not yet seen which Boat wallet that key bills (its check needs the key's account.read permission, or SEALANT_BOAT_ORGANIZATION set), so a Boat workspace must name a stored Boat account (spec.runtime.boatAccountId). Name one, or ask the install's operator to set SEALANT_BOAT_API_KEY to a key that has account.read, or set SEALANT_BOAT_ORGANIZATION.";
  if (spec.resources !== "none" && !support.resourceGateway)
    return "This install's Boat workspaces cannot reach project resources: its worker has no resource gateway. Create the workspace with runtime.resources: \"none\", or ask the install's operator to configure the gateway (SEALANT_BOAT_GATEWAY_HOST_ID).";
  return undefined;
};
