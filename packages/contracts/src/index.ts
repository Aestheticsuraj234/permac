import { createHash } from "node:crypto";
import { z } from "zod";

export const SCHEMA_VERSION = 1;

export const taskStates = [
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "paused",
  "blocked",
  "reconciling",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const taskStateSchema = z.enum(taskStates);
export type TaskState = z.infer<typeof taskStateSchema>;

export const taskSources = ["text", "voice", "schedule", "routine"] as const;
export const taskSourceSchema = z.enum(taskSources);
export type TaskSource = z.infer<typeof taskSourceSchema>;

export const actionStates = [
  "proposed",
  "authorized",
  "executing",
  "verified",
  "failed",
  "unknown",
  "cancelled_before_execution",
] as const;
export const actionStateSchema = z.enum(actionStates);
export type ActionState = z.infer<typeof actionStateSchema>;

export const eventTypes = [
  "task.created",
  "task.state_changed",
  "message.delta",
  "tool.started",
  "tool.completed",
  "approval.requested",
  "approval.resolved",
  "clarification.requested",
  "action.verified",
  "action.unknown",
  "run.finished",
] as const;
export const eventTypeSchema = z.enum(eventTypes);
export type EventType = z.infer<typeof eventTypeSchema>;

export const envelopeSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  event_id: z.string().min(1),
  task_id: z.string(),
  sequence: z.number().int().positive(),
  timestamp: z.string().min(1),
  type: eventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type Envelope = z.infer<typeof envelopeSchema>;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export interface Projection {
  tasks: Map<string, { state: TaskState; text: string; actions: Map<string, ActionState> }>;
  lastSequence: Map<string, number>;
  seen: Set<string>;
  buffered: Map<string, Map<number, Envelope>>;
  schemaError: boolean;
}

export function emptyProjection(): Projection {
  return {
    tasks: new Map(),
    lastSequence: new Map(),
    seen: new Set(),
    buffered: new Map(),
    schemaError: false,
  };
}

export function ingestEnvelope(projection: Projection, raw: unknown): Projection {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) {
    const version = (raw as { schema_version?: unknown })?.schema_version;
    if (version !== undefined && version !== SCHEMA_VERSION) {
      return { ...projection, schemaError: true };
    }
    return projection;
  }
  const event = parsed.data;
  if (projection.seen.has(event.event_id)) return projection;
  const buffer = projection.buffered.get(event.task_id) ?? new Map<number, Envelope>();
  buffer.set(event.sequence, event);
  projection.buffered.set(event.task_id, buffer);
  projection.seen.add(event.event_id);
  let next = (projection.lastSequence.get(event.task_id) ?? 0) + 1;
  while (buffer.has(next)) {
    applyOne(projection, buffer.get(next)!);
    buffer.delete(next);
    projection.lastSequence.set(event.task_id, next);
    next += 1;
  }
  return projection;
}

function applyOne(projection: Projection, event: Envelope): void {
  let task = projection.tasks.get(event.task_id);
  if (!task) {
    task = { state: "queued", text: "", actions: new Map() };
    projection.tasks.set(event.task_id, task);
  }
  if (event.type === "task.state_changed") {
    const to = taskStateSchema.safeParse(event.payload.to);
    if (to.success) task.state = to.data;
  }
  if (event.type === "message.delta" && typeof event.payload.text === "string") {
    task.text += event.payload.text;
  }
  if (event.type === "tool.started" && typeof event.payload.action_id === "string") {
    if (!task.actions.has(event.payload.action_id)) {
      task.actions.set(event.payload.action_id, "executing");
    }
  }
  if (event.type === "tool.completed" && typeof event.payload.action_id === "string") {
    const state = actionStateSchema.safeParse(event.payload.state);
    if (state.success) task.actions.set(event.payload.action_id, state.data);
  }
  if (event.type === "run.finished") {
    const state = taskStateSchema.safeParse(event.payload.state);
    if (state.success) task.state = state.data;
  }
}
