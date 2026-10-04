# Personal Mac Agent Implementation Specification (SwiftUI)

Version 1.0 • 4 October 2026 • Companion to Personal Mac Agent Product Requirements

This revision keeps the Hermes runtime and the OpenMuse task, review, and domain logic. It does not reuse OpenMuse React, Expo, or CopilotKit view code. The desktop interface is a native SwiftUI application that covers the same jobs those views covered: tasks, streaming results, approvals, and clarifications.

## 1 Architecture decision

Use Hermes as a separate local Python runtime. Build a TypeScript coordinator that owns task admission, policy, execution coordination, verification, and recovery. Build the Mac application in SwiftUI. Reuse Hermes desktop control and voice wherever they satisfy the product requirements. Introduce extra Swift helpers only for capabilities missing or unreliable in the existing path.

Hermes owns model reasoning and tool selection. The coordinator owns task state and the event journal. SwiftUI renders that journal. It does not own a second conversation store, and it does not embed OpenMuse in a web view. Do not add LangGraph around Hermes solely to duplicate its agent loop. Do not port OpenMuse screens in order to restyle them.

Proposed process boundaries:

- Mac app: SwiftUI menu bar, global shortcut, overlay, windows, lifecycle, native permissions, voice status, and every task, result, and review screen.
- Coordinator: local TypeScript service, task database, approvals, event journal, resource leases. Task and review rules are adapted from OpenMuse server and domain code, not from its UI packages.
- Hermes bridge: authenticated local integration with the existing runtime.
- Executors: existing computer-use driver, explicit app adapters, browser executor, optional native helper.

All paths and interfaces in this document are proposed project contracts unless explicitly identified as upstream documentation.

## 2 Step 1 Pin and audit the upstream source

Clone https://github.com/NousResearch/hermes-agent and https://github.com/CopilotKit/openmuse into isolated upstream checkouts. Read repository instructions before edits. Record the exact commit SHA, license, dependency lockfile, runtime requirements, and supported distribution method. Use a stable release when possible; do not ship against moving main branches.

Create an upstream manifest containing repository URL, SHA, license path, selected modules, local patches, dependency versions, and audit date. Keep upstream commits separate from application changes. Prefer adapters and extraction over broad edits to the runtime.

OpenMuse is a logic source only. During the audit, mark every UI module as out of scope, including `apps/mobile`, React components, Expo native shells, and CopilotKit view bindings. Extract task records, review rules, and shared validation types. Leave their rendering behind.

| Source candidate | Intended reuse | Audit required |
|---|---|---|
| Hermes agent runtime and tool registry | Reasoning, providers, dispatch | Confirm extension hooks and execution interception |
| Hermes TUI gateway or ACP adapter | Session lifecycle, approvals, events | Confirm wire schema and cancellation behavior |
| Hermes session store, memory, skills | Agent continuity | Confirm ownership and export/delete APIs |
| Hermes computer-use integration | Existing Mac control | Validate installed driver, permissions, supported OS |
| Hermes voice and desktop app | Speech and voice-session behavior | Check packaging and extension boundaries; do not adopt its UI if it conflicts with the SwiftUI shell |
| OpenMuse apps/server | Task records and review logic | Extract logic from UI routes, model execution, and CopilotKit thread services |
| OpenMuse packages/domain | Validation and shared types | Adapt identifiers and schemas into project contracts |
| OpenMuse apps/worker | Browser sessions and takeover | Decide whether Hermes browser already meets need; ignore its UI |
| OpenMuse packages/integrations | Useful provider adapters | Retain only explicitly needed integrations |
| OpenMuse apps/mobile | None | Confirm no reusable non-UI logic is trapped in view files, then exclude |
| OpenMuse apps/computer | Isolated Linux workspace | Optional; does not operate the user's Mac and does not supply the Mac UI |

These OpenMuse paths appear in its documented architecture; file-level extraction and transitive dependencies must still be audited. Hermes runtime entrypoints can change between releases.

Exit criteria: audit manifest completed; Hermes starts in test mode; extracted OpenMuse logic runs without its React app; documented reuse map marks every candidate keep, adapt, replace, or defer. Every OpenMuse UI path is marked defer or exclude. Do not enter implementation with unknown license or runtime boundaries.

