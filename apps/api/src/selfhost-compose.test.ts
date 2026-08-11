import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

const composePath = fileURLToPath(new URL("../../../compose.selfhost.yaml", import.meta.url));

const renderedComposeSchema = z.object({
  services: z.object({
    api: z.object({
      user: z.string(),
      cap_drop: z.array(z.string()),
      security_opt: z.array(z.string()),
      volumes: z.array(
        z.object({
          type: z.string(),
          source: z.string(),
          target: z.string(),
          read_only: z.boolean(),
        }),
      ),
    }),
  }),
});

describe("self-host API control socket access", () => {
  it("renders the least-privilege access required for persisted control sockets", () => {
    const rendered = execFileSync(
      "docker",
      ["compose", "-f", composePath, "config", "--format", "json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-characters",
          WORKSPACE_SSH_GATEWAY_TOKEN: "test-workspace-ssh-gateway-token",
        },
      },
    );
    const compose = renderedComposeSchema.parse(JSON.parse(rendered));

    expect(compose.services.api.user).toBe("0:0");
    expect(compose.services.api.cap_drop).toEqual(["ALL"]);
    expect(compose.services.api.security_opt).toEqual(["no-new-privileges:true"]);
    expect(compose.services.api.volumes).toContainEqual({
      type: "bind",
      source: "/run/sealant/sockets",
      target: "/run/sealant/sockets",
      read_only: true,
    });
    expect(compose.services.api.volumes).not.toContainEqual(
      expect.objectContaining({ target: "/var/run/docker.sock" }),
    );
  });
});
