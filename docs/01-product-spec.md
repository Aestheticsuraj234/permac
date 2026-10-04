# Personal Mac Agent — Product Specification

Version 1.0 • 4 October 2026

This document says what the product does. The build procedure lives in `Personal_Mac_Agent_SwiftUI_Implementation_Spec.md`. The stack lives in `docs/02-tech-stack-and-oss.md`. Process boundaries live in `docs/03-architecture.md`. Field names live in `docs/04-contracts.md`.

## 1 Who it is for

One person, on their own Mac. The agent opens registered apps, reads a selection, finds files in folders they have granted, and later sends messages and listens to speech. It runs locally. It asks before it deletes, runs arbitrary shell commands, or sends a message that is not already covered by a standing grant.

## 2 Product shape

The interface is a native SwiftUI Mac app: menu bar, main window, overlay, and review surfaces. It does not embed a web page, React app, or OpenMuse screen.

The person types an instruction, or later holds push-to-talk. They watch the task stream. If the agent needs a decision, a review or clarification surface shows the exact question. They can cancel. After a crash, the app shows what is known and what is unknown. It does not silently repeat an external write.

## 3 P0 journeys

P0 is the first local application. These journeys must work before WhatsApp or voice are treated as part of the product.

1. Open the menu bar app and submit a text instruction.
2. Watch streaming text and tool progress on the task detail surface.
3. See a read-only result with the evidence the coordinator recorded.
4. Resolve an approval. The screen shows the exact payload. Approving authorizes that payload hash only.
5. Answer one clarification. The answer is correlated to the request id.
6. Cancel a running task. Stop reaches the coordinator.
7. Open a registered application.
8. Open a project in Cursor.
9. Summarize selected content. The result shows the source of the selection and the text.
10. Locate a file inside granted directories. The result shows the granted root and the matches.
11. Relaunch the app. Tasks, history, and any outstanding question are still there.

Missing app, missing file, denied permission, and user interference end in a blocked or failed state with a reason. They do not look like success.

## 4 Later journeys

These are in the product, after P0 exit criteria pass. They are not required to call the local application milestone done.

- WhatsApp on the desktop client: resolve a contact, review the exact recipient and body, send once, and reconcile after a crash. An uncertain send stays unknown and is not resent automatically.
- Voice: push-to-talk, transcript review, spoken result, and a Stop control that reaches the coordinator. Voice uses the same approval path as text.
- Wake word, named routines, and schedules. A missed schedule during sleep follows an explicit skip or catch-up rule. External writes still need a current authorization.
- Optional browser and Google tools, only if the Hermes audit shows they are still needed.

## 5 What the person can trust

- Opening a registered app or a registered file can proceed without a prompt.
- Reading context follows the collection setting.
- Outgoing messages wait for review unless a matching standing grant exists.
- Deletion and arbitrary shell execution always wait for an action-specific review.
- A changed message, recipient, or account invalidates the approval.
- Two tasks do not type into the same desktop conversation at once.
- The app does not lock the keyboard.
- If the person changes the foreground target while a desktop action is in progress, the task pauses and says so.
- Delivery is claimed only when delivery was observed. Submission is not delivery.

## 6 Non-goals

- A React, Expo, or CopilotKit interface, including a web view of one.
- A second agent loop around Hermes.
- Driving a different machine, a Linux container workspace, or a remote browser as if it were this Mac.
- Using a messaging-gateway plugin as proof that the installed WhatsApp desktop app was automated.
- Mac App Store distribution. Driver and private API constraints decide whether that is possible later. This spec does not promise it.
- Generalized computer control. Opening an app in a demo is not that claim.
- Resuming an in-flight model inference across a crash, unless the pinned Hermes release actually supports it.

## 7 Known limitations shown in the app

The first release shows limitations in the app rather than hiding them. At minimum the app states:

- Desktop control is limited to verified workflows and mediated tools. Unmediated shell, browser, and generic typing paths stay disabled.
- A desktop click has no provider idempotency key. The app can avoid scheduling a second send. It cannot promise the click happened once if the outcome is unknown.
- Voice accuracy is reported from the measured corpus, not assumed.
- Wake word is optional. Text and push-to-talk remain usable when it fails.

## 8 Done

P0 is done when the journeys in section 3 pass on this Mac, the SwiftUI spec’s M2 exit criteria pass, and the limitations in section 7 are visible. The full product is done when M3 through M6 exit criteria in the SwiftUI implementation spec also pass on the declared environment, and the vendor manifest can reproduce the pinned sources.
