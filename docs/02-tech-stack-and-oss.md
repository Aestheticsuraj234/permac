# Personal Mac Agent — Tech Stack and Open Source

Version 1.0 • 4 October 2026

This document names what we write and which open-source codebases we run or adapt. Commit SHAs, licenses on disk, and the keep/adapt/exclude map are recorded during the M0 audit in `vendor-manifests/`. Until that audit, versions below are requirements, not pins.

## 1 Code we write

| Area | Choice | Role |
|---|---|---|
| Mac app | Swift 6, SwiftUI, AppKit where needed | Menu bar, windows, overlay, global shortcut, permission prompts, every task and review screen |
| Mac packaging | Swift Package Manager | Builds `apps/macos` without an OpenMuse or React toolchain |
| Minimum OS | macOS 14 | Raised only if the Hermes or cua-driver audit requires it |
| Coordinator | TypeScript, Node 24 LTS, pnpm | Tasks, approvals, event journal, leases, policy, recovery |
| Contracts | One schema in `packages/contracts` | TypeScript validates; Swift decodes the same names. Unknown `schema_version` fails closed |
| Harness database | Postgres (`pg`) | Task state, actions, approvals, grants, leases, journal, and an append-only activity log |
| App to coordinator | Authenticated local socket, newline-delimited JSON | Commands in, journal events out |
| Coordinator to Hermes | JSON-RPC 2.0 over stdio | TUI gateway. Loopback HTTP only if the pinned release forces it, and only with a token, size limit, and protocol version |
| Secrets | macOS Keychain | Broker for app secrets. Model provider keys stay in the Hermes profile |

Bun is not a packaging dependency. There is no React, Expo, or web-view target.

## 2 Open source we run

### Hermes Agent

- Repository: https://github.com/NousResearch/hermes-agent
- License: MIT
- Runtime: Python 3.11 or newer, installed with uv
- Process: separate local runtime. We do not import it into the SwiftUI app.

We use it for model reasoning, provider resolution, the tool registry, session storage, personal memory, and skills. Voice behavior is reused in the voice milestone from Hermes speech configuration. We do not adopt the Hermes desktop UI when it conflicts with the SwiftUI shell.

Integration protocol, in order:

1. TUI gateway, `tui_gateway/server.py`, JSON-RPC over stdio. Chosen because the documented interface includes sessions, streaming, approvals, steering, and interruption.
2. ACP (`acp_adapter/`) only if the pinned release shows better lifecycle support for this host.
3. HTTP API server only as an authenticated loopback fallback.

We do not parse Hermes console text as an API, and we do not write its SQLite tables. We do not wrap the agent loop in LangGraph.

### cua-driver

- Project: https://github.com/trycua/cua
- How it enters this product: Hermes pins it and launches it through `CuaDriver.app` for the `computer_use` toolset.
- Role: Mac accessibility tree and background input. We do not write a second click-and-type driver unless the audit finds a required capability missing.

Diagnostics go through `hermes computer-use doctor`. Accessibility and Screen Recording are granted to the identity that command names. Tasks are bound to this Mac. A remote Hermes engine must not target another machine.

### OpenMuse

- Repository: https://github.com/CopilotKit/openmuse
- License: MIT
- Toolchain of the upstream repo: Node 24 LTS, pnpm. We use that toolchain only while reading and extracting logic. We do not ship the OpenMuse app.

| Path | Decision |
|---|---|
| `apps/server` task records and review rules | Adapt into `packages/task-logic`. Leave UI routes, model execution, and CopilotKit thread services behind |
| `packages/domain` validation and shared types | Adapt identifiers into `packages/contracts` |
| `apps/worker` Playwright browser sessions | Defer. Use only if Hermes browser cannot meet a later milestone |
| `packages/integrations` | Defer until a milestone explicitly needs a provider adapter |
| `apps/mobile` | Exclude. React, Expo, and CopilotKit view code |
| `apps/computer` | Exclude. Linux workspace image. It does not operate this Mac and does not supply the UI |

CopilotKit Intelligence is not the thread store. Removing its environment variable is not enough. History is the Postgres journal.

## 3 Upstream code we do not adopt as our own product

- `mini-swe-agent`, the Hermes terminal submodule. It stays inside Hermes.
- Hermes speech libraries (its STT and TTS providers). The voice milestone calls Hermes speech configuration. We do not vendor a second speech stack in the first voice slice.
- The Hermes WhatsApp gateway plugin and `whatsapp_cloud` adapter. They are messaging transports. They are not automation of the installed WhatsApp desktop app.
- OpenMuse React Native components, AG-UI bindings, and the CopilotKit headless UI hooks.

## 4 Direct dependencies we add

Kept small on purpose.

- TypeScript workspace: `typescript`, `zod` for contract validation, `tsx` for running the coordinator and tests, `pg` for Postgres, and `supermemory` for remote memory. Agent memory is not stored in a local file.
- Swift app: SwiftUI and AppKit from the macOS SDK only. No third-party UI kit.

Anything else requires a note in the vendor manifest and a reason tied to a milestone.

## 5 Distribution

The packaged app bundles the pinned Hermes runtime the way Hermes documents, plus cua-driver through Hermes’s installer. Secrets go through Keychain. The app is signed so permission identity stays on the intended executable. Data survives an update. Uninstall leaves a documented data directory the person can delete. Mac App Store compatibility is not a claim.