## 3 Step 2 Prove the Hermes integration

Hermes documents ACP, a TUI gateway with JSON-RPC, and an HTTP API. Start by evaluating the TUI gateway because the documented interface includes sessions, streaming, approvals, steering, and interruption. Use stdio initially to reduce local network exposure. Choose another protocol if the pinned release demonstrates better lifecycle support.

The documented TUI gateway includes session.create, prompt.submit, session.history, session.interrupt, and message/tool events. Server-to-client approval and clarification frames are requests that require correlated responses. A WebSocket client must advertise its server-request capability in the documented handshake. Verify all details against the pinned release rather than copying this spec as an upstream schema.

Implement a HermesAdapter with the following application-level operations:

```typescript
interface HermesAdapter {
  createSession(input: SessionInput): Promise<SessionRef>;
  submit(input: RunInput): Promise<RunRef>;
  interrupt(run: RunRef): Promise<InterruptReceipt>;
  answerRequest(input: RequestAnswer): Promise<void>;
  readHistory(session: SessionRef): Promise<Message[]>;
  subscribe(session: SessionRef): AsyncIterable<EngineEvent>;
  health(): Promise<RuntimeHealth>;
}
```

Types are project-defined. The bridge must preserve upstream session IDs, request IDs, and run correlation. Do not parse console text as a production API or directly mutate Hermes SQLite tables.

The adapter talks to the coordinator. SwiftUI never speaks the Hermes protocol directly. Approval and clarification answers travel from a SwiftUI review surface, through the coordinator, to `answerRequest`.

Test one normal run, streaming tool output, an approval, a clarification, cancellation, reconnect, provider failure, and runtime crash. Demonstrate how a blocked action reaches the SwiftUI review surface. Explicitly determine whether tool interception can apply the harness policy to every side-effecting path, including shell and browser operations.

Exit criteria: automated contract fixtures pass; approvals cannot execute before resolution; unsupported requests fail clearly; all required events have stable mappings. If execution interception is missing, add a narrowly scoped upstream patch or constrained executor rather than an unenforced UI policy.

## 4 Step 3 Define the project layout and data ownership

Proposed directories:

| Directory | Responsibility |
|---|---|
| apps/macos | SwiftUI app: shell, windows, task UI, review UI, voice status |
| apps/coordinator | Local task service and event transport |
| packages/contracts | Validated commands and event schemas shared by coordinator and the Swift client |
| packages/hermes-adapter | Runtime protocol translation |
| packages/task-logic | Task records, review rules, and domain validation adapted from OpenMuse |
| packages/policy | Grants, approval binding, action admission |
| packages/mac-tools | App-specific tools and native helper client |
| packages/verification | App and workflow result checks |
| packages/storage | Harness database and migrations |
| tests/contracts | Upstream protocol and replay tests |
| tests/workflows | Mac workflow fixtures and release tests |
| vendor-manifests | Pinned upstream and patch records |

There is no `packages/openmuse-ui` package. Do not add a React, Expo, or web-view UI target.

Use the package manager supported by the retained TypeScript logic. If that logic comes from OpenMuse server and domain packages, pnpm remains acceptable for the coordinator. The Mac app uses Swift Package Manager and Xcode. Avoid adding Bun as a packaging dependency unless compatibility is proven. Do not take on OpenMuse's mobile toolchain in order to compile unused views.

Hermes owns agent sessions, personal memory, and skills. The harness owns task state, action receipts, approval metadata, resource leases, and UI preferences. SwiftUI may keep a read-only message projection for rendering; it must not become a competing conversation source. Do not put the app and the coordinator in direct write access to the same embedded database.

Retain an OpenMuse storage module only if it fits the single-machine process model and contains no UI or remote-thread dependency. Otherwise use SQLite with migrations for the harness. Choose during the audit. Replace the CopilotKit Intelligence thread path for local storage, including thread hooks, replay, and server dependencies; removing an environment variable is insufficient. Those replacements live in coordinator logic, not in SwiftUI.

Exit criteria: restart preserves tasks and history; remote thread-service calls are absent in local mode; migrations and backup/restore work; memory deletion reaches its owning store; the Mac target builds with no OpenMuse UI dependency.

