import { describe, expect, it } from "vitest";

import { splitUrlUserinfo, urlForDisplay } from "./url-for-display.js";

describe("urlForDisplay", () => {
  it("redacts userinfo and credential query parameters, and keeps the rest", () => {
    expect(urlForDisplay("https://robot:s3cret@registry.example:5000/v2/")).toBe(
      "https://REDACTED:REDACTED@registry.example:5000/v2/",
    );
    expect(urlForDisplay("https://repology.org/api/v1?token=abc&repo=nixpkgs&API_KEY=def")).toBe(
      "https://repology.org/api/v1?token=REDACTED&repo=nixpkgs&API_KEY=REDACTED",
    );
    expect(urlForDisplay("http://127.0.0.1:5000")).toBe("http://127.0.0.1:5000/");
    expect(urlForDisplay("not a url, s3cret")).toBe("[not a URL]");
  });
});

describe("splitUrlUserinfo", () => {
  it("returns the URL without its userinfo, and the userinfo decoded", () => {
    const { url, username, password } = splitUrlUserinfo("http://ro%40bot:p%3Ass@host:5000/x");
    expect(url.toString()).toBe("http://host:5000/x");
    expect([username, password]).toEqual(["ro@bot", "p:ss"]);
    expect(splitUrlUserinfo("http://host/").username).toBeUndefined();
  });
});
