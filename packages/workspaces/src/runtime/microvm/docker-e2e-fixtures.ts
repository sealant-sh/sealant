export const INNER_HTTP_FIXTURE_DOCKERFILE = [
  "FROM busybox:1.37.0@sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0",
  "RUN mkdir -p /site && printf 'microvm-docker-e2e-ok\\n' > /site/index.html",
  "WORKDIR /site",
  'CMD ["httpd", "-f", "-p", "8080", "-h", "/site"]',
].join("\n");

export interface InnerHttpFailureDiagnosticCommand {
  readonly label: string;
  readonly executable: "docker";
  readonly args: readonly string[];
}

export const innerHttpFailureDiagnosticCommands = (
  containerName: string,
): readonly InnerHttpFailureDiagnosticCommand[] => [
  {
    label: "inspect failed inner HTTP fixture",
    executable: "docker",
    args: [
      "inspect",
      "--format",
      "status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} dead={{.State.Dead}}",
      containerName,
    ],
  },
  {
    label: "capture failed inner HTTP fixture logs",
    executable: "docker",
    args: ["logs", "--tail", "50", containerName],
  },
];
