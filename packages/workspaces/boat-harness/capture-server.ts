/**
 * Mend's capture session channel for one worktree, run in a container on the twins' network.
 * The guest dials it from inside its isolated workspace namespace, which on a firewalled host
 * cannot reach a listener on the host itself. It is Core's `capture-channel.fixture.ts` plus a
 * read-only `/harness/state` view on port 9000 for scenario assertions.
 *
 * Env: CAPTURE_TOKEN, CAPTURE_WORKTREE_ID, CAPTURE_ADVERTISE_HOST.
 */
import http from "node:http";

import { startCaptureChannel } from "../src/runtime/capture-channel.fixture.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
};

const channel = await startCaptureChannel({
  token: required("CAPTURE_TOKEN"),
  worktreeId: required("CAPTURE_WORKTREE_ID"),
  advertiseHost: required("CAPTURE_ADVERTISE_HOST"),
});

http
  .createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        endpoint: channel.endpoint,
        head: channel.state.head ?? null,
        planRequests: channel.state.planRequests,
        epoch: channel.state.epoch,
        executor: channel.state.executor ?? null,
        objects: channel.state.objects.size,
        errors: channel.state.errors.map(String),
      }),
    );
  })
  .listen(9000, "0.0.0.0", () => {
    process.stdout.write(`capture channel ${channel.endpoint}\n`);
  });
