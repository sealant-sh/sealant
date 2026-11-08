import { randomUUID, createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ManagedRuntime } from "effect";
import { expect } from "vitest";
import { z } from "zod";

import { docker } from "../../sealantd/boot.js";
import {
  SealantRuntime,
  SealantRuntimeControlLive,
  type SealantTarget,
} from "../../sealantd/runtime.js";
import { BoatSecret } from "./config.js";
import { createBoatGuestTransport } from "./execution.js";

const secret = () => {
  const parsed = BoatSecret.parse("a".repeat(64));
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
const unused = async (): Promise<never> => {
  throw new Error("unexpected provider call from probe");
};
/** Runs the staged pinned daemon in owned containers; capture data crosses the real session channel. */
export const boatSessionDaemon = async (bundle: string) => {
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  if (uid === undefined || gid === undefined)
    throw new Error("Boat session proof requires Linux and Docker host networking");
  const directory = await mkdtemp(join(tmpdir(), "boat-session-daemon-"));
  const image = `boat-session-proof:${randomUUID()}`;
  const owned = new Set<string>();
  const boots: string[] = [];
  const runtime = ManagedRuntime.make(SealantRuntimeControlLive);
  const control = await runtime.runPromise(SealantRuntime);
  let origin: string | undefined;
  let relay: string | undefined;
  const created: string[] = [];
  let current: string | undefined;
  let imageBuilt = false;
  const dispose = async () => {
    await runtime.dispose();
    for (const name of owned) await docker(["rm", "-f", name]);
    for (const name of created)
      expect(await docker(["ps", "-aq", "--filter", `name=^/${name}$`])).toBe("");
    if (imageBuilt) {
      await docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--mount",
        `type=bind,src=${directory},dst=/proof`,
        image,
        "chown",
        "-R",
        `${uid}:${gid}`,
        "/proof",
      ]);
      await docker(["image", "rm", image]);
    }
    await rm(directory, { recursive: true });
  };
  try {
    await writeFile(
      join(directory, "Dockerfile"),
      `FROM node:24-bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git socat && rm -rf /var/lib/apt/lists/*\n`,
    );
    await docker(["build", "-t", image, directory]);
    imageBuilt = true;
    await copyFile(join(bundle, "sealantd"), join(directory, "sealantd"));
    await chmod(join(directory, "sealantd"), 0o755);
    await copyFile(join(bundle, "control-relay.cjs"), join(directory, "control-relay.cjs"));
  } catch (error) {
    await dispose();
    throw error;
  }
  const material = (target: SealantTarget): SealantTarget => {
    if (target.kind !== "websocket" || origin === undefined)
      throw new Error("missing daemon relay");
    const url = `${origin}/sealant/control`;
    return { ...target, url, prepare: async () => ({ ...(await target.prepare?.()), url }) };
  };
  return {
    boots,
    control: { ...control, connect: (target: SealantTarget) => control.connect(material(target)) },
    probe: async (bearer: BoatSecret) => {
      if (origin === undefined) throw new Error("probe before daemon start");
      return createBoatGuestTransport(
        { get: unused, execute: unused, hostControl: unused },
        control,
      ).probe({ origin, cookie: secret() }, bearer);
    },
    start: async (stage: string) => {
      const files = z
        .object({
          files: z.array(
            z.object({ name: z.string(), data: z.string(), size: z.number(), sha256: z.string() }),
          ),
        })
        .parse(JSON.parse(stage)).files;
      const bytes = (name: string) => {
        const file = files.find((f) => f.name === name);
        if (file === undefined) throw new Error(`missing ${name}`);
        const data = Buffer.from(file.data, "base64");
        expect(data.length).toBe(file.size);
        expect(createHash("sha256").update(data).digest("hex")).toBe(file.sha256);
        return data;
      };
      const launch = z
        .object({
          format: z.literal("sealant-daemon-launch-v1"),
          boot_env: z.record(z.string(), z.string()),
        })
        .parse(JSON.parse(bytes("launch").toString()));
      const index = boots.length;
      const root = join(directory, String(index));
      await mkdir(root);
      await mkdir(join(root, "workspace"));
      await mkdir(join(root, "sockets"));
      await writeFile(join(root, "secret-env"), bytes("secret-env"), { mode: 0o600 });
      const name = `boat-session-proof-${randomUUID()}`;
      owned.add(name);
      created.push(name);
      boots.push(name);
      current = name;
      await docker([
        "run",
        "-d",
        "--name",
        name,
        "--label",
        "sealant-proof=boat-first-launch",
        "--network",
        "host",
        "--mount",
        `type=bind,src=${directory}/sealantd,dst=/usr/local/bin/sealantd,readonly`,
        "--mount",
        `type=bind,src=${directory}/control-relay.cjs,dst=/usr/local/lib/sealant/control-relay.cjs,readonly`,
        "--mount",
        `type=bind,src=${root}/workspace,dst=/workspace`,
        "--mount",
        `type=bind,src=${root}/sockets,dst=/run/sealant`,
        "--mount",
        `type=bind,src=${root}/secret-env,dst=/run/sealant-inputs/secret-env,readonly`,
        ...Object.entries({
          ...launch.boot_env,
          SEALANT_CAPTURE_ALLOW_PLAINTEXT: "1",
          SEALANT_CONTROL_SOCKET: "/run/sealant/control.sock",
        }).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        "--entrypoint",
        "/usr/local/bin/sealantd",
        image,
        "boot",
      ]);
      let ready = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((await docker(["inspect", "--format", "{{.State.Running}}", name])) !== "true")
          throw new Error(`daemon boot failed: ${await docker(["logs", name])}`);
        try {
          await docker(["exec", name, "test", "-S", "/run/sealant/control.sock"]);
          ready = true;
          break;
        } catch {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
      }
      if (!ready) throw new Error(`daemon not ready: ${await docker(["logs", name])}`);

      const port = createServer();
      await new Promise<void>((resolve) => port.listen(0, "127.0.0.1", resolve));
      const address = port.address();
      if (address === null || typeof address === "string") throw new Error("missing relay port");
      await new Promise<void>((resolve) => port.close(() => resolve()));
      origin = `http://127.0.0.1:${address.port}`;
      await docker([
        "exec",
        name,
        "sh",
        "-c",
        `umask 077; printf '%s' '${secret().reveal()}' > /run/sealant/relay.token`,
      ]);
      // The guest relay lives outside the daemon's FINAL process sweep. A separate PID namespace
      // models that protected service without giving the fixture host root or changing its uid.
      relay = `boat-session-relay-${randomUUID()}`;
      owned.add(relay);
      created.push(relay);
      await docker([
        "run",
        "-d",
        "--name",
        relay,
        "--label",
        "sealant-proof=boat-first-launch",
        "--network",
        "host",
        "--mount",
        `type=bind,src=${root}/sockets,dst=/run/sealant`,
        "--mount",
        `type=bind,src=${directory}/control-relay.cjs,dst=/relay.cjs,readonly`,
        image,
        "node",
        "/relay.cjs",
        "--socket",
        "/run/sealant/control.sock",
        "--token-file",
        "/run/sealant/relay.token",
        "--port",
        String(address.port),
      ]);
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          const reply = await fetch(`${origin}/sealant/health`, {
            headers: { Authorization: `Bearer ${secret().reveal()}` },
          });
          await reply.body?.cancel();
          if (reply.ok) return;
        } catch {
          /* The owned relay has not bound its port yet. */
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("relay failed to start");
    },
    remove: async () => {
      if (current === undefined) throw new Error("delete without a daemon");
      await docker(["rm", "-f", current]);
      owned.delete(current);
      current = undefined;
      if (relay !== undefined) {
        await docker(["rm", "-f", relay]);
        owned.delete(relay);
        relay = undefined;
      }
    },
    dispose,
  };
};
