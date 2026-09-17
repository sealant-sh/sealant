import { describe, expect, it } from "vitest";

import {
  captureDestinationRefusal,
  gitHubWebHostOf,
  parseAllowedCaptureOrigins,
} from "./credential-destinations.js";

const open = { allowedOrigins: [], refusePlaintext: false, plaintext: false };

describe("the GitHub web host", () => {
  it("is github.com for the public API and the API's own host on Enterprise Server", () => {
    expect(gitHubWebHostOf("https://api.github.com")).toBe("github.com");
    expect(gitHubWebHostOf("https://ghe.example/api/v3")).toBe("ghe.example");
  });
});

describe("where the capture token may be sent (CORE-05)", () => {
  it("admits https anywhere and plain http on loopback", () => {
    for (const endpoint of [
      "https://mend.example/api/session-channel/s1",
      "http://127.0.0.1:3106/channel",
      "http://localhost:3106/channel",
      "http://[::1]:3106/channel",
    ]) {
      expect(captureDestinationRefusal({ ...open, endpoint })).toBeNull();
    }
  });

  it("refuses plain http beyond loopback unless the launcher states the network is private", () => {
    const endpoint = "http://mend-api:3106/channel";
    expect(captureDestinationRefusal({ ...open, endpoint })).toMatch(/transport\.plaintext/);
    expect(captureDestinationRefusal({ ...open, endpoint, plaintext: true })).toBeNull();
    expect(
      captureDestinationRefusal({ ...open, endpoint: "http://127.0.0.1.evil.example/c" }),
    ).toMatch(/plain http/);
  });

  it("lets the operator veto plain http whatever the launcher states", () => {
    expect(
      captureDestinationRefusal({
        ...open,
        endpoint: "http://mend-api:3106/channel",
        plaintext: true,
        refusePlaintext: true,
      }),
    ).toMatch(/SEALANT_CAPTURE_REFUSE_PLAINTEXT/);
    expect(
      captureDestinationRefusal({
        ...open,
        endpoint: "https://mend.example/c",
        plaintext: true,
        refusePlaintext: true,
      }),
    ).toMatch(/SEALANT_CAPTURE_REFUSE_PLAINTEXT/);
  });

  it("holds the endpoint to the operator's origins when any are set", () => {
    const allowedOrigins = ["https://mend.example"];
    expect(
      captureDestinationRefusal({ ...open, allowedOrigins, endpoint: "https://mend.example/c/1" }),
    ).toBeNull();
    for (const endpoint of [
      "https://evil.example/c",
      "https://mend.example.evil.example/c",
      "https://mend.example:8443/c",
      "http://mend.example/c",
    ]) {
      expect(captureDestinationRefusal({ ...open, allowedOrigins, endpoint })).toMatch(
        /SEALANT_CAPTURE_ALLOWED_ENDPOINTS/,
      );
    }
  });

  it("refuses other schemes and embedded credentials", () => {
    expect(captureDestinationRefusal({ ...open, endpoint: "ftp://mend.example/c" })).toMatch(
      /http\(s\)/,
    );
    expect(captureDestinationRefusal({ ...open, endpoint: "https://u:p@mend.example/c" })).toMatch(
      /credentials/,
    );
  });

  it("parses the origin list strictly", () => {
    expect(parseAllowedCaptureOrigins(undefined)).toEqual([]);
    expect(parseAllowedCaptureOrigins("https://a.example, http://b.internal:3106")).toEqual([
      "https://a.example",
      "http://b.internal:3106",
    ]);
    expect(parseAllowedCaptureOrigins("https://a.example/path")).toBeNull();
    expect(parseAllowedCaptureOrigins("a.example")).toBeNull();
    expect(parseAllowedCaptureOrigins("ftp://a.example")).toBeNull();
  });
});
