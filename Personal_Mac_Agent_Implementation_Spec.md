# Personal Mac Agent Implementation Specification

Version 1.0 • 4 October 2026 • Companion to Personal Mac Agent Product Requirements

## 1 Architecture decision

Use Hermes as a separate local Python runtime. Build a TypeScript coordinator and an OpenMuse-derived interface. Reuse Hermes desktop control and voice wherever they satisfy the product requirements. Introduce a Swift helper only for capabilities missing or unreliable in the existing path.

The harness owns task admission, policy, execution coordination, verification, and recovery. Hermes owns model reasoning and tool selection. The interface renders their combined event stream. Do not add LangGraph around Hermes solely to duplicate its agent loop.

Proposed process boundaries:

- Mac shell: menu bar, global shortcut, overlay, lifecycle, native permissions, voice status.
- UI: selected OpenMuse React components adapted for desktop.
- Coordinator: local TypeScript service, task database, approvals, event journal, resource leases.
- Hermes bridge: authenticated local integration with the existing runtime.
- Executors: existing computer-use driver, explicit app adapters, browser executor, optional native helper.

All paths and interfaces in this document are proposed project contracts unless explicitly identified as upstream documentation.

## 2 Step 1 Pin and audit the upstream source

Clone https://github.com/NousResearch/hermes-agent and https://github.com/CopilotKit/openmuse into isolated upstream checkouts. Read repository instructions before edits. Record the exact commit SHA, license, dependency lockfile, runtime requirements, and supported distribution method. Use a stable release when possible; do not ship against moving main branches.

Create an upstream manifest containing repository URL, SHA, license path, selected modules, local patches, dependency versions, and audit date. Keep upstream commits separate from application changes. Prefer adapters and extraction over broad edits to the runtime.

| Source candidate | Intended reuse | Audit required |
|---|---|---|
| Hermes agent runtime and tool registry | Reasoning, providers, dispatch | Confirm extension hooks and execution interception |
| Hermes TUI gateway or ACP adapter | Session lifecycle, approvals, events | Confirm wire schema and cancellation behavior |
| Hermes session store, memory, skills | Agent continuity | Confirm ownership and export/delete APIs |
| Hermes computer-use integration | Existing Mac control | Validate installed driver, permissions, supported OS |
| Hermes voice and desktop app | Speech and shell candidates | Check packaging and extension boundaries |
| OpenMuse apps/mobile | Task UI and rich result components | Separate reusable React code from Expo native dependencies |
| OpenMuse apps/server | Task records, review logic | Separate UI/task code from its own model execution |
| OpenMuse packages/domain | Validation and shared types | Adapt identifiers and schemas |
| OpenMuse apps/worker | Browser sessions and takeover | Decide whether Hermes browser already meets need |
| OpenMuse packages/integrations | Useful provider adapters | Retain only explicitly needed integrations |
| OpenMuse apps/computer | Isolated Linux workspace | Optional; does not operate the user's Mac |

These OpenMuse paths appear in its documented architecture; file-level extraction and transitive dependencies must still be audited. Hermes runtime entrypoints can change between releases.

Exit criteria: audit manifest completed; both apps start independently in test mode; documented reuse map marks every candidate keep, adapt, replace, or defer. Do not enter implementation with unknown license or runtime boundaries.

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

Test one normal run, streaming tool output, an approval, a clarification, cancellation, reconnect, provider failure, and runtime crash. Demonstrate how a blocked action reaches the UI. Explicitly determine whether tool interception can apply the harness policy to every side-effecting path, including shell and browser operations.

Exit criteria: automated contract fixtures pass; approvals cannot execute before resolution; unsupported requests fail clearly; all required events have stable mappings. If execution interception is missing, add a narrowly scoped upstream patch or constrained executor rather than an unenforced UI policy.

## 4 Step 3 Define the project layout and data ownership

Proposed directories:

| Directory | Responsibility |
|---|---|
| apps/desktop | Mac shell and desktop UI packaging |
| apps/coordinator | Local task service and event transport |
| packages/contracts | Validated commands and event schemas |
| packages/hermes-adapter | Runtime protocol translation |
| packages/openmuse-ui | Extracted and adapted UI components |
| packages/policy | Grants, approval binding, action admission |
| packages/mac-tools | App-specific tools and native helper client |
| packages/verification | App and workflow result checks |
| packages/storage | Harness database and migrations |
| tests/contracts | Upstream protocol and replay tests |
| tests/workflows | Mac workflow fixtures and release tests |
| vendor-manifests | Pinned upstream and patch records |

Use the package manager supported by retained upstream code; OpenMuse currently documents pnpm. Avoid adding Bun as a packaging dependency unless compatibility is proven.

Hermes owns agent sessions, personal memory, and skills. The harness owns task state, action receipts, approval metadata, resource leases, and UI preferences. The UI may keep a read-only message projection for rendering; it must not become a competing conversation source. Do not put both services in direct write access to the same embedded database.

