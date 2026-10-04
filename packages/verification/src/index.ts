export type Verification = "pending" | "verified" | "unverified" | "unknown";

export function verifyObserved(input: {
  required: boolean;
  observed: boolean | "unknown";
}): Verification {
  if (input.observed === "unknown") return "unknown";
  if (!input.required) return input.observed ? "verified" : "unverified";
  return input.observed ? "verified" : "unverified";
}

export function canSucceed(verification: Verification): boolean {
  return verification === "verified";
}
