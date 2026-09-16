import { describe, expect, it } from "vitest";

import {
  INNER_HTTP_FIXTURE_DOCKERFILE,
  innerHttpFailureDiagnosticCommands,
} from "./docker-e2e-fixtures.js";

describe("MicroVM Docker HTTP fixture", () => {
  it("uses a digest-pinned BusyBox image with its verified httpd applet", () => {
    expect(INNER_HTTP_FIXTURE_DOCKERFILE).toContain(
      "FROM busybox:1.37.0@sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0",
    );
    expect(INNER_HTTP_FIXTURE_DOCKERFILE).toContain(
      'CMD ["httpd", "-f", "-p", "8080", "-h", "/site"]',
    );
    expect(INNER_HTTP_FIXTURE_DOCKERFILE).not.toMatch(/FROM alpine|apk add/);
  });

  it("captures bounded state fields and a bounded log tail after readiness failure", () => {
    expect(innerHttpFailureDiagnosticCommands("fixture-http")).toEqual([
      {
        label: "inspect failed inner HTTP fixture",
        executable: "docker",
        args: [
          "inspect",
          "--format",
          "status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} dead={{.State.Dead}}",
          "fixture-http",
        ],
      },
      {
        label: "capture failed inner HTTP fixture logs",
        executable: "docker",
        args: ["logs", "--tail", "50", "fixture-http"],
      },
    ]);
  });
});
