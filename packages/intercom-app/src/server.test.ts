import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import type { DraftState } from "./capture";
import type { OverturnClient } from "./overturn-client";
import { handleInitialize, handleSubmit } from "./server";

const draftText = "We cover the roof under HO-3. An adjuster will call within 5 business days.";

const draft: DraftState = {
  text: draftText,
  origin: "ai",
  runId: "0199a0d0-0000-7000-8000-000000000000",
  model: null,
  at: 1_767_225_650,
};

/** A conversation the teammate answered with the draft, unchanged. */
const approveReply = {
  id: "conv_1",
  title: "Roof leak",
  tags: { tags: [] },
  parts: {
    parts: [
      {
        id: "part_1",
        body: "<p>Water came through the ceiling.</p>",
        delivered_as: "customer_initiated",
        created_at: 1_767_225_600,
      },
      {
        id: "part_2",
        body: `<p>${draftText}</p>`,
        delivered_as: "admin_initiated",
        created_at: 1_767_225_700,
      },
    ],
  },
};

/** The same conversation, but the teammate rewrote the reply. */
const editedReply = {
  ...approveReply,
  parts: {
    parts: [
      ...(approveReply.parts.parts ?? []),
      {
        id: "part_3",
        body: "<p>We do not cover the roof.</p>",
        delivered_as: "admin_initiated",
        created_at: 1_767_225_800,
      },
    ],
  },
};

/** The Overturn client, mocked the way the Zendesk tests mock the ZAF client. */
function mockOverturn(opts: { draft?: DraftState | null; fail?: boolean } = {}): {
  overturn: OverturnClient;
  captured: CaptureCreate[];
} {
  const captured: CaptureCreate[] = [];
  const overturn: OverturnClient = {
    async findDraft(): Promise<DraftState | null> {
      return opts.draft ?? null;
    },
    async capture(body: CaptureCreate): Promise<CaptureResult> {
      if (opts.fail) throw new Error("overturn is down");
      captured.push(body);
      return {
        kind: "edit",
        changed: true,
        changedFields: [],
        deduplicated: false,
      } as unknown as CaptureResult;
    },
  };
  return { overturn, captured };
}

const admin = { id: "a1", email: "ray@carrier.com" };

describe("handleInitialize", () => {
  it("captures the reply when an assist recorded the draft", async () => {
    const { overturn, captured } = mockOverturn({ draft });
    const canvas = await handleInitialize(
      { conversation: approveReply, admin },
      { settings: { overturn_api_key: "ov_test" }, overturn },
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.source).toBe("intercom");
    expect(captured[0]?.externalId).toBe("ic:conv_1");
    expect(captured[0]?.tags).toEqual(["draft:ai"]);
    expect(captured[0]?.actor).toBe("ray@carrier.com");
    expect(canvas.canvas.content.components[0]?.text).toBe("Captured · edit saved as a case");
  });

  it("captures nothing when no assist recorded a draft", async () => {
    const { overturn, captured } = mockOverturn({ draft: null });
    await handleInitialize({ conversation: approveReply, admin }, { settings: {}, overturn });
    expect(captured).toHaveLength(0);
  });

  it("holds a rewritten reply until there is a reason", async () => {
    const { overturn, captured } = mockOverturn({ draft });
    await handleInitialize({ conversation: editedReply, admin }, { settings: {}, overturn });
    expect(captured).toHaveLength(0);
  });

  it("never throws when Overturn is down", async () => {
    const { overturn } = mockOverturn({ draft, fail: true });
    const canvas = await handleInitialize({ conversation: approveReply, admin }, { settings: {}, overturn });
    expect(canvas.canvas.content.components.length).toBeGreaterThan(0);
  });
});

describe("handleSubmit", () => {
  it("saves the held correction with the reason the teammate picked", async () => {
    const { overturn, captured } = mockOverturn({ draft });
    await handleSubmit(
      {
        conversation: editedReply,
        admin,
        component_id: "reason:wrong_answer",
        input_values: { note: "exclusion" },
      },
      { settings: { require_reason: "true" }, overturn },
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.reasonCode).toBe("wrong_answer");
    expect(captured[0]?.reason).toBe("exclusion");
    expect(captured[0]?.externalId).toBe("ic:conv_1");
  });
});
