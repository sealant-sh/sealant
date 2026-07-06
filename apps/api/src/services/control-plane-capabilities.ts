import { PackageResolutionCacheRepo } from "@sealant/db";
import {
  publishRunExecRequested,
  type PackageStandardizer,
  type RegistryClient,
  type RunExecCommand,
} from "@sealant/workspaces";
import { Effect, Layer, Context } from "effect";

import { createApiPackageStandardizer } from "../lib/create-package-standardizer.js";
import { createRegistryClient } from "../lib/create-registry-client.js";
import { createWorkspaceBuildJobPublisher } from "../lib/create-workspace-build-job-publisher.js";
import type { WorkspaceBuildJobPublisher } from "../lib/types.js";
import { env } from "../runtime-env.js";

export class PackageStandardizerService extends Context.Service<
  PackageStandardizerService,
  PackageStandardizer
>()("@sealant/api/PackageStandardizerService") {}

export class RegistryClientService extends Context.Service<RegistryClientService, RegistryClient>()(
  "@sealant/api/RegistryClientService",
) {}

export class WorkspaceBuildJobPublisherService extends Context.Service<
  WorkspaceBuildJobPublisherService,
  WorkspaceBuildJobPublisher
>()("@sealant/api/WorkspaceBuildJobPublisherService") {}

export interface RunExecPublisher {
  /** Exactly one framing per request: `command` (harness) or `commands` (exec/check run). */
  readonly publishRequested: (input: {
    readonly runId: string;
    readonly command?: RunExecCommand;
    readonly commands?: readonly RunExecCommand[];
  }) => Promise<void>;
}

export class RunExecPublisherService extends Context.Service<
  RunExecPublisherService,
  RunExecPublisher
>()("@sealant/api/RunExecPublisherService") {}

export const PackageStandardizerServiceLive = Layer.effect(
  PackageStandardizerService,
  Effect.gen(function* () {
    const cacheRepository = yield* PackageResolutionCacheRepo;

    return createApiPackageStandardizer({
      env,
      cacheRepository,
    });
  }),
);

export const RegistryClientServiceLive = Layer.succeed(
  RegistryClientService,
  createRegistryClient(env),
);

export const WorkspaceBuildJobPublisherServiceLive = Layer.succeed(
  WorkspaceBuildJobPublisherService,
  createWorkspaceBuildJobPublisher(env),
);

export const RunExecPublisherServiceLive = Layer.succeed(RunExecPublisherService, {
  publishRequested: (input) => publishRunExecRequested(env.RABBITMQ_URL, input),
});

export const ControlPlaneCapabilitiesLive = Layer.mergeAll(
  PackageStandardizerServiceLive,
  RegistryClientServiceLive,
  WorkspaceBuildJobPublisherServiceLive,
  RunExecPublisherServiceLive,
);
