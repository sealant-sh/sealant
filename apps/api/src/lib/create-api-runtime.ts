import { randomUUID } from "node:crypto";

import { Context, Effect, Layer } from "effect";

import { createPassthroughPackageStandardizer } from "./create-package-standardizer.js";
import type { ApiClock, ApiIdGenerator, ApiLogger, ApiRuntime, AppRuntimeConfig } from "./types.js";

/**
 * Provides validated environment configuration to the API runtime graph.
 */
export class ConfigService extends Context.Tag("@sealant/api/ConfigService")<
  ConfigService,
  {
    readonly env: AppRuntimeConfig["env"];
  }
>() {}

/**
 * Provides external runtime dependencies assembled by API bootstrap.
 */
export class DependenciesService extends Context.Tag("@sealant/api/DependenciesService")<
  DependenciesService,
  Omit<AppRuntimeConfig, "env">
>() {}

/**
 * Clock abstraction used by handlers for deterministic time access.
 */
export class ClockService extends Context.Tag("@sealant/api/ClockService")<
  ClockService,
  ApiClock
>() {}

/**
 * UUID abstraction used by handlers to avoid direct global calls.
 */
export class IdGeneratorService extends Context.Tag("@sealant/api/IdGeneratorService")<
  IdGeneratorService,
  ApiIdGenerator
>() {}

/**
 * Logging abstraction for consistent request and error logging.
 */
export class LoggerService extends Context.Tag("@sealant/api/LoggerService")<
  LoggerService,
  ApiLogger
>() {}

/**
 * Unified runtime surface consumed by route handlers.
 */
export class ApiRuntimeService extends Context.Tag("@sealant/api/ApiRuntimeService")<
  ApiRuntimeService,
  ApiRuntime
>() {}

/**
 * Live clock implementation based on system time.
 */
export const clockLiveLayer = Layer.succeed(ClockService, {
  now: () => new Date(),
});

/**
 * Live id generator implementation based on `crypto.randomUUID`.
 */
export const idGeneratorLiveLayer = Layer.succeed(IdGeneratorService, {
  randomUuid: () => randomUUID(),
});

/**
 * Live logger implementation that proxies to standard console methods.
 */
export const loggerLiveLayer = Layer.succeed(LoggerService, {
  info: (message: string, context?: Record<string, unknown>) => {
    if (context === undefined) {
      console.log(message);
      return;
    }

    console.log(message, context);
  },
  warn: (message: string, context?: Record<string, unknown>) => {
    if (context === undefined) {
      console.warn(message);
      return;
    }

    console.warn(message, context);
  },
  error: (message: string, context?: Record<string, unknown>) => {
    if (context === undefined) {
      console.error(message);
      return;
    }

    console.error(message, context);
  },
});

/**
 * Composes infrastructure services and external dependencies into `ApiRuntime`.
 */
export const apiRuntimeLiveLayer = Layer.effect(
  ApiRuntimeService,
  Effect.gen(function* () {
    const config = yield* ConfigService;
    const dependencies = yield* DependenciesService;
    const clock = yield* ClockService;
    const idGenerator = yield* IdGeneratorService;
    const logger = yield* LoggerService;

    return {
      ...dependencies,
      env: config.env,
      clock,
      idGenerator,
      logger,
      packageStandardizer:
        dependencies.packageStandardizer ?? createPassthroughPackageStandardizer(),
    };
  }),
);

/**
 * Builds a concrete runtime instance for request-scoped handler usage.
 */
export const createApiRuntime = (config: AppRuntimeConfig): ApiRuntime => {
  const { env, ...dependencies } = config;
  const dependenciesLayer = Layer.mergeAll(
    Layer.succeed(ConfigService, { env }),
    Layer.succeed(DependenciesService, dependencies),
    clockLiveLayer,
    idGeneratorLiveLayer,
    loggerLiveLayer,
  );
  const runtimeLayer = apiRuntimeLiveLayer.pipe(Layer.provide(dependenciesLayer));

  return Effect.runSync(ApiRuntimeService.pipe(Effect.provide(runtimeLayer)));
};