## 5 Step 4 Build the task and event contracts

Task states: queued, running, waiting_input, waiting_approval, paused, blocked, reconciling, succeeded, failed, cancelled.

Persist each transition before publishing it. succeeded requires verified required outcomes. An uncertain external action moves to reconciling or blocked. paused is available only at a safe boundary; it is not a promise to snapshot a model inference or a live GUI action.

Task fields: id, session_id, engine_run_id, instruction, source, state, created_at, updated_at, current_step, attempt, last_event_sequence, cancellation_requested_at, and error.

Action fields: id, task_id, tool, target, payload_hash, state, approval_id, started_at, completed_at, verification, evidence_reference, and idempotency_key where the executor supports it. States: proposed, authorized, executing, verified, failed, unknown, cancelled_before_execution.

Approval fields: id, action_id, exact_payload_hash, scope, requested_at, expires_at, resolved_at, decision, and resolving_user. Grants are distinct records with target constraints, capability, operation, expiry, and revocation.

Events include task.created, task.state_changed, message.delta, tool.started, tool.completed, approval.requested, approval.resolved, clarification.requested, action.verified, action.unknown, and run.finished. Each envelope contains schema_version, event_id, task_id, sequence, timestamp, type, and payload. The names are your contract, not claimed upstream event names.

Store an append-only event journal. Reconnect accepts the last received sequence and replays later events, with client deduplication. Authorize task access even for local clients.

Publish the contract in a form both TypeScript and Swift can validate. Generate or hand-maintain matching Swift types for every event and command the app renders or sends. The SwiftUI client sends commands (submit, interrupt, resolve approval, answer clarification) and subscribes to the journal. It does not adapt events to AG-UI, CopilotKit, or any web component protocol.

SwiftUI screens bind to these states:

| Surface | What it shows | What it may send |
|---|---|---|
| Task list | Tasks and current state | Select task, create task |
| Task detail | Instruction, streaming text, tool progress, final result | Cancel, pause at a safe boundary |
| Result | Verified outcome and evidence reference | None; results are read-only |
| Review | Exact approval payload, recipient, account, expiry | Approve or reject |
| Clarification | The outstanding question and choices | One correlated answer |
| Blocked | Reason, missing permission, or unknown outcome | Retry only when policy allows a new action |

Result and review layouts are original SwiftUI views. OpenMuse can inform which information must appear. It does not supply components, layout, or styling.

Exit criteria: duplicate or reordered delivery does not duplicate actions or corrupt UI state; a lost connection restores outstanding questions and task progress; Swift decoding rejects an unknown schema version instead of rendering a partial event.

## 6 Step 5 Implement action policy and resource coordination

Every action passes through admission, capability authorization, target validation, execution, and verification. Preserve downstream Hermes and driver restrictions. Effective permission is the intersection of harness policy and executor permission, never a replacement for stricter enforcement.

Initial defaults: opening registered apps and files is automatic; context reading follows collection settings; outgoing messages require review unless a matching standing grant exists; deletion and arbitrary shell execution require explicit action-specific review. The product can support user-authored standing grants without asking repeatedly for already authorized actions.

Approval binds recipient identity, account, message body, attachment references, and operation. Any mutation expires the approval. Recheck the actual foreground or addressed window and account before acting. Never infer that a model-generated instruction authorizes an action. The SwiftUI review screen displays that bound payload and cannot edit it into a different authorized action. An edit is a new proposal and needs a new approval.

Route browser work through the selected browser executor, desktop work through the driver or app adapter, and direct app capabilities through explicit tools. Shell, browser scripts, and generic typing can also cause external writes; they cannot bypass the policy simply because the named tool is generic.

Begin with one global lease for desktop mutations. Include owner task, expiry, heartbeat, and fencing generation. Expired ownership must be reconciled; a stale worker may not keep executing. Handle physical user interference by re-observing state and pausing when the intended target changes. Do not lock the user's keyboard. The SwiftUI shell shows who holds the lease. It does not grant the lease by drawing a button.

Exit criteria: revoked grants block execution; changed payloads need new authorization; two simultaneous tasks cannot corrupt one conversation; tool paths that cannot be mediated remain disabled; the review screen cannot approve an action the coordinator has not requested.

