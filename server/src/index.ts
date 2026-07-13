import { marked } from "marked";
import { getServerByName, routePartykitRequest } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";

// Snapshots are chunked across storage keys: a single Durable Object storage
// value is capped at 2 MiB, and Yjs state grows monotonically.
const SNAPSHOT_PREFIX = "ydoc:snapshot:";
const LEGACY_SNAPSHOT_KEY = "ydoc:snapshot";
const CHUNK_BYTES = 1024 * 1024;
// One storage.put() accepts at most 128 pairs → hard ceiling on doc size.
const MAX_SNAPSHOT_BYTES = 128 * CHUNK_BYTES;
const MAX_PUSH_BYTES = 8 * 1024 * 1024;

const chunkKey = (i: number) => `${SNAPSHOT_PREFIX}${String(i).padStart(6, "0")}`;

// Version-history checkpoints: full snapshots under zero-padded-ms keys so
// list() returns them oldest-first.
const CKPT_PREFIX = "ckpt:";
const CKPT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CKPT_MAX_COUNT = 40;
// A checkpoint is one storage value; docs bigger than this just skip history.
const CKPT_MAX_BYTES = 2 * 1024 * 1024 - 1024;

const ckptKey = (ts: number) => `${CKPT_PREFIX}${String(ts).padStart(15, "0")}`;
const ckptTs = (key: string) => Number(key.slice(CKPT_PREFIX.length));

export class YDocServer extends YServer<Env> {
  static options = { hibernate: true };

