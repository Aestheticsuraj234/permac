# Personal Mac Agent — Contracts

Version 1.0 • 4 October 2026

`schema_version` for this document is `1`. These names belong to this project. Hermes event names are mapped into them by `packages/hermes-adapter`. SwiftUI does not translate them into AG-UI or CopilotKit events.

Timestamps are ISO-8601 UTC strings. Identifiers are opaque strings. `sequence` is a positive integer, unique per task, strictly increasing by one for each stored event.

## 1 Task

States: `queued`, `running`, `waiting_input`, `waiting_approval`, `paused`, `blocked`, `reconciling`, `succeeded`, `failed`, `cancelled`.

`succeeded` requires the required outcomes to be verified. An uncertain external action moves to `reconciling` or `blocked`. `paused` is only at a safe boundary. It does not mean a model call or a live GUI action was snapshotted.

| Field | Meaning |
|---|---|
| `id` | Task id |
| `session_id` | Hermes session id once one exists |
| `engine_run_id` | Hermes run correlation id |
| `instruction` | The person’s instruction |
| `source` | `text`, `voice`, `schedule`, or `routine` |
| `state` | One state above |
| `created_at`, `updated_at` | Timestamps |
| `current_step` | Short label of the current step |
| `attempt` | Admission attempt count, starting at 1 |
| `last_event_sequence` | Last journal sequence for this task |
| `cancellation_requested_at` | Set when cancel is requested. Null otherwise |
| `error` | Present when the task is failed or blocked |

## 2 Action

States: `proposed`, `authorized`, `executing`, `verified`, `failed`, `unknown`, `cancelled_before_execution`.

| Field | Meaning |
|---|---|
| `id` | Action id |
| `task_id` | Parent task |
| `tool` | Tool name |
| `target` | Target the policy checked |
| `payload_hash` | Hash of the canonical payload |
| `state` | One state above |
| `approval_id` | Set when an approval was required |
| `started_at`, `completed_at` | Timestamps |
| `verification` | `pending`, `verified`, `unverified`, or `unknown` |
| `evidence_reference` | Where the result evidence was stored |
| `idempotency_key` | Present when the executor supports one |

On process start, an action left in `executing` becomes `unknown` until a check says otherwise.

## 3 Approval

| Field | Meaning |
|---|---|
| `id` | Approval id |
| `action_id` | The proposed action |
| `exact_payload_hash` | Hash that must match at execution time |
| `scope` | Human-readable binding: recipient, account, body, attachments, operation |
| `requested_at`, `expires_at`, `resolved_at` | Timestamps |
| `decision` | `approved` or `rejected` once resolved |
| `resolving_user` | Local user identity |

A payload change requires a new approval. An expired or rejected approval cannot authorize execution.

## 4 Grant

Standing permission, distinct from a one-action approval.

| Field | Meaning |
|---|---|
| `id` | Grant id |
| `target` | Constraint, such as a contact id or app name |
| `capability` | For example `message.send` or `app.open` |
| `operation` | The operation covered |
| `expires_at` | Expiry |
| `revoked_at` | Set when revoked |

A revoked grant blocks execution even if an older approval exists.

## 5 Lease

| Field | Meaning |
|---|---|
| `id` | Lease id |
| `owner_task_id` | Task that holds desktop mutation rights |
| `fencing_generation` | Increments every acquisition |
| `expires_at` | Expiry without a heartbeat |
| `heartbeat_at` | Last heartbeat |

A worker whose generation is older than the stored generation must stop.

## 6 Event envelope

Every journal record and every socket frame uses this envelope.

| Field | Meaning |
|---|---|
| `schema_version` | `1` |
| `event_id` | Unique id |
| `task_id` | Task id. Empty only for service-level health frames |
| `sequence` | Per-task sequence |
| `timestamp` | When the coordinator stored it |
| `type` | One type below |
| `payload` | Type-specific object |

Types:

- `task.created`
- `task.state_changed` — payload includes `from`, `to`, and optional `error`
- `message.delta` — payload includes `text`
- `tool.started` — payload includes `action_id`, `tool`, `target`
- `tool.completed` — payload includes `action_id`, `state`
- `approval.requested` — payload includes the approval fields and a display payload
- `approval.resolved` — payload includes `approval_id` and `decision`
- `clarification.requested` — payload includes `request_id`, `question`, `choices`
- `action.verified` — payload includes `action_id` and `evidence_reference`
- `action.unknown` — payload includes `action_id` and `reason`
- `run.finished` — payload includes `state`

Clients that see a `schema_version` other than `1` reject the frame. They do not render a partial event.

## 7 Commands

The SwiftUI client sends these. The coordinator is the only process that turns them into Hermes calls.

| Command | Fields | Effect |
|---|---|---|
| `task.submit` | `instruction`, `source` | Create and admit a task |
| `task.interrupt` | `task_id` | Request cancellation |
| `task.pause` | `task_id` | Pause only if the current boundary is safe |
| `approval.resolve` | `approval_id`, `decision`, `payload_hash` | Resolve if the hash matches the stored approval |
| `clarification.answer` | `request_id`, `answer` | One correlated answer |
| `journal.subscribe` | `task_id`, `after_sequence` | Replay events with sequence greater than `after_sequence` |
| `health` | none | Runtime and driver health |

`approval.resolve` with a hash that does not match the stored `exact_payload_hash` is rejected. The client cannot approve an approval id the coordinator did not create.

## 8 Hermes adapter

Application-level operations. Types are defined in `packages/hermes-adapter`. Upstream session ids, request ids, and run correlation are preserved.

- `createSession(input) -> SessionRef`
- `submit(input) -> RunRef`
- `interrupt(run) -> InterruptReceipt`
- `answerRequest(input) -> void`
- `readHistory(session) -> Message[]`
- `subscribe(session) -> AsyncIterable<EngineEvent>`
- `health() -> RuntimeHealth`

The adapter maps Hermes TUI gateway traffic onto `EngineEvent`. The coordinator maps `EngineEvent` onto the envelope types in section 6.

## 9 Screens and the commands they may send

| Surface | Shows | May send |
|---|---|---|
| Task list | Tasks and state | `task.submit` |
| Task detail | Instruction, streaming text, tool progress | `task.interrupt`, `task.pause` |
| Result | Verified outcome and evidence reference | Nothing |
| Review | Exact payload, recipient, account, expiry | `approval.resolve` |
| Clarification | The outstanding question and choices | `clarification.answer` |
| Blocked | Reason, missing permission, or unknown outcome | `task.submit` only when policy allows a new action |

## 10 Replay rules

- Delivery may be duplicated or briefly reordered on the socket. The client applies each `event_id` once and ignores a sequence it has already applied.
- Actions are created once. A replayed `tool.started` does not create a second action.
- Reconnect restores outstanding approvals and clarifications from the journal, not from SwiftUI memory.
