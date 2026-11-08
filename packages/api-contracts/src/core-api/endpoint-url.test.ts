import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { EndpointUrl, endpointHostOf } from "./endpoint-url.js";

const decode = Schema.decodeUnknownSync(EndpointUrl);
const refuses = (value: string) => expect(() => decode(value)).toThrow();

describe("EndpointUrl", () => {
  it("takes an absolute http or https URL and drops a trailing slash from its path", () => {
    expect(decode("https://gateway.example.com/")).toBe("https://gateway.example.com");
    expect(decode("https://gateway.example.com/v1/")).toBe("https://gateway.example.com/v1");
    expect(decode("http://10.0.0.5:8080/anthropic")).toBe("http://10.0.0.5:8080/anthropic");
  });

  it("writes the host as the URL standard does, without the scheme's default port", () => {
    expect(decode("https://Gateway.Example.COM:443/v1")).toBe("https://gateway.example.com/v1");
  });

  it("decodes its own output to itself", () => {
    const once = decode("https://gateway.example.com/v1/");
    expect(decode(Schema.encodeSync(EndpointUrl)(once))).toBe(once);
  });

  it("refuses a URL that is not an absolute http or https URL with a host", () => {
    refuses("ftp://gateway.example.com/v1");
    refuses("/v1/messages");
    refuses("gateway.example.com");
    refuses("http://");
    refuses("https://:8080/v1");
    refuses("");
  });

  it("refuses a user name or password, a query string and a fragment", () => {
    refuses("https://user:secret@gateway.example.com/v1");
    refuses("https://user@gateway.example.com/v1");
    refuses("https://gateway.example.com/v1?key=abc");
    refuses("https://gateway.example.com/v1?");
    refuses("https://gateway.example.com/v1#top");
  });
});

describe("endpointHostOf", () => {
  it("is the host, with a port only when it is not the scheme's default", () => {
    expect(endpointHostOf(decode("https://gateway.example.com:443/v1"))).toBe(
      "gateway.example.com",
    );
    expect(endpointHostOf(decode("http://10.0.0.5:8080/v1"))).toBe("10.0.0.5:8080");
  });
});
