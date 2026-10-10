/**
 * The registry summary reports what the registry client sends: a base URL's `user:password@` is a
 * Basic credential (ZotRegistryClient sends it as one), so the summary says Basic auth, and its
 * base URL never shows the credential. The environment is set before the dynamic import because
 * runtime-env parses process.env at module load.
 */
import { createZotRegistryClient } from "@sealant/workspaces";
import { Effect } from "effect";
import { expect, it } from "vitest";

const SECRET = "registry_summary_credential";
process.env["REGISTRY_BASE_URL"] = `http://robot:${SECRET}@127.0.0.1:5000`;
process.env["REGISTRY_PUSH_REGISTRY"] = "127.0.0.1:5000";
delete process.env["REGISTRY_USERNAME"];
delete process.env["REGISTRY_PASSWORD"];

it("says Basic auth when the base URL carries the credential the client sends", async () => {
  const { getRegistry } = await import("./registries.module.js");
  const summary = await Effect.runPromise(getRegistry("default"));

  let authorization: string | null = null;
  const client = createZotRegistryClient({
    baseUrl: `http://robot:${SECRET}@127.0.0.1:5000`,
    fetch: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(null, { status: 200 });
    },
  });
  await client.ping();

  expect(authorization).toBe(`Basic ${Buffer.from(`robot:${SECRET}`).toString("base64")}`);
  expect(summary.hasBasicAuth).toBe(true);
  expect(summary.baseUrl).toBe("http://REDACTED:REDACTED@127.0.0.1:5000/");
});
