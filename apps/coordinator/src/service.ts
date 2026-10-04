import { randomUUID } from "node:crypto";
import { payloadHash } from "../../../packages/contracts/src/index.ts";
import type { HermesAdapter } from "../../../packages/hermes-adapter/src/index.ts";
import {
  locateFiles,
  openApp,
  openRegisteredPath,
  readSelection,
  type CommandRunner,
} from "../../../packages/mac-tools/src/index.ts";
import {
  acquireLease,
  admitTool,
  approvalHash,
  grantAllows,
  type Grant,
  type Lease,
} from "../../../packages/policy/src/index.ts";
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
  private grants: Grant[] = [];
  private lease: Lease | undefined;
  private leaseGeneration = new Map<string, number>();
  private toolActions = new Map<string, string>();
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

  listTasks(): TaskRecord[] {
    return this.store.listTasks();
  }

  eventsAfter(taskId: string, afterSequence: number) {
    return this.store.eventsAfter(taskId, afterSequence);
  }

  outstandingApprovals(taskId: string) {
    return this.store.eventsAfter(taskId, 0).filter((event) => event.type === "approval.requested");
  }

  addGrant(grant: Omit<Grant, "id"> & { id?: string }): Grant {
    const stored = { ...grant, id: grant.id ?? randomUUID() };
    this.grants.push(stored);
    return stored;
  }

  revokeGrant(id: string, now = this.now().getTime()): void {
    const grant = this.grants.find((item) => item.id === id);
    if (!grant) throw new Error("Grant not found");
    grant.revokedAt = now;
  }

  async submitText(instruction: string, source: TaskRecord["source"] = "text"): Promise<TaskRecord> {
    const task = this.openTask(instruction, source);
    const health = await this.hermes.health();
    if (!health.ok) {
      return this.fail(task, health.detail || "Hermes is unavailable");
    }
    try {
      const session = await this.hermes.createSession({ title: instruction.slice(0, 80) });
      const run = await this.hermes.submit({ session, text: instruction });
      this.store.updateTask(task.id, {
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
          this.publish(taskId, "message.delta", { text: event.text });
        } else if (event.type === "tool.started") {
          const admission = admitTool(event.name);
          if (admission.disposition === "deny") {
            await this.hermes.interrupt({ sessionId, status: "streaming" });
            this.block(this.store.getTask(taskId), admission.reason ?? "Tool is disabled");
            return;
          }
          const action = this.proposeAction(taskId, event.name, event.toolId, { args: event.args });
          this.toolActions.set(event.toolId, action.id);
          this.publish(taskId, "tool.started", {
            action_id: action.id,
            tool: event.name,
            target: event.toolId,
          });
        } else if (event.type === "tool.completed") {
          this.publish(taskId, "tool.completed", {
            action_id: this.toolActions.get(event.toolId) ?? event.toolId,
            state: "verified",
          });
        } else if (event.type === "approval.requested") {
          this.holdApproval(taskId, event.command || event.toolName || "tool", event.description, event.rpcId);
        } else if (event.type === "clarification.requested") {
          this.holdClarification(taskId, event.rpcId, event.question, event.choices);
        } else if (event.type === "run.finished") {
          if (event.status === "error") this.fail(this.store.getTask(taskId), event.error ?? "Provider failed");
          else if (event.status === "interrupted") this.cancel(this.store.getTask(taskId));
          else this.finishVerified(this.store.getTask(taskId), event.text || "completed");
          return;
        } else if (event.type === "runtime.crashed") {
          this.block(this.store.getTask(taskId), event.reason);
          return;
        }
      }
    } catch (error) {
      this.fail(this.store.getTask(taskId), error instanceof Error ? error.message : "Hermes failed");
    }
  }

  async interrupt(taskId: string): Promise<TaskRecord> {
    const task = this.store.getTask(taskId);
    this.store.updateTask(taskId, { cancellation_requested_at: this.stamp(), updated_at: this.stamp() });
    if (task.session_id) {
      await this.hermes.interrupt({ sessionId: task.session_id, status: task.engine_run_id ?? "streaming" });
    }
    return this.cancel(task);
  }

  pause(taskId: string): TaskRecord {
    const task = this.store.getTask(taskId);
    const safeBoundary = task.state === "running" && task.current_step !== "executing";
    assertTransition(task.state, "paused", { safeBoundary });
    const updated = this.store.updateTask(taskId, {
      state: "paused",
      current_step: "paused",
      updated_at: this.stamp(),
    });
    this.publish(taskId, "task.state_changed", { from: task.state, to: "paused" });
    return updated;
  }

  async resolveApproval(
    approvalId: string,
    decision: "approved" | "rejected",
    payloadHashInput: string,
  ): Promise<void> {
    const approval = this.store.getApproval(approvalId);
    if (approval.exact_payload_hash !== payloadHashInput) {
      throw new Error("Payload hash does not match this approval");
    }
    if (approval.decision) return;
    const action = this.store.getAction(approval.action_id);
    const task = this.store.getTask(action.task_id);
    if (task.state === "cancelled" || task.state === "failed") {
      throw new Error("Cancelled tasks cannot execute");
    }
    this.store.resolveApproval(approvalId, decision, this.stamp(), this.user);
    this.publish(action.task_id, "approval.resolved", { approval_id: approvalId, decision });
    if (decision === "rejected") {
      this.store.updateAction(action.id, { state: "cancelled_before_execution" });
      this.block(task, "Approval rejected");
      return;
    }
    this.store.updateAction(action.id, { state: "authorized" });
    const scope = JSON.parse(approval.scope) as { rpcId?: string };
    if (scope.rpcId && task.session_id) {
      await this.hermes.answerRequest({ rpcId: scope.rpcId, result: { choice: "once" } });
      return;
    }
    await this.executeWorkflow(task, this.store.getAction(action.id), action.tool, action.target, scope);
  }

  answerClarification(requestId: string, answer: string): void {
    const events = this.store.listTasks().flatMap((task) => this.store.eventsAfter(task.id, 0));
    const match = events.find(
      (event) =>
        event.type === "clarification.requested" && event.payload.request_id === requestId,
    );
    if (!match) throw new Error("Clarification not found");
    const rpcId = String(match.payload.rpc_id ?? "");
    void this.hermes.answerRequest({ rpcId, result: { answer } });
    const task = this.store.getTask(match.task_id);
    assertTransition(task.state, "running");
    this.store.updateTask(task.id, { state: "running", current_step: "clarified", updated_at: this.stamp() });
    this.publish(task.id, "task.state_changed", { from: task.state, to: "running" });
  }

  async runWorkflow(
    tool: string,
    target: string,
    extra: Record<string, unknown> = {},
  ): Promise<TaskRecord> {
    const idempotency = typeof extra.idempotency_key === "string" ? extra.idempotency_key : undefined;
    if (idempotency) {
      const existing = this.store.findByIdempotency(idempotency);
      if (existing) return this.store.getTask(existing.task_id);
    }
    const task = this.openTask(`${tool} ${target}`, "text");
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
    const action = this.proposeAction(task.id, tool, target, extra, hash);
    if (admission.disposition === "review") {
      const allowed = grantAllows(this.grants, {
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
        this.lease = acquireLease(this.lease, task.id, this.now().getTime(), this.leaseTtlMs);
        this.leaseGeneration.set(task.id, this.lease.fencingGeneration);
      } catch (error) {
        return this.block(task, error instanceof Error ? error.message : "Lease unavailable");
      }
    }
    if (this.store.getTask(task.id).state === "waiting_approval") {
      this.store.updateTask(task.id, { state: "running", current_step: "running", updated_at: this.stamp() });
    }
    this.store.updateTask(task.id, { current_step: "executing", updated_at: this.stamp() });
    this.store.updateAction(action.id, { state: "executing", started_at: this.stamp() });
    this.publish(task.id, "tool.started", { action_id: action.id, tool, target });
    const result = await this.dispatchTool(tool, target, extra);
    if (!result.ok) {
      this.store.updateAction(action.id, {
        state: "failed",
        verification: "unverified",
        completed_at: this.stamp(),
      });
      this.publish(task.id, "tool.completed", { action_id: action.id, state: "failed" });
      return this.block(task, result.reason);
    }
    const verification = verifyObserved({ required: true, observed: true });
    this.store.updateAction(action.id, {
      state: "verified",
      verification,
      evidence_reference: result.evidence,
      completed_at: this.stamp(),
    });
    this.publish(task.id, "tool.completed", { action_id: action.id, state: "verified" });
    this.publish(task.id, "action.verified", { action_id: action.id, evidence_reference: result.evidence });
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
        return selection.ok
          ? { ok: true, evidence: `${selection.source}: ${selection.text}` }
          : selection;
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

  private requestReview(
    task: TaskRecord,
    action: ActionRecord,
    hash: string,
    binding: Record<string, unknown>,
  ): TaskRecord {
    const approvalId = randomUUID();
    const expires = new Date(this.now().getTime() + 30 * 60 * 1000).toISOString();
    this.store.insertApproval({
      id: approvalId,
      action_id: action.id,
      exact_payload_hash: hash,
      scope: JSON.stringify(binding),
      requested_at: this.stamp(),
      expires_at: expires,
    });
    this.store.updateAction(action.id, { approval_id: approvalId, state: "proposed" });
    assertTransition(task.state, "waiting_approval");
    this.store.updateTask(task.id, {
      state: "waiting_approval",
      current_step: "review",
      updated_at: this.stamp(),
    });
    this.publish(task.id, "task.state_changed", { from: "running", to: "waiting_approval" });
    this.publish(task.id, "approval.requested", {
      approval_id: approvalId,
      exact_payload_hash: hash,
      scope: binding,
      expires_at: expires,
    });
    return this.store.getTask(task.id);
  }

  private holdApproval(taskId: string, tool: string, description: string, rpcId: string): void {
    const task = this.store.getTask(taskId);
    const hash = payloadHash({ tool, description, rpcId });
    const action = this.proposeAction(taskId, tool, description, { rpcId }, hash);
    this.requestReview(task, action, hash, { tool, description, rpcId, operation: tool, target: description });
  }

  private holdClarification(taskId: string, rpcId: string, question: string, choices: string[]): void {
    const task = this.store.getTask(taskId);
    assertTransition(task.state, "waiting_input");
    this.store.updateTask(taskId, {
      state: "waiting_input",
      current_step: "clarification",
      updated_at: this.stamp(),
    });
    this.publish(taskId, "task.state_changed", { from: task.state, to: "waiting_input" });
    this.publish(taskId, "clarification.requested", {
      request_id: rpcId,
      rpc_id: rpcId,
      question,
      choices,
    });
  }

  private openTask(instruction: string, source: TaskRecord["source"]): TaskRecord {
    const task = this.store.createTask({ instruction, source, now: this.stamp() });
    this.publish(task.id, "task.created", { instruction, source });
    assertTransition("queued", "running");
    this.store.updateTask(task.id, { state: "running", current_step: "running", updated_at: this.stamp() });
    this.publish(task.id, "task.state_changed", { from: "queued", to: "running" });
    return this.store.getTask(task.id);
  }

  private proposeAction(
    taskId: string,
    tool: string,
    target: string,
    payload: Record<string, unknown>,
    hash = payloadHash({ tool, target, payload }),
  ): ActionRecord {
    const idempotency = typeof payload.idempotency_key === "string" ? payload.idempotency_key : null;
    if (idempotency) {
      const existing = this.store.findByIdempotency(idempotency);
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
    this.store.insertAction(action);
    return action;
  }

  private finishVerified(task: TaskRecord, evidence: string): TaskRecord {
    const current = this.store.getTask(task.id);
    if (current.state === "succeeded" || current.state === "failed" || current.state === "cancelled") {
      return current;
    }
    assertTransition(current.state === "waiting_approval" ? "running" : current.state, "succeeded", {
      verified: true,
    });
    const from = current.state === "waiting_approval" ? "running" : current.state;
    if (current.state === "waiting_approval") {
      this.store.updateTask(task.id, { state: "running", updated_at: this.stamp() });
    }
    const updated = this.store.updateTask(task.id, {
      state: "succeeded",
      current_step: "succeeded",
      error: null,
      updated_at: this.stamp(),
    });
    this.publish(task.id, "task.state_changed", { from, to: "succeeded" });
    this.publish(task.id, "run.finished", { state: "succeeded", evidence });
    return updated;
  }

  private fail(task: TaskRecord, error: string): TaskRecord {
    const current = this.store.getTask(task.id);
    if (["failed", "cancelled", "succeeded"].includes(current.state)) return current;
    const updated = this.store.updateTask(task.id, {
      state: "failed",
      error,
      current_step: "failed",
      updated_at: this.stamp(),
    });
    this.publish(task.id, "task.state_changed", { from: current.state, to: "failed", error });
    this.publish(task.id, "run.finished", { state: "failed", error });
    return updated;
  }

  private block(task: TaskRecord, reason: string): TaskRecord {
    const current = this.store.getTask(task.id);
    if (["blocked", "failed", "cancelled", "succeeded"].includes(current.state)) return current;
    const updated = this.store.updateTask(task.id, {
      state: "blocked",
      error: reason,
      current_step: "blocked",
      updated_at: this.stamp(),
    });
    this.publish(task.id, "task.state_changed", { from: current.state, to: "blocked", error: reason });
    return updated;
  }

  private cancel(task: TaskRecord): TaskRecord {
    const current = this.store.getTask(task.id);
    if (current.state === "cancelled") return current;
    const updated = this.store.updateTask(task.id, {
      state: "cancelled",
      current_step: "cancelled",
      updated_at: this.stamp(),
    });
    this.publish(task.id, "task.state_changed", { from: current.state, to: "cancelled" });
    this.publish(task.id, "run.finished", { state: "cancelled" });
    return updated;
  }

  private publish(taskId: string, type: Parameters<HarnessStore["appendEvent"]>[0]["type"], payload: Record<string, unknown>): void {
    const event = this.store.appendEvent({ taskId, type, payload, now: this.stamp() });
    for (const listener of this.listeners) listener(event);
  }

  private stamp(): string {
    return this.now().toISOString();
  }
}
