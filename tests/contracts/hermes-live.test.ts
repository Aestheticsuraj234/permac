import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnStdioTransport } from "../../packages/hermes-adapter/src/stdio.ts";
import { HermesGatewayAdapter } from "../../packages/hermes-adapter/src/index.ts";

const python = join(process.cwd(), "upstream/hermes-agent/.venv/bin/python");
const hermesDir = join(process.cwd(), "upstream/hermes-agent");

test("pinned Hermes gateway accepts a session and an interrupt", async () => {
  const home = mkdtempSync(join(tmpdir(), "permac-hermes-"));
  const transport = spawnStdioTransport(python, ["-m", "tui_gateway.entry"], { ...process.env, HERMES_HOME: home }, hermesDir);
  const adapter = new HermesGatewayAdapter(transport);
  try {
    const session = await adapter.createSession({ title: "contract" });
    assert.ok(session.sessionId);
    const health = await adapter.health();
    assert.equal(health.ok, true);
    try {
      const receipt = await adapter.interrupt({ sessionId: session.sessionId, status: "streaming" });
      assert.ok(receipt.status === "interrupted" || receipt.status === "not_interrupted");
    } catch (error) {
      assert.match(String(error), /not connected to any AI provider/);
    }
  } finally {
    transport.close();
  }
});