  async onLoad(): Promise<void> {
    const chunks = await this.ctx.storage.list<Uint8Array>({ prefix: SNAPSHOT_PREFIX });
    if (chunks.size === 0) {
      const legacy = await this.ctx.storage.get<Uint8Array>(LEGACY_SNAPSHOT_KEY);
      if (legacy) Y.applyUpdate(this.document, legacy);
      return;
    }
    // list() returns keys sorted; zero-padded indices keep numeric order.
    const total = [...chunks.values()].reduce((n, c) => n + c.byteLength, 0);
    const update = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks.values()) {
      update.set(chunk, offset);
      offset += chunk.byteLength;
    }
    Y.applyUpdate(this.document, update);
  }

  async onSave(): Promise<void> {
    const update = Y.encodeStateAsUpdate(this.document);
    if (update.byteLength > MAX_SNAPSHOT_BYTES) {
      throw new Error(`snapshot for "${this.name}" is ${update.byteLength} bytes; refusing`);
    }
    const entries: Record<string, Uint8Array> = {};
    let count = 0;
    for (let offset = 0; offset < update.byteLength || count === 0; offset += CHUNK_BYTES) {
      entries[chunkKey(count++)] = update.slice(offset, offset + CHUNK_BYTES);
    }
    await this.ctx.storage.put(entries);
    // Drop stale higher-index chunks from a previously larger snapshot.
    const existing = await this.ctx.storage.list({ prefix: SNAPSHOT_PREFIX });
    const stale = [...existing.keys()].filter((k) => k >= chunkKey(count));
    if (stale.length > 0) await this.ctx.storage.delete(stale);
    await this.ctx.storage.delete(LEGACY_SNAPSHOT_KEY);
    await this.maybeCheckpoint();
  }

  /** Auto-checkpoint at most every CKPT_INTERVAL_MS. */
  private async maybeCheckpoint(): Promise<void> {
    const keys = await this.ctx.storage.list({ prefix: CKPT_PREFIX });
    const latest = [...keys.keys()].pop();
    if (latest && Date.now() - ckptTs(latest) < CKPT_INTERVAL_MS) return;
    await this.checkpointNow();
  }

  private async checkpointNow(): Promise<number | null> {
    const update = Y.encodeStateAsUpdate(this.document);
    if (update.byteLength > CKPT_MAX_BYTES) {
      console.warn(`checkpoint skipped for "${this.name}": ${update.byteLength} bytes`);
      return null;
    }
    const ts = Date.now();
    await this.ctx.storage.put(ckptKey(ts), update);
    const keys = [...(await this.ctx.storage.list({ prefix: CKPT_PREFIX })).keys()];
    if (keys.length > CKPT_MAX_COUNT) {
      await this.ctx.storage.delete(keys.slice(0, keys.length - CKPT_MAX_COUNT));
    }
    return ts;
  }

  // Background sync in the plugin pulls and pushes doc state over plain HTTP
  // so closed files don't each hold a WebSocket. Applying an update to
  // this.document broadcasts to connected clients and schedules onSave.
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/as-update")) {
      if (request.method === "GET") {
        return new Response(Y.encodeStateAsUpdate(this.document) as Uint8Array<ArrayBuffer>, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (request.method === "POST") {
        const body = new Uint8Array(await request.arrayBuffer());
        if (body.byteLength === 0 || body.byteLength > MAX_PUSH_BYTES) {
          return new Response("bad update size", { status: 400 });
        }
        try {
          Y.applyUpdate(this.document, body);
        } catch {
          return new Response("malformed update", { status: 400 });
        }
        return new Response(null, { status: 204 });
      }
    }

    if (url.pathname.endsWith("/checkpoints")) {
      if (request.method === "GET") {
        const stored = await this.ctx.storage.list<Uint8Array>({ prefix: CKPT_PREFIX });
        const list = [...stored.entries()].map(([key, value]) => ({
          ts: ckptTs(key),
          bytes: value.byteLength,
        }));
        return Response.json(list);
      }
      if (request.method === "POST") {
        const ts = await this.checkpointNow();
        if (ts === null) return new Response("doc too large to checkpoint", { status: 413 });
        return Response.json({ ts });
      }
    }

    const ckptMatch = url.pathname.match(/\/checkpoints\/(\d+)$/);
    if (ckptMatch && request.method === "GET") {
      const update = await this.ctx.storage.get<Uint8Array>(ckptKey(Number(ckptMatch[1])));
      if (!update) return new Response("not found", { status: 404 });
      return new Response(update as Uint8Array<ArrayBuffer>, {
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

// Content-addressed attachment blobs in R2, keyed by SHA-256. Same-secret
// trust model: uploads aren't hash-verified server-side.
const MAX_BLOB_BYTES = 25 * 1024 * 1024;

async function handleBlob(request: Request, env: Env, key: string): Promise<Response> {
  if (request.method === "GET") {
    const obj = await env.BLOBS.get(key);
    if (!obj) return new Response("not found", { status: 404 });
    return new Response(obj.body, {
      headers: { "content-type": "application/octet-stream" },
    });
  }
  if (request.method === "HEAD") {
    return new Response(null, { status: (await env.BLOBS.head(key)) ? 204 : 404 });
  }
  if (request.method === "PUT") {
    const size = Number(request.headers.get("content-length") ?? 0);
    if (!request.body || size <= 0 || size > MAX_BLOB_BYTES) {
      return new Response("bad blob size", { status: 400 });
    }
    // Content-addressed: an existing key already has these bytes.
    if (!(await env.BLOBS.head(key))) {
      await env.BLOBS.put(key, request.body);
    }
    return new Response(null, { status: 204 });
  }
  return new Response("method not allowed", { status: 405 });
}

// Public read-only rendering of a published note. The URL carries an HMAC of
// the room (signed with SHARED_SECRET, minted by the plugin), so the link
// itself is the capability — no registry, no revocation (rotate the secret
// to kill all links).
const PUBLISH_SIG_CHARS = 16;

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function handlePublished(env: Env, roomB64: string, sig: string): Promise<Response> {
  let room: string;
  try {
    room = atob(roomB64.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return new Response("not found", { status: 404 });
  }
  const expected = (await hmacHex(env.SHARED_SECRET, `publish:${room}`)).slice(0, PUBLISH_SIG_CHARS);
  if (!timingSafeEqual(sig, expected)) return new Response("not found", { status: 404 });

  const stub = await getServerByName(env.YDocServer, room);
  const res = await stub.fetch(
    new Request(`https://do/parties/y-doc-server/${encodeURIComponent(room)}/as-update`),
  );
  if (res.status !== 200) return new Response("not found", { status: 404 });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(await res.arrayBuffer()));
  const text = doc.getText("contents").toString();

  // Neutralize raw HTML before markdown parsing; markdown syntax survives.
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = marked.parse(escaped, { async: false });
  const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? "Shared note").slice(0, 120);
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title.replace(/</g, "&lt;")}</title>
<style>
body{max-width:42rem;margin:2rem auto;padding:0 1rem;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.6;color:#1a1a1a;background:#fff}
@media(prefers-color-scheme:dark){body{color:#ddd;background:#191919}a{color:#8ab4f8}}
pre,code{background:rgba(128,128,128,.15);border-radius:4px;padding:.1em .3em}
pre{padding:.8em;overflow-x:auto}
blockquote{border-left:3px solid rgba(128,128,128,.4);margin-left:0;padding-left:1em;opacity:.85}
</style></head><body>${body}</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const publishMatch = new URL(request.url).pathname.match(
      /^\/p\/([A-Za-z0-9_-]+)\.([a-f0-9]{16})$/,
    );
    if (publishMatch && request.method === "GET") {
      return handlePublished(env, publishMatch[1], publishMatch[2]);
    }
    const blobMatch = new URL(request.url).pathname.match(/^\/blobs\/([a-f0-9]{64})$/);
    if (blobMatch) {
      const auth = checkToken(request, env);
      if (auth instanceof Response) return auth;
      return handleBlob(request, env, blobMatch[1]);
    }
    const response = await routePartykitRequest(request, env, {
      onBeforeConnect: (req) => checkToken(req, env),
      onBeforeRequest: (req) => checkToken(req, env),
    });
    return response ?? new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
