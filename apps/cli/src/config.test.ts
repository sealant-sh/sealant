import { describe, expect, it } from "vitest";

import {
  configFilePath,
  DEFAULT_API_URL,
  DEFAULT_OWNER_USER_ID,
  parseConfigFile,
  resolveSettings,
} from "./config.js";

describe("configFilePath", () => {
  it("defaults to ~/.config/sealant/config.json", () => {
    expect(configFilePath({}, "/home/dev")).toBe("/home/dev/.config/sealant/config.json");
  });

  it("honors XDG_CONFIG_HOME", () => {
    expect(configFilePath({ XDG_CONFIG_HOME: "/xdg" }, "/home/dev")).toBe(
      "/xdg/sealant/config.json",
    );
  });

  it("ignores an empty XDG_CONFIG_HOME", () => {
    expect(configFilePath({ XDG_CONFIG_HOME: "  " }, "/home/dev")).toBe(
      "/home/dev/.config/sealant/config.json",
    );
  });
});

describe("parseConfigFile", () => {
  it("parses known string keys and ignores the rest", () => {
    const parsed = parseConfigFile(
      JSON.stringify({ apiUrl: "http://api:4000", ownerUserId: "usr_1", extra: true }),
    );
    expect(parsed).toEqual({
      ok: true,
      config: { apiUrl: "http://api:4000", ownerUserId: "usr_1" },
    });
  });

  it("drops non-string and empty values", () => {
    const parsed = parseConfigFile(JSON.stringify({ apiUrl: 42, ownerUserId: "  " }));
    expect(parsed).toEqual({ ok: true, config: {} });
  });

  it("rejects invalid JSON", () => {
    expect(parseConfigFile("{nope")).toEqual({ ok: false, reason: "not valid JSON" });
  });

  it("rejects non-object JSON", () => {
    expect(parseConfigFile("[1,2]")).toEqual({ ok: false, reason: "expected a JSON object" });
  });
});

describe("resolveSettings", () => {
  const empty = { flags: { apiUrl: undefined, ownerUserId: undefined }, env: {}, file: {} };

  it("falls back to built-in defaults", () => {
    expect(resolveSettings(empty)).toEqual({
      apiUrl: { value: DEFAULT_API_URL, source: "default" },
      ownerUserId: { value: DEFAULT_OWNER_USER_ID, source: "default" },
    });
  });

  it("applies precedence flag > env > config", () => {
    const resolved = resolveSettings({
      flags: { apiUrl: "http://flag:1", ownerUserId: undefined },
      env: { SEALANT_API_URL: "http://env:2", SEALANT_OWNER_USER_ID: "usr_env" },
      file: { apiUrl: "http://file:3", ownerUserId: "usr_file" },
    });
    expect(resolved.apiUrl).toEqual({ value: "http://flag:1", source: "flag" });
    expect(resolved.ownerUserId).toEqual({ value: "usr_env", source: "env" });
  });

  it("uses the config file when flags and env are absent", () => {
    const resolved = resolveSettings({ ...empty, file: { ownerUserId: "usr_file" } });
    expect(resolved.ownerUserId).toEqual({ value: "usr_file", source: "config" });
    expect(resolved.apiUrl.source).toBe("default");
  });

  it("trims values and skips blank ones", () => {
    const resolved = resolveSettings({
      flags: { apiUrl: "  http://flag:1  ", ownerUserId: "   " },
      env: {},
      file: { ownerUserId: "usr_file" },
    });
    expect(resolved.apiUrl.value).toBe("http://flag:1");
    expect(resolved.ownerUserId).toEqual({ value: "usr_file", source: "config" });
  });
});
