import { endpointHost } from "./adapter.js";
import { AGENT_HEALTH_ROUTE } from "./agent-contract.js";
import type { MicrovmApi } from "./api.js";
import { safeAgentHealthEvidence } from "./docker-e2e-validation.js";
import type { MicrovmEndpointTokens } from "./endpoint-tokens.js";

export interface PreTerminationHealthEvidence {
  readonly step: "capture authenticated agent health before termination";
  readonly outcome: "failed" | "observed";
  readonly classification: string;
  readonly phase?: "sealantd" | "docker" | undefined;
  readonly reason?: string | undefined;
  readonly exitCode?: number | null | undefined;
  readonly signal?: string | null | undefined;
  readonly booted?: boolean | undefined;
  readonly controlSocket?: boolean | undefined;
  readonly httpStatus?: number | undefined;
}

export interface PreTerminationHealthEvidenceSink {
  readonly record: (event: PreTerminationHealthEvidence) => Promise<void>;
}

const recordBestEffort = async (
  evidence: PreTerminationHealthEvidenceSink,
  event: PreTerminationHealthEvidence,
): Promise<void> => {
  try {
    await evidence.record(event);
  } catch {
    // Diagnostics must never delay or prevent the termination fence.
  }
};

/** Read only the existing authenticated agent health route immediately before VM termination. */
export const captureAuthenticatedAgentHealthBeforeTermination = async (input: {
  readonly api: Pick<MicrovmApi, "getMicrovm">;
  readonly tokens: Pick<MicrovmEndpointTokens, "headers">;
  readonly evidence: PreTerminationHealthEvidenceSink;
  readonly microvmId: string;
  readonly controlBearerToken: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<void> => {
  let description: Awaited<ReturnType<MicrovmApi["getMicrovm"]>>;
  try {
    description = await input.api.getMicrovm(input.microvmId);
  } catch {
    await recordBestEffort(input.evidence, {
      step: "capture authenticated agent health before termination",
      outcome: "failed",
      classification: "provider-observation-failed",
    });
    return;
  }
  if (
    description?.state !== "RUNNING" ||
    description.endpoint === undefined ||
    description.endpoint.trim().length === 0
  ) {
    await recordBestEffort(input.evidence, {
      step: "capture authenticated agent health before termination",
      outcome: "failed",
      classification: "agent-health-endpoint-unavailable",
    });
    return;
  }

  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(
      `https://${endpointHost(description.endpoint)}${AGENT_HEALTH_ROUTE}`,
      {
        method: "GET",
        headers: {
          ...(await input.tokens.headers(input.microvmId)),
          authorization: `Bearer ${input.controlBearerToken}`,
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
  } catch {
    await recordBestEffort(input.evidence, {
      step: "capture authenticated agent health before termination",
      outcome: "failed",
      classification: "agent-health-request-failed",
    });
    return;
  }
  if (response.status !== 200 && response.status !== 503) {
    await recordBestEffort(input.evidence, {
      step: "capture authenticated agent health before termination",
      outcome: "failed",
      classification: "agent-health-http-status",
      httpStatus: response.status,
    });
    return;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    await recordBestEffort(input.evidence, {
      step: "capture authenticated agent health before termination",
      outcome: "failed",
      classification: "agent-health-invalid",
      httpStatus: response.status,
    });
    return;
  }
  const health = safeAgentHealthEvidence(payload);
  await recordBestEffort(input.evidence, {
    step: "capture authenticated agent health before termination",
    outcome: health.classification === "agent-health-invalid" ? "failed" : "observed",
    httpStatus: response.status,
    ...health,
  });
};
