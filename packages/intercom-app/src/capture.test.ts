import { describe, expect, it } from "vitest";
import {
  type ConversationSnapshot,
  contextFrom,
  DEFAULT_SETTINGS,
  type DraftState,
  decideOnSend,
  draftTag,
  inScope,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";

const draftText =
  "<p>Hi Dana,</p><p>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

const conversation: ConversationSnapshot = {
  id: "conv_9f2a",
  title: "Roof leak after storm",
  tags: ["insurance"],
  parts: [
    {
      id: "part_1",
      body: "<div>Water came through the ceiling.<br>Photos attached.</div>",
      deliveredAs: "customer_initiated",
      authorEmail: "dana@example.com",
      authorName: "Dana",
      createdAt: 1_767_225_600,
    },
    {
      id: "part_2",
      body: "<p>HO-3, no prior claims.</p>",
      deliveredAs: "admin_initiated",
      authorName: "Ray",
      authorEmail: "ray@carrier.com",
      createdAt: 1_767_226_000,
    },
  ],
  contactName: "Dana",
  contactEmail: "dana@example.com",
  fields: {},
  url: "https://app.intercom.com/a/inbox/conv_9f2a",
};

const assistDraft: DraftState = {
  text: draftText,
  origin: "ai",
  runId: "0199a0d0-0000-7000-8000-000000000000",
  model: "gpt-4.1-mini",
  at: 1_767_225_900,
};

describe("settings", () => {
  it("parses the app's settings", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      agent: "claims-reply",
      require_reason: "true",
      decision_fields: "coverage:coverage, reserve:reserve",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.agent).toBe("claims-reply");
    expect(s.requireReason).toBe(true);
    expect(s.decisionFields).toEqual([
      { id: "coverage", label: "coverage" },
      { id: "reserve", label: "reserve" },
    ]);
  });

  it("a scope tag limits which conversations are watched at all", () => {
    expect(inScope(["billing"], DEFAULT_SETTINGS)).toBe(true);
    const scoped = settingsFrom({ scope_tag: "ai_drafted" });
    expect(inScope(["billing"], scoped)).toBe(false);
    expect(inScope(["billing", "ai_drafted"], scoped)).toBe(true);
  });

  it("reason_pack picks the chips: support by default, claims when a claims team opts in", () => {
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("wrong_answer");
    expect(quickReasons(settingsFrom({ reason_pack: "claims" })).map((r) => r.code)).toContain(
      "wrong_coverage_decision",
    );
    expect(settingsFrom({ reason_pack: "garbage" }).reasonPack).toBe("support");
  });

  it("falls back to defaults, with require_reason on", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(settingsFrom({ require_reason: "false" }).requireReason).toBe(false);
  });
});

describe("the draft origin", () => {
  it("tags an assist draft as ai and a teammate's own draft as manual", () => {
    expect(draftTag("ai")).toEqual(["draft:ai"]);
    expect(draftTag("manual")).toEqual(["draft:manual"]);
  });

  it("leaves an origin we were not told untagged, which the scorecard reads as unknown", () => {
    expect(draftTag("unknown")).toEqual([]);
  });
});

describe("context and html", () => {
  it("strips html and maps the direction to a role", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
    expect(contextFrom(conversation)).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Water came through the ceiling.\nPhotos attached.",
        at: "2026-01-01T00:00:00.000Z",
      },
      {
        role: "agent",
        author: "ray@carrier.com",
        content: "HO-3, no prior claims.",
        at: "2026-01-01T00:06:40.000Z",
      },
    ]);
  });
});

