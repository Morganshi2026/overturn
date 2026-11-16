import type { ConversationMessage, ConversationSnapshot } from "./capture";

/** A custom field attribute on the conversation. */
export interface FrontFieldAttribute {
  id: string;
  name: string;
  value: unknown;
}

/** The parts of a Front conversation this plugin reads. */
export interface FrontConversationView {
  id: string;
  subject: string | null;
  /** Front's conversation type: email, whatsapp, frontChat, ... */
  type: string | null;
  requesterName: string | null;
  requesterEmail: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
  /** The conversation's tags, by name. */
  tags: string[];
  customFieldAttributes: FrontFieldAttribute[];
}

/** One Front message. */
export interface FrontMessageView {
  id: string;
  body: string;
  /** "html" or "text", as Front returns it. */
  bodyType: string;
  direction: "inbound" | "outbound";
  authorName: string | null;
  authorEmail: string | null;
  createdAt: string | null;
}

/** The draft sitting in the composer. */
export interface FrontDraftView {
  id: string;
  body: string;
  bodyType: string;
}

/** The decision fields, by label, read from the conversation's custom field attributes. */
export function decisionFieldValues(
  attributes: readonly FrontFieldAttribute[],
  decisionFields: readonly { id: string; label: string }[],
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of decisionFields) {
    const hit = attributes.find((a) => a.id === field.id || a.name === field.label);
    values[field.label] = hit ? hit.value : null;
  }
  return values;
}

/** The conversation as the capture sees it. */
export function conversationSnapshot(
  conversation: FrontConversationView,
  messages: readonly FrontMessageView[],
  fields: Record<string, unknown>,
): ConversationSnapshot {
  const thread: ConversationMessage[] = messages.map((m) => ({
    id: m.id,
    body: m.body,
    direction: m.direction,
    authorName: m.authorName,
    authorEmail: m.authorEmail,
    createdAt: m.createdAt,
  }));
  return {
    id: conversation.id,
    subject: conversation.subject,
    channel: conversation.type,
    requesterName: conversation.requesterName,
    requesterEmail: conversation.requesterEmail,
    messages: thread,
    fields,
    url: `https://app.front.com/inbox/${conversation.id}`,
  };
}

/**
 * Watches the conversation for the expert's send. Front gives the plugin no "reply submitted"
 * event to await, so the send is the first outbound message that was not in the conversation
 * when the plugin started watching it.
 */
export interface SendWatcher {
  /** The conversation currently watched. */
  readonly conversationId: string | null;
  /** Remembers what the conversation already contained. */
  watch(conversationId: string, messages: readonly FrontMessageView[]): void;
  /** The message sent since the last call, if any. */
  take(messages: readonly FrontMessageView[]): FrontMessageView | null;
}

export function createSendWatcher(): SendWatcher {
  let seen = new Set<string>();
  let conversationId: string | null = null;
  return {
    get conversationId(): string | null {
      return conversationId;
    },
    watch(id: string, messages: readonly FrontMessageView[]): void {
      conversationId = id;
      seen = new Set(messages.filter((m) => m.direction === "outbound").map((m) => m.id));
    },
    take(messages: readonly FrontMessageView[]): FrontMessageView | null {
      if (conversationId === null) return null;
      for (const message of messages) {
        if (message.direction !== "outbound") continue;
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        return message;
      }
      return null;
    },
  };
}