Retain an OpenMuse storage module only if it fits the single-machine process model. Otherwise use SQLite with migrations for the harness. Choose during the audit. Replace the CopilotKit Intelligence thread path for local storage, including thread hooks, replay, and server dependencies; removing an environment variable is insufficient.

Exit criteria: restart preserves tasks and history; remote thread-service calls are absent in local mode; migrations and backup/restore work; memory deletion reaches its owning store.

## 5 Step 4 Build the task and event contracts

Task states: queued, running, waiting_input, waiting_approval, paused, blocked, reconciling, succeeded, failed, cancelled.

Persist each transition before publishing it. succeeded requires verified required outcomes. An uncertain external action moves to reconciling or blocked. paused is available only at a safe boundary; it is not a promise to snapshot a model inference or a live GUI action.

Task fields: id, session_id, engine_run_id, instruction, source, state, created_at, updated_at, current_step, attempt, last_event_sequence, cancellation_requested_at, and error.

Action fields: id, task_id, tool, target, payload_hash, state, approval_id, started_at, completed_at, verification, evidence_reference, and idempotency_key where the executor supports it. States: proposed, authorized, executing, verified, failed, unknown, cancelled_before_execution.

Approval fields: id, action_id, exact_payload_hash, scope, requested_at, expires_at, resolved_at, decision, and resolving_user. Grants are distinct records with target constraints, capability, operation, expiry, and revocation.

Events include task.created, task.state_changed, message.delta, tool.started, tool.completed, approval.requested, approval.resolved, clarification.requested, action.verified, action.unknown, and run.finished. Each envelope contains schema_version, event_id, task_id, sequence, timestamp, type, and payload. The names are your contract, not claimed upstream event names.

Store an append-only event journal. Reconnect accepts the last received sequence and replays later events, with client deduplication. Authorize task access even for local clients. Adapt these events to AG-UI only where retained CopilotKit components require it; test the adapter explicitly.

Exit criteria: duplicate/reordered delivery does not duplicate actions or corrupt UI state; a lost connection restores outstanding questions and task progress.

## 6 Step 5 Implement action policy and resource coordination

Every action passes through admission, capability authorization, target validation, execution, and verification. Preserve downstream Hermes and driver restrictions. Effective permission is the intersection of harness policy and executor permission, never a replacement for stricter enforcement.

Initial defaults: opening registered apps/files is automatic; context reading follows collection settings; outgoing messages require review unless a matching standing grant exists; deletion and arbitrary shell execution require explicit action-specific review. The product can support user-authored standing grants without asking repeatedly for already authorized actions.

Approval binds recipient identity, account, message body, attachment references, and operation. Any mutation expires the approval. Recheck the actual foreground or addressed window and account before acting. Never infer that a model-generated instruction authorizes an action.

Route browser work through the selected browser executor, desktop work through the driver or app adapter, and direct app capabilities through explicit tools. Shell, browser scripts, and generic typing can also cause external writes; they cannot bypass the policy simply because the named tool is generic.

Begin with one global lease for desktop mutations. Include owner task, expiry, heartbeat, and fencing generation. Expired ownership must be reconciled; a stale worker may not keep executing. Handle physical user interference by re-observing state and pausing when the intended target changes. Do not lock the user's keyboard.

Exit criteria: revoked grants block execution; changed payloads need new authorization; two simultaneous tasks cannot corrupt one conversation; tool paths that cannot be mediated remain disabled.

## 7 Step 6 Deliver Mac context and simple workflows

Evaluate Hermes's packaged desktop controller before writing another implementation. Run its documented diagnostics and establish the actual execution host. Bind local tasks to this Mac explicitly; remote engines must not accidentally target a different machine.

Add project-level tools: open_app, open_registered_path, read_selection, resolve_workspace, inspect_window, and verify_app_state. Wrap existing capabilities where possible. Use a Swift service for native functions only when necessary.

Collect just enough context for the request. A selection read may use accessibility or another supported mechanism; clipboard fallback must preserve existing clipboard state and report unsupported cases. Capture screenshots on demand, redact configured regions when possible, and never assume every app exposes usable accessibility controls.

First workflows: open a registered application; open a project in Cursor; summarize selected content; locate a file within approved directories; start an ordered recording routine. File searches are constrained to granted locations and exclude sensitive directories by default.

Exit criteria: 20 controlled repetitions per supported workflow meet the PRD target; permission revocation, missing app, missing file, and user interference produce clear blocked/error states.

## 8 Step 7 Implement WhatsApp as a verified adapter

Use a dedicated test account or consenting test recipient. Inspect the current WhatsApp desktop accessibility tree and capture evidence for the supported version. Do not assume messaging gateway support implies automation of the installed desktop client.

Implement resolve_contact, open_conversation, inspect_conversation, prepare_message, send_message, and verify_message. Contact records include stable identity where available, display label, account, user verification timestamp, and alternative names. Ambiguous matches ask for clarification.

Workflow: resolve target, acquire lease, open app, navigate, verify account/recipient, draft, request or match approval, revalidate, send once, and inspect the message bubble or another available outcome indicator. Distinguish submitted, visibly sent, and delivered; do not claim delivery if only submission is observable.

