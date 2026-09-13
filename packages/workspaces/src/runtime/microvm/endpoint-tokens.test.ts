import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MicrovmAuthTokenInput } from "./api.js";
import { MicrovmEndpointTokens } from "./endpoint-tokens.js";

const fakeMinter = () => {
  const mints: MicrovmAuthTokenInput[] = [];
  let failNext = false;
  return {
    mints,
    failNextMint: () => {
      failNext = true;
    },
    api: {
      createAuthToken: (input: MicrovmAuthTokenInput) => {
        mints.push(input);
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("throttled"));
        }
        return Promise.resolve(`token-${mints.length}`);
      },
    },
  };
};

const build = (
  minter: ReturnType<typeof fakeMinter>,
  webSocketAuth: "header" | "subprotocol" = "header",
) =>
  new MicrovmEndpointTokens({
    api: minter.api,
    port: 8080,
    ttlMinutes: 60,
    refreshMarginMs: 5 * 60_000,
    webSocketAuth,
  });

describe("MicrovmEndpointTokens", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T10:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mints once per VM with the configured TTL and port, then serves the cached token", async () => {
    const minter = fakeMinter();
    const tokens = build(minter);
    await expect(tokens.token("microvm-1")).resolves.toBe("token-1");
    await expect(tokens.token("microvm-1")).resolves.toBe("token-1");
    await expect(tokens.token("microvm-2")).resolves.toBe("token-2");
    expect(minter.mints).toEqual([
      { microvmId: "microvm-1", expirationInMinutes: 60, port: 8080 },
      { microvmId: "microvm-2", expirationInMinutes: 60, port: 8080 },
    ]);
    expect(tokens.expiresAt("microvm-1")).toBe(Date.parse("2026-09-13T11:00:00.000Z"));
  });

  it("re-mints once a token is within the refresh margin of expiry", async () => {
    const minter = fakeMinter();
    const tokens = build(minter);
    await tokens.token("microvm-1");
    vi.setSystemTime(new Date("2026-09-13T10:54:00.000Z"));
    await expect(tokens.token("microvm-1")).resolves.toBe("token-1");
    vi.setSystemTime(new Date("2026-09-13T10:55:30.000Z"));
    await expect(tokens.token("microvm-1")).resolves.toBe("token-2");
    expect(minter.mints).toHaveLength(2);
  });

  it("shares one in-flight mint between concurrent callers", async () => {
    const minter = fakeMinter();
    const tokens = build(minter);
    const [a, b, c] = await Promise.all([
      tokens.token("microvm-1"),
      tokens.token("microvm-1"),
      tokens.headers("microvm-1"),
    ]);
    expect(a).toBe("token-1");
    expect(b).toBe("token-1");
    expect(c).toEqual({ "X-aws-proxy-auth": "token-1", "X-aws-proxy-port": "8080" });
    expect(minter.mints).toHaveLength(1);
  });

  it("carries the token as proxy headers by default, or as the documented subprotocols", async () => {
    const minter = fakeMinter();
    await expect(build(minter).connectMaterial("microvm-1")()).resolves.toEqual({
      headers: { "X-aws-proxy-auth": "token-1", "X-aws-proxy-port": "8080" },
    });
    await expect(build(minter, "subprotocol").connectMaterial("microvm-1")()).resolves.toEqual({
      protocols: [
        "lambda-microvms",
        "lambda-microvms.authentication.token-2",
        "lambda-microvms.port.8080",
      ],
    });
  });

  it("keeps a held VM's token fresh on a timer and stops when the last hold is released", async () => {
    const minter = fakeMinter();
    const tokens = build(minter);
    const releaseA = tokens.hold("microvm-1");
    // The first hold mints immediately (nothing cached yet).
    await vi.advanceTimersByTimeAsync(0);
    expect(minter.mints).toHaveLength(1);
    const releaseB = tokens.hold("microvm-1");
    // 55 minutes later (the margin before expiry) the token is re-minted, unprompted.
    await vi.advanceTimersByTimeAsync(55 * 60_000 - 1);
    expect(minter.mints).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(minter.mints).toHaveLength(2);
    await expect(tokens.token("microvm-1")).resolves.toBe("token-2");
    // Still held by B after A releases: the next refresh happens.
    releaseA();
    releaseA();
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    expect(minter.mints).toHaveLength(3);
    // Released entirely: no further mints.
    releaseB();
    await vi.advanceTimersByTimeAsync(10 * 60 * 60_000);
    expect(minter.mints).toHaveLength(3);
  });

  it("retries a failed refresh after the margin instead of dropping the hold", async () => {
    const minter = fakeMinter();
    const tokens = build(minter);
    await tokens.token("microvm-1");
    const release = tokens.hold("microvm-1");
    minter.failNextMint();
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    expect(minter.mints).toHaveLength(2); // failed
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(minter.mints).toHaveLength(3); // retried at the margin
    await expect(tokens.token("microvm-1")).resolves.toBe("token-3");
    release();
  });

  it("forget drops the cache and the holds for a VM that is gone", async () => {
    const minter = fakeMinter();
    const tokens = build(minter);
    await tokens.token("microvm-1");
    tokens.hold("microvm-1");
    tokens.forget("microvm-1");
    expect(tokens.expiresAt("microvm-1")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(minter.mints).toHaveLength(1);
    await expect(tokens.token("microvm-1")).resolves.toBe("token-2");
  });

  it("refuses a margin that is not shorter than the TTL", () => {
    expect(
      () =>
        new MicrovmEndpointTokens({
          api: fakeMinter().api,
          port: 8080,
          ttlMinutes: 5,
          refreshMarginMs: 5 * 60_000,
          webSocketAuth: "header",
        }),
    ).toThrow(/refresh margin/);
  });
});
