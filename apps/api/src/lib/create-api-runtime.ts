import { randomUUID } from "node:crypto";

import { Context, Effect, Layer } from "effect";

import { createPassthroughPackageStandardizer } from "./create-package-standardizer.js";
import type { ApiClock, ApiIdGenerator, ApiLogger, ApiRuntime, AppRuntimeConfig } from "./types.js";

export class ConfigService extends Context.Tag("@sealant/api/ConfigService")<
  ConfigService,
  {
    readonly env: AppRuntimeConfig["env"];
  }
>() {}

export class DependenciesService extends Context.Tag("@sealant/api/DependenciesService")<
  DependenciesService,
  Omit<AppRuntimeConfig, "env">
>() {}

export class ClockService extends Context.Tag("@sealant/api/ClockService")<
  ClockService,
  ApiClock
>() {}

export class IdGeneratorService extends Context.Tag("@sealant/api/IdGeneratorService")<
  IdGeneratorService,
  ApiIdGenerator
>() {}

export class LoggerService extends Context.Tag("@sealant/api/LoggerService")<
  LoggerService,
  ApiLogger
>() {}

export class ApiRuntimeService extends Context.Tag("@sealant/api/ApiRuntimeService")<
  ApiRuntimeService,
  ApiRuntime
>() {}

export const clockLiveLayer = Layer.succeed(ClockService, {
  now: () => new Date(),
});

export const idGeneratorLiveLayer = Layer.succeed(IdGeneratorService, {
  randomUuid: () => randomUUID(),
});

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
