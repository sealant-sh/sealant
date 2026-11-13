/**
 * `GET /v1/workspaces/runtimes` through the real `ControlPlaneAPI`: the static path reaches its own
 * endpoint, never `getWorkspace` with `runtimes` as an id, and the table the API answers with is
 * the wire schema's.
 */
import { workspaceRuntimesResponseSchema } from "@sealant/api-contracts";
import { runtimeAdapterIds, runtimeSupport } from "@sealant/validators";
import { Effect, Layer, Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { BoatConfigured } from "../../services/boat-availability.js";
import { listWorkspaceRuntimes, runtimeInstall } from "../../services/runtime-support.js";
import { serveControlPlane } from "../control-plane.fixture.js";

const reached: string[] = [];
const { handler, dispose } = serveControlPlane({
  provides: Layer.empty,
  reached: (endpoint) => reached.push(endpoint),
});
afterAll(() => dispose());

describe("GET /v1/workspaces/runtimes", () => {
  it("reaches listWorkspaceRuntimes, and a workspace id still reaches getWorkspace", async () => {
    await handler(new Request("http://localhost/v1/workspaces/runtimes"));
    await handler(new Request("http://localhost/v1/workspaces/ws_1?ownerUserId=usr_a"));
    expect(reached).toEqual(["listWorkspaceRuntimes", "getWorkspace"]);
  });

  it("answers with what the wire schema carries, for every runtime", async () => {
    const install = await Effect.runPromise(runtimeInstall);
    const every = {
      default: "docker",
      runtimes: runtimeAdapterIds.map((id) => runtimeSupport(id, install)),
    };
    expect(Schema.decodeUnknownSync(workspaceRuntimesResponseSchema)(every)).toEqual(every);
    const answered = await Effect.runPromise(
      listWorkspaceRuntimes.pipe(Effect.provideService(BoatConfigured, true)),
    );
    expect(Schema.encodeSync(workspaceRuntimesResponseSchema)(answered)).toEqual(answered);
  });
});
