import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyProjection, ingestEnvelope, payloadHash } from "../../packages/contracts/src/index.ts";
import { admitTool, acquireLease, approvalHash, assertApprovalStillValid, grantAllows } from "../../packages/policy/src/index.ts";
import { decideReview } from "../../packages/task-logic/src/index.ts";

test("reordered and duplicate events do not duplicate actions", () => {
  const projection = emptyProjection();
  const first = {
    schema_version: 1,
    event_id: "e1",
    task_id: "t",
    sequence: 1,
    timestamp: "2026-10-04T00:00:00.000Z",
    type: "tool.started",
    payload: { action_id: "a1", tool: "open_app", target: "Cursor" },
  };
  const third = {
    ...first,
    event_id: "e3",
    sequence: 3,
    type: "task.state_changed",
    payload: { from: "running", to: "succeeded" },
  };
  const second = {
    ...first,
    event_id: "e2",
    sequence: 2,
    type: "tool.completed",
    payload: { action_id: "a1", state: "verified" },
  };
  ingestEnvelope(projection, first);
  ingestEnvelope(projection, first);
  ingestEnvelope(projection, third);
  ingestEnvelope(projection, second);
  const task = projection.tasks.get("t");
  assert.equal(task?.actions.size, 1);
  assert.equal(task?.actions.get("a1"), "verified");
  assert.equal(task?.state, "succeeded");
});

test("unknown schema version is rejected", () => {
  const projection = ingestEnvelope(emptyProjection(), {
    schema_version: 99,
    event_id: "e",
    task_id: "t",
    sequence: 1,
    timestamp: "2026-10-04T00:00:00.000Z",
    type: "task.created",
    payload: {},
  });
  assert.equal(projection.schemaError, true);
  assert.equal(projection.tasks.size, 0);
});

test("policy blocks unmediated tools, revoked grants, and changed payloads", () => {
  assert.equal(admitTool("shell").disposition, "deny");
  assert.equal(admitTool("browser_exec").disposition, "deny");
  assert.equal(admitTool("open_app").disposition, "allow");
  const grant = {
    id: "g",
    target: "ada",
    capability: "send_message",
    operation: "send_message",
    expiresAt: 10_000,
  };
  assert.equal(
    grantAllows([{ ...grant, revokedAt: 50 }], {
      target: "ada",
      capability: "send_message",
      operation: "send_message",
      now: 100,
    }),
    false,
  );
  const binding = { operation: "send_message", tool: "send_message", target: "ada", body: "hi", account: "me" };
  const hash = approvalHash(binding);
  assert.throws(() =>
    assertApprovalStillValid(
      { exact_payload_hash: hash, decision: "approved", expiresAt: 500 },
      { ...binding, body: "changed" },
      100,
    ),
  );
  assert.notEqual(payloadHash({ a: 1, b: 2 }), "");
});

test("a second desktop task cannot take a live lease", () => {
  const first = acquireLease(undefined, "task-a", 0, 1000);
  assert.throws(() => acquireLease(first, "task-b", 10, 1000));
});

test("review rules from OpenMuse reject a changed hash and a cancelled task", () => {
  const proposal = {
    id: "p",
    taskStatus: "running" as const,
    status: "awaiting_review" as const,
    hash: "abc",
    account: "ada@example.com",
    expiresAt: 500,
  };
  assert.throws(() =>
    decideReview(proposal, { hash: "nope", decision: "approved", now: 100, currentAccount: "ada@example.com" }),
  );
  assert.throws(() =>
    decideReview(
      { ...proposal, taskStatus: "cancelled" },
      { hash: "abc", decision: "approved", now: 100, currentAccount: "ada@example.com" },
    ),
  );
  assert.throws(() =>
    decideReview(proposal, { hash: "abc", decision: "approved", now: 100, currentAccount: "other@example.com" }),
  );
});
