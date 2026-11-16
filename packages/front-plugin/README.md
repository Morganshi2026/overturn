# Overturn for Front

Captures what the AI drafted, what the agent sent, and one line on why, from inside Front —
the same shape as `packages/zendesk-app`, on the Front side of the product.

Every capture is a replayable case: what the model produced, what the expert changed it to,
and the reason, stored as a correction record that the suite replays before the next model or
prompt change.

## What it does

1. **Detects a draft landing in the reply box** and shows `Draft inserted · N words`. A
   reply-sized insert in one change (an AI assist, a macro, a paste) is an `inserted` draft;
   a composer that already held a reply on load is `preloaded`, never guessed as an insert.
2. **Offers the reason picker** (`reason_pack`: the claims pack's eight codes or the
   vendor-neutral support pack) with an optional note.
3. **On send, POSTs `/v1/capture`** with `source: "front"`, `externalId:
   "fr:<conversation id>"`, the conversation as `context`, and `draft` / `sent` as
   `{ text, fields? }`.
4. **Honours `require_reason`**: a changed reply is held until there is a reason.
5. **Never blocks the send**: a failed capture is reported in the panel and gets out of the way.

The payload is documented in [docs/capture.md](../../docs/capture.md).

## How it is wired

The plugin reads the Front context stream (`@frontapp/plugin-sdk`) and works in either of
the two entry points that see a conversation:

| Entry point | Context | What it sees |
| --- | --- | --- |
| `COMPOSER_TOOLBAR` | `messageComposer` | the live draft, and the conversation once it exists |
| `SIDE_PANEL` | `singleConversation` | the conversation, and the draft by `conversation.draftId` |

The app declares the entry point in its AppSDK and passes its settings to the plugin view as
the entry point's custom context properties:

```ts
import { getBridge, EntryPointTypesEnum } from "@frontapp/ui-bridge";

getBridge().initialize((createEntryPoint) => {
  createEntryPoint({
    id: "overturn",
    type: EntryPointTypesEnum.SIDE_PANEL,
  }).subscribe((context) => {
    // ... serve the plugin view
  });
});
```

Settings the plugin reads (`overturn_base_url`, `overturn_api_key`, `agent`,
`require_reason`, `decision_fields`, `min_draft_chars`, `scope_tag`, `reason_pack`) are
the same ones the Zendesk app takes from its manifest. An app that would rather not hand the
API key to the browser can proxy `POST /v1/capture` itself and pass a short-lived token
instead.

## Two things worth knowing

**Front has no "reply submitted" hook the plugin can await.** The send is therefore observed
as the first outbound message that was not in the conversation when the plugin started
watching it (`createSendWatcher` in `src/front-client.ts`). A reply sent in the same second
the plugin opened is the one case this can miss.

**Front's composer is outside the plugin's control**, so a changed reply cannot be blocked
before it goes out the way the Zendesk app blocks a ticket save. With `require_reason` on, a
changed reply without a reason is *held*, not dropped: the panel asks for the reason and the
capture goes out as soon as it is known.

## Source

- `src/capture.ts` — the payload builder and the draft detector. Pure, and unit tested.
- `src/front-client.ts` — the conversation as the capture sees it, and the send watcher.
- `src/main.ts` — the Front SDK glue and the panel.

## Build

```bash
pnpm --filter @overturn-ai/front-plugin build     # tsup, then dist/overturn-front-plugin.zip
pnpm --filter @overturn-ai/front-plugin test      # unit tests
pnpm --filter @overturn-ai/front-plugin typecheck
```

The zip is written by `scripts/package.mjs` without shelling out to `zip`, so the build is
the same on a Mac, on Linux CI and on Windows.
