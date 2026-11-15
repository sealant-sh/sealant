// `pnpm verify evidence`: this commit's evidence in one place, scanned for secrets, with the verdict
// file a PR comment carries. It gathers, from `.verify/`, every result made for this commit from a
// clean tree, the logs they name, and the screenshots `shot.mjs` took at it (.verify/shots/<sha12>/),
// into `.verify/evidence/<sha12>/`, then scans every file there. A file with a hit is deleted and the
// result is `evidence_withheld`; a hit names the file and the kind, never the value.
//
// The scan looks for two things: the value of every secret-named variable in `.env` and in this
// process's environment, and the shapes credentials take (below). It reads text files whole and a
// PNG's text chunks; it cannot read a screenshot's pixels, and the verdict says so.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";

import { decodeResult } from "./result.mjs";

/** Credential shapes, by kind. A match names the kind; the matched text is never printed. */
export const CREDENTIAL_SHAPES = [
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
];

/**
 * Passwords the repository itself publishes for throwaway local services: not secrets, so neither
 * as a value nor inside a URL are they a hit. compose.yaml's Postgres (`sealant`), the CI and
 * `verify db` Postgres (`postgres`), the catalog suite's loopback role (db.mjs) and shot.mjs's
 * local verify account.
 */
export const PUBLISHED = new Set([
  "sealant",
  "postgres",
  "stage2a_fake_password",
  "verify-password-123",
]);

const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{6,})@/gi;

/** The credential kinds `text` holds: a shape, or a URL with a password the repo does not publish. */
function shapesIn(text) {
  const kinds = CREDENTIAL_SHAPES.filter(([, shape]) => shape.test(text)).map(([kind]) => kind);
  for (const [, password] of text.matchAll(URL_PASSWORD)) {
    if (!PUBLISHED.has(decodeURIComponent(password))) {
      kinds.push("url-password");
      break;
    }
  }
  return kinds;
}

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PRIVATE|_KEY\b|KEY_|API_KEY|CREDENTIAL|DATABASE_URL/i;
// Values too short or too common to mean anything when found (a port, "true", a local default).
// A URL whose only passwords are published (the local DATABASE_URL default) is no secret either.
const onlyPublishedPasswords = (value) => {
  const passwords = [...value.matchAll(URL_PASSWORD)].map(([, password]) => password);
  return passwords.length > 0 && passwords.every((password) => PUBLISHED.has(password));
};
const MEANINGFUL = (value) =>
  value.length >= 8 &&
  !/^(true|false|null|localhost)$/i.test(value) &&
  !PUBLISHED.has(value) &&
  !onlyPublishedPasswords(value);

