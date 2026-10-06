/**
 * A key to keep an image's per-person capability under, computed from the spec alone, with no
 * call: the parts of the spec that decide what the image can do for the per-person layout (harness,
 * tooling, customization, lifecycle, access, target), never its sources or runtime (repository,
 * credentials, homes, environment). It is not the image's identity: two creates with one key can
 * plan different images (the plan also reads the runtime's environment, roots and dotfiles), but
 * their bases, packages and tools are the same, which is what the capability is about. A caller
 * keeps what `launch.image` told it (after `ready()`) under this key and calls
 * `workspaces.inspectImage` only for a key it has not seen. A control-plane upgrade can change an
 * image; what an executor of it actually found stays the authority.
 */
import { createHash } from "node:crypto";

const IMAGE_SHAPING_KEYS = [
  "version",
  "harness",
  "access",
  "tooling",
  "customization",
  "lifecycle",
  "target",
] as const;

/** JSON with every object's keys sorted, so equal values have one text. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export const imageSpecKey = (spec: unknown): string => {
  const shaping =
    typeof spec === "object" && spec !== null
      ? Object.fromEntries(
          Object.entries(spec).filter(([key]) =>
            IMAGE_SHAPING_KEYS.some((shapingKey) => shapingKey === key),
          ),
        )
      : {};
  return `isk1-${createHash("sha256").update(canonical(shaping), "utf8").digest("hex").slice(0, 32)}`;
};
