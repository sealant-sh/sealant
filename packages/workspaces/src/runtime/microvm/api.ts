/**
 * The slice of the Lambda MicroVMs API the adapter uses, behind an interface so every adapter
 * test runs against an in-memory fake and the live implementation is the only file that knows
 * the SDK. Operations (API version 2025-09-09, `@aws-sdk/client-lambda-microvms`):
 *
 *   RunMicrovm             https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html
 *   GetMicrovm             https://docs.aws.amazon.com/lambda/latest/microvm-api/API_GetMicrovm.html
 *   TerminateMicrovm       https://docs.aws.amazon.com/lambda/latest/microvm-api/API_TerminateMicrovm.html
 *   CreateMicrovmAuthToken https://docs.aws.amazon.com/lambda/latest/microvm-api/API_CreateMicrovmAuthToken.html
 *
 * IAM actions carry the `lambda:` prefix (`lambda:RunMicrovm`, `lambda:GetMicrovm`,
 * `lambda:TerminateMicrovm`, `lambda:CreateMicrovmAuthToken`).
 */
import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
  type GetMicrovmCommandOutput,
  type RunMicrovmCommandInput,
} from "@aws-sdk/client-lambda-microvms";

import { PROXY_AUTH_HEADER } from "./agent-contract.js";

/** `MicrovmState` as the API enumerates it. */
export type MicrovmState =
  | "PENDING"
  | "RUNNING"
  | "SUSPENDING"
  | "SUSPENDED"
  | "TERMINATING"
  | "TERMINATED";

export const microvmStates: readonly MicrovmState[] = [
  "PENDING",
  "RUNNING",
  "SUSPENDING",
  "SUSPENDED",
  "TERMINATING",
  "TERMINATED",
];

export const isMicrovmState = (value: string | undefined): value is MicrovmState =>
  value !== undefined && (microvmStates as readonly string[]).includes(value);

/** What Run/GetMicrovm answer, reduced to the fields the adapter reads. */
export interface MicrovmDescription {
  readonly microvmId: string;
  readonly state: MicrovmState;
  /** Bare hostname (`<id>.lambda-microvm.<region>.on.aws`); the SDK sample prepends https://. */
  readonly endpoint?: string | undefined;
  readonly imageArn?: string | undefined;
  readonly maximumDurationInSeconds?: number | undefined;
  readonly startedAt?: Date | undefined;
  readonly terminatedAt?: Date | undefined;
  readonly stateReason?: string | undefined;
}

/** The RunMicrovm request as the adapter builds it (a strict subset of the SDK input). */
export interface MicrovmRunInput {
  readonly imageIdentifier: string;
  readonly imageVersion?: string | undefined;
  readonly executionRoleArn: string;
  readonly ingressNetworkConnectors: readonly string[];
  readonly egressNetworkConnectors?: readonly string[] | undefined;
  readonly idlePolicy: {
    readonly autoResumeEnabled: boolean;
    readonly maxIdleDurationSeconds: number;
    readonly suspendedDurationSeconds: number;
  };
  readonly maximumDurationInSeconds: number;
  readonly logging?: { readonly cloudWatch: { readonly logGroup: string } } | undefined;
  readonly runHookPayload: string;
  /** Idempotency: the same token returns the same MicroVM (a redelivered launch adopts). */
  readonly clientToken: string;
}

export interface MicrovmAuthTokenInput {
  readonly microvmId: string;
  readonly expirationInMinutes: number;
  readonly port: number;
}

export interface MicrovmApi {
  readonly runMicrovm: (input: MicrovmRunInput) => Promise<MicrovmDescription>;
  /** Undefined when the platform no longer knows the id (ResourceNotFoundException). */
  readonly getMicrovm: (microvmId: string) => Promise<MicrovmDescription | undefined>;
  /** Idempotent on the platform side; `not-found` only when the id is unknown outright. */
  readonly terminateMicrovm: (microvmId: string) => Promise<"terminated" | "not-found">;
  /** The `X-aws-proxy-auth` value for the given VM and port. */
  readonly createAuthToken: (input: MicrovmAuthTokenInput) => Promise<string>;
}

const isResourceNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly name?: unknown }).name === "ResourceNotFoundException";

const toDescription = (output: GetMicrovmCommandOutput): MicrovmDescription => {
  if (output.microvmId === undefined || !isMicrovmState(output.state)) {
    throw new Error(
      `Lambda MicroVMs answered without a microvmId/state (id ${String(output.microvmId)}, state ${String(output.state)}).`,
    );
  }
  return {
    microvmId: output.microvmId,
    state: output.state,
    endpoint: output.endpoint,
    imageArn: output.imageArn,
    maximumDurationInSeconds: output.maximumDurationInSeconds,
    startedAt: output.startedAt,
    terminatedAt: output.terminatedAt,
    stateReason: output.stateReason,
  };
};

export interface LiveMicrovmApiOptions {
  readonly region: string;
  /** Test seam / custom endpoints; credentials come from the default provider chain. */
  readonly client?: LambdaMicrovmsClient;
}

export const createLiveMicrovmApi = (options: LiveMicrovmApiOptions): MicrovmApi => {
  const client = options.client ?? new LambdaMicrovmsClient({ region: options.region });
  return {
    runMicrovm: async (input) => {
      const request: RunMicrovmCommandInput = {
        imageIdentifier: input.imageIdentifier,
        ...(input.imageVersion === undefined ? {} : { imageVersion: input.imageVersion }),
        executionRoleArn: input.executionRoleArn,
        ingressNetworkConnectors: [...input.ingressNetworkConnectors],
        ...(input.egressNetworkConnectors === undefined
          ? {}
          : { egressNetworkConnectors: [...input.egressNetworkConnectors] }),
        idlePolicy: { ...input.idlePolicy },
        maximumDurationInSeconds: input.maximumDurationInSeconds,
        logging:
          input.logging === undefined
            ? { disabled: {} }
            : { cloudWatch: { logGroup: input.logging.cloudWatch.logGroup } },
        runHookPayload: input.runHookPayload,
        clientToken: input.clientToken,
      };
      return toDescription(await client.send(new RunMicrovmCommand(request)));
    },
    getMicrovm: async (microvmId) => {
      try {
        return toDescription(
          await client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId })),
        );
      } catch (error) {
        if (isResourceNotFound(error)) {
          return undefined;
        }
        throw error;
      }
    },
    terminateMicrovm: async (microvmId) => {
      try {
        await client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
        return "terminated";
      } catch (error) {
        if (isResourceNotFound(error)) {
          return "not-found";
        }
        throw error;
      }
    },
    createAuthToken: async (input) => {
      const output = await client.send(
        new CreateMicrovmAuthTokenCommand({
          microvmIdentifier: input.microvmId,
          expirationInMinutes: input.expirationInMinutes,
          allowedPorts: [{ port: input.port }],
        }),
      );
      const token = output.authToken?.[PROXY_AUTH_HEADER];
      if (token === undefined || token.length === 0) {
        throw new Error(
          `CreateMicrovmAuthToken for ${input.microvmId} answered without a ${PROXY_AUTH_HEADER} value.`,
        );
      }
      return token;
    },
  };
};
