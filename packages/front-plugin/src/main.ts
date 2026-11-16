import Front, { type ApplicationMessage, type ApplicationSingleConversation } from "@frontapp/plugin-sdk";
import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  inScope,
  quickReasons,
  settingsFrom,
  statusLine,
  withReason,
} from "./capture";
import {
  conversationSnapshot,
  createSendWatcher,
  decisionFieldValues,
  type FrontConversationView,
  type FrontDraftView,
  type FrontMessageView,
} from "./front-client";

/** The Front SDK this plugin runs against. */
type FrontSdk = typeof Front;
/** The context Front pushes into the plugin view. */
type FrontContext = Parameters<NonNullable<Parameters<FrontSdk["contextUpdates"]["subscribe"]>[0]>>[0];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

/** The app's settings, as the AppSDK passed them to the plugin's entry point. */
function entryPointSettings(context: FrontContext): Record<string, unknown> {
  const entryPoint = context.entryPoint;
  if (!entryPoint || !("data" in entryPoint)) return {};
  const data = entryPoint.data;
  if (!data || !("customContextProperties" in data)) return {};
  return data.customContextProperties;
}

/** The conversation the expert is looking at, when there is one. */
function conversationOf(context: FrontContext): ApplicationSingleConversation | null {
  if (context.type === "messageComposer") return context.conversation ?? null;
  if (context.type === "singleConversation") return context.conversation;
  return null;
}

/** The draft sitting in the composer, when the plugin can see it. */
async function currentDraft(context: FrontContext): Promise<FrontDraftView | null> {
  if (context.type === "messageComposer") {
    return {
      id: context.draft.id,
      body: context.draft.content.body,
      bodyType: context.draft.content.type,
    };
  }
  if (context.type === "singleConversation" && context.conversation.draftId) {
    const draft = await context.fetchDraft(context.conversation.draftId);
    if (!draft) return null;
    return { id: draft.id, body: draft.content.body, bodyType: draft.content.type };
  }
  return null;
}

function conversationView(conversation: ApplicationSingleConversation): FrontConversationView {
  const recipient = conversation.recipient;
  const contact = recipient?.contact;
  const assignee = conversation.assignee;
  return {
    id: conversation.id,
    subject: conversation.subject ?? null,
    type: conversation.type,
    requesterName: recipient?.name ?? contact?.name ?? null,
    requesterEmail: recipient?.type === "email" ? recipient.handle : null,
    assigneeName: assignee?.name ?? null,
    assigneeEmail: assignee?.email ?? null,
    tags: conversation.tags.map((t) => t.name),
    customFieldAttributes: conversation.customFieldAttributes.map((a) => ({
      id: a.id,
      name: a.name,
      value: a.value instanceof Date ? a.value.toISOString() : a.value,
    })),
  };
}

function messageView(message: ApplicationMessage): FrontMessageView {
  const from = message.from;
  return {
    id: message.id,
    body: message.content?.body ?? "",
    bodyType: message.content?.type ?? "text",
    direction: message.status === "outbound" ? "outbound" : "inbound",
    authorName: from?.name ?? null,
    authorEmail: from?.type === "email" ? from.handle : null,
    createdAt: message.date ? message.date.toISOString() : null,
  };
}

async function listMessages(context: FrontContext): Promise<FrontMessageView[]> {
  if (context.type !== "messageComposer" && context.type !== "singleConversation") return [];
  const page = await context.listMessages();
  return page.results.map(messageView);
}

