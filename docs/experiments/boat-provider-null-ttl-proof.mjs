import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const output = process.argv[2];
if (!output || !process.env.BOAT_API_KEY) throw new Error("proof_configuration_missing");
const credential = process.env.BOAT_API_KEY;
delete process.env.BOAT_API_KEY;
const ledger = openSync(output, "wx", 0o600);
const marker = randomUUID();
const started = Date.now();
const labels = {
  "sealant-dev": "boat-stream",
  "sealant-proof": marker,
  "sealant-deployment": "stage1-proof",
  "sealant-workspace": marker,
  "sealant-run": marker,
  "sealant-instance": marker,
  "sealant-attempt": marker,
  "sealant-source": "base-ubuntu",
};
const owned = new Set();
let interrupted = false;
let cleaning = false;
let deadline = started + 360000;
const interrupt = () => {
  interrupted = true;
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const record = (event, fields = {}) => {
  const entry = { at: new Date().toISOString(), event, ...fields };
  writeSync(ledger, JSON.stringify(entry) + "\n");
  fsyncSync(ledger);
  console.log(JSON.stringify(entry));
};
const codes = new Set([
  "trial_auto_stop_required",
  "unauthorized",
  "not_found",
  "sandbox_not_found",
  "insufficient_balance",
  "rate_limited",
  "no_ready_machine",
  "idempotency_in_progress",
  "machine_class_plan_required",
]);
const fail = (code) => {
  throw new Error(code);
};
const request = async (method, path, body, headers = {}) => {
  if ((!cleaning && interrupted) || Date.now() >= deadline) fail("proof_deadline");
  let response;
  let data;
  try {
    response = await fetch("https://boat.dev/api/v1" + path, {
      method,
      headers: {
        Authorization: "Bearer " + credential,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(
        Math.min(deadline - Date.now(), method === "POST" && path === "/sandboxes" ? 90000 : 25000),
      ),
    });
    data = await response.json();
  } catch {
    record("request_failed", {
      method,
      status: response?.status ?? null,
      code: response ? "invalid_response" : "transport_error",
    });
    fail("request_unavailable");
  }
  if (!response.ok || data?.ok !== true) {
    record("request_failed", {
      method,
      operation: path.startsWith("/sandboxes/") ? "owned-sandbox" : path.split("?")[0],
      status: response.status,
      code: codes.has(data?.code) ? data.code : "provider_error",
    });
    fail("provider_request_failed");
  }
  return { status: response.status, data };
};
const inventory = async (path, field) => {
  const all = [];
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < 100; page++) {
    const q = new URLSearchParams({ limit: "200" });
    if (cursor) q.set("cursor", cursor);
    const { data } = await request("GET", path + (path === "/sandboxes" || cursor ? "?" + q : ""));
    if (
      !Array.isArray(data[field]) ||
      data[field].some((item) => !item || typeof item !== "object")
    )
      fail("malformed_inventory");
    all.push(...data[field]);
    if (!data.pageInfo) {
      if (path === "/saved-snapshots") return { all, pages: page + 1 };
      fail("missing_page_info");
    }
    const p = data.pageInfo;
    if (
      !Number.isInteger(p.limit) ||
      p.limit < 1 ||
      p.limit > 200 ||
      typeof p.hasMore !== "boolean" ||
      (p.hasMore ? typeof p.nextCursor !== "string" || !p.nextCursor : p.nextCursor !== null)
    )
      fail("malformed_pagination");
    if (!p.hasMore) return { all, pages: page + 1 };
    if (cursors.has(p.nextCursor)) fail("repeated_cursor");
    cursors.add(p.nextCursor);
    cursor = p.nextCursor;
  }
  fail("inventory_limit");
};
const remember = (id) => {
  if (!/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(id)) fail("invalid_owned_id");
  if (owned.has(id)) return;
  owned.add(id);
  record("owned_id", { id });
};
const states = new Set([
  "init",
  "provisioning",
  "provisioned",
  "cloning",
  "ready",
  "idle",
  "running",
  "archiving",
  "archived",
  "error",
  "cancelled",
]);
const timestamp = (value) =>
  value === null ||
  (typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    Number.isFinite(Date.parse(value)));
const observe = (sandbox, phase) => {
  if (!sandbox || !owned.has(sandbox.id)) fail("unexpected_sandbox");
  if (
    !states.has(sandbox.state) ||
    ["archiveAfter", "dataExpiredAt", "stoppedAt"].some(
      (k) => Object.hasOwn(sandbox, k) && !timestamp(sandbox[k]),
    ) ||
    ["snapshots", "monitoring"].some(
      (k) => Object.hasOwn(sandbox, k) && typeof sandbox[k] !== "boolean",
    ) ||
    (Object.hasOwn(sandbox, "ttlSeconds") &&
      sandbox.ttlSeconds !== null &&
      (!Number.isInteger(sandbox.ttlSeconds) ||
        sandbox.ttlSeconds < 1 ||
        sandbox.ttlSeconds > 2592000))
  )
    fail("invalid_observation");
  const safe = Object.fromEntries(
    [
      "id",
      "state",
      "archiveAfter",
      "ttlSeconds",
      "snapshots",
      "monitoring",
      "dataExpiredAt",
      "stoppedAt",
    ]
      .filter((k) => Object.hasOwn(sandbox, k))
      .map((k) => [k, sandbox[k]]),
  );
  record(phase, safe);
  return sandbox;
};
const verify = (s) => {
  if (
    s.archiveAfter !== null ||
    (Object.hasOwn(s, "ttlSeconds") && s.ttlSeconds !== null) ||
    s.snapshots === false ||
    s.monitoring === true ||
    s.dataExpiredAt != null
  )
    fail("retention_not_verified");
};
const waitFor = async (id, expectedStates, phase) => {
  while (Date.now() < deadline) {
    const { data } = await request("GET", "/sandboxes/" + id);
    const s = observe(data.sandbox, phase);
    if (expectedStates.includes(s.state)) return s;
    if (["error", "cancelled"].includes(s.state)) fail("sandbox_failed");
    await delay(2000);
  }
  fail("proof_deadline");
};
let passed = false;
record("proof_started", { marker, labels, maxSmallVms: 1 });
try {
  const { data: policy } = await request("GET", "/account/data-retention");
  if (
    typeof policy.enabled !== "boolean" ||
    ["snapshotsOff", "monitoringOff"].some(
      (k) => Object.hasOwn(policy, k) && typeof policy[k] !== "boolean",
    ) ||
    (Object.hasOwn(policy, "enabledAt") && !timestamp(policy.enabledAt))
  )
    fail("account_retention_conflict");
  record(
    "account_retention",
    Object.fromEntries(
      ["enabled", "enabledAt", "snapshotsOff", "monitoringOff"]
        .filter((k) => Object.hasOwn(policy, k))
        .map((k) => [k, policy[k]]),
    ),
  );
  if (policy.enabled !== false) fail("account_retention_conflict");
  const body = {
    type: "small",
    ttlSeconds: null,
    noEnv: true,
    monitoring: false,
    snapshots: true,
    visibility: "private",
    labels,
  };
  record("create_request", { body, idempotencyKey: marker });
  const created = await request("POST", "/sandboxes", body, { "Idempotency-Key": marker });
  remember(created.data.sandbox?.id);
  record("create_accepted", { status: created.status, id: created.data.sandbox.id });
  verify(observe(created.data.sandbox, "create_observation"));
  const id = created.data.sandbox.id;
  verify(await waitFor(id, ["ready", "idle", "running"], "create_live_observation"));
  record("intentional_stop_request", { id });
  const stop = await request("POST", "/sandboxes/" + id + "/stop", {});
  record("stop_accepted", { id, status: stop.status });
  await waitFor(id, ["archived"], "stop_observation");
  const resumeBody = {
    type: "small",
    ttlSeconds: null,
    noEnv: true,
  };
  record("resume_request", { id, body: resumeBody });
  const resumed = await request("POST", "/sandboxes/" + id + "/resume", resumeBody);
  record("resume_accepted", { id, status: resumed.status });
  verify(await waitFor(id, ["ready", "idle", "running"], "resume_live_observation"));
  passed = true;
} catch (error) {
  const allowed = new Set([
    "provider_request_failed",
    "request_unavailable",
    "account_retention_conflict",
    "retention_not_verified",
    "sandbox_failed",
    "proof_deadline",
    "invalid_owned_id",
    "unexpected_sandbox",
    "invalid_observation",
    "malformed_inventory",
    "missing_page_info",
    "malformed_pagination",
    "repeated_cursor",
    "inventory_limit",
  ]);
  record("proof_failed", {
    code: error instanceof Error && allowed.has(error.message) ? error.message : "proof_error",
  });
} finally {
  cleaning = true;
  deadline = Date.now() + 180000;
  let cleanupVerified = true;
  try {
    const initial = await inventory("/sandboxes", "sandboxes");
    for (const s of initial.all)
      if (Object.entries(labels).every(([key, value]) => s.labels?.[key] === value)) remember(s.id);
  } catch {
    record("cleanup_discovery_failed", { code: "inventory_unavailable" });
    cleanupVerified = false;
  }
  for (const id of owned) {
    try {
      const deletion = await request("DELETE", "/sandboxes/" + id, undefined, {
        "X-Ascii-Confirm-Delete": id,
      });
      const op = deletion.data.operation;
      if (
        !op ||
        !/^bdop_[a-f0-9]{32}$/.test(op.id) ||
        op.kind !== "sandbox" ||
        op.targetId !== id ||
        !["pending", "processing", "blocked", "completed"].includes(op.status)
      )
        fail("invalid_delete");
      record("delete_accepted", {
        id,
        status: deletion.status,
        operationId: op.id,
        operationStatus: op.status,
      });
      const until = Date.now() + 120000;
      let current = op;
      while (current.status !== "completed" && Date.now() < until) {
        await delay(2000);
        current = (await request("GET", "/deletion-operations/" + op.id)).data.operation;
        if (
          current?.id !== op.id ||
          current?.targetId !== id ||
          !["pending", "processing", "blocked", "completed"].includes(current.status)
        )
          fail("invalid_delete");
        record("delete_observation", { id, operationId: op.id, operationStatus: current.status });
      }
      if (current.status !== "completed") cleanupVerified = false;
    } catch {
      record("owned_cleanup_unverified", { id, code: "cleanup_unverified" });
      cleanupVerified = false;
    }
  }
  try {
    const sandboxes = await inventory("/sandboxes", "sandboxes");
    const remaining = sandboxes.all.filter(
      (s) => owned.has(s.id) || s.labels?.["sealant-proof"] === marker,
    );
    for (const s of remaining) {
      remember(s.id);
      observe(s, "remaining_owned_sandbox");
    }
    record("cleanup_sandbox_inventory", {
      pages: sandboxes.pages,
      total: sandboxes.all.length,
      ownedIds: remaining.map((s) => s.id),
    });
    if (remaining.length) cleanupVerified = false;
  } catch {
    record("cleanup_inventory_failed", { kind: "sandboxes", code: "cleanup_unverified" });
    cleanupVerified = false;
  }
  try {
    const snapshots = await inventory("/saved-snapshots", "snapshots");
    const saved = snapshots.all.filter((s) => owned.has(s.sourceSandboxId));
    record("cleanup_snapshot_inventory", {
      pages: snapshots.pages,
      total: snapshots.all.length,
      ownedCount: saved.length,
    });
    for (const s of saved) {
      if (
        typeof s.name !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(s.name) ||
        !["saving", "ready", "failed"].includes(s.status)
      )
        fail("invalid_snapshot");
      record("remaining_owned_snapshot", {
        name: s.name,
        status: s.status,
        sourceSandboxId: s.sourceSandboxId,
      });
    }
    if (saved.length) cleanupVerified = false;
  } catch {
    record("cleanup_inventory_failed", { kind: "saved-snapshots", code: "cleanup_unverified" });
    cleanupVerified = false;
  }
  passed = passed && cleanupVerified;
}
record("proof_finished", {
  passed,
  elapsedSeconds: Math.round((Date.now() - started) / 1000),
  ownedIds: [...owned],
});
closeSync(ledger);
process.removeListener("SIGINT", interrupt);
process.removeListener("SIGTERM", interrupt);
process.exitCode = passed ? 0 : 1;
