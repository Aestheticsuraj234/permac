import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  SCHEMA_VERSION,
  type ActionState,
  type Envelope,
  type EventType,
  type TaskSource,
  type TaskState,
} from "../../contracts/src/index.ts";

const migration = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  engine_run_id TEXT,
  instruction TEXT NOT NULL,
  source TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  current_step TEXT,
  attempt INTEGER NOT NULL,
  last_event_sequence INTEGER NOT NULL,
  cancellation_requested_at TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  target TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  approval_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  verification TEXT NOT NULL,
  evidence_reference TEXT,
  idempotency_key TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  exact_payload_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  decision TEXT,
  resolving_user TEXT
);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  capability TEXT NOT NULL,
  operation TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY,
  owner_task_id TEXT NOT NULL,
  fencing_generation INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(task_id, sequence)
);
CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface TaskRecord {
  id: string;
  session_id: string | null;
  engine_run_id: string | null;
  instruction: string;
  source: TaskSource;
  state: TaskState;
  created_at: string;
  updated_at: string;
  current_step: string | null;
  attempt: number;
  last_event_sequence: number;
  cancellation_requested_at: string | null;
  error: string | null;
}

export interface ActionRecord {
  id: string;
  task_id: string;
  tool: string;
  target: string;
  payload_hash: string;
  state: ActionState;
  approval_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  verification: string;
  evidence_reference: string | null;
  idempotency_key: string | null;
}

export class HarnessStore {
  constructor(private readonly db: DatabaseSync) {}

