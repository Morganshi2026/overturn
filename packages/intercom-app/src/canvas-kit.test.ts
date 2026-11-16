import { describe, expect, it } from "vitest";
import {
  buildCanvas,
  type CanvasConversation,
  conversationFrom,
  EMPTY_STATE,
  noteFromSubmit,
  planInitialize,
  reasonFromSubmit,
  replyToDraft,
} from "./canvas-kit";
import { DEFAULT_SETTINGS, type DraftState } from "./capture";

const canvasConversation: CanvasConversation = {
  id: "conv_9f2a",
  title: "Roof leak after storm",
  tags: { tags: [{ id: "t1", name: "insurance" }] },
  contacts: { contacts: [{ id: "c1", name: "Dana", email: "dana@example.com" }] },
  parts: {
    parts: [
      {
        id: "part_1",
        body: "<p>Water came through the ceiling.</p>",
        delivered_as: "customer_initiated",
        created_at: 1_767_225_600,
        author: { id: "c1", name: "Dana", email: "dana@example.com" },
      },
      {
        id: "part_2",
        body: "<p>HO-3, no prior claims.</p>",
        delivered_as: "admin_initiated",
        created_at: 1_767_225_700,
        author: { id: "a1", name: "Ray", email: "ray@carrier.com" },
      },
    ],
  },
};

const draft: DraftState = {
  text: "We cover the roof under HO-3. An adjuster will call within 5 business days.",
  origin: "ai",
  runId: "0199a0d0-0000-7000-8000-000000000000",
  model: null,
  at: 1_767_225_650,
};

describe("conversationFrom", () => {
  it("reads the thread, the contact, the tags and the link back to Intercom", () => {
    const conversation = conversationFrom(canvasConversation);
    expect(conversation.id).toBe("conv_9f2a");
    expect(conversation.title).toBe("Roof leak after storm");
    expect(conversation.tags).toEqual(["insurance"]);
    expect(conversation.contactEmail).toBe("dana@example.com");
    expect(conversation.parts).toHaveLength(2);
    expect(conversation.parts[0]?.deliveredAs).toBe("customer_initiated");
    expect(conversation.url).toBe("https://app.intercom.com/a/inbox/conv_9f2a");
  });

  it("falls back to the conversation source when there are no parts", () => {
    const conversation = conversationFrom({
      id: "conv_1",
      source: { body: "<p>Hello</p>", delivered_as: "customer_initiated" },
    });
    expect(conversation.parts).toHaveLength(1);
    expect(conversation.parts[0]?.body).toBe("<p>Hello</p>");
  });
});

describe("replyToDraft", () => {
  it("is the newest message a teammate sent", () => {
    const conversation = conversationFrom(canvasConversation);
    expect(replyToDraft(conversation, draft)?.id).toBe("part_2");
  });

  it("is nothing when the newest teammate message predates the draft", () => {
    const conversation = conversationFrom(canvasConversation);
    const later = { ...draft, at: 1_767_225_800 };
    expect(replyToDraft(conversation, later)).toBeNull();
  });

  it("is nothing when the teammate has not written yet", () => {
    const conversation = conversationFrom({
      id: "conv_2",
      parts: {
        parts: [{ id: "p1", body: "<p>Hi</p>", delivered_as: "customer_initiated", created_at: 1 }],
      },
    });
    expect(replyToDraft(conversation, draft)).toBeNull();
  });
});

describe("planInitialize", () => {
  const request = { conversation: canvasConversation, admin: { id: "a1", email: "ray@carrier.com" } };

  it("does nothing without a conversation, a draft or a reply", () => {
    expect(planInitialize({ request: {}, state: EMPTY_STATE, settings: DEFAULT_SETTINGS })).toEqual({
      action: "none",
      why: "no-conversation",
    });
    expect(planInitialize({ request, state: EMPTY_STATE, settings: DEFAULT_SETTINGS })).toEqual({
      action: "none",
      why: "no-draft",
    });
    const noReply = {
      ...request,
      conversation: { ...canvasConversation, parts: { parts: [] } },
    };
    expect(
      planInitialize({ request: noReply, state: { ...EMPTY_STATE, draft }, settings: DEFAULT_SETTINGS }),
    ).toEqual({ action: "none", why: "no-reply" });
  });

  it("skips a conversation outside the scope tag", () => {
    const scoped = { ...DEFAULT_SETTINGS, scopeTag: "ai_drafted" };
    expect(planInitialize({ request, state: { ...EMPTY_STATE, draft }, settings: scoped })).toEqual({
      action: "none",
      why: "out-of-scope",
    });
  });

  it("captures when the teammate sent the draft unchanged", () => {
    const sent = {
      ...canvasConversation,
      parts: {
        parts: [
          ...(canvasConversation.parts?.parts ?? []),
          {
            id: "part_3",
            body: draft.text,
            delivered_as: "admin_initiated",
            created_at: 1_767_225_700,
          },
        ],
      },
    };
    const plan = planInitialize({
      request: { ...request, conversation: sent },
      state: { ...EMPTY_STATE, draft },
      settings: { ...DEFAULT_SETTINGS, requireReason: false },
    });
    expect(plan.action).toBe("capture");
    if (plan.action !== "capture") return;
    expect(plan.changed).toBe(false);
    expect(plan.body.externalId).toBe("ic:conv_9f2a");
    expect(plan.body.source).toBe("intercom");
    expect(plan.body.actor).toBe("ray@carrier.com");
  });

  it("holds a changed reply until there is a reason", () => {
    const sent = {
      ...canvasConversation,
      parts: {
        parts: [
          ...(canvasConversation.parts?.parts ?? []),
          {
            id: "part_3",
            body: "We do not cover the roof. An adjuster will call within 2 business days.",
            delivered_as: "admin_initiated",
            created_at: 1_767_225_700,
          },
        ],
      },
    };
    const plan = planInitialize({
      request: { ...request, conversation: sent },
      state: { ...EMPTY_STATE, draft },
      settings: DEFAULT_SETTINGS,
    });
    expect(plan.action).toBe("need-reason");
  });
});

describe("buildCanvas", () => {
  it("shows the status and the reason chips when there is a draft", () => {
    const canvas = buildCanvas({ ...EMPTY_STATE, draft }, DEFAULT_SETTINGS);
    const components = canvas.canvas.content.components;
    expect(components[0]?.text).toBe("Draft inserted · 14 words");
    const chips = components.filter((c) => c.id?.startsWith("reason:"));
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0]?.action?.type).toBe("submit");
  });

  it("waits for a draft when there is none", () => {
    const canvas = buildCanvas(EMPTY_STATE, DEFAULT_SETTINGS);
    expect(canvas.canvas.content.components[0]?.text).toBe("Waiting for a draft");
    expect(canvas.canvas.content.components.length).toBe(2);
  });
});

describe("the submit flow", () => {
  it("reads the reason the teammate picked and the optional note", () => {
    expect(reasonFromSubmit({ component_id: "reason:wrong_answer" })).toBe("wrong_answer");
    expect(reasonFromSubmit({ component_id: "other" })).toBeNull();
    expect(noteFromSubmit({ input_values: { note: "the SLA is 2 days" } })).toBe("the SLA is 2 days");
    expect(noteFromSubmit({})).toBe("");
  });
});
