import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { test } from "node:test";
import { CoordinatorService } from "../../apps/coordinator/src/service.ts";
import { listen } from "../../apps/coordinator/src/server.ts";
import type { EngineEvent, HermesAdapter, RequestAnswer, RunRef, SessionRef } from "../../packages/hermes-adapter/src/index.ts";
import { locateFiles, openApp, readSelection, walkFiles } from "../../packages/mac-tools/src/index.ts";
import { HarnessStore } from "../../packages/storage/src/index.ts";
import { runWhatsAppSend, type WhatsAppDriver } from "../../packages/messaging/src/whatsapp.ts";
import { applyStop, decideVoiceInput } from "../../packages/voice/src/index.ts";
import { missedSchedule, optionalToolEnabled, runRoutine } from "../../packages/schedule/src/index.ts";

class Queue<T> {
  private items: T[] = [];
  private waiters: Array<(value: T) => void> = [];
  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.items.push(value);
  }
  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

class FakeHermes implements HermesAdapter {
  answered: RequestAnswer[] = [];
  healthOk = true;
  subscribed = Promise.resolve();
  private markSubscribed = () => {};
  private queue = new Queue<EngineEvent>();

  constructor() {
    this.subscribed = new Promise((resolve) => {
      this.markSubscribed = resolve;
    });
  }

  async createSession(): Promise<SessionRef> {
    return { sessionId: "s" };
  }
  async submit(): Promise<RunRef> {
    return { sessionId: "s", status: "streaming" };
  }
  async interrupt(): Promise<{ sessionId: string; status: string }> {
    return { sessionId: "s", status: "interrupted" };
  }
  async answerRequest(input: RequestAnswer): Promise<void> {
    this.answered.push(input);
  }
  async readHistory() {
    return [];
  }
  subscribe(): AsyncIterable<EngineEvent> {
    this.markSubscribed();
    const queue = this.queue;
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const event = await queue.next();
          yield event;
          if (event.type === "run.finished" || event.type === "runtime.crashed") return;
        }
      },
    };
  }
  async health() {
    return { ok: this.healthOk, detail: this.healthOk ? "ok" : "down" };
  }
  push(event: EngineEvent): void {
    this.queue.push(event);
  }
}

function service(hermes = new FakeHermes(), runnerCode = 0) {
  const store = HarnessStore.open(":memory:");
  const coordinator = new CoordinatorService(store, hermes, {
    registry: ["Cursor", "TextEdit"],
    roots: ["/Users/me/Documents"],
    runner: {
      async run(command: string, args: string[]) {
        if (args.includes("Missing")) return { code: 1, stdout: "", stderr: "missing" };
        if (command === "osascript" && args.join(" ").includes("frontmost")) {
          return { code: 0, stdout: args.includes("Safari") ? "Safari\n" : "TextEdit\n", stderr: "" };
        }
        return { code: runnerCode, stdout: runnerCode === 0 ? "selected text\n" : "", stderr: "" };
      },
    },
  });
  return { store, coordinator, hermes };
}

test("restart keeps tasks and marks executing actions unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "permac-db-"));
  const path = join(dir, "harness.sqlite");
  const first = HarnessStore.open(path);
  const task = first.createTask({
    instruction: "remember",
    source: "text",
    now: "2026-10-04T00:00:00.000Z",
  });
  first.insertAction({
    id: "act",
    task_id: task.id,
    tool: "send_message",
    target: "ada",
    payload_hash: "h",
    state: "executing",
    approval_id: null,
    started_at: "2026-10-04T00:00:00.000Z",
    completed_at: null,
    verification: "pending",
    evidence_reference: null,
    idempotency_key: null,
  });
  first.appendEvent({
    taskId: task.id,
    type: "task.created",
    payload: { instruction: "remember" },
    now: "2026-10-04T00:00:01.000Z",
  });
  first.close();
  const second = HarnessStore.open(path);
  assert.equal(second.getTask(task.id).instruction, "remember");
  assert.equal(second.getAction("act").state, "unknown");
  assert.equal(second.eventsAfter(task.id, 0).length, 1);
  second.close();
});

test("workflows open an app, block a missing app, and find a granted file", async () => {
  const { coordinator } = service();
  const opened = await coordinator.runWorkflow("open_app", "Cursor");
  assert.equal(opened.state, "succeeded");
  const missing = await coordinator.runWorkflow("open_app", "Missing");
  assert.equal(missing.state, "blocked");
  const found = await coordinator.runWorkflow("locate_file", "notes", {
    entries: ["/Users/me/Documents/notes.txt", "/Users/me/Documents/.ssh/id_rsa", "/tmp/notes.txt"],
  });
  assert.equal(found.state, "succeeded");
  assert.match(coordinator.eventsAfter(found.id, 0).at(-1)?.payload.evidence as string, /notes.txt/);
  assert.doesNotMatch(String(coordinator.eventsAfter(found.id, 0).at(-1)?.payload.evidence), /id_rsa/);
});

