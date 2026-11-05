import {
  RESOURCE_INSTANCE_BACKUP,
  ResourceDomainId,
  ResourceInstanceKey,
} from "@sealant/api-contracts";
import { ResourceInstanceRepo } from "@sealant/db";
import { Effect, Schema, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { ResourceRuntimeHost } from "../../services/resource-runtime.js";
import { admitRawRequest, CurrentPrincipal } from "../../services/service-principals.js";

const refuse = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { _tag: "ResourceInstanceBackupRefusedError", message },
    { status },
  );

/** The lock covers the whole tar stream, including cancellation, rather than just its headers. */
export const ResourceInstanceBackupRoute = HttpRouter.add(
  "GET",
  RESOURCE_INSTANCE_BACKUP.path,
  () =>
    Effect.gen(function* () {
      const budgetRefusal = yield* admitRawRequest(undefined);
      if (budgetRefusal !== undefined) return budgetRefusal;
      const principal = yield* CurrentPrincipal;
      if (principal.kind !== "service" && principal.kind !== "open")
        return refuse(403, "A service key is required to back up an instance volume.");
      const params = yield* HttpRouter.params;
      const domain = params["resourceDomainId"];
      const key = params["key"];
      const volume = params["volume"];
      if (
        !Schema.is(ResourceDomainId)(domain) ||
        !Schema.is(ResourceInstanceKey)(key) ||
        volume === undefined ||
        !/^[a-z][a-z0-9-]{0,30}$/.test(volume)
      )
        return refuse(400, "The path names no instance volume.");
      const repo = yield* ResourceInstanceRepo;
      const host = yield* ResourceRuntimeHost;
      if (host.kind === "unsupported" || host.runtime.backup === undefined)
        return refuse(409, "This runtime does not support caller-instance volume backup.");
      const instance = yield* repo.get(domain, key).pipe(Effect.orDie);
      if (instance === undefined) return refuse(404, "No such instance.");
      if (instance.spec.reach === undefined || instance.desired !== "stopped")
        return refuse(409, "Stop the caller instance before backing up its volume.");
      if (!instance.spec.volumes.some((candidate) => candidate.name === volume))
        return refuse(404, "No such retained volume.");
      const runtime = host.runtime;
      const body = Stream.unwrap(
        Effect.gen(function* () {
          const channel = new TransformStream<Uint8Array, Uint8Array>();
          const copy = repo.withLock(
            `${domain}:${key}`,
            Effect.promise(async () => {
              const current = await Effect.runPromise(repo.get(domain, key));
              if (
                current === undefined ||
                current.desired !== "stopped" ||
                runtime.backup === undefined
              )
                throw new Error("The instance is no longer stopped.");
              const backup = await runtime.backup(current, volume);
              await backup.pipeTo(channel.writable);
            }),
          );
          yield* Effect.forkScoped(
            copy.pipe(
              Effect.catchCause(() =>
                Effect.promise(() =>
                  channel.writable.abort(new Error("The stopped-volume backup failed.")),
                ).pipe(Effect.ignore),
              ),
            ),
          );
          return Stream.fromReadableStream({
            evaluate: () => channel.readable,
            onError: () => new Error("The stopped-volume backup failed."),
          });
        }),
      );
      return HttpServerResponse.stream(body, {
        contentType: "application/x-tar",
        headers: { "cache-control": "no-store" },
      });
    }),
);
