/**
 * The raw exec route (`RESOURCE_INSTANCE_EXEC` in the contract): one JSON line naming the command,
 * then its stdin, streamed into the instance. Nothing of the argv or stdin goes into a log line, a
 * header, a query or a run record; a refusal says where the request is wrong, never what it held.
 */
import {
  describeRequestIssue,
  RESOURCE_INSTANCE_EXEC,
  ResourceDomainId,
  ResourceInstanceKey,
  resourceInstanceExecFrameSchema,
  type ResourceInstanceExecResult,
} from "@sealant/api-contracts";
import { ResourceInstanceRepo } from "@sealant/db";
import { Effect, Result, Schema, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { ResourceRuntimeHost } from "../../services/resource-runtime.js";
import { CurrentPrincipal } from "../../services/service-principals.js";

export type ExecBody =
  | { readonly kind: "frame"; readonly frame: string; readonly stdin: AsyncIterable<Uint8Array> }
  | { readonly kind: "refused"; readonly reason: string };

/** The body's first line, and everything after it as the command's stdin, still streaming. */
export const splitExecBody = async (
  body: AsyncIterable<Uint8Array>,
  maxFrameBytes: number,
): Promise<ExecBody> => {
  const iterator = body[Symbol.asyncIterator]();
  let head = Buffer.alloc(0);
  for (;;) {
    const next = await iterator.next();
    if (next.done === true) {
      return { kind: "refused", reason: "the request body must start with one JSON line" };
    }
    head = Buffer.concat([head, next.value]);
    const newline = head.indexOf(10);
    if (newline > maxFrameBytes || (newline < 0 && head.length > maxFrameBytes)) {
      return {
        kind: "refused",
        reason: `the request body's first line is longer than ${String(maxFrameBytes)} bytes`,
      };
    }
    if (newline >= 0) {
      const rest = head.subarray(newline + 1);
      const stdin = async function* () {
        if (rest.length > 0) yield rest;
        for (;;) {
          const chunk = await iterator.next();
          if (chunk.done === true) return;
          yield chunk.value;
        }
      };
      return { kind: "frame", frame: head.subarray(0, newline).toString("utf8"), stdin: stdin() };
    }
  }
};

const refuse = (status: number, tag: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ _tag: tag, message }, { status });

const decodeFrame = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      ...resourceInstanceExecFrameSchema.fields,
      timeoutMs: Schema.optional(resourceInstanceExecFrameSchema.fields.timeoutMs),
    }),
  ),
);
const isDomainId = Schema.is(ResourceDomainId);
const isKey = Schema.is(ResourceInstanceKey);

export const ResourceInstanceExecRoute = HttpRouter.add(
  "POST",
  RESOURCE_INSTANCE_EXEC.path,
  (request) =>
    Effect.gen(function* () {
      const principal = yield* CurrentPrincipal;
      if (principal.kind !== "service" && principal.kind !== "open") {
        return refuse(
          403,
          "ResourceDomainForbiddenError",
          "A service key is required to manage resource instances.",
        );
      }
      const params = yield* HttpRouter.params;
      const resourceDomainId = params["resourceDomainId"];
      const key = params["key"];
      if (!isDomainId(resourceDomainId) || !isKey(key)) {
        return refuse(400, "RequestRefusedError", "the path names no resource instance");
      }
      const host = yield* ResourceRuntimeHost;
      if (host.kind === "unsupported") {
        return refuse(
          409,
          "ResourceRuntimeUnsupportedError",
          `resources run on Docker; this Sealant runs ${host.runtime}`,
        );
      }
      const repo = yield* ResourceInstanceRepo;
      const instance = yield* repo.get(resourceDomainId, key).pipe(Effect.orDie);
      if (instance === undefined) {
        return refuse(
          404,
          "ResourceInstanceNotFoundError",
          "This resource domain has no instance with that key.",
        );
      }
      if (instance.desired !== "running" || instance.observed.kind !== "running") {
        return refuse(
          409,
          "ResourceInstanceNotRunningError",
          "The instance is not running: start it, then run the command.",
        );
      }
      const body = yield* Effect.promise(() =>
        splitExecBody(Stream.toAsyncIterable(request.stream), RESOURCE_INSTANCE_EXEC.maxFrameBytes),
      );
      if (body.kind === "refused") return refuse(400, "RequestRefusedError", body.reason);
      const frame = decodeFrame(body.frame, { onExcessProperty: "error" });
      if (Result.isFailure(frame)) {
        return refuse(
          400,
          "RequestRefusedError",
          describeRequestIssue("frame", frame.failure.issue),
        );
      }
      const command = {
        argv: frame.success.argv,
        user: frame.success.user,
        timeoutMs: frame.success.timeoutMs ?? RESOURCE_INSTANCE_EXEC.defaultTimeoutMs,
      };
      yield* repo.touchReached([instance.id], new Date()).pipe(Effect.orDie);
      const result = yield* Effect.tryPromise(() =>
        host.runtime.exec(instance, command, body.stdin),
      ).pipe(Effect.result);
      yield* repo.touchReached([instance.id], new Date()).pipe(Effect.orDie);
      if (Result.isFailure(result)) {
        return refuse(
          500,
          "ResourceDomainInternalServerError",
          "The command could not run in the instance, or its input was cut off.",
        );
      }
      const answer: ResourceInstanceExecResult = result.success;
      return HttpServerResponse.jsonUnsafe(answer);
    }),
);
