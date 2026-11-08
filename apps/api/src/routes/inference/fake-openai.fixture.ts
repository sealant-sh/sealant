import { createServer, type ServerResponse } from "node:http";

/**
 * An OpenAI-compatible endpoint that answers every Responses request with one text message, or
 * with `refuseWith`'s status when it is set.
 */
export interface FakeOpenAi {
  readonly baseUrl: string;
  /** Each request's method and path, in order. */
  readonly requests: readonly string[];
  readonly authorizations: readonly (string | undefined)[];
  readonly close: () => Promise<void>;
}

const writeEvents = (res: ServerResponse, events: readonly Record<string, unknown>[]): void => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    res.write(`event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
};

const responseEvents = (model: unknown, text: string): Record<string, unknown>[] => {
  const item = {
    type: "message",
    id: "msg_fake",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const usage = {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 3,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 13,
  };
  return [
    { type: "response.created", response: { id: "resp_fake", model, status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: { id: "resp_fake", model, status: "completed", output: [item], usage },
    },
  ];
};

/** `path` is where the fake's API sits, as an endpoint behind a gateway does. */
export const startFakeOpenAi = async (
  options: { readonly path?: string; readonly text?: string; readonly refuseWith?: number } = {},
): Promise<FakeOpenAi> => {
  const path = options.path ?? "";
  const requests: string[] = [];
  const authorizations: (string | undefined)[] = [];

  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      const url = (req.url ?? "").split("?")[0] ?? "";
      requests.push(`${req.method ?? ""} ${url}`);
      authorizations.push(req.headers.authorization);
      if (
        req.method === "POST" &&
        url === `${path}/responses` &&
        options.refuseWith !== undefined
      ) {
        res.writeHead(options.refuseWith, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "forbidden", type: "permission_error" } }));
        return;
      }
      if (req.method === "POST" && url === `${path}/responses`) {
        let request: unknown;
        try {
          request = JSON.parse(body);
        } catch {
          request = undefined;
        }
        const model =
          typeof request === "object" && request !== null && "model" in request
            ? request.model
            : undefined;
        writeEvents(res, responseEvents(model, options.text ?? "ok"));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `no route ${req.method ?? ""} ${url}` } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake OpenAI: no port");

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}${path}`,
    requests,
    authorizations,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