function main(): void {
  const root = document.getElementById("app");
  if (!root) return;

  const status = el("div", { class: "status" }, "Waiting for a draft");
  const quick = el("div", {
    class: "quick",
    role: "radiogroup",
    "aria-label": "Why did you change it?",
  });
  const reason = el("textarea", {
    class: "reason",
    rows: "2",
    placeholder: "Anything else? Optional.",
  }) as HTMLTextAreaElement;
  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const note = el("div", { class: "note" }, "");
  root.append(status, quick, reason, mark, note);

  const chips: HTMLButtonElement[] = [];
  let settings: AppSettings = DEFAULT_SETTINGS;
  let detector = createDraftDetector({ minDraftChars: settings.minDraftChars });
  let reasonCode: string | null = null;
  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  let held: { body: CaptureCreate; changedFields: string[] } | null = null;
  let draftFields: Record<string, unknown> = {};
  let apiKey: string | null = null;
  const watcher = createSendWatcher();

  const render = (): void => {
    status.textContent = statusLine(detector.current(), lastResult);
  };

  const buildChips = (): void => {
    quick.replaceChildren();
    chips.length = 0;
    for (const option of quickReasons(settings)) {
      const chip = el(
        "button",
        { type: "button", class: "chip", "data-code": option.code },
        option.label,
      ) as HTMLButtonElement;
      chip.addEventListener("click", () => {
        reasonCode = reasonCode === option.code ? null : option.code;
        for (const c of chips) c.classList.toggle("on", c.dataset.code === reasonCode);
        void releaseHeld();
      });
      chips.push(chip);
      quick.appendChild(chip);
    }
  };

  const post = async (body: CaptureCreate): Promise<void> => {
    try {
      const response = await fetch(`${settings.baseUrl}/v1/capture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey ?? ""}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = (await response.json()) as CaptureResult;
      lastResult = { kind: result.kind, changed: result.changed, dedup: result.deduplicated };
      note.textContent = result.changed && result.case ? `Case: ${result.case.title}` : "";
    } catch (error) {
      // Overturn failing never blocks the expert's work; say so and get out of the way.
      note.textContent = `Overturn could not save this correction (${
        (error as { message?: string }).message ?? "network"
      }).`;
    }
  };

  const releaseHeld = async (): Promise<void> => {
    if (!held || !reasonCode) return;
    const body = withReason(held.body, reasonCode, reason.value);
    held = null;
    await post(body);
    reason.value = "";
    reasonCode = null;
    for (const c of chips) c.classList.remove("on");
    render();
  };

  const handleSend = async (
    conversation: FrontConversationView,
    messages: FrontMessageView[],
    sent: FrontMessageView,
  ): Promise<void> => {
    const draft = detector.current();
    if (!draft) return;
    const decision = decideOnSend({
      conversation: conversationSnapshot(conversation, messages, draftFields),
      draft,
      draftFields,
      sent: {
        text: sent.body,
        fields: decisionFieldValues(conversation.customFieldAttributes, settings.decisionFields),
      },
      reasonCode,
      reason: reason.value,
      actor: conversation.assigneeEmail,
      settings,
      now: Date.now(),
    });
    if (decision.action === "skip") return;
    if (decision.action === "need-reason") {
      // The reply already went out; the capture is held until the reason is known.
      held = { body: decision.body, changedFields: decision.changedFields };
      note.textContent = "Pick why you changed the reply to save this correction.";
      chips[0]?.focus();
      return;
    }
    held = null;
    await post(decision.body);
    reason.value = "";
    reasonCode = null;
    for (const c of chips) c.classList.remove("on");
    detector.set(null);
    draftFields = {};
    render();
  };

  const onContext = async (context: FrontContext): Promise<void> => {
    const props = entryPointSettings(context);
    const next = settingsFrom(props);
    const key = props.overturn_api_key;
    apiKey = typeof key === "string" && key.trim() ? key.trim() : null;
    if (next.reasonPack !== settings.reasonPack) {
      settings = next;
      buildChips();
    } else {
      settings = next;
    }
    if (next.minDraftChars !== DEFAULT_SETTINGS.minDraftChars) {
      const current = detector.current();
      detector = createDraftDetector({ minDraftChars: next.minDraftChars });
      detector.set(current);
    }

    const raw = conversationOf(context);
    if (!raw) return;
    const conversation = conversationView(raw);
    if (!inScope(conversation.tags, settings)) {
      status.textContent = `Not watching: no "${settings.scopeTag}" tag`;
      return;
    }

    const draft = await currentDraft(context);
    if (draft) {
      const found = detector.onComposer(draft.body);
      if (found) {
        draftFields = decisionFieldValues(conversation.customFieldAttributes, settings.decisionFields);
        render();
      }
    }

    const messages = await listMessages(context);
    if (watcher.conversationId !== conversation.id) {
      watcher.watch(conversation.id, messages);
      return;
    }
    const sent = watcher.take(messages);
    if (!sent) return;
    await handleSend(conversation, messages, sent);
  };

  mark.addEventListener("click", async () => {
    const context = await lastContext;
    const draft = await currentDraft(context);
    if (!draft?.body.trim()) return;
    detector.set({ text: draft.body, origin: "manual", at: Date.now() });
    lastResult = null;
    render();
  });

  buildChips();
  render();

  let lastContext: Promise<FrontContext> = new Promise(() => {});
  Front.contextUpdates.subscribe((context) => {
    lastContext = Promise.resolve(context);
    void onContext(context);
  });
}

main();
