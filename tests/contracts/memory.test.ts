import assert from "node:assert/strict";
import { test } from "node:test";
import { forgetMemory, recallMemory, storeMemory, type MemoryClient } from "../../packages/memory/src/index.ts";

function fakeClient(): MemoryClient & { added: string[]; deleted: string[] } {
  const added: string[] = [];
  const deleted: string[] = [];
  return {
    added,
    deleted,
    async add(params) {
      added.push(params.content);
      return { id: "doc-1" };
    },
    async search() {
      return { results: [{ memory: "likes short notes" }, { chunk: "cursor project" }] };
    },
    documents: {
      async delete(id: string) {
        deleted.push(id);
      },
    },
  };
}

test("supermemory sdk stores, recalls, and forgets without a local file", async () => {
  const client = fakeClient();
  assert.equal(await storeMemory("task finished", { type: "run.finished" }, client), "stored");
  assert.match(client.added[0] ?? "", /task finished/);
  assert.deepEqual(await recallMemory("notes", client), ["likes short notes", "cursor project"]);
  assert.equal(await forgetMemory("doc-1", client), "stored");
  assert.deepEqual(client.deleted, ["doc-1"]);
});

test("missing supermemory key does not store locally", async () => {
  const previous = process.env.SUPERMEMORY_API_KEY;
  delete process.env.SUPERMEMORY_API_KEY;
  try {
    assert.equal(await storeMemory("nothing local"), "skipped");
    assert.deepEqual(await recallMemory("nothing local"), []);
    assert.equal(await forgetMemory("doc-1"), "skipped");
  } finally {
    if (previous === undefined) delete process.env.SUPERMEMORY_API_KEY;
    else process.env.SUPERMEMORY_API_KEY = previous;
  }
});
