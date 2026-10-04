import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import {
  SCHEMA_VERSION,
  type ActionState,
  type Envelope,
  type EventType,
  type TaskSource,
  type TaskState,
} from "../../contracts/src/index.ts";
import type { Grant, Lease } from "../../policy/src/index.ts";

const tables = `
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
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT
);
CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY,
  owner_task_id TEXT NOT NULL,
  fencing_generation INTEGER NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  UNIQUE(task_id, sequence)
);
CREATE TABLE IF NOT EXISTS activity_log (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  task_id TEXT,
  detail JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const pools = new Map<string, Pool>();

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required. Postgres is the only harness store.");
  return url;
}

function schemaName(schema: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("Invalid Postgres schema name");
  return schema;
}

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

export interface ActivityLogRow {
  kind: string;
  task_id: string | null;
  detail: Record<string, unknown>;
}

export class HarnessStore {
  private constructor(
    private readonly pool: Pool,
    private readonly schema: string,
    private readonly poolKey: string,
  ) {}

  static async open(options?: { schema?: string; reset?: boolean }): Promise<HarnessStore> {
    const schema = schemaName(options?.schema ?? process.env.PERMAC_SCHEMA ?? "permac");
    const key = `${connectionString()}::${schema}`;
    let pool = pools.get(key);
    if (!pool) {
      pool = new Pool({ connectionString: connectionString(), max: 2 });
      pools.set(key, pool);
    }
    const store = new HarnessStore(pool, schema, key);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await client.query(tables);
      if (options?.reset) {
        await client.query(
          "TRUNCATE tasks, actions, approvals, grants, leases, events, activity_log, preferences",
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await store.reconcileExecutingActions();
    return store;
  }

  close(): void {}

  async dropSchema(): Promise<void> {
    if (this.schema === "permac") throw new Error("Refusing to drop the application schema");
    const client = await this.pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`);
    } finally {
      client.release();
    }
    pools.delete(this.poolKey);
    await this.pool.end();
  }

  async recordLog(kind: string, taskId: string | null, detail: Record<string, unknown>): Promise<void> {
    await this.query(
      "INSERT INTO activity_log (kind, task_id, detail) VALUES ($1, $2, $3::jsonb)",
      [kind, taskId, JSON.stringify(detail)],
    );
  }

  async recentLogs(limit = 50): Promise<ActivityLogRow[]> {
    const result = await this.query<ActivityLogRow>(
      "SELECT kind, task_id, detail FROM activity_log ORDER BY id DESC LIMIT $1",
      [limit],
    );
    return result.rows.map((row) => ({
      kind: row.kind,
      task_id: row.task_id,
      detail: typeof row.detail === "string" ? (JSON.parse(row.detail) as Record<string, unknown>) : row.detail,
    }));
  }

  async createTask(input: { instruction: string; source: TaskSource; now: string }): Promise<TaskRecord> {
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
    await this.query(
      `INSERT INTO tasks (id, session_id, engine_run_id, instruction, source, state, created_at, updated_at, current_step, attempt, last_event_sequence, cancellation_requested_at, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
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
      ],
    );
    await this.recordLog("task.insert", task.id, { instruction: task.instruction, source: task.source });
    return task;
  }

  async updateTask(id: string, patch: Partial<TaskRecord>): Promise<TaskRecord> {
    const current = await this.getTask(id);
    const next = { ...current, ...patch, id: current.id };
    await this.query(
      `UPDATE tasks SET session_id=$1, engine_run_id=$2, instruction=$3, source=$4, state=$5, updated_at=$6, current_step=$7, attempt=$8, last_event_sequence=$9, cancellation_requested_at=$10, error=$11 WHERE id=$12`,
      [
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
      ],
    );
    await this.recordLog("task.update", id, { state: next.state, error: next.error });
    return next;
  }

  async getTask(id: string): Promise<TaskRecord> {
    const result = await this.query<TaskRecord>("SELECT * FROM tasks WHERE id = $1", [id]);
    const row = result.rows[0];
    if (!row) throw new Error(`Task ${id} not found`);
    return normalizeTask(row);
  }

  async listTasks(): Promise<TaskRecord[]> {
    const result = await this.query<TaskRecord>("SELECT * FROM tasks ORDER BY created_at");
    return result.rows.map(normalizeTask);
  }

  async insertAction(action: ActionRecord): Promise<void> {
    await this.query(
      `INSERT INTO actions (id, task_id, tool, target, payload_hash, state, approval_id, started_at, completed_at, verification, evidence_reference, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
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
      ],
    );
    await this.recordLog("action.insert", action.task_id, { action_id: action.id, tool: action.tool, target: action.target });
  }

  async updateAction(id: string, patch: Partial<ActionRecord>): Promise<ActionRecord> {
    const current = await this.getAction(id);
    const next = { ...current, ...patch, id };
    await this.query(
      `UPDATE actions SET state=$1, approval_id=$2, started_at=$3, completed_at=$4, verification=$5, evidence_reference=$6 WHERE id=$7`,
      [next.state, next.approval_id, next.started_at, next.completed_at, next.verification, next.evidence_reference, id],
    );
    await this.recordLog("action.update", next.task_id, { action_id: id, state: next.state });
    return next;
  }

  async getAction(id: string): Promise<ActionRecord> {
    const result = await this.query<ActionRecord>("SELECT * FROM actions WHERE id = $1", [id]);
    const row = result.rows[0];
    if (!row) throw new Error(`Action ${id} not found`);
    return row;
  }

  async findByIdempotency(key: string): Promise<ActionRecord | undefined> {
    const result = await this.query<ActionRecord>("SELECT * FROM actions WHERE idempotency_key = $1", [key]);
    return result.rows[0];
  }

  async findActionByTarget(taskId: string, target: string): Promise<ActionRecord | undefined> {
    const result = await this.query<ActionRecord>(
      "SELECT * FROM actions WHERE task_id = $1 AND target = $2 ORDER BY started_at DESC NULLS LAST LIMIT 1",
      [taskId, target],
    );
    return result.rows[0];
  }

  async reconcileExecutingActions(): Promise<number> {
    const result = await this.query(
      "UPDATE actions SET state = 'unknown', verification = 'unknown' WHERE state = 'executing'",
    );
    if ((result.rowCount ?? 0) > 0) {
      await this.recordLog("action.reconcile", null, { count: result.rowCount });
    }
    return result.rowCount ?? 0;
  }

  async appendEvent(input: {
    taskId: string;
    type: EventType;
    payload: Record<string, unknown>;
    now: string;
  }): Promise<Envelope> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${this.schema}`);
      const current = await client.query<TaskRecord>("SELECT * FROM tasks WHERE id = $1", [input.taskId]);
      const task = current.rows[0];
      if (!task) throw new Error(`Task ${input.taskId} not found`);
      const sequence = Number(task.last_event_sequence) + 1;
      const event: Envelope = {
        schema_version: SCHEMA_VERSION,
        event_id: randomUUID(),
        task_id: input.taskId,
        sequence,
        timestamp: input.now,
        type: input.type,
        payload: input.payload,
      };
      await client.query(
        `INSERT INTO events (event_id, task_id, sequence, schema_version, timestamp, type, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [event.event_id, event.task_id, event.sequence, event.schema_version, event.timestamp, event.type, JSON.stringify(event.payload)],
      );
      await client.query("UPDATE tasks SET last_event_sequence = $1, updated_at = $2 WHERE id = $3", [
        sequence,
        input.now,
        input.taskId,
      ]);
      await client.query(
        "INSERT INTO activity_log (kind, task_id, detail) VALUES ($1, $2, $3::jsonb)",
        ["event.append", input.taskId, JSON.stringify({ type: input.type, sequence, event_id: event.event_id })],
      );
      await client.query("COMMIT");
      return event;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async eventsAfter(taskId: string, afterSequence: number): Promise<Envelope[]> {
    const result = await this.query<{
      event_id: string;
      task_id: string;
      sequence: number;
      timestamp: string;
      type: EventType;
      payload: Record<string, unknown> | string;
    }>("SELECT * FROM events WHERE task_id = $1 AND sequence > $2 ORDER BY sequence", [taskId, afterSequence]);
    return result.rows.map((row) => ({
      schema_version: SCHEMA_VERSION,
      event_id: row.event_id,
      task_id: row.task_id,
      sequence: Number(row.sequence),
      timestamp: row.timestamp,
      type: row.type,
      payload: typeof row.payload === "string" ? (JSON.parse(row.payload) as Record<string, unknown>) : row.payload,
    }));
  }

  async insertApproval(row: {
    id: string;
    action_id: string;
    exact_payload_hash: string;
    scope: string;
    requested_at: string;
    expires_at: string;
  }): Promise<void> {
    await this.query(
      `INSERT INTO approvals (id, action_id, exact_payload_hash, scope, requested_at, expires_at, resolved_at, decision, resolving_user)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,NULL)`,
      [row.id, row.action_id, row.exact_payload_hash, row.scope, row.requested_at, row.expires_at],
    );
    await this.recordLog("approval.insert", null, { approval_id: row.id, action_id: row.action_id });
  }

  async getApproval(id: string): Promise<{
    id: string;
    action_id: string;
    exact_payload_hash: string;
    scope: string;
    expires_at: string;
    decision: string | null;
  }> {
    const result = await this.query<{
      id: string;
      action_id: string;
      exact_payload_hash: string;
      scope: string;
      expires_at: string;
      decision: string | null;
    }>("SELECT * FROM approvals WHERE id = $1", [id]);
    const row = result.rows[0];
    if (!row) throw new Error(`Approval ${id} not found`);
    return row;
  }

  async resolveApproval(id: string, decision: "approved" | "rejected", now: string, user: string): Promise<void> {
    await this.query(
      "UPDATE approvals SET decision = $1, resolved_at = $2, resolving_user = $3 WHERE id = $4",
      [decision, now, user, id],
    );
    await this.recordLog("approval.resolve", null, { approval_id: id, decision, user });
  }

  async insertGrant(grant: Grant): Promise<void> {
    await this.query(
      `INSERT INTO grants (id, target, capability, operation, expires_at, revoked_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [grant.id, grant.target, grant.capability, grant.operation, grant.expiresAt, grant.revokedAt ?? null],
    );
    await this.recordLog("grant.insert", null, { grant_id: grant.id, target: grant.target, capability: grant.capability });
  }

  async listGrants(): Promise<Grant[]> {
    const result = await this.query<{
      id: string;
      target: string;
      capability: string;
      operation: string;
      expires_at: string;
      revoked_at: string | null;
    }>("SELECT * FROM grants");
    return result.rows.map((row) => ({
      id: row.id,
      target: row.target,
      capability: row.capability,
      operation: row.operation,
      expiresAt: Number(row.expires_at),
      revokedAt: row.revoked_at === null ? undefined : Number(row.revoked_at),
    }));
  }

  async revokeGrant(id: string, revokedAt: number): Promise<void> {
    const result = await this.query("UPDATE grants SET revoked_at = $1 WHERE id = $2", [revokedAt, id]);
    if ((result.rowCount ?? 0) === 0) throw new Error("Grant not found");
    await this.recordLog("grant.revoke", null, { grant_id: id });
  }

  async readLease(): Promise<Lease | undefined> {
    const result = await this.query<{
      owner_task_id: string;
      fencing_generation: number;
      expires_at: string;
    }>("SELECT * FROM leases WHERE id = 'desktop'");
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      ownerTaskId: row.owner_task_id,
      fencingGeneration: Number(row.fencing_generation),
      expiresAt: Number(row.expires_at),
    };
  }

  async writeLease(lease: Lease): Promise<void> {
    await this.query(
      `INSERT INTO leases (id, owner_task_id, fencing_generation, expires_at) VALUES ('desktop', $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET owner_task_id = EXCLUDED.owner_task_id, fencing_generation = EXCLUDED.fencing_generation, expires_at = EXCLUDED.expires_at`,
      [lease.ownerTaskId, lease.fencingGeneration, lease.expiresAt],
    );
    await this.recordLog("lease.write", lease.ownerTaskId, { fencing_generation: lease.fencingGeneration });
  }

  private async query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${this.schema}`);
      const result = await client.query<T>(text, values);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function normalizeTask(row: TaskRecord): TaskRecord {
  return { ...row, attempt: Number(row.attempt), last_event_sequence: Number(row.last_event_sequence) };
}