test("two desktop workflows cannot share the lease", async () => {
  const { coordinator } = service();
  const first = await coordinator.runWorkflow("open_app", "Cursor");
  assert.equal(first.state, "succeeded");
  const second = await coordinator.runWorkflow("open_app", "TextEdit");
  assert.equal(second.state, "blocked");
  assert.match(second.error ?? "", /lease/i);
});

test("message approval binds the payload and a revoked grant does not skip review", async () => {
  const { coordinator } = service();
  const grant = coordinator.addGrant({
    target: "ada",
    capability: "send_message",
    operation: "send_message",
    expiresAt: Date.now() + 10_000,
  });
  coordinator.revokeGrant(grant.id);
  const waiting = await coordinator.runWorkflow("send_message", "ada", {
    body: "hello",
    account: "me",
    recipient: "ada",
  });
  assert.equal(waiting.state, "waiting_approval");
  const approval = coordinator.eventsAfter(waiting.id, 0).find((event) => event.type === "approval.requested");
  assert.ok(approval);
  await assert.rejects(() =>
    coordinator.resolveApproval(
      String(approval?.payload.approval_id),
      "approved",
      "not-the-hash",
    ),
  );
  assert.equal(coordinator.listTasks().find((task) => task.id === waiting.id)?.state, "waiting_approval");
});

test("shell stays disabled and Hermes approvals wait for the coordinator", async () => {
  const hermes = new FakeHermes();
  const { coordinator } = service(hermes);
  const denied = await coordinator.runWorkflow("shell", "rm -rf");
  assert.equal(denied.state, "blocked");
  const submitted = coordinator.submitText("look around");
  await hermes.subscribed;
  const task = await submitted;
  hermes.push({
    type: "approval.requested",
    sessionId: "s",
    rpcId: "srq-1",
    requestId: "req",
    command: "rm build",
    description: "delete",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.listTasks().find((item) => item.id === task.id)?.state, "waiting_approval");
  assert.equal(hermes.answered.length, 0);
  const approval = coordinator.eventsAfter(task.id, 0).find((event) => event.type === "approval.requested");
  await coordinator.resolveApproval(
    String(approval?.payload.approval_id),
    "approved",
    String(approval?.payload.exact_payload_hash),
  );
  assert.equal(hermes.answered[0]?.result.choice, "once");
  hermes.push({
    type: "tool.started",
    sessionId: "s",
    toolId: "tool-1",
    name: "terminal",
    args: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.listTasks().find((item) => item.id === task.id)?.state, "blocked");
});

test("journal replay restores events after the last sequence", async () => {
  const { coordinator } = service();
  const task = await coordinator.runWorkflow("open_app", "Cursor");
  const all = coordinator.eventsAfter(task.id, 0);
  const tail = coordinator.eventsAfter(task.id, 1);
  assert.ok(all.length > tail.length);
  assert.equal(tail[0]?.sequence, 2);
});

test("local socket rejects a bad token, a malformed frame, and an oversized payload", async () => {
  const { coordinator } = service();
  const server = await listen(coordinator, "secret", 0);
  const send = (payload: string) =>
    new Promise<string>((resolve, reject) => {
      const socket = connect(server.port, "127.0.0.1");
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
        if (data.includes("\n")) {
          socket.end();
          resolve(data);
        }
      });
      socket.on("error", reject);
      socket.write(payload);
    });
  const unauthorized = await send(`${JSON.stringify({ id: "1", token: "nope", command: "health" })}\n`);
  assert.match(unauthorized, /Unauthorized/);
  const malformed = await send(`{not-json\n`);
  assert.match(malformed, /Malformed/);
  const huge = await send(`${"x".repeat(1_000_001)}`);
  assert.match(huge, /too large/i);
  await server.close();
});

