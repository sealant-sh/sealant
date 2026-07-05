/**
 * Production server for the prebuilt web image: serves the static client build (dist/client) and
 * hands every other request to the TanStack Start fetch handler (dist/server/server.js). Node
 * builtins only — the runtime image needs no extra HTTP framework. `vite preview` is not a
 * production server, and the Start build emits a WinterCG fetch handler with no listener of its own.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const serverEntry = await import("./dist/server/server.js");
const fetchHandler = serverEntry.default;

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const clientDir = fileURLToPath(new URL("./dist/client", import.meta.url));

const mimeTypes = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const tryServeStatic = async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    return false;
  }
  if (pathname.includes("\0")) {
    return false;
  }

  // Skip the fs stat for SSR routes: everything in dist/client is either under /assets/ or a
  // dotted filename (favicon.ico, robots.txt, …), while app routes are extensionless.
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (!pathname.startsWith("/assets/") && !lastSegment.includes(".")) {
    return false;
  }

  // normalize + prefix check keeps traversal (`/../`) inside the client dir.
  const filePath = normalize(join(clientDir, pathname));
  if (!filePath.startsWith(clientDir + sep)) {
    return false;
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return false;
  }
  if (!fileStat.isFile()) {
    return false;
  }

  res.writeHead(200, {
    "content-type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
    "content-length": fileStat.size,
    // Vite content-hashes everything under /assets/, so those are immutable forever.
    "cache-control": pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=3600",
  });

  if (req.method === "HEAD") {
    res.end();
    return true;
  }

  await pipeline(createReadStream(filePath), res);
  return true;
};

const toWebRequest = (req) => {
  const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url ?? "/"}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(key, entry);
      }
    } else {
      headers.set(key, value);
    }
  }

  const body = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req);

  return new Request(url, { method: req.method, headers, body, duplex: "half" });
};

const sendWebResponse = async (response, res) => {
  const headers = {};
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") {
      headers[key] = value;
    }
  });
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) {
    headers["set-cookie"] = setCookies;
  }

  res.writeHead(response.status, headers);

  if (response.body === null) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body), res);
};

const server = createServer((req, res) => {
  void (async () => {
    try {
      if (await tryServeStatic(req, res)) {
        return;
      }
      const response = await fetchHandler.fetch(toWebRequest(req));
      await sendWebResponse(response, res);
    } catch (error) {
      console.error("[web] request failed:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
      }
      res.end("Internal Server Error");
    }
  })();
});

server.listen(port, host, () => {
  console.log(`[web] listening on http://${host}:${port}`);
});
