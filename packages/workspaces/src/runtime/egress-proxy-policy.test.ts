import { Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { buildProxyPolicyDocument } from "./egress-proxy-policy.js";
import { generateExecutorCa } from "./executor-ca.js";

const ca = generateExecutorCa({ executor: "sealant-run-1" });

const documentWith = (host: { mirrorHosts?: string[]; resourceHosts?: string[] }) =>
  buildProxyPolicyDocument({
    networkPolicy: {
      mode: "restricted",
      policyHash: "sha256:p",
      allowMirrors: [
        { name: "npm", host: "npm-mirror", port: 4873 },
        // A private destination the caller named as a "mirror": the proxy would let it through at
        // its private address.
        { name: "docker", host: "postgres", port: 5432 },
      ],
      allowResources: [
        { name: "db", host: "sealres-db", port: 5432, guestIp: "10.201.0.1" },
        { name: "lan", host: "nas", port: 445, guestIp: "10.201.0.2" },
      ],
    },
    brokeredSecrets: [],
    brokeredValues: Redacted.make({}),
    ca,
    tombstones: { revocationWatermark: 0, revokedHosts: [], revokedSecretIds: [] },
    host: {
      operatorAllowedPrivateCidrs: [],
      hostPublicIps: [],
      blockedCidrs: [],
      ...host,
    },
  });

describe("private-address grants in a proxy's policy", () => {
  it("grants a mirror only on the operator's own mirror hosts", () => {
    expect(documentWith({ mirrorHosts: ["npm-mirror"] }).allowMirrors).toEqual([
      { name: "npm", host: "npm-mirror", port: 4873 },
    ]);
    expect(documentWith({}).allowMirrors).toEqual([]);
  });

  it("grants a resource only on a host the workspace is authorized to reach", () => {
    expect(documentWith({ resourceHosts: ["sealres-db"] }).allowResources).toEqual([
      { name: "db", host: "sealres-db", port: 5432, guestIp: "10.201.0.1" },
    ]);
    expect(documentWith({}).allowResources).toEqual([]);
  });
});
