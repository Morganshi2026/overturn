import type { CaptureCreate } from "@overturn-ai/shared";
import {
  type AppSettings,
  type ConversationPart,
  type ConversationSnapshot,
  type DraftState,
  decideOnSend,
  inScope,
  quickReasons,
  statusLine,
} from "./capture";

/** The teammate using the app. */
export interface CanvasAuthor {
  id?: string;
  name?: string | null;
  email?: string | null;
}

/** The contact on the other side of the conversation. */
export interface CanvasContact {
  id?: string;
  name?: string | null;
  email?: string | null;
}

/** One message in the conversation, as the Canvas Kit carries it. */
export interface CanvasPart {
  id?: string;
  body?: string | null;
  delivered_as?: string | null;
  created_at?: number | null;
  author?: CanvasAuthor | null;
}

/** The conversation, as the Canvas Kit initialize request carries it. */
export interface CanvasConversation {
  id: string;
  title?: string | null;
  source?: { body?: string | null; delivered_as?: string | null; author?: CanvasAuthor | null } | null;
  contacts?: { contacts?: CanvasContact[] } | null;
  tags?: { tags?: Array<{ id?: string; name?: string }> } | null;
  parts?: { parts?: CanvasPart[] } | null;
  custom_attributes?: Record<string, unknown> | null;
}

/** The initialize request Intercom POSTs to the app. */
export interface InitializeRequest {
  workspace_id?: string;
  workspace_region?: string | null;
  admin?: CanvasAuthor | null;
  conversation?: CanvasConversation | null;
  contact?: CanvasContact | null;
}

/** The submit request Intercom POSTs when a component with a submit action is used. */
export interface SubmitRequest extends InitializeRequest {
  current_canvas?: { content?: { components?: CanvasComponent[] } } | null;
  component_id?: string | null;
  input_values?: Record<string, unknown> | null;
}

/** One component of the canvas Intercom renders. */
export interface CanvasComponent {
  type: string;
  id?: string;
  text?: string;
  align?: "left" | "center" | "right";
  style?: "header" | "paragraph" | "muted" | "error";
  bottom_margin?: "none";
  action?: { type: "submit" };
}

/** The canvas Intercom renders, plus the data kept with the card. */
export interface CanvasResponse {
  canvas: { content: { components: CanvasComponent[] } };
  stored_data?: Record<string, unknown>;
}

/** What the app knows between requests. */
export interface AppState {
  /** The draft an assist recorded for this conversation, if any. */
  draft: DraftState | null;
  /** The reason code the teammate picked, if any. */
  reasonCode: string | null;
  /** The optional note. */
  reason: string;
  /** What the last capture made of the reply, for the status line. */
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null;
}

export const EMPTY_STATE: AppState = {
  draft: null,
  reasonCode: null,
  reason: "",
  lastResult: null,
};

/** The conversation as the capture sees it. */
export function conversationFrom(canvas: CanvasConversation): ConversationSnapshot {
  const parts: ConversationPart[] = (canvas.parts?.parts ?? []).map((p) => ({
    id: p.id,
    body: p.body ?? "",
    deliveredAs: p.delivered_as ?? "",
    authorName: p.author?.name ?? null,
    authorEmail: p.author?.email ?? null,
    createdAt: p.created_at ?? null,
  }));
  if (canvas.source?.body && parts.length === 0) {
    parts.push({
      id: undefined,
      body: canvas.source.body,
      deliveredAs: canvas.source.delivered_as ?? "",
      authorName: canvas.source.author?.name ?? null,
      authorEmail: canvas.source.author?.email ?? null,
      createdAt: null,
    });
  }
  const contact = canvas.contacts?.contacts?.[0] ?? null;
  const attributes = canvas.custom_attributes ?? {};
  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(attributes)) fields[name] = value;
  return {
    id: canvas.id,
    title: canvas.title ?? null,
    tags: (canvas.tags?.tags ?? []).map((t) => t.name).filter((n): n is string => Boolean(n)),
    parts,
    contactName: contact?.name ?? null,
    contactEmail: contact?.email ?? null,
    fields,
    url: `https://app.intercom.com/a/inbox/${canvas.id}`,
  };
}

