# Overturn for Intercom

Captures what the AI drafted, what the teammate sent, and one line on why, from inside
Intercom — the same shape as `packages/zendesk-app`, on the Intercom side of the product.

Every capture is a replayable case: what the model produced, what the expert changed it to,
and the reason, stored as a correction record that the suite replays before the next model or
prompt change.

## How this differs from the Zendesk and Front apps

Intercom's **Canvas Kit** is not a plugin the browser loads: Intercom POSTs the initialize and
submit flows to URLs the app serves, and the app answers with the canvas to render. So this
package is a small **service**, not an iframe bundle:

| | Endpoint | Request | Answer |
| --- | --- | --- | --- |
| Initialize | `POST /initialize` | `{ workspace_id, workspace_region, admin, conversation, contact }` | `{ canvas: { content: { components } } }` |
| Submit | `POST /submit` | the initialize payload plus `{ current_canvas, component_id, input_values }` | the updated canvas |

Point the app's *Initialize flow webhook URL* at `/initialize` and its *Submit flow webhook
URL* at `/submit`, and add it to the **Inbox → conversation details** location.

## What it does

1. **Finds the draft** — a drafting agent that recorded its run with the Overturn SDK for this
   conversation (`externalId: "ic:<conversation id>"`). That run is the evidence that an
   assist, not the teammate, wrote the draft.
2. **Offers the reason picker** (`reason_pack`: the claims pack's eight codes or the
   vendor-neutral support pack) with an optional note. Each chip is a canvas component with a
   submit action, so the pick comes back on the submit flow.
3. **On send, POSTs `/v1/capture`** with `source: "intercom"`, `externalId:
   "ic:<conversation id>"`, the conversation as `context`, and `draft` / `sent` as
   `{ text, fields? }`.
4. **Honours `require_reason`**: a changed reply is held until there is a reason.
5. **Never blocks the send** — a failed capture is swallowed and the app keeps serving the
   canvas.

## The draft origin

Intercom's Fin drafts and a human-written reply have to be told apart. The tag follows what we
were actually told, never a guess:

| What we know | Tag | The scorecard reads |
| --- | --- | --- |
| An assist recorded the run | `draft:ai` | ai |
| The teammate wrote it | `draft:manual` | manual |
| We were not told | *(no tag)* | unknown |

The API only turns a named `draftModel` into `draft:ai` by itself, so a draft of unknown
origin travels without a run and without a model.

## Two things worth knowing

**Canvas Kit has no composer.** Unlike Zendesk, whose App Framework streams the reply box, or
Front, whose plugin SDK exposes the draft, Intercom gives the app the *conversation* and
nothing about the text the teammate is typing. The draft therefore comes from the recorded
run, and the reply is matched to it by time: the newest message a teammate sent that was
written after the draft was recorded.

**The app hears about a reply when Intercom next initializes it** — a conversation switch, for
example — not the instant the reply is sent. A deployment that wants the capture the moment
the reply goes out should call the same `decideOnSend` from an Intercom webhook
(`conversation.admin.replied`) instead.

## Source

- `src/capture.ts` — the payload builder, the origin rules and the settings. Pure, unit tested.
- `src/canvas-kit.ts` — the Canvas Kit contract, and the app's plan for a request. Pure, unit tested.
- `src/overturn-client.ts` — the Overturn client: the draft lookup and the capture POST.
- `src/server.ts` — the two endpoints.

## Build

```bash
pnpm --filter @overturn-ai/intercom-app build     # tsup, then dist/overturn-intercom-app.zip
pnpm --filter @overturn-ai/intercom-app test      # unit tests
pnpm --filter @overturn-ai/intercom-app typecheck
```

The zip is written by `scripts/package.mjs` without shelling out to `zip`, so the build is
the same on a Mac, on Linux CI and on Windows.
