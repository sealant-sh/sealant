import { EndpointUrl } from "@sealant/api-contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  exchangeRedaction,
  extractJson,
  soundsLikeAuthFailure,
  redactSecret,
  redactSecrets,
} from "./support.js";

describe("redactSecret", () => {
  it("strips every occurrence of the secret", () => {
    const secret = "sk-ant-oat01-abc123";
    expect(redactSecret(`bad token ${secret} (${secret})`, secret)).toBe(
      "bad token [redacted] ([redacted])",
    );
  });

  it("is a no-op for an empty secret", () => {
    expect(redactSecret("message", "")).toBe("message");
  });
});

describe("redactSecrets", () => {
  it("strips every listed secret (access AND refresh tokens)", () => {
    const accessToken = "sk-ant-oat01-access";
    const refreshToken = "sk-ant-ort01-refresh";
    expect(
      redactSecrets(`rejected ${accessToken} / ${refreshToken}`, [accessToken, refreshToken]),
    ).toBe("rejected [redacted] / [redacted]");
  });

  it("skips undefined entries (token-kind accounts have no refresh token)", () => {
    expect(redactSecrets("bad sk-ant-oat01-a", ["sk-ant-oat01-a", undefined])).toBe(
      "bad [redacted]",
    );
  });
});

describe("exchangeRedaction", () => {
  const endpoint = Schema.decodeSync(EndpointUrl)(
    "http://10.0.0.9:8080/private-company/tenant-5678",
  );

  it("strips the endpoint's URL with what follows it, and its path, and keeps its host", () => {
    const redact = exchangeRedaction(["placeholder-key"], endpoint);
    expect(
      redact(
        "unexpected status 403 Forbidden: forbidden, url: http://10.0.0.9:8080/private-company/tenant-5678/v1/responses (key placeholder-key)",
      ),
    ).toBe("unexpected status 403 Forbidden: forbidden, url: [redacted] (key [redacted])");
    expect(redact("POST /private-company/tenant-5678/v1/messages on 10.0.0.9:8080")).toBe(
      "POST [redacted]/v1/messages on 10.0.0.9:8080",
    );
  });

  it("strips a URL at the endpoint's host alone when its path is the root", () => {
    const redact = exchangeRedaction([], Schema.decodeSync(EndpointUrl)("https://gateway.test/"));
    expect(redact("refused at https://gateway.test/v1/responses by gateway.test")).toBe(
      "refused at [redacted] by gateway.test",
    );
  });

  it("strips only the secrets without an endpoint", () => {
    expect(exchangeRedaction(["sk-a"])("bad sk-a at /v1/responses")).toBe(
      "bad [redacted] at /v1/responses",
    );
  });
});

describe("soundsLikeAuthFailure", () => {
  it("matches the agent SDK's typed auth failure and provider 401 shapes", () => {
    expect(soundsLikeAuthFailure("Inference failed: authentication_failed")).toBe(true);
    expect(soundsLikeAuthFailure("API returned 401 Unauthorized")).toBe(true);
    expect(soundsLikeAuthFailure("OAuth token has expired")).toBe(true);
  });

  it("does not match unrelated failures", () => {
    expect(soundsLikeAuthFailure("model overloaded, retry later")).toBe(false);
    expect(soundsLikeAuthFailure("max turns exceeded")).toBe(false);
  });

  it("reads 401 as a word, never inside a number or an id", () => {
    expect(soundsLikeAuthFailure("prompt is too long: 64010 tokens")).toBe(false);
    expect(soundsLikeAuthFailure("request req_401abc failed")).toBe(false);
    expect(soundsLikeAuthFailure("upstream answered HTTP 401")).toBe(true);
  });
});

describe("extractJson", () => {
  it("parses bare JSON", () => {
    expect(extractJson('{"ok": true}')).toEqual({ ok: true });
  });

  it("parses fenced JSON", () => {
    expect(extractJson('```json\n{"ok": true}\n```')).toEqual({ ok: true });
  });

  it("parses JSON embedded in prose", () => {
    expect(extractJson('Here you go: {"items": [1, 2]} — enjoy.')).toEqual({ items: [1, 2] });
  });

  it("returns undefined when there is no JSON", () => {
    expect(extractJson("no structured data here")).toBeUndefined();
  });
});
