import { describe, expect, it } from "vitest";

import { extractJson, isAuthFailureMessage, redactSecret } from "./support.js";

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

describe("isAuthFailureMessage", () => {
  it("matches the agent SDK's typed auth failure and provider 401 shapes", () => {
    expect(isAuthFailureMessage("Inference failed: authentication_failed")).toBe(true);
    expect(isAuthFailureMessage("API returned 401 Unauthorized")).toBe(true);
    expect(isAuthFailureMessage("OAuth token has expired")).toBe(true);
  });

  it("does not match unrelated failures", () => {
    expect(isAuthFailureMessage("model overloaded, retry later")).toBe(false);
    expect(isAuthFailureMessage("max turns exceeded")).toBe(false);
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
