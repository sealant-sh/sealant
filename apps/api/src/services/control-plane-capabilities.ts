import { PackageResolutionCacheRepo } from "@sealant/db";
import type { PackageStandardizer, RegistryClient } from "@sealant/sandboxes";
import { Effect, Layer, Context } from "effect";

import { createApiPackageStandardizer } from "../lib/create-package-standardizer.js";
import { createRegistryClient } from "../lib/create-registry-client.js";
import { createSandboxBuildJobPublisher } from "../lib/create-sandbox-build-job-publisher.js";
import type { SandboxBuildJobPublisher } from "../lib/types.js";
import { env } from "../runtime-env.js";

export class PackageStandardizerService extends Context.Tag(
  "@sealant/api/PackageStandardizerService",
)<PackageStandardizerService, PackageStandardizer>() {}

export class RegistryClientService extends Context.Tag("@sealant/api/RegistryClientService")<
  RegistryClientService,
  RegistryClient
>() {}

export class SandboxBuildJobPublisherService extends Context.Tag(
  "@sealant/api/SandboxBuildJobPublisherService",
)<SandboxBuildJobPublisherService, SandboxBuildJobPublisher>() {}

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

export const ControlPlaneCapabilitiesLive = Layer.mergeAll(
  PackageStandardizerServiceLive,
  RegistryClientServiceLive,
  SandboxBuildJobPublisherServiceLive,
);