## 7 Step 6 Deliver Mac context and simple workflows

Evaluate Hermes's packaged desktop controller before writing another implementation. Run its documented diagnostics and establish the actual execution host. Bind local tasks to this Mac explicitly; remote engines must not accidentally target a different machine.

Add project-level tools: open_app, open_registered_path, read_selection, resolve_workspace, inspect_window, and verify_app_state. Wrap existing capabilities where possible. Use a Swift service for native functions only when necessary. That service is an executor behind the coordinator, separate from the SwiftUI screens.

Collect just enough context for the request. A selection read may use accessibility or another supported mechanism; clipboard fallback must preserve existing clipboard state and report unsupported cases. Capture screenshots on demand, redact configured regions when possible, and never assume every app exposes usable accessibility controls.

First workflows: open a registered application; open a project in Cursor; summarize selected content; locate a file within approved directories; start an ordered recording routine. File searches are constrained to granted locations and exclude sensitive directories by default.

Each workflow ends on a SwiftUI result or blocked state. A successful summary shows the source of the selection and the text. A file lookup shows the granted root and the matches. A missing app, missing file, denied permission, or user interference shows a blocked state with the reason.

Exit criteria: 20 controlled repetitions per supported workflow meet the PRD target; permission revocation, missing app, missing file, and user interference produce clear blocked or error states in SwiftUI.

## 8 Step 7 Implement WhatsApp as a verified adapter

Use a dedicated test account or consenting test recipient. Inspect the current WhatsApp desktop accessibility tree and capture evidence for the supported version. Do not assume messaging gateway support implies automation of the installed desktop client.

Implement resolve_contact, open_conversation, inspect_conversation, prepare_message, send_message, and verify_message. Contact records include stable identity where available, display label, account, user verification timestamp, and alternative names. Ambiguous matches ask for clarification through the SwiftUI clarification surface.

Workflow: resolve target, acquire lease, open app, navigate, verify account and recipient, draft, request or match approval, revalidate, send once, and inspect the message bubble or another available outcome indicator. Distinguish submitted, visibly sent, and delivered; do not claim delivery if only submission is observable.

The review screen shows the resolved contact, account, and exact body before send. Approving from that screen authorizes only the displayed payload hash.

A desktop click has no provider-enforced idempotency key. The local action key prevents duplicate scheduling but cannot guarantee exactly-once external execution. Persist intent before the send and reconcile the conversation after a crash. If the result cannot be distinguished from an existing identical message, mark unknown and request review in SwiftUI. Do not offer a one-tap resend while the outcome is unknown.

Exit criteria: zero wrong-recipient and duplicate sends across test cases; crash before send, during send, and after send reconciles without automatic resubmission; permissions and app-update failures are detected and shown as blocked states.

## 9 Step 8 Add voice and the SwiftUI shell

The shell is SwiftUI. Do not spike a React or Expo shell, and do not host OpenMuse components inside the app. Hermes may still supply speech-to-text, speech synthesis, and session behavior.

Build the shell in this order:

1. Menu bar extra, main window, and overlay.
2. Global shortcut and push-to-talk.
3. Transcript review before a consequential action is submitted.
4. Listening indicator, spoken-result playback, and a visible Stop control.
5. Settings for permissions, grants, and collection.

Reuse Hermes speech configuration and processing where practical. Benchmark English and Hinglish commands, speech silence, device changes, headphone use, and model or provider errors. Consequential actions use the same authorization path regardless of input modality. Voice does not skip the review screen.

Then evaluate Hermes wake word. Add mute and a visible microphone state. Distinguish stopping speech playback, cancelling a run, and ending listening. Ensure assistant speech does not trigger a new task. Optimize idle use only after collecting a baseline.

Exit criteria: the voice accuracy target passes; accidental or background audio does not send messages; Stop reaches the execution coordinator; wake-word failure leaves text entry and push-to-talk usable; every screen in the shell is SwiftUI.

## 10 Step 9 Recover tasks and package the application

Persist tasks before admission, proposed actions before execution, and receipts after observation. On restart, mark executing actions as unknown until checked. Recover read-only work automatically when safe. External writes require reconciliation before another attempt. Never advertise resuming the exact inference unless the selected runtime supports it.

