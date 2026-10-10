/**
 * `sessions.open(argv)` against a stubbed `fetch`: the contract's argv rule is checked before any
 * request, a control plane's `SessionBadRequestError` surfaces with its reason, and an older control
 * plane's empty `400` is explained.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Sealant } from "./client.js";
import { SealantApiError, SealantError } from "./errors.js";

const details = {
  workspaceId: "ws_1",
  name: "t",
  ownerUserId: "usr_owner",
  status: "ready",
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Effect's fetch client keeps the `fetch` it first finds, so one stub serves every test and each
// test sets what `POST /v1/sessions` answers.
let answerSession: () => Response = () => json({}, 500);
let received: unknown[] = [];

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/v1/workspaces/ws_1") return json(details, 200);
      if (request.method === "POST" && path === "/v1/sessions") {
        received.push(await request.json());
        return answerSession();
      }
      return json({}, 404);
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

/** A control plane whose `POST /v1/sessions` answers `session`; the bodies it is sent. */
const serve = (session: () => Response): unknown[] => {
  answerSession = session;
  received = [];
  return received;
};

const open = async (argv: readonly string[]) => {
  const sealant = new Sealant({ baseUrl: "http://stub.invalid", ownerUserId: "usr_owner" });
  try {
    const workspace = await sealant.workspaces.get("ws_1");
    return await workspace.sessions.open(argv);
  } finally {
    await sealant.close();
  }
};

const refusal = async (argv: readonly string[]): Promise<unknown> => {
  try {
    await open(argv);
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
};

describe("sessions.open(argv)", () => {
  it("refuses what the contract refuses before asking, without quoting the argument", async () => {
    const posted = serve(() => json({}, 500));
    for (const [argv, reason] of [
      [[" bash", "secret-value"], "argv[0], the program, must be non-empty"],
      [["printf", "secret-value\u0000"], "argv[1] contains a NUL byte"],
      [["printf", "x".repeat(131_072)], "argv[1] is 131072 bytes; the maximum per word is 131071"],
    ] as const) {
      const error = await refusal(argv);
      expect(error).toBeInstanceOf(SealantError);
      expect(error).toMatchObject({ code: "invalid_argv" });
      expect(String(error)).toContain(reason);
      expect(String(error)).not.toContain("secret-value");
    }
    expect(posted).toEqual([]);
  });

  it("sends a whitespace-led, multi-line or empty argument as it is", async () => {
    const posted = serve(() => json({ _tag: "SessionBadRequestError", message: "stop here" }, 400));
    const argv = ["bash", "-lc", "\n echo hi\n", ""];
    await refusal(argv);
    expect(posted).toEqual([{ workspaceId: "ws_1", ownerUserId: "usr_owner", argv }]);
  });

  it("surfaces the control plane's reason", async () => {
    for (const tag of ["RequestRefusedError", "SessionBadRequestError"]) {
      serve(() => json({ _tag: tag, message: "argv[1] must be a string" }, 400));
      const error = await refusal(["printf", "x"]);
      expect(error).toBeInstanceOf(SealantApiError);
      expect(error).toMatchObject({ code: tag, message: "argv[1] must be a string" });
    }
  });

  it("explains an older control plane's empty 400, naming the argument it refuses", async () => {
    serve(() => new Response(null, { status: 400 }));
    const error = await refusal(["bash", "-lc", "\n echo hi"]);
    expect(error).toBeInstanceOf(SealantApiError);
    expect(error).toMatchObject({ status: 400 });
    expect(String(error)).toContain(
      "argv[2] is empty or has leading or trailing whitespace, and a control plane older than this SDK refuses such an argument; upgrade the control plane",
    );
    expect(String(error)).not.toContain("echo hi");

    const other = await refusal(["printf", "%s", "plain"]);
    expect(String(other)).toContain("gave no reason");
  });
});
