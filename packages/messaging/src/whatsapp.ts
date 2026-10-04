export interface ContactRecord {
  id: string;
  displayLabel: string;
  account: string;
  verifiedAt?: string;
  alternativeNames: string[];
}

export type SendObservation = "not_sent" | "submitted" | "visibly_sent" | "delivered" | "unknown";

export interface WhatsAppSnapshot {
  account?: string;
  recipientId?: string;
  bubbles: string[];
  appAvailable: boolean;
  permissions: boolean;
}

export interface WhatsAppDriver {
  resolve(query: string): ContactRecord[];
  snapshot(): WhatsAppSnapshot;
  openConversation(contactId: string): void;
  prepare(body: string): void;
  send(): void;
}

export type CrashPoint = "before_send" | "during_send" | "after_send";

export interface WhatsAppOutcome {
  state: "clarification" | "blocked" | "waiting_approval" | "unknown" | "verified" | "cancelled_before_execution";
  reason: string;
  observation: SendObservation;
  contactId?: string;
  resend: false;
}

export function runWhatsAppSend(input: {
  query: string;
  body: string;
  expectedAccount: string;
  driver: WhatsAppDriver;
  approvedHash?: string;
  payloadHash: string;
  crash?: CrashPoint;
  clarifiedContactId?: string;
}): WhatsAppOutcome {
  if (!input.driver.snapshot().permissions || !input.driver.snapshot().appAvailable) {
    return {
      state: "blocked",
      reason: "WhatsApp permissions or the desktop app are unavailable",
      observation: "not_sent",
      resend: false,
    };
  }
  const matches = input.driver.resolve(input.query);
  if (matches.length === 0) {
    return { state: "blocked", reason: "No contact matched", observation: "not_sent", resend: false };
  }
  if (matches.length > 1 && !input.clarifiedContactId) {
    return {
      state: "clarification",
      reason: "More than one contact matches",
      observation: "not_sent",
      resend: false,
    };
  }
  const contact =
    matches.find((item) => item.id === input.clarifiedContactId) ?? matches[0]!;
  if (input.clarifiedContactId && contact.id !== input.clarifiedContactId) {
    return { state: "blocked", reason: "Clarified contact is not a match", observation: "not_sent", resend: false };
  }
  input.driver.openConversation(contact.id);
  const seen = input.driver.snapshot();
  if (seen.account !== input.expectedAccount || seen.recipientId !== contact.id) {
    return {
      state: "blocked",
      reason: "Account or recipient changed before send",
      observation: "not_sent",
      resend: false,
    };
  }
  if (input.approvedHash !== input.payloadHash) {
    return {
      state: "waiting_approval",
      reason: "Send needs approval of the exact body and recipient",
      observation: "not_sent",
      resend: false,
      contactId: contact.id,
    };
  }
  if (input.crash === "before_send") {
    return {
      state: "cancelled_before_execution",
      reason: "Crashed before send",
      observation: "not_sent",
      resend: false,
      contactId: contact.id,
    };
  }
  const before = input.driver.snapshot().bubbles.filter((bubble) => bubble === input.body).length;
  if (before > 0) {
    return {
      state: "unknown",
      reason: "An identical message is already visible, so a new send would be indistinguishable",
      observation: "unknown",
      resend: false,
      contactId: contact.id,
    };
  }
  if (input.crash === "during_send") {
    return {
      state: "unknown",
      reason: "Crashed during send. Outcome is unknown and will not be sent again automatically.",
      observation: "unknown",
      resend: false,
      contactId: contact.id,
    };
  }
  input.driver.prepare(input.body);
  input.driver.send();
  const after = input.driver.snapshot();
  if (after.recipientId !== contact.id || after.account !== input.expectedAccount) {
    return {
      state: "unknown",
      reason: "Recipient or account could not be rechecked after send",
      observation: "unknown",
      resend: false,
      contactId: contact.id,
    };
  }
  const copies = after.bubbles.filter((bubble) => bubble === input.body).length;
  if (input.crash === "after_send") {
    if (copies === before) {
      return {
        state: "unknown",
        reason: "Crashed after send and the bubble could not be distinguished",
        observation: "unknown",
        resend: false,
        contactId: contact.id,
      };
    }
    return {
      state: "verified",
      reason: "Message is visible after crash reconciliation",
      observation: "visibly_sent",
      resend: false,
      contactId: contact.id,
    };
  }
  if (copies > before + 1) {
    return {
      state: "unknown",
      reason: "Identical message already existed and the new send cannot be distinguished",
      observation: "unknown",
      resend: false,
      contactId: contact.id,
    };
  }
  if (copies === before + 1) {
    return {
      state: "verified",
      reason: "Message bubble is visible. Delivery was not observed.",
      observation: "visibly_sent",
      resend: false,
      contactId: contact.id,
    };
  }
  return {
    state: "unknown",
    reason: "Send was submitted but the bubble was not observed",
    observation: "submitted",
    resend: false,
    contactId: contact.id,
  };
}
