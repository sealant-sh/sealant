import { PackageResolutionCacheRepo } from "@sealant/db";
import {
  publishRunExecRequested,
  type PackageStandardizer,
  type RegistryClient,
  type RunExecCommand,
} from "@sealant/sandboxes";
import { Effect, Layer, Context } from "effect";

import { createApiPackageStandardizer } from "../lib/create-package-standardizer.js";
import { createRegistryClient } from "../lib/create-registry-client.js";
import { createSandboxBuildJobPublisher } from "../lib/create-sandbox-build-job-publisher.js";
import type { SandboxBuildJobPublisher } from "../lib/types.js";
import { env } from "../runtime-env.js";

export class PackageStandardizerService extends Context.Service<
  PackageStandardizerService,
  PackageStandardizer
>()("@sealant/api/PackageStandardizerService") {}

export class RegistryClientService extends Context.Service<RegistryClientService, RegistryClient>()(
  "@sealant/api/RegistryClientService",
) {}

export class SandboxBuildJobPublisherService extends Context.Service<
  SandboxBuildJobPublisherService,
  SandboxBuildJobPublisher
>()("@sealant/api/SandboxBuildJobPublisherService") {}

export interface RunExecPublisher {
  readonly publishRequested: (input: {
    readonly runId: string;
    readonly command: RunExecCommand;
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

export const SandboxBuildJobPublisherServiceLive = Layer.succeed(
  SandboxBuildJobPublisherService,
  createSandboxBuildJobPublisher(env),
);

export const RunExecPublisherServiceLive = Layer.succeed(RunExecPublisherService, {
  publishRequested: (input) => publishRunExecRequested(env.RABBITMQ_URL, input),
});

export const ControlPlaneCapabilitiesLive = Layer.mergeAll(
  PackageStandardizerServiceLive,
  RegistryClientServiceLive,
  SandboxBuildJobPublisherServiceLive,
  RunExecPublisherServiceLive,
);
