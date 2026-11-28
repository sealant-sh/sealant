import { BoatRunRepo, WorkspaceCaptureDrainRepo, WorkspaceRuntimeInstanceRepo } from "@sealant/db";
import { parseWorkspaceBlueprint, type NativePublication } from "@sealant/validators";
import { Effect, Layer, ManagedRuntime, Redacted, Tracer } from "effect";
import { describe, expect, it } from "vitest";

import { BoatReadiness } from "../../worker/boat-readiness.js";
import { daemonSentryConfigFromEnv } from "../daemon-telemetry.js";
import type { RuntimeLaunch } from "../runtime-adapter.js";
import {
  BoatAccountRouterAdapter,
  type BoatAccountStack,
  type BoatAccountStacks,
} from "./account-router.js";
import { BoatRuntimeAdapter, type BoatAdapterServices } from "./adapter.js";
import { BoatExecution } from "./execution.js";
import { BoatRemoval } from "./removal.js";
import { BoatVm } from "./vm.js";

const DSN = "https://k3y@sentry.example.com/10";
const HASH = "a".repeat(64);
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const PUB_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const BUILD_ID = "44444444-4444-4444-8444-444444444444";

const runtimeIdentity = {
  source: `ghcr.io/sealant-sh/sealantd-next:0.21.0-next.223@sha256:${HASH}`,
  platform: "linux/amd64" as const,
  manifest: HASH,
  sealantd: HASH,
  sealantctl: HASH,
};

const publication: NativePublication = {
  kind: "boat-native",
  publicationId: PUB_ID,
  snapshot: {
    kind: "boat-saved-snapshot",
    owner: OWNER_ID,
    build: BUILD_ID,
    recipeHash: HASH,
    receiptHash: HASH,
    runtime: runtimeIdentity,
    identity: {
      name: "snap-1" as NativePublication["snapshot"]["identity"]["name"],
      sourceSandboxId:
        "bx_23456789" as NativePublication["snapshot"]["identity"]["sourceSandboxId"],
      createdAt: "2026-11-28T00:00:00.000Z",
    },
  },
  evidence: {
    imageProbe: {
      version: 1,
      tools: {
        sudo: true,
        sudoSetuid: true,
        useradd: true,
        groupadd: true,
        setfacl: true,
        getfacl: true,
        setpriv: true,
      },
      sudoersMend: true,
      sudoersIncludesDir: true,
      noNewPrivileges: false,
      passwdWritable: true,
      mendGroup: "present",
      reservedIdsInUse: [],
      personEnv: true,
      sharedDirs: [],
      sealantd: null,
    },
    receiptHash: HASH,
    receipt: "ok",
    runtime: runtimeIdentity,
    assetsHash: HASH,
    recipeHash: HASH,
    daemonRecovery: "supported",
    executorRecovery: "unverified",
  },
};

const blueprint = parseWorkspaceBlueprint({
  harness: { id: "claude-code" },
  target: {
    os: { family: "ubuntu", mode: "require" },
    runtime: { family: "boat", mode: "require" },
  },
  sources: {
    workspace: {
      kind: "capture",
      endpoint: "https://mend.example.com/session/s1",
      worktreeId: "wt_1",
      harnessHome: "/workspace/harness-home",
    },
  },
  runtime: { resources: "none" },
});

const sampleLaunch = (): RuntimeLaunch<NativePublication> => ({
  runId: RUN_ID,
  workspaceId: "ws_1",
  principalId: "user_1",
  blueprint,
  publication,
  admissionPins: {
    credentialVersions: [],
    dotfiles: [],
  },
});

const stubStacks = (adapter: BoatRuntimeAdapter): BoatAccountStacks => {
  const stack: BoatAccountStack = {
    accountId: null,
    deploymentId: "dep_1",
    adapter,
    control: undefined,
    catalog: async () => undefined,
  };
  return {
    // Resolves asynchronously on a later tick: callingFiberTraceCarrier() would be undefined after this await.
    launching: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return stack;
    },
    ofRun: async () => stack,
    ofSandbox: async () => stack,
    ofDeployment: async () => stack,
    fallback: stack,
  };
};