Startup restores the SwiftUI windows and the database, checks runtime and driver health, reconciles leases, and waits for a usable session. Sleep and lock block interactive tasks; wake rechecks targets and permissions. Scheduled tasks missed during sleep follow an explicit skip or catch-up policy, with external writes requiring current authorization.

Package the SwiftUI app with pinned Python and runtime dependencies and any native driver, using supported distribution methods. Store secrets through a native Keychain broker. Use authenticated stdio or local sockets between the app and the coordinator; if loopback HTTP is required, validate tokens, origin, request sizes, and protocol versions. Do not ship a broad unauthenticated local executor.

Test app signing and permission identity stability on a clean Mac account. Validate first launch, start at login, update rollback, runtime crashes, offline startup, data backup, and uninstall. Preserve data on app update. Distribution feasibility depends on driver and private API constraints; do not promise Mac App Store compatibility.

Exit criteria: clean-install and upgrade tests pass; no missing bundled dependencies; permissions remain attributable to the intended executable; failures leave recoverable task records; the installed app contains no OpenMuse or React UI bundle.

## 11 Step 10 Validate and release

Required tests are meaningful boundary tests, not assertions that mirror implementation.

| Test area | Required cases |
|---|---|
| Runtime contract | Streaming, question correlation, cancel, reconnect, version mismatch |
| Policy | Payload change, revoked grant, wrong account, indirect write path |
| Desktop | Target drift, sparse accessibility, multiple windows, user interference |
| Messaging | Duplicate names, changed contact, identical message, uncertain send |
| Recovery | Crash at each action boundary, stale lease, event replay |
| Voice | English and Hinglish corpus, silence, echo, false wake, device change |
| SwiftUI client | Schema mismatch, replayed events, outstanding approval after relaunch, review cannot mutate a bound payload |
| Local service | Authentication, malformed frames, oversized payloads, unauthorized origin |
| Packaging | Fresh account, permission loss, offline boot, sleep and wake, update rollback |

Maintain fixtures that replay observed events and driver states into both the coordinator and the SwiftUI client. Run limited real-app workflows on each supported OS and app version. Mock tests do not establish desktop compatibility. Release experimental generic desktop control separately from verified app adapters.

## 12 Build milestones and completion definition

M0 Audit: pinned manifests, licenses, runnable Hermes baseline, OpenMuse logic extracted with UI excluded, protocol selection.

M1 Engine bridge: text input, real event stream, approval and cancellation tests. A temporary command-line client may prove the bridge before SwiftUI exists.

M2 Local application: SwiftUI task list, task detail, result view, review view, local persistence, history, permissions, and basic Mac tools.

M3 Verified messaging: tested adapter, contact mapping, outcome reconciliation, and the SwiftUI review and unknown-outcome states.

M4 Voice: SwiftUI push-to-talk, transcript review, spoken result, and measured corpus accuracy.

M5 Packaged release: startup, recovery, signing, dependency and permission tests, SwiftUI app bundle.

M6 Extensions: wake word, named routines, schedules, optional browser and Google tools, still rendered in SwiftUI.

The first release is complete when all P0 requirements and release tests pass on the declared environment, known limitations are shown in the app, and source reuse and patch records are reproducible. Do not count a demo that opens an app as complete generalized computer control. Do not count an OpenMuse screenshot, component, or web view as the Mac interface.

## 13 Source references and verification boundaries

- https://github.com/CopilotKit/openmuse — documented app structure. This project reuses task, review, and domain logic only. It does not reuse React or Expo UI.
- https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration — documented integration choices, gateway event and request patterns.
- https://hermes-agent.nousresearch.com/docs/developer-guide/architecture — documented runtime, providers, tools, storage boundaries.
- https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use — existing driver integration, permission modes, limitations.
- https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode — voice implementation and provider options.
- https://hermes-agent.nousresearch.com/docs/user-guide/features/wake-word — wake-word entrypoint.

Checked 4 October 2026. This specification proposes an integration; it does not certify that the unmodified projects interoperate. Step 1 must replace documentation-level assumptions with pinned source evidence.
