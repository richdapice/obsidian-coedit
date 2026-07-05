import { routePartykitRequest } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";

const SNAPSHOT_KEY = "ydoc:snapshot";
// A single Durable Object storage value is capped at 2 MiB.
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export class YDocServer extends YServer<Env> {
  static options = { hibernate: true };

  async onLoad(): Promise<void> {
    const snapshot = await this.ctx.storage.get<Uint8Array>(SNAPSHOT_KEY);
    if (snapshot) {
      Y.applyUpdate(this.document, snapshot);
    }
  }

  async onSave(): Promise<void> {
    const update = Y.encodeStateAsUpdate(this.document);
    if (update.byteLength > MAX_SNAPSHOT_BYTES) {
      // Refuse to clobber the last good snapshot with one we can't store.
      throw new Error(
        `snapshot for "${this.name}" is ${update.byteLength} bytes, over the ${MAX_SNAPSHOT_BYTES}-byte storage value limit`,
      );
    }
    await this.ctx.storage.put(SNAPSHOT_KEY, update);
  }

  // Background sync in the plugin pulls doc state over plain HTTP so closed
  // files don't each hold a WebSocket.
  onRequest(request: Request): Response {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/as-update")) {
      return new Response(Y.encodeStateAsUpdate(this.document) as Uint8Array<ArrayBuffer>, {
        headers: { "content-type": "application/octet-stream" },
      });
    }
    return new Response("not found", { status: 404 });
  }
}

function checkToken(request: Request, env: Env): Request | Response {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!env.SHARED_SECRET || !timingSafeEqual(token, env.SHARED_SECRET)) {
    return new Response("unauthorized", { status: 403 });
  }
  return request;
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await routePartykitRequest(request, env, {
      onBeforeConnect: (req) => checkToken(req, env),
      onBeforeRequest: (req) => checkToken(req, env),
    });
    return response ?? new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