test("mac tool helpers preserve the clipboard and skip sensitive paths", async () => {
  let board = "original";
  const writes: string[] = [];
  const selection = await readSelection({
    allowClipboardFallback: true,
    runner: {
      async run(_command, args) {
        const script = args.join(" ");
        if (script.includes("AXSelectedText")) return { code: 1, stdout: "", stderr: "unsupported" };
        board = "copied";
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    pasteboard: {
      async read() {
        return board;
      },
      async write(value) {
        writes.push(value);
        board = value;
      },
    },
  });
  assert.equal(selection.ok, true);
  if (selection.ok) assert.equal(selection.source, "clipboard");
  assert.deepEqual(writes, ["original"]);
  const blocked = locateFiles(["/Users/me/.ssh/id"], ["/Users/me/.ssh"], "id");
  assert.equal(blocked.ok, false);
  const opened = await openApp({
    app: "Nope",
    registry: ["Cursor"],
    runner: { async run() { return { code: 0, stdout: "", stderr: "" }; } },
  });
  assert.equal(opened.ok, false);
  const dir = mkdtempSync(join(tmpdir(), "permac-files-"));
  writeFileSync(join(dir, "a.txt"), "a");
  assert.equal(walkFiles(dir).length, 1);
});

test("whatsapp crashes do not send twice and ambiguous contacts ask", () => {
  const contacts = [
    { id: "1", displayLabel: "Ada", account: "me", alternativeNames: [] },
    { id: "2", displayLabel: "Ada", account: "me", alternativeNames: ["A"] },
  ];
  const state = { account: "me", recipientId: undefined as string | undefined, bubbles: [] as string[], sent: 0 };
  const driver: WhatsAppDriver = {
    resolve: () => contacts,
    snapshot: () => ({ ...state, appAvailable: true, permissions: true, bubbles: [...state.bubbles] }),
    openConversation(id) {
      state.recipientId = id;
    },
    prepare() {},
    send() {
      state.sent += 1;
      state.bubbles.push("hello");
    },
  };
  const ambiguous = runWhatsAppSend({
    query: "Ada",
    body: "hello",
    expectedAccount: "me",
    driver,
    payloadHash: "hash",
  });
  assert.equal(ambiguous.state, "clarification");
  assert.equal(state.sent, 0);
  const during = runWhatsAppSend({
    query: "Ada",
    body: "hello",
    expectedAccount: "me",
    driver,
    payloadHash: "hash",
    approvedHash: "hash",
    clarifiedContactId: "1",
    crash: "during_send",
  });
  assert.equal(during.state, "unknown");
  assert.equal(during.resend, false);
  assert.equal(state.sent, 0);
  const sent = runWhatsAppSend({
    query: "Ada",
    body: "hello",
    expectedAccount: "me",
    driver,
    payloadHash: "hash",
    approvedHash: "hash",
    clarifiedContactId: "1",
  });
  assert.equal(sent.observation, "visibly_sent");
  assert.equal(state.sent, 1);
  const duplicate = runWhatsAppSend({
    query: "Ada",
    body: "hello",
    expectedAccount: "me",
    driver,
    payloadHash: "hash",
    approvedHash: "hash",
    clarifiedContactId: "1",
  });
  assert.equal(duplicate.state, "unknown");
  assert.equal(state.sent, 1);
});

test("voice and schedules keep consequential actions on the review path", () => {
  assert.equal(
    decideVoiceInput({
      transcript: "send it",
      fromAssistant: false,
      background: true,
      consequential: true,
      transcriptReviewed: false,
      wakeWordFailed: false,
    }).submit,
    false,
  );
  assert.equal(
    decideVoiceInput({
      transcript: "send it",
      fromAssistant: true,
      background: false,
      consequential: true,
      transcriptReviewed: true,
      wakeWordFailed: false,
    }).submit,
    false,
  );
  const failedWake = decideVoiceInput({
    transcript: "",
    fromAssistant: false,
    background: false,
    consequential: false,
    transcriptReviewed: false,
    wakeWordFailed: true,
  });
  assert.equal(failedWake.pushToTalk, true);
  assert.equal(failedWake.textEntry, true);
  assert.equal(applyStop("run").cancelRun, true);
  assert.equal(applyStop("playback").cancelRun, false);
  assert.equal(missedSchedule({ policy: "skip", externalWrite: true, authorizationCurrent: true }), "skip");
  assert.equal(
    missedSchedule({ policy: "catch_up", externalWrite: true, authorizationCurrent: false }),
    "needs_authorization",
  );
  const routine = runRoutine(
    [
      { tool: "open_app", target: "Cursor" },
      { tool: "shell", target: "rm" },
    ],
    (step) => (step.tool === "shell" ? "blocked" : "ok"),
  );
  assert.equal(routine.completed, 1);
  assert.equal(routine.stopped, true);
  assert.equal(optionalToolEnabled("browser"), false);
  assert.equal(optionalToolEnabled("google"), false);
});
