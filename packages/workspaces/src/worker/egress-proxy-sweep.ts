/**
 * Keeps every live egress proxy on this host current with storage (workspace isolation
 * architecture §7.3, §9.2), every `EGRESS_PROXY_HEARTBEAT_MS`:
 *
 * - renews its disconnected lease with the workspace's stored revocation watermark (a proxy that
 *   hears nothing for 120 s closes every brokered and restricted stream on its own);
 * - pushes the stored policy again when the proxy asks for a resync (it saw a newer watermark),
 *   or when what it last confirmed is behind storage (an "Apply updated policy" or a revocation
 *   the API could not deliver);
 * - a proxy that cannot be reached, or does not confirm closing what a policy revokes, is killed
 *   (confirmed not running), so nothing it may still pass outlives a revocation it never
 *   confirmed, then started again with the same executor CA and the full stored policy, its
 *   tombstones included, but only while its workspace container still runs. A proxy that crashed
 *   comes back the same way. One that answers `watermark_rollback` holds more revocations than
 *   storage and is left as it is; one that lost its policy (`not_initialized`) is pushed.
 *
 * Only proxies whose run is the workspace's current one, with an executor that may be running and
 * no stop under way (`listLiveProxies`). A parked proxy (a retained executor) stays parked.
 */
import type { CredentialCipherService } from "@sealant/credentials";
import type { LiveWorkspaceEgressProxy, WorkspaceEgressRepoService } from "@sealant/db";
import { Effect, Result } from "effect";

import type { EgressProxyOrchestrator } from "../runtime/egress-proxy-orchestrator.js";
import { storedProxyPolicyDocument } from "../runtime/egress-proxy-store.js";
import { ProxyAdminRefusedError } from "../runtime/proxy-admin-client.js";

/** A third of the proxy's 120 s lease: two heartbeats can be lost before it fails closed. */
export const EGRESS_PROXY_HEARTBEAT_MS = 30_000;

export type EgressProxySweepOutcome =
  | "renewed"
  | "pushed"
  | "restarted"
  /** Killed and left down: its workspace is no longer running. */
  | "killed"
  | "launching"
  | "failed";

const failureText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The proxy holds a watermark past storage's: it refuses more than storage says, never less. */
const isRollback = (error: unknown): boolean =>
  error instanceof ProxyAdminRefusedError && error.code === "watermark_rollback";
/** The proxy started again on its own and holds no policy: push it, nothing to kill. */
const isUninitialized = (error: unknown): boolean =>
  error instanceof ProxyAdminRefusedError && error.code === "not_initialized";

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

  /**
   * Push the whole stored policy, with the host measured again first (a bridge made since the
   * launch is refused too), and record what the proxy confirmed. Fails with the proxy's own error.
   */
  const push = Effect.gen(function* () {
    const measured = proxy.network;
    if (measured === null) return;
    const networks = yield* Effect.tryPromise(() => proxies.prepareNetworks(workspaceContainer));
    const host = yield* Effect.tryPromise(() =>
      proxies.hostFacts({
        networks,
        operatorAllowedPrivateCidrs: measured.operatorAllowedPrivateCidrs,
        hostPublicIps: measured.hostPublicIps,
        resourceHosts: measured.resourceHosts ?? [],
      }),
    );
    const network = { ...host, proxyIp: measured.proxyIp };
    yield* repo.recordProxyNetwork(proxy.runId, network);
    const document = yield* storedProxyPolicyDocument({
      cipher,
      proxy: { ...proxy, network },
      policy,
      revocations: yield* repo.listRevocations(proxy.workspaceId),
    });
    if (document === undefined) return;
    const applied = yield* Effect.tryPromise({
      try: () => proxies.pushPolicy(workspaceContainer, document),
      catch: (error) => error,
    });
    yield* repo.confirmProxy({
      runId: proxy.runId,
      policyHash: applied.policyHash,
      revocationWatermark: applied.revocationWatermark,
      // A workspace with no stored policy (a standard host-vm run) is at revision 0: confirming
      // it keeps the next tick from pushing the same policy again.
      policyRevision: policy?.policyRevision ?? 0,
    });
  });

  /**
   * Kill the proxy and confirm it is down: whatever it revoked unconfirmed, or still passes after
   * its admin socket stopped answering, ends here. Started again (same CA, whole stored policy)
   * only while its workspace still runs; a workspace stopping or stopped keeps it down.
   */
  const restart = (why: string) =>
    Effect.gen(function* () {
      yield* Effect.logWarning(
        `Egress proxy ${proxy.proxyContainer} ${why}; it is killed and, while its workspace runs, started again with the stored policy.`,
      );
      yield* Effect.tryPromise(() => proxies.kill(workspaceContainer));
      const workspace = yield* Effect.tryPromise(() => proxies.containerState(workspaceContainer));
      if (workspace?.running !== true) return "killed" as const;
      const networks = yield* Effect.tryPromise(() => proxies.prepareNetworks(workspaceContainer));
      yield* Effect.tryPromise(() => proxies.startProxy({ workspaceContainer, networks }));
      yield* push;
      return "restarted" as const;
    });

  /** Push, and restart a proxy the push could not reach or that did not confirm its closes. */
  const pushOrRestart = push.pipe(
    Effect.as("pushed" as const),
    Effect.catch((error) =>
      isRollback(error)
        ? Effect.logError(
            `Egress proxy ${proxy.proxyContainer} holds a revocation watermark past storage's ${String(watermark)}; it refuses more than storage says and is left as it is.`,
          ).pipe(Effect.as("failed" as const))
        : restart(`did not take the stored policy (${failureText(error)})`),
    ),
  );

  return Effect.gen(function* () {
    // Its launch has not measured the host yet: the launch pushes its first policy itself.
    if (proxy.network === null) return "launching" as const;
    const renewed = yield* Effect.tryPromise({
      try: () => proxies.heartbeat(workspaceContainer, watermark),
      catch: (error) => error,
    }).pipe(Effect.result);
    if (Result.isSuccess(renewed)) {
      const behind =
        renewed.success.resyncRequired ||
        (proxy.confirmedRevocationWatermark ?? -1) < watermark ||
        (proxy.confirmedPolicyRevision ?? -1) < (policy?.policyRevision ?? 0);
      if (!behind) return "renewed" as const;
      return yield* pushOrRestart;
    }
    if (isRollback(renewed.failure) || isUninitialized(renewed.failure))
      return yield* pushOrRestart;
    return yield* restart(`did not answer its heartbeat (${failureText(renewed.failure)})`);
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
}): Effect.Effect<Readonly<Record<EgressProxySweepOutcome, number>>> =>
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
      killed: 0,
      launching: 0,
      failed: 0,
    };
    for (const outcome of outcomes) counts[outcome] += 1;
    return counts;
  });
