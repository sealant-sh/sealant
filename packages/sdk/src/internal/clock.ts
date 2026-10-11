/**
 * Milliseconds on a clock that only moves forward, for every bound and wait the SDK keeps. The
 * wall clock can step: a VM resynced after its host slept (OrbStack, Docker Desktop) jumped 72
 * minutes mid-build, and `ready()` gave up on a build 8 minutes in as stalled for 80. Timestamps
 * that are shown or sent (`occurredAt`, a `Retry-After` date) stay on the wall clock.
 */
export const elapsed = (): number => performance.now();
