import type { TaskState } from "../../contracts/src/index.ts";

// Review binding adapted from OpenMuse apps/server/src/actions.ts (MIT, pinned in
// vendor-manifests/upstream.json). The React UI, CopilotKit thread store, and Google
// client from that file are not included. Account rechecks stay, without that provider.

const transitions: Record<TaskState, readonly TaskState[]> = {
  queued: ["running", "cancelled"],
  running: [
    "waiting_input",
    "waiting_approval",
    "paused",
    "blocked",
    "reconciling",
    "succeeded",
    "failed",
    "cancelled",
  ],
  waiting_input: ["running", "cancelled", "failed", "blocked"],
  waiting_approval: ["running", "cancelled", "failed", "blocked"],
  paused: ["running", "cancelled", "failed"],
  blocked: ["queued", "running", "cancelled", "failed"],
  reconciling: ["succeeded", "blocked", "failed", "running"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export class TaskRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskRuleError";
  }
}

export function assertTransition(
  from: TaskState,
  to: TaskState,
  options?: { verified?: boolean; safeBoundary?: boolean },
): void {
  if (!transitions[from].includes(to)) {
    throw new TaskRuleError(`Cannot move a task from ${from} to ${to}`);
  }
  if (to === "succeeded" && !options?.verified) {
    throw new TaskRuleError("succeeded requires a verified outcome");
  }
  if (to === "paused" && !options?.safeBoundary) {
    throw new TaskRuleError("paused is only available at a safe boundary");
  }
}

export interface ReviewProposal {
  id: string;
  taskStatus: TaskState;
  status: "awaiting_review" | "approved" | "rejected" | "expired" | "executed";
  hash: string;
  account?: string;
  expiresAt: number;
}

export function decideReview(
  proposal: ReviewProposal,
  input: { hash: string; decision: "approved" | "rejected"; now: number; currentAccount?: string },
): ReviewProposal {
  if (proposal.hash !== input.hash) {
    throw new TaskRuleError("This proposal changed. Open its latest review before deciding.");
  }
  if (proposal.taskStatus === "cancelled" || proposal.taskStatus === "failed") {
    throw new TaskRuleError("Cancelled tasks cannot execute.");
  }
  if (proposal.status !== "awaiting_review") return proposal;
  if (proposal.expiresAt <= input.now) {
    throw new TaskRuleError("This review expired. Create a fresh proposal.");
  }
  if (
    input.decision === "approved" &&
    proposal.account &&
    input.currentAccount !== proposal.account
  ) {
    throw new TaskRuleError("Account changed. Prepare a new action for the current account.");
  }
  return { ...proposal, status: input.decision === "approved" ? "approved" : "rejected" };
}

export function proposalIdForIdempotency(existing: string | undefined, fresh: string): string {
  return existing ?? fresh;
}
