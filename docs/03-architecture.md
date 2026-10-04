# Personal Mac Agent — Architecture

Version 1.0 • 4 October 2026

## 1 Processes

Four boundaries. They do not share a writable database.

```text
SwiftUI app  --authenticated local socket-->  Coordinator (TypeScript)
Coordinator  --JSON-RPC stdio-------------->  Hermes (Python)
Hermes       --MCP stdio------------------->  cua-driver (this Mac only)
```

- The SwiftUI app renders the event journal and sends commands: submit, interrupt, resolve approval, answer clarification. It keeps a read-only projection for the current screen. That projection is not a second conversation history.
- The coordinator admits tasks, applies policy, coordinates execution, verifies outcomes, recovers after crashes, and publishes the journal.
- Hermes chooses the model’s next step and which of its tools to call. It owns agent sessions, personal memory, and skills.
- cua-driver performs mediated desktop control on this Mac. Explicit app tools (`open_app`, and the other project tools) run behind the coordinator. A Swift helper exists only for a native capability the audit shows Hermes cannot do reliably. That helper is an executor, not a screen.

## 2 What owns which data

| Data | Owner | Others may |
|---|---|---|
| Agent session and skills | Hermes profile | Read through the adapter API. Never write Hermes tables. Built-in MEMORY.md and USER.md stay off |
| Agent memory | Supermemory, through the official SDK | No local memory file. A missing API key is logged in Postgres and nothing is stored |
| Task, action, approval, grant, lease, journal, activity log | Postgres schema `permac` | SwiftUI reads events. It does not write the database |
| Screen projection | SwiftUI memory | Dropped on reconnect; rebuilt by replaying the journal |

Restart loads the coordinator database, reconciles leases, and marks actions that were `executing` as `unknown` until checked. Read-only work may be recovered when the check is safe. External writes wait for reconciliation. The app does not claim the model inference itself resumed.

## 3 Event path

1. The person submits an instruction in SwiftUI.
2. The coordinator persists a task in `queued`, then publishes `task.created`, then moves it to `running`.
3. The coordinator opens or reuses a Hermes session and submits the prompt.
4. Hermes streams events. The adapter maps them onto the project event names in `docs/04-contracts.md`. Those names are ours. They are not claimed to be Hermes’s event names.
5. Each transition is stored, then published, with a monotonic `sequence`.
6. If Hermes asks for approval or clarification, the coordinator persists the request and publishes it. The action does not execute until the correlated answer is stored.
7. SwiftUI renders the new sequence. On reconnect it sends the last sequence it applied. The coordinator replays later events. The client drops duplicates.

A blocked or unknown external action is published as such. The review surface can approve only an approval the coordinator has already requested.

## 4 Policy path

Every side-effecting action passes admission, capability authorization, target validation, execution, and verification. Harness policy and the executor’s own permission both apply. The tighter one wins.

Initial defaults:

- Open a registered app or registered path: automatic.
- Read context: follows the collection setting.
- Outgoing message: review, unless a standing grant matches the target, capability, and operation and has not expired or been revoked.
- Delete, or arbitrary shell: explicit review of that action.

Shell, browser scripts, and generic typing can write to the outside world. They do not skip policy because the tool name is generic. A tool path the coordinator cannot intercept stays disabled.

Approvals bind recipient identity, account, message body, attachment references, and operation, via `exact_payload_hash`. Any mutation expires the approval. The review screen cannot edit that payload into a different authorized action.

## 5 Desktop lease

One global lease for desktop mutations. Fields: owner task, expiry, heartbeat, fencing generation. A stale owner cannot keep executing after expiry. The SwiftUI shell displays the holder. Holding the lease is a coordinator decision, not a button in the view.

The app does not lock the keyboard. If observation shows the intended target changed, the task pauses.

## 6 Failure

- Provider failure and Hermes crash become a failed or blocked task with an error the UI can show.
- Crash during an external write: the action stays `unknown` until reconciliation. No automatic resubmit.
- Sleep and lock: interactive tasks block. Wake rechecks targets and permissions.
- Scheduled work missed during sleep: skip or catch up, as the schedule record says. External writes still need a current authorization.

## 7 Layout

| Directory | Responsibility |
|---|---|
| `apps/macos` | SwiftUI shell and screens |
| `apps/coordinator` | Local task service and socket transport |
| `packages/contracts` | Commands and event schemas |
| `packages/hermes-adapter` | Hermes JSON-RPC translation |
| `packages/task-logic` | Task and review rules adapted from OpenMuse |
| `packages/policy` | Grants, approval binding, admission |
| `packages/mac-tools` | Registered app tools and the native helper client |
| `packages/verification` | Result checks |
| `packages/storage` | Postgres schema, journal, and activity log |
| `packages/memory` | Supermemory SDK client |
| `packages/messaging` | WhatsApp desktop workflow |
| `packages/voice` | Push-to-talk, playback, wake-word gate |
| `tests/contracts` | Protocol fixtures and replay |
| `tests/workflows` | Workflow fixtures |
| `vendor-manifests` | Pinned upstream records |
| `upstream/` | Isolated checkouts. Not imported as app source |

## 8 Security of the local socket

Even on localhost, the coordinator checks a shared token created at startup and stored with the data directory’s permissions. It rejects malformed frames, oversized payloads, and a missing or wrong token. It does not expose an unauthenticated executor.
