import { describe, expect, it } from "vitest";
import {
  conversationSnapshot,
  createSendWatcher,
  decisionFieldValues,
  type FrontConversationView,
  type FrontMessageView,
} from "./front-client";

const conversation: FrontConversationView = {
  id: "cnv_9f2a",
  subject: "Roof leak after storm",
  type: "email",
  requesterName: "Dana",
  requesterEmail: "dana@example.com",
  assigneeName: "Ray",
  assigneeEmail: "ray@carrier.com",
  tags: ["insurance", "ai_drafted"],
  customFieldAttributes: [
    { id: "cf_1", name: "status", value: "covered" },
    { id: "cf_2", name: "reserve", value: 4000 },
  ],
};

const inbound: FrontMessageView = {
  id: "msg_1",
  body: "<p>Water came through the ceiling.</p>",
  bodyType: "html",
  direction: "inbound",
  authorName: "Dana",
  authorEmail: "dana@example.com",
  createdAt: "2026-10-01T10:00:00Z",
};

const outbound: FrontMessageView = {
  id: "msg_2",
  body: "<p>HO-3, no prior claims.</p>",
  bodyType: "html",
  direction: "outbound",
  authorName: "Ray",
  authorEmail: "ray@carrier.com",
  createdAt: "2026-10-01T10:04:00Z",
};

describe("decisionFieldValues", () => {
  it("reads the decision fields by id, and falls back to the label", () => {
    expect(
      decisionFieldValues(conversation.customFieldAttributes, [
        { id: "cf_1", label: "status" },
        { id: "cf_missing", label: "denial_reason" },
      ]),
    ).toEqual({ status: "covered", denial_reason: null });
  });

  it("matches on the label when the id is not known", () => {
    expect(decisionFieldValues(conversation.customFieldAttributes, [{ id: "x", label: "reserve" }])).toEqual({
      reserve: 4000,
    });
  });
});

describe("conversationSnapshot", () => {
  it("carries the conversation, the thread and a link back to Front", () => {
    const snapshot = conversationSnapshot(conversation, [inbound, outbound], { status: "covered" });
    expect(snapshot.id).toBe("cnv_9f2a");
    expect(snapshot.channel).toBe("email");
    expect(snapshot.subject).toBe("Roof leak after storm");
    expect(snapshot.requesterEmail).toBe("dana@example.com");
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0]?.direction).toBe("inbound");
    expect(snapshot.fields).toEqual({ status: "covered" });
    expect(snapshot.url).toBe("https://app.front.com/inbox/cnv_9f2a");
  });
});

describe("createSendWatcher", () => {
  it("ignores the replies the conversation already had", () => {
    const watcher = createSendWatcher();
    watcher.watch("cnv_9f2a", [inbound, outbound]);
    expect(watcher.conversationId).toBe("cnv_9f2a");
    expect(watcher.take([inbound, outbound])).toBeNull();
  });

  it("returns the reply that was sent after the plugin started watching", () => {
    const watcher = createSendWatcher();
    watcher.watch("cnv_9f2a", [inbound, outbound]);
    const sent: FrontMessageView = { ...outbound, id: "msg_3", body: "<p>Adjusting today.</p>" };
    expect(watcher.take([inbound, outbound, sent])).toEqual(sent);
    // The same reply is not reported twice.
    expect(watcher.take([inbound, outbound, sent])).toBeNull();
  });

  it("returns nothing before it watches a conversation", () => {
    const watcher = createSendWatcher();
    expect(watcher.conversationId).toBeNull();
    expect(watcher.take([outbound])).toBeNull();
  });
});
