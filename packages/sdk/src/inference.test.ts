import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Sealant } from "./client.js";
import { SealantApiError, SealantError } from "./errors.js";

let answer: { readonly status: number; readonly body: unknown } = { status: 500, body: {} };
let seen: Array<{ readonly url: string; readonly body: unknown }> = [];
let features: Record<string, boolean> = {};

const answering = (status: number, body: unknown, reported: Record<string, boolean>) => {
  answer = { status, body };
  features = reported;
  seen = [];
};

const receipt = { accountId: "cacc_key", revision: 3, login: "api-key" } as const;

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/") {
        return Response.json({
          name: "Sealant Control Plane API",
          version: "0.0.0",
          docsPath: "/docs",
          openApiPath: "/openapi.json",
          features,
        });
      }
      const text = await request.text();
      seen.push({ url: request.url, body: text.length === 0 ? undefined : JSON.parse(text) });
      return Response.json(answer.body, { status: answer.status });
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const client = () => new Sealant({ baseUrl: "http://stub.invalid", ownerUserId: "usr_owner" });

describe("inference.respond", () => {
  it("sends allowedLogin and hands back the exchange's receipt", async () => {
    answering(
      200,
      { sessionId: "inf_1", turn: { type: "text", text: "named" }, receipt },
      { processUser: false, inferenceAllowedLogin: true },
    );
    const sealant = client();

    const response = await sealant.inference.respond({
      prompt: "name it",
      credentials: { claude: true },
      allowedLogin: "subscription",
    });

    expect(seen[0]?.body).toMatchObject({ allowedLogin: "subscription" });
    expect(response.receipt).toEqual(receipt);
    await sealant.close();
  });

  it("sends nothing to a control plane that would drop allowedLogin unread", async () => {
    answering(200, {}, { processUser: false });
    const sealant = client();

    const error = await sealant.inference
      .respond({ prompt: "name it", credentials: { claude: true }, allowedLogin: "subscription" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SealantError);
    expect(error).toMatchObject({ code: "inference-allowed-login-unsupported" });
    expect(seen).toEqual([]);
    await sealant.close();
  });

  it("reads the refusal's reason and receipt", async () => {
    answering(
      409,
      {
        _tag: "InferenceConflictError",
        message: "holds an API key",
        code: "login-not-allowed",
        receipt,
      },
      { processUser: false, inferenceAllowedLogin: true },
    );
    const sealant = client();

    const error = await sealant.inference
      .respond({ prompt: "name it", credentials: { claude: true }, allowedLogin: "subscription" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SealantApiError);
    expect(error).toMatchObject({ reason: "login-not-allowed", receipt });
    await sealant.close();
  });
});
