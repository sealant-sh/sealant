import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { CredentialCipher } from "@sealant/credentials";
import {
  BoatAllocationRepo,
  BoatAllocationRepoLive,
  BoatControlRequestRepo,
  boatControlRequestRepoLayer,
  SealantDB,
  WorkspaceRuntimeInstanceRepo,
  WorkspaceRuntimeInstanceRepoLive,
  type BoatControlRequest,
} from "@sealant/db";
import { boatExecutionTargetSchema, type BoatExecutionTarget } from "@sealant/validators";
import { Context, Effect, Layer, Redacted } from "effect";
import { z } from "zod";

import type { WebSocketConnectMaterial } from "../../sealantd/runtime.js";
import { boatTargetIsCurrent } from "../../worker/boat-current.js";
import { BoatExecution } from "./execution.js";

/** Safe failure for expired requests, stale incarnations and unavailable workers. */
export class BoatControlError extends Error {
  readonly _tag = "BoatControlError";
  constructor() {
    super("Boat interactive control unavailable");
  }
}

const accessSchema = z.strictObject({
  url: z.url().refine((value) => new URL(value).protocol === "wss:"),
  auth: z.strictObject({ bearerToken: z.string().regex(/^[a-f0-9]{64}$/) }),
  headers: z.record(z.string(), z.string()),
});
const replySchema = z.strictObject({
  context: z.strictObject({
    id: z.uuid(),
    target: boatExecutionTargetSchema,
    purpose: z.literal("interactive-control"),
  }),
  value: accessSchema,
});
const context = (request: BoatControlRequest) => ({
  id: request.id,
  target: request.target,
  purpose: "interactive-control",
});

/** Rechecked before and after a worker opens access, and again at the client connection edge. */
const current = (target: BoatExecutionTarget) =>
  Effect.gen(function* () {
    const instance = yield* (yield* WorkspaceRuntimeInstanceRepo).getRuntimeInstanceByRunId(
      target.runId,
    );
    if (
      instance?.adapter !== "boat" ||
      instance.status !== "ready" ||
      instance.stopReason !== null ||
      instance.resourceId !== target.sandboxId ||
      !(yield* boatTargetIsCurrent(target))
    )
      return yield* Effect.fail(new BoatControlError());
  });

/** API processes receive a short-lived sealed response; they never receive the provider key. */
export class BoatInteractiveControl extends Context.Service<
  BoatInteractiveControl,
  {
    readonly connectMaterial: (
      runId: string,
      sandboxId: string,
    ) => Promise<WebSocketConnectMaterial>;
  }
>()("@sealant/workspaces/BoatInteractiveControl") {}

type ControlDependencies =
  | BoatControlRequestRepo
  | CredentialCipher
  | BoatAllocationRepo
  | WorkspaceRuntimeInstanceRepo;
const make: Effect.Effect<BoatInteractiveControl["Service"], never, ControlDependencies> =
  Effect.gen(function* () {
    const requests = yield* BoatControlRequestRepo;
    const cipher = yield* CredentialCipher;
    const allocations = yield* BoatAllocationRepo;
    const instances = yield* WorkspaceRuntimeInstanceRepo;
    const checking = (target: BoatExecutionTarget) =>
      current(target).pipe(
        Effect.provideService(BoatAllocationRepo, allocations),
        Effect.provideService(WorkspaceRuntimeInstanceRepo, instances),
      );
    return {
      connectMaterial: (runId: string, sandboxId: string) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const target = (yield* allocations.get(runId))?.target;
            if (target == null || target.sandboxId !== sandboxId)
              return yield* Effect.fail(new BoatControlError());
            yield* checking(target);
            const id = randomUUID();
            yield* requests.create(id, target);
            return yield* Effect.gen(function* () {
              for (;;) {
                const request = yield* requests.get(id);
                if (request === undefined || !isDeepStrictEqual(request.target, target))
                  return yield* Effect.fail(new BoatControlError());
                if (request.sealedAccess !== null) {
                  const raw = yield* cipher.decrypt(request.sealedAccess);
                  const reply = yield* Effect.try({
                    try: () => replySchema.parse(JSON.parse(raw)),
                    catch: () => new BoatControlError(),
                  });
                  if (!isDeepStrictEqual(reply.context, context(request)))
                    return yield* Effect.fail(new BoatControlError());
                  yield* checking(target);
                  return reply.value;
                }
                yield* Effect.sleep(100);
              }
            }).pipe(
              Effect.timeout(15_000),
              Effect.ensuring(requests.remove(id).pipe(Effect.catch(() => Effect.void))),
            );
          }).pipe(Effect.mapError(() => new BoatControlError())),
        ),
    };
  });
/** Open assembly for transport and persistence tests. */
export const boatInteractiveControlLayerNoDeps: Layer.Layer<
  BoatInteractiveControl,
  never,
  ControlDependencies
> = Layer.effect(BoatInteractiveControl, make);
/** Infrastructure stays at the API/worker root. Owned repositories share their layer constants. */
export const boatInteractiveControlLayer: Layer.Layer<
  BoatInteractiveControl,
  never,
  SealantDB | CredentialCipher
> = boatInteractiveControlLayerNoDeps.pipe(
  Layer.provide(
    Layer.mergeAll(
      boatControlRequestRepoLayer,
      BoatAllocationRepoLive,
      WorkspaceRuntimeInstanceRepoLive,
    ),
  ),
);

/** Hosted access is refreshed by the credential-owning worker, without replaying guest bootstrap. */
export const serveBoatControlRequests = Effect.gen(function* () {
  const requests = yield* BoatControlRequestRepo;
  const execution = yield* BoatExecution;
  const cipher = yield* CredentialCipher;
  yield* requests.expire();
  const pending = yield* requests.pending();
  yield* Effect.forEach(
    pending,
    (request) =>
      Effect.gen(function* () {
        yield* current(request.target);
        const target = Redacted.value(yield* execution.control(request.target));
        if (target.kind !== "websocket" || target.auth === undefined)
          return yield* Effect.fail(new BoatControlError());
        const material = awaitMaterial(target.prepare);
        const prepared = yield* material;
        yield* current(request.target);
        const sealed = yield* cipher.encrypt(
          JSON.stringify({
            context: context(request),
            value: { url: target.url, auth: target.auth, headers: prepared?.headers ?? {} },
          }),
        );
        yield* requests.complete(request, sealed.sealed);
      }).pipe(Effect.catch(() => Effect.void)),
    { concurrency: 4 },
  );
});

const awaitMaterial = (prepare: (() => Promise<WebSocketConnectMaterial>) | undefined) =>
  prepare === undefined
    ? Effect.succeed(undefined)
    : Effect.tryPromise({ try: prepare, catch: () => new BoatControlError() });