describe("Boat daemon telemetry propagation", () => {
  const daemonTelemetry = daemonSentryConfigFromEnv({
    SEALANTD_SENTRY_DSN: DSN,
    SEALANTD_SENTRY_ENVIRONMENT: "check-vm",
    SEALANTD_SENTRY_RELEASE: "sealantd@0.21.0-next.223",
  });

  it("captures the launching fiber trace and daemon Sentry config before BoatAccountRouterAdapter awaits account lookup", async () => {
    const received: Array<RuntimeLaunch<NativePublication>> = [];
    const inner = {
      launch: async (launch: RuntimeLaunch<NativePublication>) => {
        received.push(launch);
        return {
          adapter: "boat" as const,
          resourceId: "bx_1",
          reference: launch.runId ?? "run_1",
          status: "ready" as const,
        };
      },
    } as unknown as BoatRuntimeAdapter;

    const router = new BoatAccountRouterAdapter({
      stacks: stubStacks(inner),
      resourceGateway: false,
      ...(daemonTelemetry === undefined ? {} : { daemonTelemetry }),
    });

    const exporting = Effect.map(Effect.tracer, (tracer) => Tracer.make({ ...tracer }));
    const span = await Effect.runPromise(
      Effect.flatMap(exporting, (tracer) =>
        Effect.gen(function* () {
          const current = yield* Effect.currentSpan;
          yield* Effect.promise(() => router.launch(sampleLaunch()));
          return current;
        }).pipe(Effect.withSpan("sealant.workspace.launch"), Effect.withTracer(tracer)),
      ),
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.telemetry).toEqual({
      traceparent: `00-${span.traceId}-${span.spanId}-01`,
      sentryDsn: DSN,
      environment: "check-vm",
      release: "sealantd@0.21.0-next.223",
    });
  });

  it("writes SEALANT_TRACEPARENT and SEALANT_SENTRY_* into Boat bootEnv when daemonTelemetry is configured", async () => {
    let pushedBootEnv: Record<string, string> | undefined;
    const servicesLayer = Layer.mergeAll(
      Layer.succeed(WorkspaceRuntimeInstanceRepo, {
        getRuntimeInstanceByRunId: () =>
          Effect.succeed({
            adapter: "boat",
            publicationId: publication.publicationId,
            stopReason: null,
            imageScope: { kind: "owner", ownerUserId: "user_1" },
          }),
      } as unknown as WorkspaceRuntimeInstanceRepo["Service"]),
      Layer.succeed(BoatVm, {
        prepare: () =>
          Effect.succeed({
            runId: RUN_ID,
            sandboxId: "bx_23456789",
            deploymentId: "dep_1",
            accountId: null,
          }),
      } as unknown as BoatVm["Service"]),
      Layer.succeed(BoatReadiness, {
        launch: (
          _target: unknown,
          material: Redacted.Redacted<{ readonly bootEnv: Record<string, string> }>,
        ) => {
          pushedBootEnv = Redacted.value(material).bootEnv;
          return Effect.void;
        },
      } as unknown as BoatReadiness["Service"]),
      Layer.succeed(BoatExecution, {
        control: () =>
          Effect.succeed(
            Redacted.make({
              kind: "websocket" as const,
              url: "wss://boat.example/control",
              token: "tok",
            }),
          ),
      } as unknown as BoatExecution["Service"]),
      Layer.succeed(BoatRemoval, {} as unknown as BoatRemoval["Service"]),
      Layer.succeed(BoatRunRepo, {} as unknown as BoatRunRepo["Service"]),
      Layer.succeed(
        WorkspaceCaptureDrainRepo,
        {} as unknown as WorkspaceCaptureDrainRepo["Service"],
      ),
    ) as unknown as Layer.Layer<BoatAdapterServices>;

    const runtime = ManagedRuntime.make(servicesLayer);
    try {
      const adapter = new BoatRuntimeAdapter({
        deploymentId: "dep_1",
        runtime,
        resourceGateway: false,
        ...(daemonTelemetry === undefined ? {} : { daemonTelemetry }),
      });
      const router = new BoatAccountRouterAdapter({
        stacks: stubStacks(adapter),
        resourceGateway: false,
        ...(daemonTelemetry === undefined ? {} : { daemonTelemetry }),
      });

      const exporting = Effect.map(Effect.tracer, (tracer) => Tracer.make({ ...tracer }));
      const span = await Effect.runPromise(
        Effect.flatMap(exporting, (tracer) =>
          Effect.gen(function* () {
            const current = yield* Effect.currentSpan;
            yield* Effect.promise(() => router.launch(sampleLaunch()));
            return current;
          }).pipe(Effect.withSpan("sealant.workspace.launch"), Effect.withTracer(tracer)),
        ),
      );

      expect(pushedBootEnv).toMatchObject({
        SEALANT_TRACEPARENT: `00-${span.traceId}-${span.spanId}-01`,
        SEALANT_SENTRY_DSN: DSN,
        SEALANT_SENTRY_ENVIRONMENT: "check-vm",
        SEALANT_SENTRY_RELEASE: "sealantd@0.21.0-next.223",
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("omits SEALANT_TRACEPARENT and SEALANT_SENTRY_* from Boat bootEnv when telemetry is unconfigured", async () => {
    let pushedBootEnv: Record<string, string> | undefined;
    const servicesLayer = Layer.mergeAll(
      Layer.succeed(WorkspaceRuntimeInstanceRepo, {
        getRuntimeInstanceByRunId: () =>
          Effect.succeed({
            adapter: "boat",
            publicationId: publication.publicationId,
            stopReason: null,
            imageScope: { kind: "owner", ownerUserId: "user_1" },
          }),
      } as unknown as WorkspaceRuntimeInstanceRepo["Service"]),
      Layer.succeed(BoatVm, {
        prepare: () =>
          Effect.succeed({
            runId: RUN_ID,
            sandboxId: "bx_23456789",
            deploymentId: "dep_1",
            accountId: null,
          }),
      } as unknown as BoatVm["Service"]),
      Layer.succeed(BoatReadiness, {
        launch: (
          _target: unknown,
          material: Redacted.Redacted<{ readonly bootEnv: Record<string, string> }>,
        ) => {
          pushedBootEnv = Redacted.value(material).bootEnv;
          return Effect.void;
        },
      } as unknown as BoatReadiness["Service"]),
      Layer.succeed(BoatExecution, {
        control: () =>
          Effect.succeed(
            Redacted.make({
              kind: "websocket" as const,
              url: "wss://boat.example/control",
              token: "tok",
            }),
          ),
      } as unknown as BoatExecution["Service"]),
      Layer.succeed(BoatRemoval, {} as unknown as BoatRemoval["Service"]),
      Layer.succeed(BoatRunRepo, {} as unknown as BoatRunRepo["Service"]),
      Layer.succeed(
        WorkspaceCaptureDrainRepo,
        {} as unknown as WorkspaceCaptureDrainRepo["Service"],
      ),
    ) as unknown as Layer.Layer<BoatAdapterServices>;

    const runtime = ManagedRuntime.make(servicesLayer);
    try {
      const adapter = new BoatRuntimeAdapter({
        deploymentId: "dep_1",
        runtime,
        resourceGateway: false,
      });
      const router = new BoatAccountRouterAdapter({
        stacks: stubStacks(adapter),
        resourceGateway: false,
      });

      await router.launch(sampleLaunch());

      expect(pushedBootEnv).toBeDefined();
      expect(pushedBootEnv).not.toHaveProperty("SEALANT_TRACEPARENT");
      expect(pushedBootEnv).not.toHaveProperty("SEALANT_SENTRY_DSN");
      expect(pushedBootEnv).not.toHaveProperty("SEALANT_SENTRY_ENVIRONMENT");
      expect(pushedBootEnv).not.toHaveProperty("SEALANT_SENTRY_RELEASE");
    } finally {
      await runtime.dispose();
    }
  });
});
