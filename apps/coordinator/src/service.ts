import { randomUUID } from "node:crypto";
import { payloadHash } from "../../../packages/contracts/src/index.ts";
import type { HermesAdapter } from "../../../packages/hermes-adapter/src/index.ts";
import { locateFiles, openApp, openRegisteredPath, readSelection, type CommandRunner } from "../../../packages/mac-tools/src/index.ts";
import { memoryConfigured, recallMemory, storeMemory } from "../../../packages/memory/src/index.ts";
import { acquireLease, admitTool, approvalHash, grantAllows, type Grant } from "../../../packages/policy/src/index.ts";
import { HarnessStore, type ActionRecord, type TaskRecord } from "../../../packages/storage/src/index.ts";
import { assertTransition } from "../../../packages/task-logic/src/index.ts";
import { canSucceed, verifyObserved } from "../../../packages/verification/src/index.ts";

export interface CoordinatorOptions {
  now?: () => Date;
  registry?: readonly string[];
  roots?: readonly string[];
  runner?: CommandRunner;
  user?: string;
  leaseTtlMs?: number;
}

export class CoordinatorService {
  private readonly now: () => Date;
  private readonly registry: readonly string[];
  private readonly roots: readonly string[];
  private readonly runner: CommandRunner;
  private readonly user: string;
  private readonly leaseTtlMs: number;
  private listeners = new Set<(event: unknown) => void>();

