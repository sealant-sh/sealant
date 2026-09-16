import { describe, expect, it, vi } from "vitest";

import {
  captureAuthenticatedAgentHealthBeforeTermination,
  type PreTerminationHealthEvidence,
} from "./docker-e2e-health.js";

const runningVm = {
  microvmId: "microvm-1",
  state: "RUNNING" as const,
  endpoint: "microvm-1.lambda-microvm.eu-central-1.on.aws",
};

describe("captureAuthenticatedAgentHealthBeforeTermination", () => {
  it("captures strict authenticated Docker failure health without retaining credentials", async () => {
    const events: PreTerminationHealthEvidence[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(
        "https://microvm-1.lambda-microvm.eu-central-1.on.aws/sealant/health",
      );
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer control-token");
      expect(headers.get("x-aws-proxy-auth")).toBe("endpoint-token");
      return new Response(
        JSON.stringify({
          version: 2,
          booted: false,
          controlSocket: false,
          services: {
            docker: { status: "failed", reason: "readiness-timeout", code: 1, signal: null },
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    });

    await captureAuthenticatedAgentHealthBeforeTermination({
      api: { getMicrovm: async () => runningVm },
      tokens: {
        headers: async () => ({
          "x-aws-proxy-auth": "endpoint-token",
          "x-aws-proxy-port": "8080",
        }),
      },
      evidence: { record: async (event) => void events.push(event) },
      microvmId: runningVm.microvmId,
      controlBearerToken: "control-token",
      fetchImpl,
    });

    expect(events).toEqual([
      {
        step: "capture authenticated agent health before termination",
        outcome: "observed",
        classification: "agent-health-docker-failed",
        phase: "docker",
        reason: "readiness-timeout",
        exitCode: 1,
        signal: null,
        booted: false,
        controlSocket: false,
        httpStatus: 503,
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/endpoint-token|control-token/);
  });

  it("records only a fixed classification for an invalid health body", async () => {
    const events: PreTerminationHealthEvidence[] = [];
    await captureAuthenticatedAgentHealthBeforeTermination({
      api: { getMicrovm: async () => runningVm },
      tokens: { headers: async () => ({}) },
      evidence: { record: async (event) => void events.push(event) },
      microvmId: runningVm.microvmId,
      controlBearerToken: "control-token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            version: 2,
            booted: false,
            controlSocket: false,
            services: {
              docker: {
                status: "failed",
                reason: "raw-log control-token",
                code: 1,
                signal: "mst_secret",
              },
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    });

    expect(events).toEqual([
      {
        step: "capture authenticated agent health before termination",
        outcome: "failed",
        classification: "agent-health-invalid",
        httpStatus: 503,
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/raw-log|control-token|mst_secret/);
  });

  it("never lets evidence persistence failure block termination", async () => {
    await expect(
      captureAuthenticatedAgentHealthBeforeTermination({
        api: { getMicrovm: async () => undefined },
        tokens: { headers: async () => ({}) },
        evidence: {
          record: async () => {
            throw new Error("evidence disk failed");
          },
        },
        microvmId: runningVm.microvmId,
        controlBearerToken: "control-token",
      }),
    ).resolves.toBeUndefined();
  });
});
