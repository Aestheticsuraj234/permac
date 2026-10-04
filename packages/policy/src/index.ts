import { payloadHash } from "../../contracts/src/index.ts";

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

const automatic = new Set([
  "open_app",
  "open_registered_path",
  "read_selection",
  "resolve_workspace",
  "inspect_window",
  "verify_app_state",
  "locate_file",
]);

const review = new Set(["prepare_message", "send_message"]);
const explicitReview = new Set(["delete_registered_path"]);
const unmediated = new Set([
  "shell",
  "terminal",
  "execute_code",
  "browser",
  "browser_exec",
  "browser_script",
  "computer_use",
  "type_text",
]);

export type Disposition = "allow" | "review" | "deny";

export function admitTool(tool: string): { disposition: Disposition; reason?: string } {
  if (unmediated.has(tool)) {
    return {
      disposition: "deny",
      reason: `${tool} is disabled until a mediated executor exists`,
    };
  }
  if (automatic.has(tool)) return { disposition: "allow" };
  if (review.has(tool) || explicitReview.has(tool)) return { disposition: "review" };
  return { disposition: "deny", reason: `${tool} is not a registered capability` };
}

export interface Grant {
  id: string;
  target: string;
  capability: string;
  operation: string;
  expiresAt: number;
  revokedAt?: number;
}

export function grantAllows(
  grants: readonly Grant[],
  input: { target: string; capability: string; operation: string; now: number },
): boolean {
  return grants.some(
    (grant) =>
      grant.target === input.target &&
      grant.capability === input.capability &&
      grant.operation === input.operation &&
      grant.expiresAt > input.now &&
      grant.revokedAt === undefined,
  );
}

export interface ApprovalBinding {
  recipient?: string;
  account?: string;
  body?: string;
  attachments?: string[];
  operation: string;
  tool: string;
  target: string;
}

export function approvalHash(binding: ApprovalBinding): string {
  return payloadHash(binding);
}

export function assertApprovalStillValid(
  approval: { exact_payload_hash: string; decision?: "approved" | "rejected"; expiresAt: number },
  binding: ApprovalBinding,
  now: number,
): void {
  if (approval.decision !== "approved") {
    throw new PolicyError("Action is not approved");
  }
  if (approval.expiresAt <= now) throw new PolicyError("Approval expired");
  if (approval.exact_payload_hash !== approvalHash(binding)) {
    throw new PolicyError("Payload changed and needs a new approval");
  }
}

export interface Lease {
  ownerTaskId: string;
  fencingGeneration: number;
  expiresAt: number;
}

export function acquireLease(
  current: Lease | undefined,
  taskId: string,
  now: number,
  ttlMs: number,
): Lease {
  if (current && current.expiresAt > now && current.ownerTaskId !== taskId) {
    throw new PolicyError(`Desktop lease is held by ${current.ownerTaskId}`);
  }
  return {
    ownerTaskId: taskId,
    fencingGeneration: (current?.fencingGeneration ?? 0) + 1,
    expiresAt: now + ttlMs,
  };
}

export function assertFence(current: Lease | undefined, taskId: string, generation: number, now: number): void {
  if (!current || current.ownerTaskId !== taskId || current.fencingGeneration !== generation) {
    throw new PolicyError("Stale desktop lease");
  }
  if (current.expiresAt <= now) throw new PolicyError("Desktop lease expired");
}