/**
 * The teammate's reply to the draft: the newest message a teammate sent that was written after
 * the draft was recorded. Anything older is history, not the reply to this draft.
 */
export function replyToDraft(conversation: ConversationSnapshot, draft: DraftState): ConversationPart | null {
  const replies = conversation.parts.filter((p) => p.deliveredAs === "admin_initiated");
  const latest = replies[replies.length - 1];
  if (!latest) return null;
  if (latest.createdAt !== null && latest.createdAt !== undefined && latest.createdAt < draft.at) {
    return null;
  }
  return latest;
}

export type InitializePlan =
  | { action: "none"; why: "no-conversation" | "out-of-scope" | "no-draft" | "no-reply" | "empty" }
  | { action: "need-reason"; changedFields: string[]; body: CaptureCreate }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] };

/** What the app should do with an initialize request. Pure. */
export function planInitialize(input: {
  request: InitializeRequest;
  state: AppState;
  settings: AppSettings;
  now?: number;
}): InitializePlan {
  const canvas = input.request.conversation;
  if (!canvas) return { action: "none", why: "no-conversation" };
  const conversation = conversationFrom(canvas);
  if (!inScope(conversation.tags, input.settings)) return { action: "none", why: "out-of-scope" };
  const draft = input.state.draft;
  if (!draft) return { action: "none", why: "no-draft" };
  const reply = replyToDraft(conversation, draft);
  if (!reply) return { action: "none", why: "no-reply" };
  const decision = decideOnSend({
    conversation,
    draft,
    draftFields: conversation.fields,
    sent: { text: reply.body, fields: conversation.fields },
    reasonCode: input.state.reasonCode,
    reason: input.state.reason,
    actor: input.request.admin?.email ?? null,
    settings: input.settings,
    now: input.now,
  });
  if (decision.action === "skip") {
    return { action: "none", why: decision.why === "no-send" ? "no-reply" : decision.why };
  }
  if (decision.action === "need-reason") {
    return { action: "need-reason", changedFields: decision.changedFields, body: decision.body };
  }
  return {
    action: "capture",
    body: decision.body,
    changed: decision.changed,
    changedFields: decision.changedFields,
  };
}

/** The panel the app renders: the status, and the reason chips. */
export function buildCanvas(state: AppState, settings: AppSettings): CanvasResponse {
  const components: CanvasComponent[] = [
    { type: "text", style: "header", text: statusLine(state.draft, state.lastResult) },
  ];
  if (!state.draft) {
    components.push({
      type: "text",
      style: "muted",
      text: "Waiting for a draft in this conversation.",
    });
    return { canvas: { content: { components } } };
  }
  components.push({ type: "text", style: "paragraph", text: "Why did you change it?" });
  for (const option of quickReasons(settings)) {
    components.push({
      type: "text",
      id: `reason:${option.code}`,
      text: option.label,
      action: { type: "submit" },
    });
  }
  components.push({
    type: "text",
    style: "muted",
    text: "Pick one to save the correction. A note is optional.",
  });
  return { canvas: { content: { components } } };
}

/** The reason code a submit request picked, if the component was one of the chips. */
export function reasonFromSubmit(request: SubmitRequest): string | null {
  const id = request.component_id ?? "";
  if (!id.startsWith("reason:")) return null;
  return id.slice("reason:".length) || null;
}

/** The optional note the teammate typed, if the platform gave us an input for it. */
export function noteFromSubmit(request: SubmitRequest): string {
  const values = request.input_values ?? {};
  const note = values.note;
  return typeof note === "string" ? note : "";
}
