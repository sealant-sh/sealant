import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import test from "node:test";

import { BOAT_LIVE_ENV, runBoatLive } from "./runtime.mjs";
import { apiReady, webReady } from "./stack.mjs";

/** Serves `respond` on a loopback port for the test's duration; returns its base URL. */
async function serve(t, respond) {
  const server = createHttpServer(respond);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

const json = (status, body) => (_request, response) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const page = (status, body) => (_request, response) => {
  response.writeHead(status, { "content-type": "text/html" });
  response.end(body);
};

// Ready means the API answered from the database, not that its port opened: the dev server binds
// before its first request can reach Postgres, and an API without a database answers 500.
test("the API is ready only when setup-state answers with its needsSetup boolean", async (t) => {
  assert.equal(
    await apiReady(await serve(t, json(200, { needsSetup: true, sshGateway: null }))),
    true,
  );
  assert.equal(
    await apiReady(await serve(t, json(500, { _tag: "SystemInternalServerError" }))),
    false,
  );
  assert.equal(await apiReady(await serve(t, json(404, {}))), false);
  assert.equal(await apiReady(await serve(t, json(200, { ok: true }))), false, "another server");

  const tcp = createTcpServer((socket) => socket.end());
  await new Promise((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  t.after(() => tcp.close());
  assert.equal(
    await apiReady(`http://127.0.0.1:${tcp.address().port}`),
    false,
    "an open port alone",
  );
});

test("the web app is ready only when its root serves a page", async (t) => {
  assert.equal(
    await webReady(await serve(t, page(200, "<!doctype html><html><body></body></html>"))),
    true,
  );
  assert.equal(await webReady(await serve(t, page(500, "<html>error</html>"))), false);
  assert.equal(await webReady(await serve(t, page(200, ""))), false);
});

test("without its credentials the live Boat check starts nothing and is never passed", async () => {
  const none = await runBoatLive({ root: "/nonexistent", env: {}, stamp: "t", echo: false });
  assert.equal(none.steps[0].status, "requires_external_observer");
  for (const name of BOAT_LIVE_ENV) assert.match(none.steps[0].detail, new RegExp(`\\b${name}\\b`));

  const partial = Object.fromEntries(BOAT_LIVE_ENV.slice(1).map((name) => [name, "secret-value"]));
  const one = await runBoatLive({ root: "/nonexistent", env: partial, stamp: "t", echo: false });
  assert.equal(one.steps[0].status, "requires_external_observer");
  assert.match(one.steps[0].detail, /not run: MEND_URL is not set/);
  assert.doesNotMatch(JSON.stringify(one), /secret-value/, "no credential value is printed");
});
