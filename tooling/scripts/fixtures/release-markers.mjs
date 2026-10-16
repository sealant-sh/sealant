// Stand-ins for what a stable release's floor reads (release.yml's floor block): GitHub's latest
// release, npm's dist-tags, and ghcr through `docker buildx imagetools`. Each records what it was
// asked, so a test can count writes. Ported from sealant-sh/mend scripts/fixtures/release-markers.mjs.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const listen = async (t, handler) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({ method: request.method, path: decodeURIComponent(request.url ?? "") });
      handler(request, response, body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
};

/**
 * GitHub's API for one repository: `latest` is the latest release's tag (none: a 404), `status`
 * answers every request with that status instead.
 */
export const githubApi = (t, { latest, status } = {}) =>
  listen(t, (request, response) => {
    if (status !== undefined) {
      response.writeHead(status).end('{"message":"stub failure"}');
      return;
    }
    if (request.method === "GET" && /^\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(request.url)) {
      if (latest === undefined) response.writeHead(404).end('{"message":"Not Found"}');
      else
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ tag_name: latest }));
      return;
    }
    response.writeHead(405).end();
  });

/**
 * npm's uncached dist-tags endpoint: `tags` for every package, or `packages` (name → tags, absent: a
 * 404) for one answer per package; `status` answers every request instead.
 */
export const npmDistTags = (t, { tags = {}, packages, status } = {}) =>
  listen(t, (request, response) => {
    if (status !== undefined) {
      response.writeHead(status).end("{}");
      return;
    }
    const match = /^\/-\/package\/(.+)\/dist-tags$/.exec(decodeURIComponent(request.url ?? ""));
    if (request.method === "GET" && match !== null) {
      const answer = packages === undefined ? tags : packages[match[1]];
      if (answer === undefined) response.writeHead(404).end("{}");
      else
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
      return;
    }
    response.writeHead(405).end();
  });

/**
 * A stand-in `docker` (and `gh`) in `<directory>/bin` over a registry held in a JSON file. `tags`
 * maps a reference to its digest; `versions` maps a reference to the
 * org.opencontainers.image.version each platform's config carries (one value for every platform,
 * an array for one per platform, null for no label); `unreadable` lists references whose reads
 * fail for a reason other than not found. `docker buildx imagetools create --tag <ref> <repo@digest>`
 * points the reference at that digest; `gh` only records.
 */
export const registryStandIn = (directory, { tags = {}, versions = {}, unreadable = [] } = {}) => {
  const bin = path.join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  const calls = path.join(directory, "calls.jsonl");
  const state = path.join(directory, "registry.json");
  writeFileSync(calls, "");
  writeFileSync(state, JSON.stringify({ tags, versions, unreadable }));
  const script = `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const name = require("node:path").basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify([name, ...args]) + "\\n");
if (name === "gh") process.exit(0);
const registry = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
if (args.slice(0, 3).join(" ") === "buildx imagetools inspect" && args[4] === "--format") {
  const ref = args[3];
  if (registry.unreadable.includes(ref)) {
    console.error("ERROR: failed to do request: Head \\"https://ghcr.io/v2/x\\": unauthorized");
    process.exit(1);
  }
  if (!(ref in registry.tags)) { console.error("ERROR: " + ref + ": not found"); process.exit(1); }
  if (args[5] === "{{json .Manifest}}") {
    console.log(JSON.stringify({ mediaType: "application/vnd.oci.image.index.v1+json", digest: registry.tags[ref] }));
    process.exit(0);
  }
  if (args[5] === "{{json .Image}}") {
    const value = registry.versions[ref];
    const per = Array.isArray(value) ? value : [value, value];
    const config = (version) => ({ architecture: "x", os: "linux", config: { Labels: version === null || version === undefined ? {} : { "org.opencontainers.image.version": version } } });
    console.log(JSON.stringify({ "linux/amd64": config(per[0]), "linux/arm64": config(per[1]) }));
    process.exit(0);
  }
}
if (args.slice(0, 4).join(" ") === "buildx imagetools create --tag" && args.length === 6) {
  registry.tags[args[4]] = args[5].split("@")[1];
  writeFileSync(${JSON.stringify(state)}, JSON.stringify(registry));
  process.exit(0);
}
process.exit(79);
`;
  for (const command of ["docker", "gh"]) {
    writeFileSync(path.join(bin, command), script);
    chmodSync(path.join(bin, command), 0o755);
  }
  return {
    bin,
    calls: () =>
      readFileSync(calls, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    registry: () => JSON.parse(readFileSync(state, "utf8")),
  };
};

/** The writes among recorded calls: imagetools creates and gh release edits. */
export const writesIn = (calls) =>
  calls.filter(
    ([command, , , verb]) => (command === "docker" && verb === "create") || command === "gh",
  );
