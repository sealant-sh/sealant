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

/**
 * A bound on one API call: aborting it stops the SDK's retries and the request in flight, so no
 * request of it is signed (or sent) after the signal fires (review 9 #5).
 */
export interface MicrovmCallOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface MicrovmApi {
  readonly runMicrovm: (input: MicrovmRunInput) => Promise<MicrovmDescription>;
  /** Undefined when the platform no longer knows the id (ResourceNotFoundException). */
  readonly getMicrovm: (
    microvmId: string,
    options?: MicrovmCallOptions,
  ) => Promise<MicrovmDescription | undefined>;
  /**
   * Idempotent on the platform side; `not-found` only when the id is unknown outright. The API
   * names no operation to ask about later and takes no condition or client token: a call that
   * failed without the service's answer has an outcome only `getMicrovm` can tell afterwards
   * (`TERMINATING`/`TERMINATED`: it was taken), and a request can act only while its SigV4
   * signature is accepted (review 9 #5). ONE transport attempt, never retried inside the call
   * (review 10 #3): the answer it fails with is the answer to the only request sent, so a refusal
   * says something about every request of it (`isServiceRefusal`).
   */
  readonly terminateMicrovm: (
    microvmId: string,
    options?: MicrovmCallOptions,
  ) => Promise<"terminated" | "not-found">;
  /** The `X-aws-proxy-auth` value for the given VM and port. */
  readonly createAuthToken: (input: MicrovmAuthTokenInput) => Promise<string>;
}

/**
 * The errors TerminateMicrovm documents as client faults the service answers WITHOUT acting on
 * the request: it refused it (access, a conflict with the VM's state, throttling, validation).
 * `ResourceNotFoundException` is not among them: the adapter reads it as `not-found`.
 */
const TERMINATE_REFUSALS: ReadonlySet<string> = new Set([
  "AccessDeniedException",
  "ConflictException",
  "ThrottlingException",
  "ValidationException",
]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/**
 * Whether a failed TerminateMicrovm call is the service's DEFINITIVE refusal of it (review 9 #5,
 * review 10 #3): the service answered with a 4xx it documents as not acting
 * (`TERMINATE_REFUSALS`), AND that answer was to the call's only request — the SDK's attempt
 * count says exactly one was sent. An SDK retries transient failures inside one call, and its
 * final answer describes only its final request: an earlier one may have reached the service and
 * lost its reply, so a refusal after a retry proves nothing about it. A 5xx, a transport error, a
 * timeout, an abort, an undocumented error, or an attempt count that is missing or above one is
 * not definitive: the platform may have acted.
 */
export const isServiceRefusal = (error: unknown): boolean => {
  if (!isRecord(error) || !isRecord(error["$metadata"])) {
    return false;
  }
  const metadata = error["$metadata"];
  const status = metadata["httpStatusCode"];
  const name = error["name"];
  return (
    metadata["attempts"] === 1 &&
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    typeof name === "string" &&
    TERMINATE_REFUSALS.has(name)
  );
};

/**
 * Raised in place of a second request of one TerminateMicrovm call (review 10 #3): whatever the
 * client's retry policy, a removal is sent at most once per call, so its outcome is either the
 * service's answer to that one request or unknown.
 */
export class TerminateNotRepeatedError extends Error {
  override readonly name = "TerminateNotRepeatedError";
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
  // TerminateMicrovm is sent with no retries (review 10 #3): its own client, one attempt. A
  // client handed in keeps its policy for everything else; its terminations are held to one
  // request by the send-once step below.
  const terminateClient =
    options.client ?? new LambdaMicrovmsClient({ region: options.region, maxAttempts: 1 });
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
    getMicrovm: async (microvmId, call) => {
      try {
        return toDescription(
          await client.send(
            new GetMicrovmCommand({ microvmIdentifier: microvmId }),
            call?.signal === undefined ? {} : { abortSignal: call.signal },
          ),
        );
      } catch (error) {
        if (isResourceNotFound(error)) {
          return undefined;
        }
        throw error;
      }
    },
    terminateMicrovm: async (microvmId, call) => {
      const command = new TerminateMicrovmCommand({ microvmIdentifier: microvmId });
      // The innermost step of the call, under any retry policy: its first request goes out, a
      // second is never sent — it fails the call instead, as an outcome nobody knows.
      let sent = 0;
      command.middlewareStack.add(
        (next) => async (args) => {
          sent += 1;
          if (sent > 1) {
            throw new TerminateNotRepeatedError(
              `TerminateMicrovm for ${microvmId} is sent once per call; its first request failed without a definitive answer, so its outcome is unknown.`,
            );
          }
          return next(args);
        },
        { step: "deserialize", priority: "low", name: "sealantTerminateSendOnce" },
      );
      try {
        await terminateClient.send(
          command,
          call?.signal === undefined ? {} : { abortSignal: call.signal },
        );
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
