import { describe, expect, it } from "vitest";

import { REDACTED, scrubPayload, scrubText } from "./scrub";

describe("scrubText", () => {
  it.each([
    [
      "request to https://user:pw@web.example/api/trpc/x?batch=1&input=%7B%7D#frag failed",
      "request to https://web.example/api/trpc/x failed",
    ],
    ["/reset-password?token=abc123", "/reset-password"],
    ["Authorization: Bearer abc.def-ghi", `Authorization: Bearer ${REDACTED}`],
    ['{"apiKey":"abc123","name":"ok"}', `{"apiKey":"${REDACTED}","name":"ok"}`],
    ["key sk-ant-api03-abcdefghijklmnopqrstuvwx leaked", `key ${REDACTED} leaked`],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked", `token ${REDACTED} leaked`],
  ])("scrubs %j", (input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });

  it("leaves trace and span ids and route templates alone", () => {
    const text =
      "trace 4bf92f3577b34da6a3ce929d0e0e4736 span 00f067aa0ba902b7 at /_authenticated/workspaces/$workspaceId/";
    expect(scrubText(text)).toBe(text);
  });
});

describe("scrubPayload", () => {
  it("cuts a request down to its path and the user agent", () => {
    const event = {
      request: {
        url: "https://web.example/login?redirect=%2Fsettings",
        query_string: "redirect=%2Fsettings",
        cookies: { session: "x" },
        data: { password: "x" },
        headers: { "User-Agent": "Firefox", Referer: "https://web.example/a?b=c", Cookie: "x" },
      },
    };

    expect(scrubPayload(event)).toEqual({
      request: { url: "https://web.example/login", headers: { "User-Agent": "Firefox" } },
    });
  });
});
