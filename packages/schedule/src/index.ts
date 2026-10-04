export type MissedPolicy = "skip" | "catch_up";

export function missedSchedule(input: {
  policy: MissedPolicy;
  externalWrite: boolean;
  authorizationCurrent: boolean;
}): "skip" | "run" | "needs_authorization" {
  if (input.policy === "skip") return "skip";
  if (input.externalWrite && !input.authorizationCurrent) return "needs_authorization";
  return "run";
}

export interface RoutineStep {
  tool: string;
  target: string;
}

export function runRoutine(
  steps: readonly RoutineStep[],
  execute: (step: RoutineStep) => "ok" | "blocked",
): { completed: number; stopped: boolean } {
  let completed = 0;
  for (const step of steps) {
    if (execute(step) !== "ok") return { completed, stopped: true };
    completed += 1;
  }
  return { completed, stopped: false };
}

export function optionalToolEnabled(name: "browser" | "google"): false {
  void name;
  return false;
}