  constructor(
    private readonly store: HarnessStore,
    private readonly hermes: HermesAdapter,
    options: CoordinatorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.registry = options.registry ?? ["Cursor"];
    this.roots = options.roots ?? [];
    this.runner = options.runner ?? {
      async run() {
        return { code: 1, stdout: "", stderr: "No command runner configured" };
      },
    };
    this.user = options.user ?? "local";
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listTasks(): Promise<TaskRecord[]> {
    return this.store.listTasks();
  }

  eventsAfter(taskId: string, afterSequence: number) {
    return this.store.eventsAfter(taskId, afterSequence);
  }

  async outstandingApprovals(taskId: string) {
    return (await this.store.eventsAfter(taskId, 0)).filter((event) => event.type === "approval.requested");
  }

  async addGrant(grant: Omit<Grant, "id"> & { id?: string }): Promise<Grant> {
    const stored = { ...grant, id: grant.id ?? randomUUID() };
    await this.store.insertGrant(stored);
    return stored;
  }

  async revokeGrant(id: string, now = this.now().getTime()): Promise<void> {
    await this.store.revokeGrant(id, now);
  }

  async submitText(instruction: string, source: TaskRecord["source"] = "text"): Promise<TaskRecord> {
    const task = await this.openTask(instruction, source);
    const prompt = await this.promptWithMemory(task.id, instruction);
    const health = await this.hermes.health();
    if (!health.ok) {
      return this.fail(task, health.detail || "Hermes is unavailable");
    }
    try {
      const session = await this.hermes.createSession({ title: instruction.slice(0, 80) });
      const run = await this.hermes.submit({ session, text: prompt });
      await this.store.updateTask(task.id, {
        session_id: session.sessionId,
        engine_run_id: run.status,
        current_step: "submitted",
        updated_at: this.stamp(),
      });
      void this.consume(task.id, session.sessionId);
      return this.store.getTask(task.id);
    } catch (error) {
      return this.fail(task, error instanceof Error ? error.message : "Hermes submit failed");
    }
  }

  private async consume(taskId: string, sessionId: string): Promise<void> {
    try {
      for await (const event of this.hermes.subscribe({ sessionId })) {
        if (event.type === "message.delta") {
          await this.publish(taskId, "message.delta", { text: event.text });
        } else if (event.type === "tool.started") {
          const admission = admitTool(event.name);
          if (admission.disposition === "deny") {
            await this.hermes.interrupt({ sessionId, status: "streaming" });
            await this.block(await this.store.getTask(taskId), admission.reason ?? "Tool is disabled");
            return;
          }
          const action = await this.proposeAction(taskId, event.name, event.toolId, { args: event.args });
          await this.publish(taskId, "tool.started", {
            action_id: action.id,
            tool: event.name,
            target: event.toolId,
          });
        } else if (event.type === "tool.completed") {
          const action = await this.store.findActionByTarget(taskId, event.toolId);
          await this.publish(taskId, "tool.completed", {
            action_id: action?.id ?? event.toolId,
            state: "verified",
          });
        } else if (event.type === "approval.requested") {
          await this.holdApproval(taskId, event.command || event.toolName || "tool", event.description, event.rpcId);
        } else if (event.type === "clarification.requested") {
          await this.holdClarification(taskId, event.rpcId, event.question, event.choices);
        } else if (event.type === "run.finished") {
          const task = await this.store.getTask(taskId);
          if (event.status === "error") await this.fail(task, event.error ?? "Provider failed");
          else if (event.status === "interrupted") await this.cancel(task);
          else await this.finishVerified(task, event.text || "completed");
          return;
        } else if (event.type === "runtime.crashed") {
          await this.block(await this.store.getTask(taskId), event.reason);
          return;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Hermes failed";
      try {
        await this.fail(await this.store.getTask(taskId), message);
      } catch {
        // Shutdown can close the store while a run is still finishing.
      }
    }
  }

  async interrupt(taskId: string): Promise<TaskRecord> {
    const task = await this.store.getTask(taskId);
    await this.store.updateTask(taskId, { cancellation_requested_at: this.stamp(), updated_at: this.stamp() });
    if (task.session_id) {
      await this.hermes.interrupt({ sessionId: task.session_id, status: task.engine_run_id ?? "streaming" });
    }
    return this.cancel(task);
  }

  async pause(taskId: string): Promise<TaskRecord> {
    const task = await this.store.getTask(taskId);
    const safeBoundary = task.state === "running" && task.current_step !== "executing";
    assertTransition(task.state, "paused", { safeBoundary });
    const updated = await this.store.updateTask(taskId, {
      state: "paused",
      current_step: "paused",
      updated_at: this.stamp(),
    });
    await this.publish(taskId, "task.state_changed", { from: task.state, to: "paused" });
    return updated;
  }

  async resolveApproval(
    approvalId: string,
    decision: "approved" | "rejected",
    payloadHashInput: string,
  ): Promise<void> {
    const approval = await this.store.getApproval(approvalId);
    if (approval.exact_payload_hash !== payloadHashInput) {
      throw new Error("Payload hash does not match this approval");
    }
    if (approval.decision) return;
    const action = await this.store.getAction(approval.action_id);
    const task = await this.store.getTask(action.task_id);
    if (task.state === "cancelled" || task.state === "failed") {
      throw new Error("Cancelled tasks cannot execute");
    }
    await this.store.resolveApproval(approvalId, decision, this.stamp(), this.user);
    await this.publish(action.task_id, "approval.resolved", { approval_id: approvalId, decision });
    if (decision === "rejected") {
      await this.store.updateAction(action.id, { state: "cancelled_before_execution" });
      await this.block(task, "Approval rejected");
      return;
    }
    await this.store.updateAction(action.id, { state: "authorized" });
    const scope = JSON.parse(approval.scope) as { rpcId?: string };
    if (scope.rpcId && task.session_id) {
      await this.hermes.answerRequest({ rpcId: scope.rpcId, result: { choice: "once" } });
      return;
    }
    await this.executeWorkflow(task, await this.store.getAction(action.id), action.tool, action.target, scope);
  }

  async answerClarification(requestId: string, answer: string): Promise<void> {
    const tasks = await this.store.listTasks();
    const events = (await Promise.all(tasks.map((task) => this.store.eventsAfter(task.id, 0)))).flat();
    const match = events.find(
      (event) => event.type === "clarification.requested" && event.payload.request_id === requestId,
    );
    if (!match) throw new Error("Clarification not found");
    const rpcId = String(match.payload.rpc_id ?? "");
    void this.hermes.answerRequest({ rpcId, result: { answer } });
    const task = await this.store.getTask(match.task_id);
    assertTransition(task.state, "running");
    await this.store.updateTask(task.id, { state: "running", current_step: "clarified", updated_at: this.stamp() });
    await this.publish(task.id, "task.state_changed", { from: task.state, to: "running" });
  }

  async runWorkflow(
    tool: string,
    target: string,
    extra: Record<string, unknown> = {},
  ): Promise<TaskRecord> {
    const idempotency = typeof extra.idempotency_key === "string" ? extra.idempotency_key : undefined;
    if (idempotency) {
      const existing = await this.store.findByIdempotency(idempotency);
      if (existing) return this.store.getTask(existing.task_id);
    }
    const task = await this.openTask(`${tool} ${target}`, "text");
    const admission = admitTool(tool);
    if (admission.disposition === "deny") return this.block(task, admission.reason ?? "Denied");
    const binding = {
      operation: tool,
      tool,
      target,
      body: typeof extra.body === "string" ? extra.body : undefined,
      account: typeof extra.account === "string" ? extra.account : undefined,
      recipient: typeof extra.recipient === "string" ? extra.recipient : undefined,
    };
    const hash = approvalHash(binding);
    const action = await this.proposeAction(task.id, tool, target, extra, hash);
    if (admission.disposition === "review") {
      const allowed = grantAllows(await this.store.listGrants(), {
        target,
        capability: tool,
        operation: tool,
        now: this.now().getTime(),
      });
      if (!allowed) {
        return this.requestReview(task, action, hash, binding);
      }
    }
    return this.executeWorkflow(task, action, tool, target, extra);
  }

  private async executeWorkflow(
    task: TaskRecord,
    action: ActionRecord,
    tool: string,
    target: string,
    extra: Record<string, unknown>,
  ): Promise<TaskRecord> {
    if (tool === "send_message" || tool === "open_app" || tool === "open_registered_path") {
      try {
        const lease = acquireLease(await this.store.readLease(), task.id, this.now().getTime(), this.leaseTtlMs);
        await this.store.writeLease(lease);
      } catch (error) {
        return this.block(task, error instanceof Error ? error.message : "Lease unavailable");
      }
    }
    if ((await this.store.getTask(task.id)).state === "waiting_approval") {
      await this.store.updateTask(task.id, { state: "running", current_step: "running", updated_at: this.stamp() });
    }
    await this.store.updateTask(task.id, { current_step: "executing", updated_at: this.stamp() });
    await this.store.updateAction(action.id, { state: "executing", started_at: this.stamp() });
    await this.publish(task.id, "tool.started", { action_id: action.id, tool, target });
    const result = await this.dispatchTool(tool, target, extra);
    if (!result.ok) {
      await this.store.updateAction(action.id, {
        state: "failed",
        verification: "unverified",
        completed_at: this.stamp(),
      });
      await this.publish(task.id, "tool.completed", { action_id: action.id, state: "failed" });
      return this.block(task, result.reason);
    }
    const verification = verifyObserved({ required: true, observed: true });
    await this.store.updateAction(action.id, {
      state: "verified",
      verification,
      evidence_reference: result.evidence,
      completed_at: this.stamp(),
    });
    await this.publish(task.id, "tool.completed", { action_id: action.id, state: "verified" });
    await this.publish(task.id, "action.verified", { action_id: action.id, evidence_reference: result.evidence });
    if (!canSucceed(verification)) return this.block(task, "Outcome was not verified");
    return this.finishVerified(task, result.evidence);
  }

  private async dispatchTool(
    tool: string,
    target: string,
    extra: Record<string, unknown>,
  ): Promise<{ ok: true; evidence: string } | { ok: false; reason: string }> {
    if (tool === "open_app") {
      const opened = await openApp({ app: target, registry: this.registry, runner: this.runner });
      return opened.ok ? { ok: true, evidence: `opened ${target}` } : opened;
    }
    if (tool === "open_registered_path") {
      const opened = await openRegisteredPath({ path: target, roots: this.roots, runner: this.runner });
      return opened.ok ? { ok: true, evidence: `opened ${target}` } : opened;
    }
    if (tool === "read_selection" || tool === "resolve_workspace" || tool === "inspect_window" || tool === "verify_app_state") {
      if (tool === "read_selection") {
        const selection = await readSelection({ runner: this.runner });
        return selection.ok ? { ok: true, evidence: `${selection.source}: ${selection.text}` } : selection;
      }
      if (tool === "verify_app_state") {
        const front = await this.runner.run("osascript", [
          "-e",
          'tell application "System Events" to get name of first process whose frontmost is true',
        ]);
        if (front.code !== 0) return { ok: false, reason: "Could not inspect the front app" };
        if (front.stdout.trim() !== target) {
          return { ok: false, reason: `Foreground changed to ${front.stdout.trim() || "unknown"}` };
        }
        return { ok: true, evidence: `foreground ${target}` };
      }
      return { ok: true, evidence: `${tool} ${target}` };
    }
    if (tool === "locate_file") {
      const entries = Array.isArray(extra.entries) ? extra.entries.map(String) : [];
      const found = locateFiles(entries, this.roots, target);
      if (!found.ok) return found;
      return { ok: true, evidence: `${found.root}: ${found.matches.join(", ") || "no matches"}` };
    }
    return { ok: false, reason: `${tool} has no executor` };
  }

  private async requestReview(
    task: TaskRecord,
    action: ActionRecord,
    hash: string,
    binding: Record<string, unknown>,
  ): Promise<TaskRecord> {
    const approvalId = randomUUID();
    const expires = new Date(this.now().getTime() + 30 * 60 * 1000).toISOString();
    await this.store.insertApproval({
      id: approvalId,
      action_id: action.id,
      exact_payload_hash: hash,
      scope: JSON.stringify(binding),
      requested_at: this.stamp(),
      expires_at: expires,
    });
    await this.store.updateAction(action.id, { approval_id: approvalId, state: "proposed" });
    assertTransition(task.state, "waiting_approval");
    await this.store.updateTask(task.id, {
      state: "waiting_approval",
      current_step: "review",
      updated_at: this.stamp(),
    });
    await this.publish(task.id, "task.state_changed", { from: "running", to: "waiting_approval" });
    await this.publish(task.id, "approval.requested", {
      approval_id: approvalId,
      exact_payload_hash: hash,
      scope: binding,
      expires_at: expires,
    });
    return this.store.getTask(task.id);
  }

  private async holdApproval(taskId: string, tool: string, description: string, rpcId: string): Promise<void> {
    const task = await this.store.getTask(taskId);
    const hash = payloadHash({ tool, description, rpcId });
    const action = await this.proposeAction(taskId, tool, description, { rpcId }, hash);
    await this.requestReview(task, action, hash, { tool, description, rpcId, operation: tool, target: description });
  }

  private async holdClarification(taskId: string, rpcId: string, question: string, choices: string[]): Promise<void> {
    const task = await this.store.getTask(taskId);
    assertTransition(task.state, "waiting_input");
    await this.store.updateTask(taskId, {
      state: "waiting_input",
      current_step: "clarification",
      updated_at: this.stamp(),
    });
    await this.publish(taskId, "task.state_changed", { from: task.state, to: "waiting_input" });
    await this.publish(taskId, "clarification.requested", {
      request_id: rpcId,
      rpc_id: rpcId,
      question,
      choices,
    });
  }

  private async openTask(instruction: string, source: TaskRecord["source"]): Promise<TaskRecord> {
    const task = await this.store.createTask({ instruction, source, now: this.stamp() });
    await this.publish(task.id, "task.created", { instruction, source });
    assertTransition("queued", "running");
    await this.store.updateTask(task.id, { state: "running", current_step: "running", updated_at: this.stamp() });
    await this.publish(task.id, "task.state_changed", { from: "queued", to: "running" });
    return this.store.getTask(task.id);
  }

  private async proposeAction(
    taskId: string,
    tool: string,
    target: string,
    payload: Record<string, unknown>,
    hash = payloadHash({ tool, target, payload }),
  ): Promise<ActionRecord> {
    const idempotency = typeof payload.idempotency_key === "string" ? payload.idempotency_key : null;
    if (idempotency) {
      const existing = await this.store.findByIdempotency(idempotency);
      if (existing) return existing;
    }
    const action: ActionRecord = {
      id: randomUUID(),
      task_id: taskId,
      tool,
      target,
      payload_hash: hash,
      state: "proposed",
      approval_id: null,
      started_at: null,
      completed_at: null,
      verification: "pending",
      evidence_reference: null,
      idempotency_key: idempotency,
    };
    await this.store.insertAction(action);
    return action;
  }

  private async finishVerified(task: TaskRecord, evidence: string): Promise<TaskRecord> {
    const current = await this.store.getTask(task.id);
    if (current.state === "succeeded" || current.state === "failed" || current.state === "cancelled") {
      return current;
    }
    assertTransition(current.state === "waiting_approval" ? "running" : current.state, "succeeded", {
      verified: true,
    });
    const from = current.state === "waiting_approval" ? "running" : current.state;
    if (current.state === "waiting_approval") {
      await this.store.updateTask(task.id, { state: "running", updated_at: this.stamp() });
    }
    const updated = await this.store.updateTask(task.id, {
      state: "succeeded",
      current_step: "succeeded",
      error: null,
      updated_at: this.stamp(),
    });
    await this.publish(task.id, "task.state_changed", { from, to: "succeeded" });
    await this.publish(task.id, "run.finished", { state: "succeeded", evidence });
    return updated;
  }

  private async fail(task: TaskRecord, error: string): Promise<TaskRecord> {
    const current = await this.store.getTask(task.id);
    if (["failed", "cancelled", "succeeded"].includes(current.state)) return current;
    const updated = await this.store.updateTask(task.id, {
      state: "failed",
      error,
      current_step: "failed",
      updated_at: this.stamp(),
    });
    await this.publish(task.id, "task.state_changed", { from: current.state, to: "failed", error });
    await this.publish(task.id, "run.finished", { state: "failed", error });
    return updated;
  }

  private async block(task: TaskRecord, reason: string): Promise<TaskRecord> {
    const current = await this.store.getTask(task.id);
    if (["blocked", "failed", "cancelled", "succeeded"].includes(current.state)) return current;
    const updated = await this.store.updateTask(task.id, {
      state: "blocked",
      error: reason,
      current_step: "blocked",
      updated_at: this.stamp(),
    });
    await this.publish(task.id, "task.state_changed", { from: current.state, to: "blocked", error: reason });
    return updated;
  }

  private async cancel(task: TaskRecord): Promise<TaskRecord> {
    const current = await this.store.getTask(task.id);
    if (current.state === "cancelled") return current;
    const updated = await this.store.updateTask(task.id, {
      state: "cancelled",
      current_step: "cancelled",
      updated_at: this.stamp(),
    });
    await this.publish(task.id, "task.state_changed", { from: current.state, to: "cancelled" });
    await this.publish(task.id, "run.finished", { state: "cancelled" });
    return updated;
  }

  private async promptWithMemory(taskId: string, instruction: string): Promise<string> {
    if (!memoryConfigured()) {
      await this.store.recordLog("memory.skipped", taskId, {
        operation: "recall",
        reason: "SUPERMEMORY_API_KEY is not set",
      });
      return instruction;
    }
    try {
      const memories = await recallMemory(instruction);
      await this.store.recordLog("memory.recalled", taskId, { count: memories.length, memories });
      if (memories.length === 0) return instruction;
      return `${instruction}\n\nRecalled from Supermemory:\n${memories.map((item) => `- ${item}`).join("\n")}`;
    } catch (error) {
      await this.store.recordLog("memory.failed", taskId, {
        operation: "recall",
        error: error instanceof Error ? error.message : "Supermemory recall failed",
      });
      return instruction;
    }
  }

  private async publish(
    taskId: string,
    type: Parameters<HarnessStore["appendEvent"]>[0]["type"],
    payload: Record<string, unknown>,
  ): Promise<void> {
    const event = await this.store.appendEvent({ taskId, type, payload, now: this.stamp() });
    const content = `${type}\n${JSON.stringify(payload)}`;
    try {
      const stored = await storeMemory(content, { type });
      await this.store.recordLog(stored === "stored" ? "memory.stored" : "memory.skipped", taskId, {
        type,
        event_id: event.event_id,
      });
    } catch (error) {
      await this.store.recordLog("memory.failed", taskId, {
        operation: "store",
        type,
        error: error instanceof Error ? error.message : "Supermemory store failed",
      });
    }
    for (const listener of this.listeners) listener(event);
  }

  private stamp(): string {
    return this.now().toISOString();
  }
}
