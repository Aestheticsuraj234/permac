import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HermesGatewayAdapter,
  scriptedTransport,
  type LineTransport,
} from "../../packages/hermes-adapter/src/index.ts";

function answering(transport: ReturnType<typeof scriptedTransport>): LineTransport {
  const base = transport.write.bind(transport);
  transport.write = (line: string) => {
    base(line);
    const message = JSON.parse(line) as { id?: number; method?: string };
    if (typeof message.id !== "number" || !message.method) return;
    const result =
      message.method === "session.create"
        ? { session_id: "sess-1" }
        : message.method === "prompt.submit"
          ? { status: "streaming" }
          : message.method === "session.interrupt"
            ? { status: "interrupted" }
            : message.method === "session.history"
              ? { count: 1, messages: [{ role: "user", content: "hello" }] }
              : message.method === "ping"
                ? { pong: true }
                : message.method === "client.capabilities"
                  ? { server_requests: ["approval", "clarify"] }
                  : {};
    transport.emit(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  };
  return transport;
}

async function started(): Promise<{
  adapter: HermesGatewayAdapter;
  transport: ReturnType<typeof scriptedTransport>;
}> {
  const transport = scriptedTransport();
  const adapter = new HermesGatewayAdapter(answering(transport));
  transport.emit(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "gateway.ready", session_id: "", payload: { skin: {}, change_events: true, replay_epoch: "1" } },
    }),
  );
  await adapter.createSession({});
  return { adapter, transport };
}

test("streams a normal run and tool output", async () => {
  const { adapter, transport } = await started();
  const events = [];
  const subscription = adapter.subscribe({ sessionId: "sess-1" });
  const iterator = subscription[Symbol.asyncIterator]();
  const pending = iterator.next();
  transport.emit(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.delta", session_id: "sess-1", payload: { text: "Hi" } },
    }),
  );
  events.push((await pending).value);
  transport.emit(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "tool.start",
        session_id: "sess-1",
        payload: { tool_id: "t1", name: "open_app", args: { app: "Cursor" } },
      },
    }),
  );
  events.push((await iterator.next()).value);
  transport.emit(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "tool.complete",
        session_id: "sess-1",
        payload: { tool_id: "t1", name: "open_app", result: "ok" },
      },
    }),
  );
  events.push((await iterator.next()).value);
  transport.emit(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.complete", session_id: "sess-1", payload: { text: "Done", status: "complete" } },
    }),
  );
  events.push((await iterator.next()).value);
  assert.deepEqual(
    events.map((event) => event.type),
    ["message.delta", "tool.started", "tool.completed", "run.finished"],
  );
});

test("approval is not answered until answerRequest", async () => {
  const { adapter, transport } = await started();
  const before = transport.outbound.length;
  transport.emit(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "srq-7",
      method: "approval",
      params: { session_id: "sess-1", request_id: "req-1", command: "rm build", description: "delete" },
    }),
  );
  const answered = transport.outbound.slice(before).some((line) => line.includes("srq-7"));
  assert.equal(answered, false);
  await adapter.answerRequest({ rpcId: "srq-7", result: { choice: "deny" } });
  assert.equal(transport.outbound.some((line) => line.includes("srq-7") && line.includes("deny")), true);
});

test("clarify is correlated and unsupported requests fail clearly", async () => {
  const { adapter, transport } = await started();
  const seen = adapter.subscribe({ sessionId: "sess-1" });
  const iterator = seen[Symbol.asyncIterator]();
  const next = iterator.next();
  transport.emit(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "srq-8",
      method: "clarify",
      params: { session_id: "sess-1", question: "Which file?", choices: ["a", "b"] },
    }),
  );
  const event = (await next).value;
  assert.equal(event.type, "clarification.requested");
  assert.equal(event.rpcId, "srq-8");
  transport.emit(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "srq-9",
      method: "sudo",
      params: { session_id: "sess-1", command: "sudo true" },
    }),
  );
  assert.equal(
    transport.outbound.some((line) => line.includes("srq-9") && line.includes("-32601")),
    true,
  );
});

test("cancel, provider failure, and crash map to stable events", async () => {
  const { adapter, transport } = await started();
  const receipt = await adapter.interrupt({ sessionId: "sess-1", status: "streaming" });
  assert.equal(receipt.status, "interrupted");
  const history = await adapter.readHistory({ sessionId: "sess-1" });
  assert.equal(history[0]?.content, "hello");
  const iterator = adapter.subscribe({ sessionId: "sess-1" })[Symbol.asyncIterator]();
  const next = iterator.next();
  transport.emit(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "message.complete",
        session_id: "sess-1",
        payload: { text: "", status: "error", error: "provider down" },
      },
    }),
  );
  const finished = (await next).value;
  assert.equal(finished.status, "error");
  assert.equal(finished.error, "provider down");
  transport.fail("eof");
  const health = await adapter.health();
  assert.equal(health.ok, false);
});
