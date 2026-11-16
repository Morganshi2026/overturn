import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** One message in the conversation, as Intercom returns it in the conversation's parts. */
export interface ConversationPart {
  id?: string;
  /** The body as Intercom returns it: HTML. */
  body: string;
  /** "customer_initiated" (the customer wrote in) or "admin_initiated" (a teammate wrote out). */
  deliveredAs: string;
  authorName?: string | null;
  authorEmail?: string | null;
  /** Unix seconds, as every Intercom timestamp is. */
  createdAt?: number | null;
}

/** What the app knows about the conversation, read through the Canvas Kit. */
export interface ConversationSnapshot {
  id: string;
  title: string | null;
  /** The conversation's tags, by name. */
  tags: string[];
  /** The thread, oldest first. */
  parts: ConversationPart[];
  contactName: string | null;
  contactEmail: string | null;
  /** The conversation's custom attributes that are the decision, by label. */
  fields: Record<string, unknown>;
  /** Link back to the conversation in Intercom. */
  url: string | null;
}

/**
 * Where the draft came from.
 *
 * Intercom's Fin drafts and a human-written reply have to be told apart: `draft:ai` is tagged
 * only when the draft came from an assist, `draft:manual` when the teammate wrote it, and an
 * origin nobody told us stays untagged, which the scorecard reads as unknown. Guessing an
 * origin is worse than unknown.
 */
export type DraftOrigin = "ai" | "manual" | "unknown";

/** The draft tag a capture carries for an origin, or none when the origin is unknown. */
export function draftTag(origin: DraftOrigin): string[] {
  if (origin === "unknown") return [];
  return [`draft:${origin}`];
}

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  /** The drafting agent's own run, when the draft came from one. */
  runId?: string;
  model?: string | null;
  /** When the draft was recorded, in Unix seconds. */
  at: number;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Hold a changed reply until a reason code is picked. */
  requireReason: boolean;
  /** `reserve:reserve, coverage:coverage` → decision fields by label. */
  decisionFields: Array<{ id: string; label: string }>;
  /** When set, only conversations carrying this tag are watched. */
  scopeTag: string | null;
  /** Which quick-pick reasons the teammate sees: the claims pack or the support pack. */
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  decisionFields: [],
  scopeTag: null,
  reasonPack: "support",
};

/** Parses the app's settings. */
export function settingsFrom(raw: Record<string, unknown>): AppSettings {
  const str = (k: string): string | null => {
    const v = raw[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const bool = (k: string, d: boolean): boolean => {
    const v = raw[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v === "true" || v === "1";
    return d;
  };
  const fields = (str("decision_fields") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id!, label: label || id! };
    });
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    decisionFields: fields,
    scopeTag: str("scope_tag"),
    reasonPack: reasonPackFrom(str("reason_pack")),
  };
}

/** Whether the app should watch this conversation at all. */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

/** The thread the teammate saw, oldest first, as capture context. */
export function contextFrom(conversation: ConversationSnapshot): CaptureMessage[] {
  return conversation.parts
    .filter((p) => p.body?.trim())
    .map((p) => ({
      role: p.deliveredAs === "admin_initiated" ? ("agent" as const) : ("customer" as const),
      author: p.authorEmail ?? p.authorName ?? null,
      content: stripHtml(p.body),
      at: p.createdAt ? new Date(p.createdAt * 1000).toISOString() : null,
    }));
}

/** Intercom hands message bodies back as HTML; the case wants the text the human read. */
export function stripHtml(html: string): string {
  return normalizeCaptureText(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

export interface PendingSend {
  /** The body of the message that was sent. */
  text: string;
  /** The decision fields as they were when it was sent. */
  fields: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "no-send" | "empty" }
  | { action: "need-reason"; changedFields: string[]; body: CaptureCreate }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] };

/** What to do when the teammate sends. Pure: the Canvas Kit glue only forwards the answer. */
export function decideOnSend(input: {
  conversation: ConversationSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  sent: PendingSend | null;
  /** The picked reason code, required for a changed send when requireReason is on. */
  reasonCode: string | null;
  /** Optional free-text note. */
  reason: string;
  actor: string | null;
  settings: AppSettings;
  /** When the reply was sent; with the draft's `at`, gives how long it sat in front of the expert. */
  now?: number;
}): SendDecision {
  const { conversation, draft, sent, settings } = input;
  if (!draft) return { action: "skip", why: "no-draft" };
  if (!sent) return { action: "skip", why: "no-send" };
  const sentText = stripHtml(sent.text);
  if (!sentText.trim()) return { action: "skip", why: "empty" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: input.draftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = {
    text: sentText,
    ...(hasFields ? { fields: sent.fields } : {}),
  };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;

  const body: CaptureCreate = {
    source: "intercom",
    externalId: `ic:${conversation.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: conversation.title,
    context: contextFrom(conversation),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    // Both times are Unix seconds, like every timestamp Intercom returns.
    secondsToSend: Math.max(0, Math.round((input.now ?? draft.at) - draft.at)),
    // The run and the model only travel with a draft we know an assist wrote: the API turns a
    // named model into "draft:ai" itself, and an unknown origin has to stay unknown.
    draftRunId: draft.origin === "ai" ? (draft.runId ?? null) : null,
    draftModel: draft.origin === "ai" ? (draft.model ?? null) : null,
    url: conversation.url,
    tags: draftTag(draft.origin),
    metadata: { requester: conversation.contactEmail ?? conversation.contactName ?? null },
  };

  // A changed reply without a reason is held, not dropped: the panel asks for the reason and
  // the capture goes out as soon as it is known.
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields, body };
  }
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** Attaches a reason to a capture that was held for one. */
export function withReason(body: CaptureCreate, reasonCode: string, reason: string): CaptureCreate {
  return { ...body, reasonCode: reasonCode.trim() || null, reason: reason.trim() || null };
}

/** Short status line for the panel. */
export function statusLine(
  d: DraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const words = d.text.trim().split(/\s+/).length;
  const from = {
    ai: "inserted",
    manual: "written by you",
    unknown: "found in the conversation",
  }[d.origin];
  return `Draft ${from} · ${words} words`;
}

/** The chips the teammate clicks, for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
