/**
 * A key for the image a create would build, computed from the spec alone, with no call: the parts
 * of the spec that shape the image (harness, tooling, customization, lifecycle, access, target),
 * never its sources or runtime (repository, credentials, homes, environment). Two creates with
 * one key plan the same image on one control plane, so a caller can keep what it learnt about an
 * image (its per-person capability, from `launch.image` after `ready()`) under this key and skip
 * `workspaces.inspectImage` when it already knows. A control-plane upgrade can change the image a
 * key plans; what an executor of the image actually found stays the authority.
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
