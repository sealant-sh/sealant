import { Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  applyWorkspaceNetworkPolicyRequestSchema,
  revokeWorkspaceAccessRequestSchema,
} from "./core-api/workspaces.js";
import {
  brokeredSecretValuesProblems,
  brokeredSecretsProblems,
  needsEgressProxy,
  networkPolicyProblems,
  type BrokeredSecret,
} from "./network-policy.js";

const secret = (overrides: Partial<BrokeredSecret> = {}): BrokeredSecret => ({
  secretId: "psec_vercel",
  name: "VERCEL_TOKEN",
  placeholder: "mend_sec_0123456789abcdefghijklmn",
  secretRef: "ref-vercel",
  headerName: "Authorization",
  bindHosts: ["api.vercel.com"],
  ...overrides,
});

describe("brokered secret rules", () => {
  it("accepts a secret bound to exact hosts in one ordinary header", () => {
    expect(brokeredSecretsProblems([secret()])).toEqual([]);
  });

  it.each(["Host", "transfer-encoding", "Content-Length", "Connection", "Upgrade", "TE"])(
    "refuses the framing or routing header %s",
    (headerName) => {
      expect(brokeredSecretsProblems([secret({ headerName })])).toEqual([
        expect.stringContaining("frames or routes the request"),
      ]);
    },
  );

  it("refuses Proxy-Authorization, which authenticates to the proxy itself", () => {
    expect(brokeredSecretsProblems([secret({ headerName: "Proxy-Authorization" })])).toHaveLength(
      1,
    );
  });

  it("refuses a header field that is not one header name", () => {
    expect(brokeredSecretsProblems([secret({ headerName: "X-Key: injected" })])).toEqual([
      expect.stringContaining("must be one HTTP header name"),
    ]);
  });

  it.each([
    ["*.vercel.com", "wildcard"],
    ["api.vercel.com/v1?token=x", "not a host name"],
    ["api.vercel.com:443", "not a host name"],
    ["203.0.113.7", "IP address"],
    ["https://api.vercel.com", "not a host name"],
  ])("refuses the bind host %s", (bindHost, words) => {
    expect(brokeredSecretsProblems([secret({ bindHosts: [bindHost] })])).toEqual([
      expect.stringContaining(words),
    ]);
  });

  it("refuses a secret with no bind host", () => {
    expect(brokeredSecretsProblems([secret({ bindHosts: [] })])).toEqual([
      expect.stringContaining("at least one host"),
    ]);
  });

  it("refuses a placeholder the proxy would refuse", () => {
    expect(brokeredSecretsProblems([secret({ placeholder: "short" })])).toHaveLength(1);
    expect(brokeredSecretsProblems([secret({ placeholder: "has a space in it" })])).toHaveLength(1);
  });

  it("refuses a path prefix with a query", () => {
    expect(brokeredSecretsProblems([secret({ pathPrefixes: ["/v1?x=1"] })])).toHaveLength(1);
  });

  it("refuses two secrets with the same id, variable or placeholder", () => {
    const twice = brokeredSecretsProblems([
      secret(),
      secret({ secretRef: "other", bindHosts: ["api.example.com"] }),
    ]);
    expect(twice).toEqual([
      expect.stringContaining("secretId"),
      expect.stringContaining("name"),
      expect.stringContaining("placeholder"),
    ]);
  });
});

describe("brokered secret values", () => {
  it("needs a value for every secretRef and refuses ones nothing names", () => {
    expect(brokeredSecretValuesProblems([secret()], { other: "x" })).toEqual([
      expect.stringContaining("no value for secretRef `ref-vercel`"),
      expect.stringContaining("`other` names no brokered secret"),
    ]);
  });

  it("refuses a value that would split a header, without echoing it", () => {
    const problems = brokeredSecretValuesProblems([secret()], {
      "ref-vercel": "Bearer abc\r\nX-Evil: 1",
    });
    expect(problems).toHaveLength(1);
    expect(problems.join(" ")).not.toContain("abc");
  });

  it("accepts a bearer value", () => {
    expect(brokeredSecretValuesProblems([secret()], { "ref-vercel": "Bearer abc" })).toEqual([]);
  });
});

describe("network policy rules", () => {
  it("refuses a wildcard host and a resource outside the synthetic range", () => {
    expect(
      networkPolicyProblems({
        mode: "restricted",
        policyHash: "sha256:1",
        allowHosts: [{ host: "*.github.com" }],
        allowResources: [{ name: "db", host: "db", port: 5432, guestIp: "10.0.0.5" }],
      }),
    ).toEqual([expect.stringContaining("wildcard"), expect.stringContaining("outside")]);
  });

  it("refuses two resources on one synthetic address and port", () => {
    expect(
      networkPolicyProblems({
        mode: "standard",
        policyHash: "sha256:1",
        allowResources: [
          { name: "db", host: "db", port: 5432, guestIp: "10.201.0.1" },
          { name: "db2", host: "db2", port: 5432, guestIp: "10.201.0.1" },
        ],
      }),
    ).toEqual([expect.stringContaining("assigned twice")]);
  });

  it("puts a workspace behind a proxy for restricted egress or any brokered secret only", () => {
    expect(needsEgressProxy({ networkPolicy: { mode: "standard", policyHash: "h" } })).toBe(false);
    expect(needsEgressProxy({ networkPolicy: { mode: "restricted", policyHash: "h" } })).toBe(true);
    expect(needsEgressProxy({ brokeredSecrets: [secret()] })).toBe(true);
  });
});

describe("policy endpoints' requests", () => {
  it("refuses an update whose secrets have no values", () => {
    const decoded = Schema.decodeUnknownExit(applyWorkspaceNetworkPolicyRequestSchema)({
      ownerUserId: "user_1",
      networkPolicy: { mode: "standard", policyHash: "h" },
      brokeredSecrets: [secret()],
    });
    expect(Exit.isFailure(decoded)).toBe(true);
  });

  it("refuses a revocation that names nothing", () => {
    const decoded = Schema.decodeUnknownExit(revokeWorkspaceAccessRequestSchema)({
      ownerUserId: "user_1",
    });
    expect(Exit.isFailure(decoded)).toBe(true);
    const revoke = Schema.decodeUnknownExit(revokeWorkspaceAccessRequestSchema)({
      ownerUserId: "user_1",
      secretIds: ["psec_vercel"],
    });
    expect(Exit.isSuccess(revoke)).toBe(true);
  });
});

describe("a brokered secret's variable", () => {
  it("may look like a secret, since it is delivered as one", () => {
    expect(brokeredSecretsProblems([secret({ name: "VERCEL_TOKEN" })])).toEqual([]);
  });

  it.each(["GITHUB_TOKEN", "HTTP_PROXY", "SEALANT_CAPTURE_TOKEN"])(
    "may not take the reserved name %s",
    (name) => {
      expect(brokeredSecretsProblems([secret({ name })])).toEqual([
        expect.stringContaining("is reserved"),
      ]);
    },
  );
});
