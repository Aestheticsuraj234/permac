export type StopKind = "playback" | "run" | "listening";

export interface VoiceDecision {
  submit: boolean;
  reason: string;
  textEntry: true;
  pushToTalk: true;
}

export function decideVoiceInput(input: {
  transcript: string;
  fromAssistant: boolean;
  background: boolean;
  consequential: boolean;
  transcriptReviewed: boolean;
  wakeWordFailed: boolean;
}): VoiceDecision {
  const base = { textEntry: true as const, pushToTalk: true as const };
  if (input.wakeWordFailed) {
    return { ...base, submit: false, reason: "Wake word is unavailable. Use text or push-to-talk." };
  }
  if (input.fromAssistant) {
    return { ...base, submit: false, reason: "Assistant speech does not start a task" };
  }
  if (input.background || !input.transcript.trim()) {
    return { ...base, submit: false, reason: "Background or empty audio is not a command" };
  }
  if (input.consequential && !input.transcriptReviewed) {
    return { ...base, submit: false, reason: "Review the transcript before a consequential action" };
  }
  return { ...base, submit: true, reason: "Transcript accepted" };
}

export function applyStop(kind: StopKind): { playback: boolean; cancelRun: boolean; listening: boolean } {
  if (kind === "playback") return { playback: false, cancelRun: false, listening: true };
  if (kind === "run") return { playback: false, cancelRun: true, listening: true };
  return { playback: false, cancelRun: false, listening: false };
}
