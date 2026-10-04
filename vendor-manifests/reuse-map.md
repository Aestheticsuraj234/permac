# Reuse map

Audit date 2026-10-04. SHAs are in `upstream.json`.

| Candidate | Decision | Why |
|---|---|---|
| Hermes agent runtime and tool registry | Keep, separate process | Reasoning and tool selection stay in Hermes |
| Hermes TUI gateway | Keep | Stdio JSON-RPC answered `gateway.ready`, `ping`, `client.capabilities`, and `session.create` on the pinned tag |
| Hermes ACP adapter | Defer | Not required after the gateway probe |
| Hermes HTTP API | Defer | More network exposure than stdio |
| Hermes session store, memory, skills | Keep, Hermes-owned | No delete-by-SQL. No dedicated memory-delete RPC was confirmed in the pinned gateway contracts. The coordinator refuses to edit those tables |
| Hermes computer-use and cua-driver | Defer execution | Driver remains the Mac control path if enabled later. It is not turned on for P0 |
| Hermes voice behavior | Adapt later | Speech stays in Hermes. The SwiftUI shell draws the controls |
| Hermes desktop UI | Exclude | Conflicts with the SwiftUI shell |
| OpenMuse `apps/server` review rules | Adapt | Hash binding, expiry, idempotency, and cancelled-task refusal live in `packages/task-logic` |
| OpenMuse `packages/domain` | Adapt | Task and proposal ideas only. Identifiers are the contracts in `docs/04-contracts.md` |
| OpenMuse `apps/worker` | Defer | Hermes browser is not enabled either. Playwright is not a P0 dependency |
| OpenMuse `packages/integrations` | Defer | Google tools stay disabled |
| OpenMuse `apps/mobile` | Exclude | React, Expo, and CopilotKit views |
| OpenMuse `apps/computer` | Exclude | Linux workspace, not this Mac |
| CopilotKit Intelligence thread store | Replace | Postgres is the journal. Supermemory is the memory store |
| LangGraph | Exclude | Would duplicate the Hermes loop |

Unmediated toolsets (`terminal`, `browser`, `computer_use`) are disabled in the Hermes profile via `agent.disabled_toolsets`. Side effects go through coordinator executors that can be held for approval. Generic shell stays disabled rather than approved from the UI alone.
