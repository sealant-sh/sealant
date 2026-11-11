/** How often a run that stays as it is, with nothing for anyone to do this pass, is reported. */
export const BOAT_KEPT_REPORT_MS = 60 * 60_000;
/** Past this many remembered runs, the ones last reported more than a period ago are forgotten. */
const BOAT_KEPT_REMEMBERED = 1_024;

/**
 * Whether to report a run that stays as it is: when it is first asked about, then once a period
 * for as long as it is asked about. The sweeps visit such a run on every tick, and a line a tick
 * buries the ones an operator can act on. This process only: a restarted worker reports each once
 * more.
 */
export const boatKeptReports = (periodMs: number = BOAT_KEPT_REPORT_MS) => {
  const reported = new Map<string, number>();
  return (runId: string, now: number): boolean => {
    const last = reported.get(runId);
    if (last !== undefined && now - last < periodMs) return false;
    if (reported.size >= BOAT_KEPT_REMEMBERED)
      for (const [id, at] of reported) if (now - at >= periodMs) reported.delete(id);
    reported.set(runId, now);
    return true;
  };
};