  static open(path: string): HarnessStore {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA journal_mode = WAL");
    } catch {
      // In-memory databases reject WAL. The default journal is enough there.
    }
    db.exec(migration);
    const store = new HarnessStore(db);
    store.reconcileExecutingActions();
    return store;
  }

  close(): void {
    this.db.close();
  }

  createTask(input: {
    instruction: string;
    source: TaskSource;
    now: string;
  }): TaskRecord {
    const task: TaskRecord = {
      id: randomUUID(),
      session_id: null,
      engine_run_id: null,
      instruction: input.instruction,
      source: input.source,
      state: "queued",
      created_at: input.now,
      updated_at: input.now,
      current_step: "queued",
      attempt: 1,
      last_event_sequence: 0,
      cancellation_requested_at: null,
      error: null,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, session_id, engine_run_id, instruction, source, state, created_at, updated_at, current_step, attempt, last_event_sequence, cancellation_requested_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.session_id,
        task.engine_run_id,
        task.instruction,
        task.source,
        task.state,
        task.created_at,
        task.updated_at,
        task.current_step,
        task.attempt,
        task.last_event_sequence,
        task.cancellation_requested_at,
        task.error,
      );
    return task;
  }

  updateTask(id: string, patch: Partial<TaskRecord>): TaskRecord {
    const current = this.getTask(id);
    const next = { ...current, ...patch, id: current.id };
    this.db
      .prepare(
        `UPDATE tasks SET session_id=?, engine_run_id=?, instruction=?, source=?, state=?, updated_at=?, current_step=?, attempt=?, last_event_sequence=?, cancellation_requested_at=?, error=? WHERE id=?`,
      )
      .run(
        next.session_id,
        next.engine_run_id,
        next.instruction,
        next.source,
        next.state,
        next.updated_at,
        next.current_step,
        next.attempt,
        next.last_event_sequence,
        next.cancellation_requested_at,
        next.error,
        id,
      );
    return next;
  }

  getTask(id: string): TaskRecord {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRecord | undefined;
    if (!row) throw new Error(`Task ${id} not found`);
    return row;
  }

  listTasks(): TaskRecord[] {
    return this.db.prepare("SELECT * FROM tasks ORDER BY created_at").all() as unknown as TaskRecord[];
  }

  insertAction(action: ActionRecord): void {
    this.db
      .prepare(
        `INSERT INTO actions (id, task_id, tool, target, payload_hash, state, approval_id, started_at, completed_at, verification, evidence_reference, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        action.id,
        action.task_id,
        action.tool,
        action.target,
        action.payload_hash,
        action.state,
        action.approval_id,
        action.started_at,
        action.completed_at,
        action.verification,
        action.evidence_reference,
        action.idempotency_key,
      );
  }

  updateAction(id: string, patch: Partial<ActionRecord>): ActionRecord {
    const current = this.getAction(id);
    const next = { ...current, ...patch, id };
    this.db
      .prepare(
        `UPDATE actions SET state=?, approval_id=?, started_at=?, completed_at=?, verification=?, evidence_reference=? WHERE id=?`,
      )
      .run(
        next.state,
        next.approval_id,
        next.started_at,
        next.completed_at,
        next.verification,
        next.evidence_reference,
        id,
      );
    return next;
  }

  getAction(id: string): ActionRecord {
    const row = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as ActionRecord | undefined;
    if (!row) throw new Error(`Action ${id} not found`);
    return row;
  }

  findByIdempotency(key: string): ActionRecord | undefined {
    return this.db.prepare("SELECT * FROM actions WHERE idempotency_key = ?").get(key) as
      | ActionRecord
      | undefined;
  }

  reconcileExecutingActions(): number {
    const result = this.db
      .prepare(
        `UPDATE actions SET state = 'unknown', verification = 'unknown' WHERE state = 'executing'`,
      )
      .run();
    return Number(result.changes);
  }

  appendEvent(input: {
    taskId: string;
    type: EventType;
    payload: Record<string, unknown>;
    now: string;
  }): Envelope {
    this.db.exec("BEGIN");
    try {
      const task = this.getTask(input.taskId);
      const sequence = task.last_event_sequence + 1;
      const event: Envelope = {
        schema_version: SCHEMA_VERSION,
        event_id: randomUUID(),
        task_id: input.taskId,
        sequence,
        timestamp: input.now,
        type: input.type,
        payload: input.payload,
      };
      this.db
        .prepare(
          `INSERT INTO events (event_id, task_id, sequence, schema_version, timestamp, type, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.event_id,
          event.task_id,
          event.sequence,
          event.schema_version,
          event.timestamp,
          event.type,
          JSON.stringify(event.payload),
        );
      this.db
        .prepare("UPDATE tasks SET last_event_sequence = ?, updated_at = ? WHERE id = ?")
        .run(sequence, input.now, input.taskId);
      this.db.exec("COMMIT");
      return event;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  eventsAfter(taskId: string, afterSequence: number): Envelope[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE task_id = ? AND sequence > ? ORDER BY sequence",
      )
      .all(taskId, afterSequence) as unknown as Array<{
      event_id: string;
      task_id: string;
      sequence: number;
      schema_version: number;
      timestamp: string;
      type: EventType;
      payload: string;
    }>;
    return rows.map((row) => ({
      schema_version: SCHEMA_VERSION,
      event_id: row.event_id,
      task_id: row.task_id,
      sequence: row.sequence,
      timestamp: row.timestamp,
      type: row.type,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    }));
  }

  insertApproval(row: {
    id: string;
    action_id: string;
    exact_payload_hash: string;
    scope: string;
    requested_at: string;
    expires_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, action_id, exact_payload_hash, scope, requested_at, expires_at, resolved_at, decision, resolving_user)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      )
      .run(row.id, row.action_id, row.exact_payload_hash, row.scope, row.requested_at, row.expires_at);
  }

  getApproval(id: string): {
    id: string;
    action_id: string;
    exact_payload_hash: string;
    scope: string;
    expires_at: string;
    decision: string | null;
  } {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | {
          id: string;
          action_id: string;
          exact_payload_hash: string;
          scope: string;
          expires_at: string;
          decision: string | null;
        }
      | undefined;
    if (!row) throw new Error(`Approval ${id} not found`);
    return row;
  }

  resolveApproval(id: string, decision: "approved" | "rejected", now: string, user: string): void {
    this.db
      .prepare(
        "UPDATE approvals SET decision = ?, resolved_at = ?, resolving_user = ? WHERE id = ?",
      )
      .run(decision, now, user, id);
  }
}