describe("decideOnSend", () => {
  const base = {
    conversation,
    draft: assistDraft,
    draftFields: {},
    reasonCode: null as string | null,
    reason: "",
    actor: "ray@carrier.com",
    settings: { ...DEFAULT_SETTINGS, requireReason: false },
  };

  it("skips without a draft, without a send, and on an empty send", () => {
    expect(decideOnSend({ ...base, draft: null, sent: { text: "x", fields: {} } })).toEqual({
      action: "skip",
      why: "no-draft",
    });
    expect(decideOnSend({ ...base, sent: null })).toEqual({ action: "skip", why: "no-send" });
    expect(decideOnSend({ ...base, sent: { text: "<p></p>", fields: {} } })).toEqual({
      action: "skip",
      why: "empty",
    });
  });

  it("sending the draft unchanged is an approve capture", () => {
    const d = decideOnSend({ ...base, sent: { text: draftText, fields: {} } });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("intercom");
    expect(d.body.externalId).toBe("ic:conv_9f2a");
    expect(d.body.agent).toBe("support-reply");
    expect(d.body.draft.text).toBe(d.body.sent.text);
    expect(d.body.tags).toEqual(["draft:ai"]);
    expect(d.body.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
    expect(d.body.draftModel).toBe("gpt-4.1-mini");
    expect(d.body.context).toHaveLength(2);
    expect(typeof d.body.secondsToSend).toBe("number");
  });

  it("a changed reply is an edit capture carrying the reason", () => {
    const sent = draftText.replace("5 business days", "2 business days");
    const d = decideOnSend({
      ...base,
      reasonCode: "wrong_amount_or_date",
      reason: "Storm SLA is 2 days",
      sent: { text: sent, fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.body.reason).toBe("Storm SLA is 2 days");
    expect(d.body.reasonCode).toBe("wrong_amount_or_date");
    expect(d.body.sent.text).toContain("2 business days");
  });

  it("require_reason (the default) holds a changed send until a reason code is picked", () => {
    expect(DEFAULT_SETTINGS.requireReason).toBe(true);
    const sent = draftText.replace("covered", "not covered");
    const held = decideOnSend({
      ...base,
      settings: DEFAULT_SETTINGS,
      sent: { text: sent, fields: {} },
    });
    expect(held.action).toBe("need-reason");
    if (held.action !== "need-reason") return;
    // The capture is held, not dropped: it goes out once the reason is known.
    expect(held.body.externalId).toBe("ic:conv_9f2a");
    expect(held.body.reasonCode).toBeNull();

    const ok = decideOnSend({
      ...base,
      settings: DEFAULT_SETTINGS,
      reasonCode: "missed_exclusion",
      sent: { text: sent, fields: {} },
    });
    expect(ok.action).toBe("capture");
    if (ok.action === "capture") expect(ok.body.reasonCode).toBe("missed_exclusion");
  });

  it("an unknown origin is not tagged and travels without a run or a model", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "unknown", at: 1_767_225_900 },
      sent: { text: draftText, fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.body.tags).toEqual([]);
    expect(d.body.draftRunId).toBeNull();
    expect(d.body.draftModel).toBeNull();
  });

  it("a manual draft is tagged manual and travels without a run or a model", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "manual", at: 1_767_225_900 },
      sent: { text: draftText, fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.body.tags).toEqual(["draft:manual"]);
    expect(d.body.draftRunId).toBeNull();
  });

  it("decision fields ride along and a changed field is a change", () => {
    const settings = { ...DEFAULT_SETTINGS, decisionFields: [{ id: "coverage", label: "coverage" }] };
    const d = decideOnSend({
      ...base,
      settings,
      reasonCode: "wrong_coverage_decision",
      draftFields: { coverage: "covered" },
      sent: { text: draftText, fields: { coverage: "denied" } },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["coverage"]);
    expect(d.body.draft.fields).toEqual({ coverage: "covered" });
    expect(d.body.sent.fields).toEqual({ coverage: "denied" });
  });

  it("records how long the draft sat in front of the teammate", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "ai", at: 1_767_225_900 },
      now: 1_767_225_940,
      sent: { text: draftText, fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.secondsToSend).toBe(40);
  });
});

describe("statusLine", () => {
  it("describes the state", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "one two three", origin: "ai", at: 1 }, null)).toBe("Draft inserted · 3 words");
    expect(statusLine({ text: "one two three", origin: "manual", at: 1 }, null)).toBe(
      "Draft written by you · 3 words",
    );
    expect(statusLine(null, { kind: "approve", changed: false, dedup: false })).toBe(
      "Sent as drafted · approved",
    );
    expect(statusLine(null, { kind: "edit", changed: true, dedup: true })).toBe(
      "Captured · already in the suite",
    );
  });
});