A desktop click has no provider-enforced idempotency key. The local action key prevents duplicate scheduling but cannot guarantee exactly-once external execution. Persist intent before the send and reconcile the conversation after a crash. If the result cannot be distinguished from an existing identical message, mark unknown and request review.

Exit criteria: zero wrong-recipient and duplicate sends across test cases; crash before send, during send, and after send reconciles without automatic resubmission; permissions and app-update failures are detected.

## 9 Step 8 Add voice and Mac shell

Choose the shell after an integration spike: reuse Hermes desktop and port OpenMuse components if compatible, or build a Swift shell hosting adapted web UI. Do not assume Expo React Native mobile components run unchanged on macOS.

First implement global shortcut, push-to-talk, transcript review, listening indicator, and spoken results. Reuse Hermes STT/TTS configuration and processing where practical. Benchmark English and Hinglish commands, speech silence, device changes, headphone use, and model/provider errors. Consequential actions use the same authorization path regardless of input modality.

Then evaluate Hermes wake word. Add mute, visible microphone state, and Stop. Distinguish stopping speech playback, cancelling a run, and ending listening. Ensure assistant speech does not trigger a new task. Optimize idle use only after collecting a baseline.

Exit criteria: the voice accuracy target passes; accidental/background audio does not send messages; Stop reaches the execution coordinator; wake-word failure leaves text and push-to-talk usable.

## 10 Step 9 Recover tasks and package the application

Persist tasks before admission, proposed actions before execution, and receipts after observation. On restart, mark executing actions as unknown until checked. Recover read-only work automatically when safe. External writes require reconciliation before another attempt. Never advertise resuming the exact inference unless the selected runtime supports it.

Startup restores the UI and database, checks runtime and driver health, reconciles leases, and waits for a usable session. Sleep and lock block interactive tasks; wake rechecks targets and permissions. Scheduled tasks missed during sleep follow an explicit skip or catch-up policy, with external writes requiring current authorization.

Package pinned Python/runtime dependencies and any native driver using supported distribution methods. Store secrets through a native Keychain broker where feasible. Use authenticated stdio or local sockets; if loopback HTTP is required, validate tokens, origin, request sizes, and protocol versions. Do not ship a broad unauthenticated local executor.

Test app signing and permission identity stability on a clean Mac account. Validate first launch, start at login, update rollback, runtime crashes, offline startup, data backup, and uninstall. Preserve data on app update. Distribution feasibility depends on driver/private API constraints; do not promise Mac App Store compatibility.

Exit criteria: clean-install and upgrade tests pass; no missing bundled dependencies; permissions remain attributable to the intended executable; failures leave recoverable task records.

## 11 Step 10 Validate and release

Required tests are meaningful boundary tests, not assertions that mirror implementation.

| Test area | Required cases |
|---|---|
| Runtime contract | Streaming, question correlation, cancel, reconnect, version mismatch |
| Policy | Payload change, revoked grant, wrong account, indirect write path |
| Desktop | Target drift, sparse accessibility, multiple windows, user interference |
| Messaging | Duplicate names, changed contact, identical message, uncertain send |
| Recovery | Crash at each action boundary, stale lease, event replay |
| Voice | English/Hinglish corpus, silence, echo, false wake, device change |
| Local service | Authentication, malformed frames, oversized payloads, unauthorized origin |
| Packaging | Fresh account, permission loss, offline boot, sleep/wake, update rollback |

Maintain fixtures that replay observed events and driver states. Run limited real-app workflows on each supported OS and app version. Mock tests do not establish desktop compatibility. Release experimental generic desktop control separately from verified app adapters.

## 12 Build milestones and completion definition

M0 Audit: pinned manifests, licenses, runnable baselines, protocol selection.

M1 Engine bridge: text input, real event stream, approval and cancellation tests.

M2 Local application: task UI, local persistence, history, permissions, basic Mac tools.

M3 Verified messaging: tested adapter, contact mapping, outcome reconciliation.

M4 Voice: push-to-talk and spoken result, measured corpus accuracy.

M5 Packaged release: startup, recovery, signing, dependency and permission tests.

M6 Extensions: wake word, named routines, schedules, optional browser and Google tools.

The first release is complete when all P0 requirements and release tests pass on the declared environment, known limitations are shown in the app, and source reuse/patch records are reproducible. Do not count a demo that opens an app as complete generalized computer control.

## 13 Source references and verification boundaries

- https://github.com/CopilotKit/openmuse — documented app structure, alpha features, Linux workspace, CopilotKit Intelligence dependency.
- https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration — documented integration choices, gateway event/request patterns.
- https://hermes-agent.nousresearch.com/docs/developer-guide/architecture — documented runtime, providers, tools, storage boundaries.
- https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use — existing driver integration, permission modes, limitations.
- https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode — voice implementation and provider options.
- https://hermes-agent.nousresearch.com/docs/user-guide/features/wake-word — wake-word entrypoint.

Checked 4 October 2026. This specification proposes an integration; it does not certify that the unmodified projects interoperate. Step 1 must replace documentation-level assumptions with pinned source evidence.
