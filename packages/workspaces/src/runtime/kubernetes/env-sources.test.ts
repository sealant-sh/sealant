/**
 * Pure resolution semantics for cluster env sources: one ordered list, last-wins across kinds,
 * the winning source deciding the delivery lane; every refusal readable and naming the binding.
 */
import { describe, expect, it } from "vitest";

import {
  resolveEnvSources,
  WORKSPACE_ENV_OPT_IN_LABEL,
  type EnvSourceReader,
} from "./env-sources.js";

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

const optIn = { [WORKSPACE_ENV_OPT_IN_LABEL]: "true" };

interface FakeObjects {
  readonly secrets?: Record<
    string,
    { labels?: Record<string, string>; data?: Record<string, string> }
  >;
  readonly configmaps?: Record<
    string,
    {
      labels?: Record<string, string>;
      data?: Record<string, string>;
      binaryData?: Record<string, string>;
    }
  >;
}

const reader = (objects: FakeObjects): EnvSourceReader => ({
  namespace: "ns",
  getSecret: async (name) => {
    const entry = objects.secrets?.[name];
    return entry === undefined
      ? undefined
      : {
          metadata: { name, ...(entry.labels === undefined ? {} : { labels: entry.labels }) },
          ...(entry.data === undefined ? {} : { data: entry.data }),
        };
  },
  getConfigMap: async (name) => {
    const entry = objects.configmaps?.[name];
    return entry === undefined
      ? undefined
      : {
          metadata: { name, ...(entry.labels === undefined ? {} : { labels: entry.labels }) },
          ...(entry.data === undefined ? {} : { data: entry.data }),
          ...(entry.binaryData === undefined ? {} : { binaryData: entry.binaryData }),
        };
  },
});

const managedBy = { managedBy: "sealant" };

describe("resolveEnvSources", () => {
  it("decodes Secret data from base64 and keeps ConfigMap data verbatim, split by lane", async () => {
    const resolved = await resolveEnvSources(
      reader({
        secrets: { "app-env": { labels: optIn, data: { APP_TOKEN: b64("s3cret") } } },
        configmaps: { "app-config": { labels: optIn, data: { APP_MODE: "staging" } } },
      }),
      managedBy,
      [
        { kind: "secret", name: "app-env" },
        { kind: "configmap", name: "app-config" },
      ],
    );
    expect(resolved.secretEnv).toEqual({ APP_TOKEN: "s3cret" });
    expect(resolved.configMapEnv).toEqual([["APP_MODE", "staging"]]);
  });

  it("is last-wins across kinds: the winning source decides the delivery lane", async () => {
    const objects: FakeObjects = {
      secrets: { s: { labels: optIn, data: { SHARED: b64("from-secret") } } },
      configmaps: { c: { labels: optIn, data: { SHARED: "from-configmap" } } },
    };
    const secretLast = await resolveEnvSources(reader(objects), managedBy, [
      { kind: "configmap", name: "c" },
      { kind: "secret", name: "s" },
    ]);
    expect(secretLast.secretEnv).toEqual({ SHARED: "from-secret" });
    expect(secretLast.configMapEnv).toEqual([]);

    const configMapLast = await resolveEnvSources(reader(objects), managedBy, [
      { kind: "secret", name: "s" },
      { kind: "configmap", name: "c" },
    ]);
    expect(configMapLast.secretEnv).toEqual({});
    expect(configMapLast.configMapEnv).toEqual([["SHARED", "from-configmap"]]);
  });

  it.each([
    [
      "a missing object",
      reader({}),
      [{ kind: "secret", name: "absent" }] as const,
      /secret\/absent was not found in namespace 'ns'/,
    ],
    [
      "an object without the opt-in label",
      reader({ secrets: { plain: { data: {} } } }),
      [{ kind: "secret", name: "plain" }] as const,
      /not opted in .* sealant\.sh\/workspace-env/,
    ],
    [
      "a platform-managed object",
      reader({
        secrets: {
          owned: { labels: { ...optIn, "app.kubernetes.io/managed-by": "sealant" }, data: {} },
        },
      }),
      [{ kind: "secret", name: "owned" }] as const,
      /secret\/owned is managed by the platform/,
    ],
    [
      "a platform-pattern name, before any read",
      reader({}),
      [{ kind: "secret", name: "ws-abc-123456-env" }] as const,
      /matches the platform's per-workspace resource names/,
    ],
    [
      "a ConfigMap with binaryData keys",
      reader({
        configmaps: { bin: { labels: optIn, data: {}, binaryData: { blob: b64("x") } } },
      }),
      [{ kind: "configmap", name: "bin" }] as const,
      /binaryData keys \(blob\)/,
    ],
    [
      "a key that is not a valid env name",
      reader({ configmaps: { dotted: { labels: optIn, data: { "app.mode": "x" } } } }),
      [{ kind: "configmap", name: "dotted" }] as const,
      /'app\.mode', which is not a valid environment variable name/,
    ],
  ])("refuses %s readably", async (_case, sourceReader, envFrom, message) => {
    await expect(resolveEnvSources(sourceReader, managedBy, [...envFrom])).rejects.toThrow(message);
  });
});
