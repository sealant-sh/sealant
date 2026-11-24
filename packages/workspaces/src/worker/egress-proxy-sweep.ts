/**
 * Keeps every live egress proxy on this host current with storage (workspace isolation
 * architecture §7.3, §9.2), every `EGRESS_PROXY_HEARTBEAT_MS`:
 *
 * - renews its disconnected lease with the workspace's stored revocation watermark (a proxy that
 *   hears nothing for 120 s closes every brokered and restricted stream on its own);
 * - pushes the stored policy again when the proxy asks for a resync (it saw a newer watermark),
 *   or when what it last confirmed is behind storage (an "Apply updated policy" or a revocation
 *   the API could not deliver);
 * - a proxy that cannot be reached is killed (confirmed not running), so nothing it may still
 *   pass outlives a revocation it never confirmed, then started again with the same executor CA
 *   and the full stored policy, its tombstones included. A proxy that crashed comes back the same
 *   way.
 *
 * Only proxies whose run is the workspace's current one, with an executor that may be running
 * (`listLiveProxies`). A parked proxy (a retained executor) stays parked.
 */
import type { CredentialCipherService } from "@sealant/credentials";
import type { LiveWorkspaceEgressProxy, WorkspaceEgressRepoService } from "@sealant/db";
import { Effect } from "effect";

import type { EgressProxyOrchestrator } from "../runtime/egress-proxy-orchestrator.js";
import { egressPolicyHash } from "../runtime/egress-proxy-policy.js";
import { storedProxyPolicyDocument } from "../runtime/egress-proxy-store.js";

/** A third of the proxy's 120 s lease: two heartbeats can be lost before it fails closed. */
export const EGRESS_PROXY_HEARTBEAT_MS = 30_000;

export type EgressProxySweepOutcome = "renewed" | "pushed" | "restarted" | "launching" | "failed";

const failureText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** One proxy's pass. Never throws: a failure is logged and counted, and the next tick retries. */
export const sweepEgressProxy = (input: {
  readonly live: LiveWorkspaceEgressProxy;
  readonly repo: WorkspaceEgressRepoService;
  readonly cipher: CredentialCipherService;
  readonly proxies: EgressProxyOrchestrator;
}): Effect.Effect<EgressProxySweepOutcome> => {
  const { live, repo, cipher, proxies } = input;
  const { proxy, policy } = live;
  const workspaceContainer = proxy.proxyContainer.replace(/-proxy$/, "");
  const watermark = policy?.revocationWatermark ?? 0;
  const push = Effect.gen(function* () {
    const document = yield* storedProxyPolicyDocument({
      cipher,
      proxy,
      policy,
      revocations: yield* repo.listRevocations(proxy.workspaceId),
    });
    if (document === undefined) return false;
    const applied = yield* Effect.tryPromise(() =>
      proxies.pushPolicy(workspaceContainer, document),
    );
    yield* repo.confirmProxy({
      runId: proxy.runId,
      policyHash: applied.policyHash,
      revocationWatermark: applied.revocationWatermark,
    });
    return true;
  });

  return Effect.gen(function* () {
    // Its launch has not measured the host yet: the launch pushes its first policy itself.
    if (proxy.network === null) return "launching" as const;
    const renewed = yield* Effect.tryPromise(() =>
      proxies.heartbeat(workspaceContainer, watermark),
    ).pipe(Effect.result);
    if (renewed._tag === "Success") {
      const behind =
        renewed.success.resyncRequired ||
        (proxy.confirmedRevocationWatermark ?? -1) < watermark ||
        proxy.confirmedPolicyHash !==
          egressPolicyHash(policy?.networkPolicy ?? undefined, policy?.brokeredSecrets ?? []);
      if (!behind) return "renewed" as const;
      yield* push;
      return "pushed" as const;
    }
    yield* Effect.logWarning(
      `Egress proxy ${proxy.proxyContainer} did not answer its heartbeat (${failureText(renewed.failure)}); it is killed and started again with the stored policy.`,
    );
    // Killed first and confirmed not running: whatever it revoked unconfirmed, or still passes
    // after its admin socket stopped answering, ends here.
    yield* Effect.tryPromise(() => proxies.kill(workspaceContainer));
    const networks = yield* Effect.tryPromise(() => proxies.prepareNetworks(workspaceContainer));
    yield* Effect.tryPromise(() => proxies.startProxy({ workspaceContainer, networks }));
    yield* push;
    return "restarted" as const;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError(
        `Egress proxy ${proxy.proxyContainer} could not be kept current.`,
        cause,
      ).pipe(Effect.as("failed" as const)),
    ),
  );
};

/** One tick over every live proxy, a few at a time (each is a handful of socket and Docker calls). */
export const sweepEgressProxies = (input: {
  readonly repo: WorkspaceEgressRepoService;
  readonly cipher: CredentialCipherService;
  readonly proxies: EgressProxyOrchestrator;
}): Effect.Effect<Readonly<Record<EgressProxySweepOutcome, number>>, never> =>
  Effect.gen(function* () {
    const live = yield* input.repo
      .listLiveProxies()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Listing the live egress proxies failed.", cause).pipe(Effect.as([])),
        ),
      );
    const outcomes = yield* Effect.forEach(
      live,
      (each) => sweepEgressProxy({ ...input, live: each }),
      // Bounded: one tick never opens more than this many proxy sockets and Docker calls at once.
      { concurrency: 4 },
    );
    const counts: Record<EgressProxySweepOutcome, number> = {
      renewed: 0,
      pushed: 0,
      restarted: 0,
      launching: 0,
      failed: 0,
    };
    for (const outcome of outcomes) counts[outcome] += 1;
    return counts;
  });