/** The secret values to look for: secret-named variables of `.env` and of `env`. */
export function secretValues(root, env = process.env) {
  const values = new Set();
  const add = (name, value) => {
    if (SECRET_NAME.test(name) && typeof value === "string" && MEANINGFUL(value.trim())) {
      values.add(value.trim());
    }
  };
  const dotenv = path.join(root, ".env");
  if (existsSync(dotenv)) {
    for (const line of readFileSync(dotenv, "utf8").split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (match !== null) add(match[1], match[2].replace(/^(["'])(.*)\1$/, "$2"));
    }
  }
  for (const [name, value] of Object.entries(env)) add(name, value);
  return [...values];
}

/**
 * A PNG's text chunks (tEXt, zTXt, iTXt), the only part of an image the scan can read. A chunk it
 * cannot decode is searched as raw bytes rather than skipped.
 */
export function pngText(bytes) {
  const texts = [];
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) return texts;
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + length);
    try {
      if (type === "tEXt") texts.push(data.toString("latin1"));
      else if (type === "zTXt") {
        // keyword \0 method data
        texts.push(inflateSync(data.subarray(data.indexOf(0) + 2)).toString("utf8"));
      } else if (type === "iTXt") {
        // keyword \0 compressed method language \0 translated keyword \0 text
        const keywordEnd = data.indexOf(0);
        const compressed = data[keywordEnd + 1] === 1;
        const languageEnd = data.indexOf(0, keywordEnd + 3);
        const textStart = data.indexOf(0, languageEnd + 1) + 1;
        const body = data.subarray(textStart);
        texts.push(compressed ? inflateSync(body).toString("utf8") : body.toString("utf8"));
      }
    } catch {
      texts.push(data.toString("latin1"));
    }
    at += 12 + length;
  }
  return texts;
}

/** The hits in one file: `{ kind }` per secret value or credential shape found. */
export function scanFile(file, secrets) {
  const bytes = readFileSync(file);
  const views = file.toLowerCase().endsWith(".png") ? pngText(bytes) : [bytes.toString("utf8")];
  const kinds = new Set();
  for (const view of views) {
    if (secrets.some((secret) => view.includes(secret)))
      kinds.add("a secret value from .env or the environment");
    for (const kind of shapesIn(view)) kinds.add(kind);
  }
  return [...kinds];
}

const walk = (directory) =>
  readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

/** This commit's clean-tree results in `.verify/results/`, newest last. */
function resultsFor(root, sha) {
  const directory = path.join(root, ".verify", "results");
  if (!existsSync(directory)) return [];
  const results = [];
  for (const name of readdirSync(directory).toSorted()) {
    try {
      const result = decodeResult(JSON.parse(readFileSync(path.join(directory, name), "utf8")));
      if (result.head.sha === sha && !result.head.dirty) results.push({ name, result });
    } catch {
      // Not a result this schema reads: not evidence.
    }
  }
  return results;
}

/** Gathers, scans and writes the verdict. Returns steps, evidence, next and the verdict's path. */
export function runEvidence({ root, head, receipt }) {
  const sha12 = head.sha.slice(0, 12);
  const out = path.join(root, ".verify", "evidence", sha12);
  const relative = (file) => path.relative(root, file);
  if (head.dirty) {
    return {
      steps: [
        {
          id: "gather",
          title: "This commit's evidence",
          status: "skipped",
          detail: "the tree is dirty: evidence belongs to a commit, so commit first",
        },
      ],
      evidence: [],
      next: ["commit, then pnpm verify evidence"],
    };
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(path.join(out, "results"), { recursive: true });

  const results = resultsFor(root, head.sha).filter(({ result }) => result.verb !== "evidence");
  for (const { name, result } of results) {
    copyFileSync(path.join(root, ".verify", "results", name), path.join(out, "results", name));
    for (const step of result.steps) {
      if (step.log !== undefined && existsSync(path.join(root, step.log))) {
        mkdirSync(path.join(out, "logs"), { recursive: true });
        copyFileSync(
          path.join(root, step.log),
          path.join(out, "logs", `${result.verb}-${path.basename(step.log)}`),
        );
      }
    }
  }
  const shotsFrom = path.join(root, ".verify", "shots", sha12);
  const shots = existsSync(shotsFrom)
    ? walk(shotsFrom).filter((file) => file.endsWith(".png"))
    : [];
  for (const shot of shots) {
    mkdirSync(path.join(out, "shots"), { recursive: true });
    copyFileSync(shot, path.join(out, "shots", path.basename(shot)));
  }
  const gathered = {
    id: "gather",
    title: "This commit's results, their logs and its screenshots",
    status: results.length + shots.length === 0 ? "skipped" : "passed",
    detail: `${results.length} result(s), ${shots.length} screenshot(s) from ${relative(shotsFrom)}`,
  };

  const secrets = secretValues(root);
  const hits = [];
  const files = walk(out);
  for (const file of files) {
    const kinds = scanFile(file, secrets);
    if (kinds.length > 0) {
      hits.push({ file: relative(file), kinds });
      rmSync(file);
    }
  }
  const scan = {
    id: "scan",
    title: "No secret value or credential shape in the evidence",
    status: hits.length === 0 ? "passed" : "evidence_withheld",
    detail:
      hits.length === 0
        ? `${files.length} file(s), ${secrets.length} secret value(s) and ${CREDENTIAL_SHAPES.length} shapes: no hit`
        : `deleted ${hits.map((hit) => `${hit.file} (${hit.kinds.join(", ")})`).join("; ")}`,
  };
  writeFileSync(
    path.join(out, "scan.json"),
    `${JSON.stringify({ files: files.length, secrets: secrets.length, hits }, null, 2)}\n`,
  );

  const kept = existsSync(path.join(out, "shots"))
    ? readdirSync(path.join(out, "shots")).toSorted()
    : [];
  const verdict = [
    `## Verdict for ${sha12}`,
    "",
    `Commit \`${head.sha}\`${head.branch === null ? "" : ` on \`${head.branch}\``}, clean tree.`,
    "",
    "### What ran",
    "",
    ...(results.length === 0
      ? ["Nothing recorded for this commit."]
      : results.map(
          ({ result }) =>
            `- \`${result.invocation ?? `pnpm verify ${result.verb}`}\`: ${result.status}`,
        )),
    "",
    receipt.trim(),
    "",
    "### Screenshots",
    "",
    ...(kept.length === 0 ? ["None."] : kept.map((name) => `- \`${name}\`: (what it shows)`)),
    "",
    "### Secret scan",
    "",
    hits.length === 0
      ? `No hit in ${files.length} file(s). It read text files and PNG text chunks; it cannot read a screenshot's pixels, so look at each before you attach it.`
      : `Withheld ${hits.length} file(s): ${hits.map((hit) => `\`${hit.file}\` (${hit.kinds.join(", ")})`).join(", ")}. They are deleted; say so rather than attach them.`,
    "",
    "### What I saw",
    "",
    "(Write it: what each screenshot and result showed, against what you expected before running it.)",
    "",
    "### Not checked",
    "",
    "(Write it: every state, path or runtime you did not see, and why.)",
    "",
  ].join("\n");
  const verdictPath = path.join(out, "verdict.md");
  writeFileSync(verdictPath, verdict);

  return {
    steps: [gathered, scan],
    evidence: [
      { kind: "verdict", path: relative(verdictPath) },
      ...kept.map((name) => ({
        kind: "screenshot",
        path: relative(path.join(out, "shots", name)),
      })),
    ],
    next:
      hits.length === 0
        ? []
        : ["fix what put a secret in the evidence, take it again, then pnpm verify evidence"],
  };
}
