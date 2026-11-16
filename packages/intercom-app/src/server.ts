import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  buildCanvas,
  type CanvasResponse,
  type InitializeRequest,
  noteFromSubmit,
  planInitialize,
  reasonFromSubmit,
  type SubmitRequest,
} from "./canvas-kit";
import { type AppSettings, settingsFrom, withReason } from "./capture";
import type { OverturnClient } from "./overturn-client";

export interface AppOptions {
  /** The app's settings, as the deployment configures them. */
  settings: Record<string, unknown>;
  /** The Overturn client the app talks to. */
  overturn: OverturnClient;
  /** Injected so a test can pin the clock. Unix seconds, like every Intercom timestamp. */
  now?: () => number;
}

function settingsOf(options: AppOptions): AppSettings {
  return settingsFrom(options.settings);
}

/** The clock, in Unix seconds. */
function nowOf(options: AppOptions): number {
  return options.now ? options.now() : Math.floor(Date.now() / 1000);
}

/**
 * The draft for this conversation: an assist that recorded its run with the SDK. Without one
 * there is nothing to diff the teammate's reply against, so nothing is captured.
 */
async function draftFor(
  request: InitializeRequest,
  settings: AppSettings,
  overturn: OverturnClient,
): Promise<Awaited<ReturnType<OverturnClient["findDraft"]>>> {
  const conversation = request.conversation;
  if (!conversation) return null;
  return overturn.findDraft(`ic:${conversation.id}`, settings.agent);
}

/** Answers Intercom's initialize request. */
export async function handleInitialize(
  request: InitializeRequest,
  options: AppOptions,
): Promise<CanvasResponse> {
  const settings = settingsOf(options);
  const draft = await draftFor(request, settings, options.overturn);
  const plan = planInitialize({ request, state: { ...EMPTY, draft }, settings, now: nowOf(options) });
  let lastResult = null;
  if (plan.action === "capture") {
    try {
      const result = await options.overturn.capture(plan.body);
      lastResult = { kind: result.kind, changed: result.changed, dedup: result.deduplicated };
    } catch {
      // Overturn failing never blocks the teammate; the panel says so and gets out of the way.
      lastResult = null;
    }
  }
  return buildCanvas({ ...EMPTY, draft, lastResult }, settings);
}

/** Answers Intercom's submit request: the teammate picked a reason. */
export async function handleSubmit(request: SubmitRequest, options: AppOptions): Promise<CanvasResponse> {
  const settings = settingsOf(options);
  const draft = await draftFor(request, settings, options.overturn);
  const reasonCode = reasonFromSubmit(request);
  const reason = noteFromSubmit(request);
  const plan = planInitialize({
    request,
    state: { ...EMPTY, draft, reasonCode, reason },
    settings,
    now: nowOf(options),
  });
  let lastResult = null;
  if (plan.action === "capture") {
    try {
      const result = await options.overturn.capture(plan.body);
      lastResult = { kind: result.kind, changed: result.changed, dedup: result.deduplicated };
    } catch {
      lastResult = null;
    }
  } else if (plan.action === "need-reason" && reasonCode) {
    try {
      const result = await options.overturn.capture(withReason(plan.body, reasonCode, reason));
      lastResult = { kind: result.kind, changed: result.changed, dedup: result.deduplicated };
    } catch {
      lastResult = null;
    }
  }
  return buildCanvas({ ...EMPTY, draft, reasonCode, reason, lastResult }, settings);
}

const EMPTY = {
  draft: null,
  reasonCode: null,
  reason: "",
  lastResult: null,
};

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The HTTP surface: Intercom POSTs the initialize and submit flows to these two paths. */
export function createRequestListener(options: AppOptions) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = request.url ?? "";
    if (request.method !== "POST") {
      response.writeHead(405).end("POST only");
      return;
    }
    const raw = await readBody(request);
    let payload: unknown;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      response.writeHead(400).end("not json");
      return;
    }
    try {
      if (url.startsWith("/initialize")) {
        const canvas = await handleInitialize(payload as InitializeRequest, options);
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(canvas));
        return;
      }
      if (url.startsWith("/submit")) {
        const canvas = await handleSubmit(payload as SubmitRequest, options);
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(canvas));
        return;
      }
      response.writeHead(404).end("not found");
    } catch {
      // A failure in the app must not take the teammate's inbox down with it.
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(buildCanvas(EMPTY, settingsOf(options))));
    }
  };
}

/** Starts the app on a port. */
export function startServer(options: AppOptions & { port?: number }): ReturnType<typeof createServer> {
  const server = createServer((request, response) => {
    void createRequestListener(options)(request, response);
  });
  server.listen(options.port ?? 8787);
  return server;
}
