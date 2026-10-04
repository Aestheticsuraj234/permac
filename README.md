# Permac

Permac is a personal agent for one Mac. It runs on that computer. Nothing in this project is a public web service, and it does not drive a different machine.

You get a SwiftUI menu bar app for tasks, results, and review, and a local coordinator that keeps the task log, asks before risky actions, and talks to [Hermes Agent](https://github.com/NousResearch/hermes-agent) for model reasoning. The interface is not the OpenMuse React app. OpenMuse contributed review rules only.

## What you can do

- Submit a text instruction and keep the task, its state, its event history, and an activity log in Postgres.
- Open a registered app. The built-in registry is Cursor, TextEdit, and Safari.
- Open a file under your granted folders. The default folder is `~/Documents`.
- Find a file in those folders. Paths such as `.ssh`, `.aws`, Keychains, Mail, and Messages are skipped.
- Read selected text when Accessibility exposes it. A clipboard fallback puts the previous clipboard contents back.
- Watch a task move through queued, running, waiting for you, waiting for approval, blocked, succeeded, failed, or cancelled.
- Approve or reject one exact action. If the message, recipient, or account changes, the old approval no longer applies.
- Answer one clarification. Cancel a running task.
- Keep only one desktop task in control at a time, so two jobs do not type into the same place.
- Restart the coordinator and still have the task list. An action that was mid-run comes back as unknown instead of being repeated.
- Send agent memory to [Supermemory](https://supermemory.ai) through the official SDK. Permac does not keep a local `MEMORY.md` or `USER.md`. Without `SUPERMEMORY_API_KEY`, memory writes are skipped and that skip is recorded in the Postgres activity log.
- Package an ad-hoc signed `Permac.app` on this Mac.

These controls exist in the coordinator and are covered by tests. Treat them as guarded workflows, not finished live automation:

- WhatsApp on the desktop app: resolve a contact, review the exact body, send once, and leave an uncertain send as unknown. It does not send again by itself.
- Voice: push-to-talk, a transcript review step, and separate Stop actions for playback, the run, and listening.
- Schedules that were missed during sleep, and ordered routines.
- Wake word, browser control, and Google tools stay off.

## What it will not do

- Run shell, browser scripts, or generic click-and-type on its own. Those paths stay disabled until a mediated executor can hold them for approval.
- Claim a WhatsApp message was delivered when it only saw the send click.
- Lock your keyboard.
- Put the app on the Mac App Store. `scripts/package-mac.sh` ad-hoc signs a local bundle.

## Self-host

You host it by running it on your own Mac. The coordinator listens on `127.0.0.1` only.

You need:

- macOS 14 or newer
- Node.js 22.13 or newer and pnpm 11
- Swift 6 (Xcode or the Command Line Tools)
- [uv](https://docs.astral.sh/uv/) and Python 3.12. Hermes does not run on Python 3.14.
- A Hermes model provider configured in the Hermes profile. Provider keys stay there, not in the SwiftUI app.

From the project root:

```sh
pnpm install

mkdir -p upstream
git clone --depth 1 --branch v2026.9.24 https://github.com/NousResearch/hermes-agent.git upstream/hermes-agent
cd upstream/hermes-agent
uv python install 3.12
uv sync --frozen --python 3.12
cd ../..
```

That tag is the pinned Hermes release recorded in `vendor-manifests/upstream.json`. Point Hermes at a provider before you expect model answers. Hermes documents this as `hermes model`, `/login`, or an API key in the profile `.env`.

Start the coordinator with the Python from that virtualenv:

```sh
export HERMES_PYTHON="$PWD/upstream/hermes-agent/.venv/bin/python"
export HERMES_HOME="$PWD/data/hermes-home"
export PERMAC_DATA_DIR="$PWD/data"
export PERMAC_PORT=8788
pnpm coordinator
```

Copy `.env.example` to `.env` and set `DATABASE_URL` to your Postgres database. The coordinator reads that file on startup. Tasks, approvals, grants, the desktop lease, the event journal, and the activity log all live in the `permac` schema. Nothing from the harness is stored in SQLite.

Set `SUPERMEMORY_API_KEY` in the same file when you want memory. Permac uses the [`supermemory`](https://www.npmjs.com/package/supermemory) SDK (`add`, `search`, and `documents.delete`) and the container tag `permac`. The coordinator also writes `$HERMES_HOME/supermemory.json` and turns off Hermes' built-in `MEMORY.md` / `USER.md`. With a key set, Hermes is pointed at the Supermemory provider; install that provider in the Hermes virtualenv with `uv pip install supermemory` from `upstream/hermes-agent` before you expect Hermes itself to recall. See the [Hermes Supermemory guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers).

The process prints the port it bound. It writes a local access token to `data/token` (mode `0600`). Hermes sessions stay in `data/hermes-home`. The app does not write the Postgres database, and Permac does not write Hermes' database.

Open the Mac app in a second terminal:

```sh
swift run --package-path apps/macos
```

Or build a local app bundle:

```sh
scripts/package-mac.sh
open dist/Permac.app
```

The bundle is ad-hoc signed. The first launch may need you to allow it in System Settings. Accessibility is required for selection reading. Screen Recording is only needed if you later enable Hermes computer use.

The menu bar app is the place you read tasks, results, review, and the known limitations. The coordinator is the process that stores tasks and runs workflows. Talk to it on the local socket. The first line must include the token:

```sh
TOKEN=$(cat data/token)
printf '%s\n' "{\"id\":\"1\",\"token\":\"$TOKEN\",\"command\":\"health\",\"payload\":{}}" | nc 127.0.0.1 8788
```

Open Cursor:

```sh
printf '%s\n' "{\"id\":\"2\",\"token\":\"$TOKEN\",\"command\":\"workflow.run\",\"payload\":{\"tool\":\"open_app\",\"target\":\"Cursor\"}}" | nc 127.0.0.1 8788
```

Other commands the coordinator accepts: `task.submit`, `task.interrupt`, `task.pause`, `approval.resolve`, `clarification.answer`, and `journal.subscribe`. A wrong token, a broken JSON line, or a frame over 1 MB is rejected.

To stop, quit the coordinator process. `data/` still holds the access token and the Hermes profile. Task history stays in Postgres. Uninstalling the app bundle does not delete either one.

## Checks

```sh
pnpm test
swift test --package-path apps/macos
```

## Layout

| Path | What it is |
|---|---|
| `docs/` | Product, stack, architecture, and event contracts |
| `apps/macos` | SwiftUI menu bar app |
| `apps/coordinator` | Local task service |
| `packages/` | Contracts, Hermes adapter, policy, storage, Mac tools, messaging, voice |
| `vendor-manifests/` | Pinned upstream commits and what was kept or excluded |
| `upstream/` | Local Hermes checkout. Not part of this git repo |

Deeper behavior is in `docs/01-product-spec.md` and `Personal_Mac_Agent_SwiftUI_Implementation_Spec.md`.
