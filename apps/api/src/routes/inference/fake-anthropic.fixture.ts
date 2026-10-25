/**
 * A local stand-in for the Anthropic Messages API, for tests that drive the real Claude Code CLI
 * through the Agent SDK. Each `POST /v1/messages` takes the next queued reply (a text answer when
 * the queue is empty) and records the `x-api-key` it carried.
 */
import { createServer, type ServerResponse } from "node:http";

export type FakeAnthropicReply =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "toolUse"; readonly name: string; readonly input: unknown }
  | { readonly type: "status"; readonly status: number; readonly errorType: string }
  | { readonly type: "hang" };

export interface FakeAnthropic {
  readonly baseUrl: string;
  readonly apiKeys: readonly (string | undefined)[];
  readonly reply: (...replies: readonly FakeAnthropicReply[]) => void;
  readonly reset: () => void;
  readonly close: () => Promise<void>;
}

const writeEvents = (res: ServerResponse, events: readonly Record<string, unknown>[]): void => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    res.write(`event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
};

let toolUseCounter = 0;

const messageEvents = (
  reply: Extract<FakeAnthropicReply, { type: "text" | "toolUse" }>,
): Record<string, unknown>[] => {
  const block =
    reply.type === "text"
      ? [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: reply.text },
          },
        ]
      : [
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: `toolu_fake_${String((toolUseCounter += 1))}`,
              name: reply.name,
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.input) },
          },
        ];
  return [
    {
      type: "message_start",
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: "claude-fake",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 1 },
      },
    },
    ...block,
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: reply.type === "text" ? "end_turn" : "tool_use", stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ];
};

export const startFakeAnthropic = async (): Promise<FakeAnthropic> => {
  const apiKeys: (string | undefined)[] = [];
  const queue: FakeAnthropicReply[] = [];
  const hanging = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method !== "POST" || req.url?.startsWith("/v1/messages") !== true) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const header = req.headers["x-api-key"];
      apiKeys.push(typeof header === "string" ? header : undefined);
      const reply = queue.shift() ?? { type: "text", text: "ok" };
      switch (reply.type) {
        case "hang": {
          hanging.add(res);
          return;
        }
        case "status": {
          res.writeHead(reply.status, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              type: "error",
              error: { type: reply.errorType, message: "refused by the fake" },
            }),
          );
          return;
        }
        case "text":
        case "toolUse": {
          writeEvents(res, messageEvents(reply));
          return;
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake Anthropic: no port");
  const port = address.port;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    apiKeys,
    reply: (...replies) => {
      queue.push(...replies);
    },
    reset: () => {
      apiKeys.length = 0;
      queue.length = 0;
    },
    close: async () => {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
