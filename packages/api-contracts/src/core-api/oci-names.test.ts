import { describe, expect, it } from "vitest";

import { isOciRepository, toOciRepositoryComponent } from "./oci-names.js";

describe("generated repository components", () => {
  it.each([
    ["Mend", "mend"],
    ["my.repo", "my.repo"],
    ["my_repo", "my_repo"],
    [".github", "github"],
    ["a..b", "a-b"],
    ["a_-b", "a-b"],
    ["--foo", "foo"],
    ["repo.", "repo"],
    ["Hello World!", "hello-world"],
    ["", "repo"],
    ["...", "repo"],
  ])("%j becomes %j", (input, expected) => {
    expect(toOciRepositoryComponent(input, "repo")).toBe(expected);
  });

  it("always satisfies the grammar, including after the length cut", () => {
    for (const input of [
      "x".repeat(47) + ".tail",
      "a".repeat(47) + "--b",
      "ünïcödé/../x",
      "A__B",
    ]) {
      const component = toOciRepositoryComponent(input, "repo");
      expect(component.length).toBeLessThanOrEqual(48);
      expect(isOciRepository(component)).toBe(true);
    }
  });
});
