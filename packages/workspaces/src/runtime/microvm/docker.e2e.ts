/**
 * Opt-in live-provider proof for guest-local Docker in a Lambda MicroVM.
 *
 * This spec is excluded from normal unit tests and remains skipped unless the caller explicitly
 * sets `SEALANT_MICROVM_DOCKER_E2E=1`. Before creating a VM it also requires exact expected AWS
 * account, region, and exact candidate-image ARN/version, then checks them against the standard
 * runtime configuration. This only checks account/region coordinates embedded in configured ARNs; it does
 * not attest the ambient AWS principal. The coordinator's parent preflight must verify the actual
 * caller with STS before invoking Vitest. A coordinator may load variables from a private file;
 * this file never reads or prints that file, credentials, endpoint tokens, or raw errors. Set
 * `SEALANT_MICROVM_DOCKER_E2E_OUTPUT_FILE` to retain a private 0600 JSON record of safe step
 * classifications and bounded output from this file's fixed fixture commands.
 *
 * The enabled suite creates exactly one VM with a 900-second maximum duration. It uses the real
 * adapter and AWS API plus the public sealantd target/runtime helpers. Do not run this test as part
 * of CI or image builds: it incurs provider usage and deliberately stops dockerd near the end.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  SealantRuntime,
  SealantRuntimeControlLive,
  type SealantTarget,
} from "../../sealantd/runtime.js";
import { execInWorkspace, sealantTargetForRuntimeInstance } from "../../sealantd/target.js";
import {
  parseRuntimeAdapterLaunchInput,
  type RuntimeAdapterLaunchResult,
} from "../runtime-adapter.js";
import { MicrovmRuntimeAdapter } from "./adapter.js";
import { createLiveMicrovmApi, type MicrovmApi } from "./api.js";
import { microvmRuntimeConfigFromEnv, type MicrovmRuntimeConfig } from "./config.js";
import {
  INNER_HTTP_FIXTURE_DOCKERFILE,
  innerHttpFailureDiagnosticCommands,
} from "./docker-e2e-fixtures.js";
import { captureAuthenticatedAgentHealthBeforeTermination } from "./docker-e2e-health.js";
import {
  matchesExpectedMicrovmDockerCandidate,
  runNestedDnsAcceptanceProbes,
  safeErrorEvidence,
} from "./docker-e2e-validation.js";
import { MicrovmEndpointTokens } from "./endpoint-tokens.js";

const E2E_ENABLED = process.env.SEALANT_MICROVM_DOCKER_E2E === "1";
const FIXTURE_PREFIX = "sealant-microvm-docker-e2e";
const WORKING_DIRECTORY = "/workspace/repo";
const INNER_HTTP_PORT = 18_080;
const EVIDENCE_OUTPUT_MAX_BYTES = 4_096;

interface EvidenceEvent {
  readonly at: string;
  readonly step: string;
  readonly outcome: "passed" | "failed" | "observed";
  readonly classification?: string | undefined;
  readonly code?: string | undefined;
  readonly phase?: "protocol" | "sealantd" | "docker" | undefined;
  readonly reason?: string | undefined;
  readonly exitCode?: number | null | undefined;
  readonly signal?: string | null | undefined;
  readonly booted?: boolean | undefined;
  readonly controlSocket?: boolean | undefined;
  readonly httpStatus?: number | undefined;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
}

interface EvidenceRecorder {
  readonly setResourceId: (resourceId: string) => Promise<void>;
  readonly record: (event: Omit<EvidenceEvent, "at">) => Promise<void>;
}

const boundedFixtureOutput = (value: string): string =>
  Buffer.from(value, "utf8").subarray(0, EVIDENCE_OUTPUT_MAX_BYTES).toString("utf8");

const createEvidenceRecorder = async (input: {
  readonly fixtureId: string;
  readonly candidateImageArn: string;
  readonly candidateImageVersion: string;
}): Promise<EvidenceRecorder> => {
  const outputFile = process.env.SEALANT_MICROVM_DOCKER_E2E_OUTPUT_FILE?.trim();
  let resourceId: string | undefined;
  const events: EvidenceEvent[] = [];
  const persist = async (): Promise<void> => {
    if (outputFile === undefined || outputFile.length === 0) {
      return;
    }
    await mkdir(dirname(outputFile), { recursive: true, mode: 0o700 });
    const temporary = `${outputFile}.${String(process.pid)}.tmp`;
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(
        `${JSON.stringify({
          version: 1,
          fixtureId: input.fixtureId,
          candidateImage: {
            arn: input.candidateImageArn,
            version: input.candidateImageVersion,
          },
          ...(resourceId === undefined ? {} : { resourceId }),
          events,
        })}\n`,
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    let renamed = false;
    try {
      await rename(temporary, outputFile);
      renamed = true;
    } catch {
      // Report only the fixed evidence failure below.
    }
    if (!renamed) {
      try {
        await unlink(temporary);
      } catch {
        // The private temporary either remained mode 0600 or was already removed.
      }
      throw new Error("Could not persist private MicroVM Docker E2E evidence.");
    }
  };

  await persist();
  return {
    setResourceId: async (value) => {
      resourceId = value;
      await persist();
    },
    record: async (event) => {
      events.push({ ...event, at: new Date().toISOString() });
      await persist();
    },
  };
};

const recordEvidence = async (
  evidence: EvidenceRecorder,
  event: Omit<EvidenceEvent, "at">,
): Promise<void> => {
  try {
    await evidence.record(event);
  } catch {
    throw new Error("MicroVM Docker E2E could not update its private evidence file.");
  }
};

const requiredEnvironment = (key: string): string => {
  const value = process.env[key]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${key} is required for the explicitly enabled MicroVM Docker E2E test.`);
  }
  return value;
};

const arnCoordinates = (
  arn: string,
): { readonly region: string; readonly accountId: string } | undefined => {
  const parts = arn.split(":");
  const region = parts[3];
  const accountId = parts[4];
  if (parts[0] !== "arn" || region === undefined || accountId === undefined) {
    return undefined;
  }
  return { region, accountId };
};

const e2eConfig = (): MicrovmRuntimeConfig => {
  const expectedAccountId = requiredEnvironment("SEALANT_MICROVM_DOCKER_E2E_EXPECTED_ACCOUNT_ID");
  const expectedRegion = requiredEnvironment("SEALANT_MICROVM_DOCKER_E2E_EXPECTED_REGION");
  const expectedImageArn = requiredEnvironment("SEALANT_MICROVM_DOCKER_E2E_EXPECTED_CANDIDATE_ARN");
  const expectedImageVersion = requiredEnvironment(
    "SEALANT_MICROVM_DOCKER_E2E_EXPECTED_CANDIDATE_VERSION",
  );
  const configuredRegion = requiredEnvironment("SEALANT_MICROVM_REGION");
  const configuredImageArn = requiredEnvironment("SEALANT_MICROVM_IMAGE_ARN");
  const configuredDockerImageArn = requiredEnvironment("SEALANT_MICROVM_DOCKER_IMAGE_ARN");
  const configuredDockerImageVersion = requiredEnvironment("SEALANT_MICROVM_DOCKER_IMAGE_VERSION");
  const executionRoleArn = requiredEnvironment("SEALANT_MICROVM_EXEC_ROLE_ARN");
  const egressConnector = requiredEnvironment("SEALANT_MICROVM_EGRESS_CONNECTOR");
  const controlBearerToken = requiredEnvironment("SEALANT_CONTROL_BEARER_TOKEN");

  const dockerCoordinates = arnCoordinates(configuredDockerImageArn);
  const roleCoordinates = arnCoordinates(executionRoleArn);
  if (
    configuredRegion !== expectedRegion ||
    !matchesExpectedMicrovmDockerCandidate({
      configuredArn: configuredDockerImageArn,
      configuredVersion: configuredDockerImageVersion,
      expectedArn: expectedImageArn,
      expectedVersion: expectedImageVersion,
    }) ||
    dockerCoordinates?.region !== expectedRegion ||
    dockerCoordinates.accountId !== expectedAccountId ||
    roleCoordinates?.accountId !== expectedAccountId
  ) {
    throw new Error(
      "MicroVM Docker E2E opt-in values do not exactly match the configured account, region, candidate image, and execution role.",
    );
  }

  let config: MicrovmRuntimeConfig | undefined;
  try {
    config = microvmRuntimeConfigFromEnv({
      SEALANT_MICROVM_REGION: configuredRegion,
      SEALANT_MICROVM_IMAGE_ARN: configuredImageArn,
      ...(process.env.SEALANT_MICROVM_IMAGE_VERSION === undefined
        ? {}
        : { SEALANT_MICROVM_IMAGE_VERSION: process.env.SEALANT_MICROVM_IMAGE_VERSION }),
      SEALANT_MICROVM_DOCKER_IMAGE_ARN: configuredDockerImageArn,
      SEALANT_MICROVM_DOCKER_IMAGE_VERSION: configuredDockerImageVersion,
      SEALANT_MICROVM_EXEC_ROLE_ARN: executionRoleArn,
      SEALANT_MICROVM_EGRESS_CONNECTOR: egressConnector,
      ...(process.env.SEALANT_MICROVM_INGRESS_CONNECTOR === undefined
        ? {}
        : { SEALANT_MICROVM_INGRESS_CONNECTOR: process.env.SEALANT_MICROVM_INGRESS_CONNECTOR }),
      SEALANT_MICROVM_MAX_DURATION_SECONDS: 900,
      SEALANT_MICROVM_READINESS_TIMEOUT_MS: 300_000,
      SEALANT_MICROVM_TERMINATE_TIMEOUT_MS: 120_000,
      SEALANT_CONTROL_BEARER_TOKEN: controlBearerToken,
    });
  } catch {
    throw new Error("The explicitly enabled MicroVM Docker E2E runtime configuration is invalid.");
  }
  if (config === undefined) {
    throw new Error("The explicitly enabled MicroVM Docker E2E runtime configuration is absent.");
  }
  return config;
};

type CapturedOperation<A> =
  | { readonly succeeded: true; readonly value: A }
  | { readonly succeeded: false; readonly error: unknown };

const captureOperation = <A>(operation: Promise<A>): Promise<CapturedOperation<A>> =>
  operation.then(
    (value): CapturedOperation<A> => ({ succeeded: true, value }),
    (error: unknown): CapturedOperation<A> => ({ succeeded: false, error }),
  );

const safeStep = async <A>(
  label: string,
  operation: () => Promise<A>,
  evidence: EvidenceRecorder,
): Promise<A> => {
  const captured = await captureOperation(operation());
  if (!captured.succeeded) {
    await recordEvidence(evidence, {
      step: label,
      outcome: "failed",
      ...safeErrorEvidence(captured.error),
    });
    throw new Error(`MicroVM Docker E2E step failed: ${label}.`);
  }
  await recordEvidence(evidence, { step: label, outcome: "passed" });
  return captured.value;
};

const execChecked = async (
  target: SealantTarget,
  label: string,
  executable: string,
  args: readonly string[],
  evidence: EvidenceRecorder,
): Promise<string> => {
  const captured = await captureOperation(
    Effect.runPromise(
      execInWorkspace(target, {
        executable: "bash",
        args: [
          "-c",
          'stdout_file="/tmp/sealant-e2e-stdout.$$"; stderr_file="/tmp/sealant-e2e-stderr.$$"; "$@" >"$stdout_file" 2>"$stderr_file"; command_code=$?; printf "%s\\n" "$command_code"; base64 -w 0 "$stdout_file"; printf "\\n"; base64 -w 0 "$stderr_file"; printf "\\n"; rm -f "$stdout_file" "$stderr_file"; exit 0',
          "sealant-e2e-command",
          executable,
          ...args,
        ],
        cwd: WORKING_DIRECTORY,
      }).pipe(Effect.provide(SealantRuntimeControlLive)),
    ),
  );
  if (!captured.succeeded) {
    await recordEvidence(evidence, {
      step: label,
      outcome: "failed",
      ...safeErrorEvidence(captured.error),
    });
    throw new Error(`MicroVM Docker E2E step failed: ${label}.`);
  }
  const wrapperResult = captured.value;
  const [exitCodeText, encodedStdout, encodedStderr] = wrapperResult.stdout.split("\n");
  if (
    wrapperResult.exitCode !== 0 ||
    exitCodeText === undefined ||
    !/^\d+$/.test(exitCodeText) ||
    encodedStdout === undefined ||
    encodedStderr === undefined
  ) {
    await recordEvidence(evidence, {
      step: label,
      outcome: "failed",
      classification: "fixture-command-wrapper-failed",
    });
    throw new Error(`MicroVM Docker E2E command wrapper failed: ${label}.`);
  }
  const exitCode = Number(exitCodeText);
  const commandStdout = Buffer.from(encodedStdout, "base64").toString("utf8");
  const commandStderr = Buffer.from(encodedStderr, "base64").toString("utf8");
  const stdout = boundedFixtureOutput(commandStdout);
  const stderr = boundedFixtureOutput(commandStderr);
  await recordEvidence(evidence, {
    step: label,
    outcome: exitCode === 0 ? "passed" : "failed",
    exitCode,
    ...(stdout.length === 0 ? {} : { stdout }),
    ...(stderr.length === 0 ? {} : { stderr }),
  });
  if (exitCode !== 0) {
    throw new Error(`MicroVM Docker E2E command returned non-zero: ${label}.`);
  }
  return commandStdout.trim();
};

const fetchInnerHttp = async (target: SealantTarget, evidence: EvidenceRecorder): Promise<string> =>
  safeStep(
    "authenticated control forwarding",
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* SealantRuntime;
            const session = yield* runtime.connect(target);
            const forward = yield* session.openForward(INNER_HTTP_PORT);
            return yield* Effect.promise(async () => {
              forward.channel.write(
                new TextEncoder().encode(
                  "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
                ),
              );
              forward.channel.end();
              const chunks: Uint8Array[] = [];
              const iterator = forward.channel[Symbol.asyncIterator]();
              for (;;) {
                const next = await iterator.next();
                if (next.done) {
                  break;
                }
                chunks.push(next.value);
              }
              return Buffer.concat(chunks).toString("utf8");
            });
          }),
        ).pipe(Effect.provide(SealantRuntimeControlLive), Effect.timeout("10 seconds")),
      ),
    evidence,
  );

const captureInnerHttpFailureDiagnostics = async (
  target: SealantTarget,
  containerName: string,
  evidence: EvidenceRecorder,
): Promise<void> => {
  for (const command of innerHttpFailureDiagnosticCommands(containerName)) {
    try {
      await execChecked(target, command.label, command.executable, command.args, evidence);
    } catch {
      // Each fixed command records bounded stdout/stderr when available; attempt both diagnostics.
    }
  }
};

const waitForInnerHttpReady = async (
  target: SealantTarget,
  containerName: string,
  evidence: EvidenceRecorder,
): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const body = await execChecked(
        target,
        "probe inner HTTP fixture",
        "docker",
        ["exec", containerName, "wget", "-qO-", "http://127.0.0.1:8080/"],
        evidence,
      );
      if (body === "microvm-docker-e2e-ok") {
        return;
      }
    } catch {
      // Container start and its listener becoming ready are separate events; retry a safe probe.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  await captureInnerHttpFailureDiagnostics(target, containerName, evidence);
  await recordEvidence(evidence, {
    step: "probe inner HTTP fixture",
    outcome: "failed",
    classification: "deadline-exceeded",
  });
  throw new Error("MicroVM Docker E2E inner HTTP fixture did not become ready in time.");
};

const waitForDockerFailure = async (
  adapter: MicrovmRuntimeAdapter,
  resourceId: string,
  evidence: EvidenceRecorder,
): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let status: Awaited<ReturnType<MicrovmRuntimeAdapter["inspect"]>>;
    try {
      status = await adapter.inspect({ resourceId });
    } catch {
      // Endpoint and provider observation can be transient; never expose the raw error.
      await recordEvidence(evidence, {
        step: "inspect guest Docker failure",
        outcome: "observed",
        classification: "transient-observation-error",
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    if (status.state === "exited") {
      // Only the authenticated guest Docker failure is success. A provider/TTL exit must fail.
      if (!status.detail?.includes("Guest-local Docker failed")) {
        await recordEvidence(evidence, {
          step: "inspect guest Docker failure",
          outcome: "failed",
          classification: "non-docker-runtime-exit",
          ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
        });
        throw new Error("MicroVM Docker E2E observed a non-Docker runtime exit.");
      }
      await recordEvidence(evidence, {
        step: "inspect guest Docker failure",
        outcome: "passed",
        classification: "guest-docker-failed",
        ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  await recordEvidence(evidence, {
    step: "inspect guest Docker failure",
    outcome: "failed",
    classification: "deadline-exceeded",
  });
  throw new Error("MicroVM Docker E2E did not observe guest-local Docker failure in time.");
};

describe.skipIf(!E2E_ENABLED)("Lambda MicroVM guest-local Docker (live provider)", () => {
  it("runs Docker workflows and reports daemon loss through the authenticated control plane", async () => {
    const config = e2eConfig();
    const candidateImage = config.dockerImage;
    if (candidateImage === undefined) {
      throw new Error("MicroVM Docker E2E needs a configured candidate image.");
    }
    const fixtureId = `${FIXTURE_PREFIX}-${randomUUID().slice(0, 8)}`;
    let evidence: EvidenceRecorder;
    try {
      evidence = await createEvidenceRecorder({
        fixtureId,
        candidateImageArn: candidateImage.arn,
        candidateImageVersion: candidateImage.version,
      });
    } catch {
      throw new Error("MicroVM Docker E2E could not initialize its private evidence file.");
    }
    const liveApi = createLiveMicrovmApi({ region: config.region });
    const tokens = new MicrovmEndpointTokens({
      api: liveApi,
      port: config.agentPort,
      ttlMinutes: config.endpointTokenTtlMinutes,
      refreshMarginMs: config.endpointTokenRefreshMarginMs,
      webSocketAuth: config.endpointWebSocketAuth,
    });
    const healthCapturedBeforeTermination = new Set<string>();
    let returnedResourceId: string | undefined;
    let runMicrovmCalls = 0;
    const api: MicrovmApi = {
      runMicrovm: async (input) => {
        if (runMicrovmCalls !== 0) {
          throw new Error("MicroVM Docker E2E permits at most one runMicrovm call.");
        }
        runMicrovmCalls += 1;
        const description = await liveApi.runMicrovm(input);
        // Record the exact provider response before returning control to adapter readiness logic.
        returnedResourceId = description.microvmId;
        try {
          await evidence.setResourceId(description.microvmId);
          await recordEvidence(evidence, {
            step: "runMicrovm returned",
            outcome: "observed",
            classification: "provider-resource-created",
          });
        } catch {
          throw new Error("MicroVM Docker E2E could not retain the returned resource ID.");
        }
        return description;
      },
      getMicrovm: liveApi.getMicrovm,
      terminateMicrovm: async (microvmId) => {
        if (!healthCapturedBeforeTermination.has(microvmId)) {
          healthCapturedBeforeTermination.add(microvmId);
          try {
            await captureAuthenticatedAgentHealthBeforeTermination({
              api: liveApi,
              tokens,
              evidence,
              microvmId,
              controlBearerToken: config.controlBearerToken,
            });
          } catch {
            // Diagnostic capture is best-effort and must never prevent provider termination.
          }
        }
        return liveApi.terminateMicrovm(microvmId);
      },
      createAuthToken: liveApi.createAuthToken,
    };
    const adapter = new MicrovmRuntimeAdapter({ config, api });
    const image = `${fixtureId}:fixture`;
    const composeProject = `${fixtureId}-compose`;
    const httpContainer = `${fixtureId}-http`;
    let launched: RuntimeAdapterLaunchResult | undefined;

    try {
      const active = await safeStep(
        "launch one Docker-capable VM",
        () =>
          adapter.launch(
            parseRuntimeAdapterLaunchInput({
              runId: fixtureId,
              blueprint: {
                version: "1",
                sources: {
                  workspace: {
                    kind: "git",
                    provider: "generic",
                    url: "https://github.com/octocat/Hello-World.git",
                    ref: "master",
                  },
                  inputs: [],
                  mounts: [],
                },
                harness: { id: "opencode" },
                access: { ssh: { enabled: false, listenPort: 2222 } },
                tooling: { packages: [], services: { docker: { enabled: true } } },
                customization: {
                  defaultShell: "bash",
                  dotfilesManager: "auto",
                  dotfilesTarget: "home",
                  applyDotfiles: false,
                  dotfilesBootstrap: false,
                },
                lifecycle: {
                  setup: [],
                  startup: {
                    steps: [],
                    foreground: { kind: "command", run: "sleep 840", shell: "bash" },
                  },
                },
                runtime: {
                  env: {},
                  credentialRefs: [],
                  workspaceRoot: "/workspace",
                  workingDirectory: WORKING_DIRECTORY,
                  persistence: "ephemeral",
                  ociRuntime: "runc",
                  network: { outbound: true },
                },
                target: {
                  os: { family: "auto", mode: "prefer" },
                  runtime: { family: "microvm", mode: "require" },
                },
              },
              publishedImage: {
                repository: `${FIXTURE_PREFIX}/unused`,
                tag: "fixture",
                reference: `${FIXTURE_PREFIX}:unused`,
                digestReference: `${FIXTURE_PREFIX}@sha256:e2e-fixture`,
                digest: "sha256:e2e-fixture",
              },
            }),
          ),
        evidence,
      );
      launched = active;

      const target = sealantTargetForRuntimeInstance(
        {
          adapter: "microvm",
          resourceId: active.resourceId,
          endpoint: active.endpoint ?? null,
        },
        {
          controlBearerToken: config.controlBearerToken,
          microvmConnectMaterial: (microvmId) => tokens.connectMaterial(microvmId),
        },
      );
      if (target === undefined) {
        await recordEvidence(evidence, {
          step: "derive authenticated control target",
          outcome: "failed",
          classification: "target-unavailable",
        });
        throw new Error("MicroVM Docker E2E could not derive an authenticated control target.");
      }
      await recordEvidence(evidence, {
        step: "derive authenticated control target",
        outcome: "passed",
      });

      expect(
        await execChecked(
          target,
          "verify Docker env inheritance",
          "bash",
          [
            "-lc",
            'test "$DOCKER_HOST" = "unix:///run/docker/docker.sock" && test -z "$DOCKER_CONTEXT" && test -z "$DOCKER_TLS_CERTDIR" && test -z "$DOCKER_TLS_VERIFY" && test -z "$DOCKER_CERT_PATH" && printf inherited-ok',
          ],
          evidence,
        ),
      ).toBe("inherited-ok");

      const dockerVersion = await execChecked(
        target,
        "docker info",
        "docker",
        ["info", "--format", "{{.ServerVersion}}"],
        evidence,
      );
      expect(dockerVersion.length).toBeGreaterThan(0);

      await execChecked(
        target,
        "write Docker fixtures",
        "bash",
        [
          "-lc",
          `cat > Dockerfile <<'EOF'\n${INNER_HTTP_FIXTURE_DOCKERFILE}\nEOF\ncat > compose.yaml <<'EOF'\nservices:\n  app:\n    image: ${image}\n    command: ["cat", "/site/index.html"]\nEOF`,
        ],
        evidence,
      );
      await execChecked(
        target,
        "docker build",
        "docker",
        ["build", "--tag", image, WORKING_DIRECTORY],
        evidence,
      );
      expect(
        await execChecked(
          target,
          "docker run",
          "docker",
          ["run", "--rm", image, "cat", "/site/index.html"],
          evidence,
        ),
      ).toBe("microvm-docker-e2e-ok");

      await execChecked(
        target,
        "docker compose",
        "docker",
        [
          "compose",
          "--project-name",
          composeProject,
          "--file",
          `${WORKING_DIRECTORY}/compose.yaml`,
          "up",
          "--abort-on-container-exit",
          "--exit-code-from",
          "app",
        ],
        evidence,
      );
      await execChecked(
        target,
        "docker compose cleanup",
        "docker",
        [
          "compose",
          "--project-name",
          composeProject,
          "--file",
          `${WORKING_DIRECTORY}/compose.yaml`,
          "down",
          "--volumes",
        ],
        evidence,
      );

      await execChecked(
        target,
        "root-owned repository bind write",
        "docker",
        [
          "run",
          "--rm",
          "--volume",
          `${WORKING_DIRECTORY}:/repo`,
          image,
          "sh",
          "-c",
          "printf 'root-owned-ok\\n' > /repo/root-owned-e2e.txt",
        ],
        evidence,
      );
      expect(
        await execChecked(
          target,
          "verify root-owned repository bind write",
          "bash",
          ["-lc", 'test "$(stat -c %u root-owned-e2e.txt)" = 0 && cat root-owned-e2e.txt'],
          evidence,
        ),
      ).toBe("root-owned-ok");

      await execChecked(
        target,
        "start inner published HTTP fixture",
        "docker",
        [
          "run",
          "--detach",
          "--name",
          httpContainer,
          "--publish",
          `127.0.0.1:${String(INNER_HTTP_PORT)}:8080`,
          image,
        ],
        evidence,
      );
      await waitForInnerHttpReady(target, httpContainer, evidence);
      const response = await fetchInnerHttp(target, evidence);
      expect(response).toContain("200 OK");
      expect(response).toContain("microvm-docker-e2e-ok");
      await execChecked(
        target,
        "remove inner published HTTP fixture",
        "docker",
        ["rm", "--force", httpContainer],
        evidence,
      );

      let dockerTcpPortsClosed = true;
      try {
        await execChecked(
          target,
          "verify Docker TCP ports are closed",
          "bash",
          ["-lc", "if ss -ltnH | awk '{print $4}' | grep -Eq '(^|:)(2375|2376)$'; then exit 1; fi"],
          evidence,
        );
      } catch {
        dockerTcpPortsClosed = false;
      }

      const nestedDns = await runNestedDnsAcceptanceProbes(async (mode) => {
        await execChecked(
          target,
          mode === "default"
            ? "nested container default DNS"
            : "diagnose nested DNS with AWS resolver",
          "docker",
          mode === "default"
            ? ["run", "--rm", image, "sh", "-c", "timeout 15 nslookup example.com"]
            : [
                "run",
                "--rm",
                "--dns",
                "169.254.169.253",
                image,
                "sh",
                "-c",
                "timeout 15 nslookup example.com",
              ],
          evidence,
        );
      });
      if (!nestedDns.defaultSucceeded) {
        await recordEvidence(evidence, {
          step: "nested container default DNS",
          outcome: "failed",
          classification:
            nestedDns.diagnosticSucceeded === true
              ? "default-dns-failed-aws-resolver-succeeded"
              : "default-dns-and-aws-resolver-failed",
        });
      }

      await execChecked(
        target,
        "stop guest dockerd",
        "bash",
        ["-lc", 'kill -TERM "$(cat /run/sealant/docker.pid)"'],
        evidence,
      );
      await waitForDockerFailure(adapter, active.resourceId, evidence);
      if (!dockerTcpPortsClosed || !nestedDns.defaultSucceeded) {
        await recordEvidence(evidence, {
          step: "Docker MicroVM fixture",
          outcome: "failed",
          classification: dockerTcpPortsClosed
            ? "default-nested-dns-failed"
            : "docker-tcp-port-listener-detected",
        });
        throw new Error(
          "MicroVM Docker E2E acceptance failed before successful daemon-loss cleanup.",
        );
      }
      await recordEvidence(evidence, {
        step: "Docker MicroVM fixture",
        outcome: "passed",
      });
    } finally {
      const cleanupResourceId = launched?.resourceId ?? returnedResourceId;
      if (cleanupResourceId !== undefined) {
        await safeStep(
          "terminate VM",
          () => adapter.stop({ resourceId: cleanupResourceId, fence: true }),
          evidence,
        );
        const terminated = await safeStep(
          "verify VM termination",
          () => api.getMicrovm(cleanupResourceId),
          evidence,
        );
        expect(terminated?.state).toBe("TERMINATED");
        tokens.forget(cleanupResourceId);
      }
      expect(runMicrovmCalls).toBeLessThanOrEqual(1);
    }
  }, 1_020_000);
});
