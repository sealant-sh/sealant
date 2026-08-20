#!/usr/bin/env node
/**
 * Fake Codex CLI for codex-engine tests: emits canned `--json` JSONL shapes (captured from the
 * real CLI's `codex exec --json` output) per FAKE_CODEX_MODE. The "echo" mode reports its argv and
 * env back through the agent message so tests can assert the spawn contract without a network.
 */
const mode = process.env.FAKE_CODEX_MODE ?? "echo";
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (mode === "echo") {
  emit({ type: "thread.started", thread_id: "thread_fixture" });
  emit({ type: "turn.started" });
  const payload = {
    argv: process.argv.slice(2),
    codexHome: process.env.CODEX_HOME ?? null,
    openaiApiKey: process.env.OPENAI_API_KEY ?? null,
  };
  emit({
    type: "item.completed",
    item: { id: "item_0", type: "agent_message", text: JSON.stringify(payload) },
  });
  emit({
    type: "turn.completed",
    usage: {
      input_tokens: 12,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 3,
      reasoning_output_tokens: 0,
    },
  });
  process.exit(0);
}

if (mode === "fail") {
  process.stderr.write("boom: request rejected, token sk-secret-token-value in flight\n");
  process.exit(2);
}

if (mode === "auth") {
  process.stderr.write(
    "ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized\n",
  );
  process.exit(1);
}

if (mode === "hang") {
  emit({ type: "thread.started", thread_id: "thread_fixture" });
  setTimeout(() => process.exit(0), 60_000);
}
