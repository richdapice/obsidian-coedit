import Anthropic from "@anthropic-ai/sdk";
import * as encoding from "lib0/encoding";
import { marked } from "marked";
import {
  type Connection,
  type ConnectionContext,
  getServerByName,
  routePartykitRequest,
} from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";
import {
  MAX_REPLY_CHARS,
  claimReply,
  findUnansweredMentions,
  parseEditInstruction,
  systemPrompt,
} from "../../shared/mentions.mjs";

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

/** y-protocols message type: ask a client to re-send its awareness state. */
const MESSAGE_QUERY_AWARENESS = 3;
/** Ghost-peer sweep cadence: how often to poke sockets while any exist. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// ---- @claude peer (Durable-Object brain) --------------------------------
// Fallback responder: answers @claude mentions ONLY when (a) an
// ANTHROPIC_API_KEY secret is configured and (b) the Mac daemon brain has
// not heartbeated recently (it holds priority — subscription-billed, richer
// capabilities). Without a key this code is fully dormant.
const PEER_HEARTBEAT_KEY = "peer:heartbeat";
/** Daemon considered offline after this long without a heartbeat. */
const PEER_HEARTBEAT_TTL_MS = 5 * 60 * 1000;
/** Debounce between a doc update and the mention scan. */
const PEER_SCAN_DELAY_MS = 2000;
/** Per-doc daily API-call cap (each DO only sees its own doc; the global
 *  50/day cap is the daemon's job — this bounds the metered fallback). */
const PEER_DOC_DAILY_CAP = 10;
const PEER_MODEL = "claude-opus-4-8";

export class YDocServer extends YServer<Env> {
  static options = { hibernate: true };

  override async onStart(): Promise<void> {
    await super.onStart();
    // Awareness is in-memory only, and the provider suppresses the usual
    // renewal interval (so DOs can hibernate). After a hibernation wake the
    // store is empty and idle peers stay invisible to anyone who connects
    // later — ask every surviving socket to re-announce itself.
    this.queryAwareness();
    await this.scheduleSweep();
    this.installMentionResponder();
  }

  // ---- @claude fallback brain -------------------------------------------

  private peerScanTimer: ReturnType<typeof setTimeout> | null = null;
  /** Mentions currently being answered (prompt text), so one update storm
   *  can't double-answer within this isolate's lifetime. */
  private peerBusy = new Set<string>();

  /** Content docs only; the index doc holds the file map, never prose. */
  private isContentDoc(): boolean {
    return this.name.includes(":") && !this.name.endsWith(":index");
  }

  private installMentionResponder(): void {
    if (!this.isContentDoc() || !this.env.ANTHROPIC_API_KEY) return;
    this.document.getText("contents").observe(() => {
      if (this.peerScanTimer) clearTimeout(this.peerScanTimer);
      this.peerScanTimer = setTimeout(() => {
        this.peerScanTimer = null;
        this.ctx.waitUntil(
          this.respondToMentions().catch((err) => {
            console.error(`claude peer failed in ${this.name}`, err);
          }),
        );
      }, PEER_SCAN_DELAY_MS);
    });
  }

  private async respondToMentions(): Promise<void> {
    const apiKey = this.env.ANTHROPIC_API_KEY;
    if (!apiKey) return;
    // The daemon brain has priority whenever it is alive.
    const beat = await this.ctx.storage.get<number>(PEER_HEARTBEAT_KEY);
    if (beat !== undefined && Date.now() - beat < PEER_HEARTBEAT_TTL_MS) return;

    const ytext = this.document.getText("contents");
    // Re-scan after every answer (replies shift later mentions' offsets),
    // but give each prompt ONE attempt per pass regardless of outcome — a
    // raced or duplicate mention must not spin this loop.
    const handled = new Set<string>();
    for (;;) {
      const mention = findUnansweredMentions(ytext.toString()).find(
        (m) => !this.peerBusy.has(m.prompt) && !handled.has(m.prompt),
      );
      if (!mention) return;
      handled.add(mention.prompt);
      this.peerBusy.add(mention.prompt);
      try {
        await this.answerMention(apiKey, mention.prompt);
      } catch (err) {
        console.error(`claude peer answer failed in ${this.name}`, err);
      } finally {
        this.peerBusy.delete(mention.prompt);
      }
    }
  }

  private async answerMention(apiKey: string, prompt: string): Promise<void> {
    const ytext = this.document.getText("contents");
    const reply = claimReply(this.document, ytext, prompt, "do");
    if (!reply) return;
    // Let a racing daemon claim propagate; keep only the first block.
    await new Promise((r) => setTimeout(r, 2500));
    if (!reply.ownsClaim()) return;

    // Edit mode needs the Mac daemon's sandbox; this fallback brain only
    // answers. Say so instead of replying with prose to an edit request.
    if (parseEditInstruction(prompt) !== null) {
      reply.update(
        "✏️ Edits need the Mac running Coedit's Claude daemon, and it looks offline right now. I can answer questions meanwhile — re-ask without “edit:”.",
      );
      return;
    }

    // Metered call is now certain — count it. Per-doc cap; yesterday's
    // counter is dropped as the day rolls over.
    const day = new Date().toISOString().slice(0, 10);
    const capKey = `peer:apiCount:${day}`;
    const used = (await this.ctx.storage.get<number>(capKey)) ?? 0;
    if (used >= PEER_DOC_DAILY_CAP) {
      console.warn(`claude peer cap reached for ${this.name}`);
      reply.update("⚠️ Claude's daily budget for this note is used up — try again tomorrow.");
      return;
    }
    const stale = [...(await this.ctx.storage.list({ prefix: "peer:apiCount:" })).keys()].filter(
      (k) => k !== capKey,
    );
    if (stale.length > 0) await this.ctx.storage.delete(stale);
    await this.ctx.storage.put(capKey, used + 1);

    const noteText = ytext.toString();
    const client = new Anthropic({ apiKey });
    try {
      const stream = client.messages.stream({
        model: PEER_MODEL,
        max_tokens: 2000,
        thinking: { type: "adaptive" },
        system: systemPrompt(null, this.env.PEER_CONTEXT),
        messages: [{ role: "user", content: noteText }],
      });
      let answer = "";
      let flushed = 0;
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          answer += event.delta.text;
          if (answer.length >= MAX_REPLY_CHARS) break;
          if (answer.length - flushed >= 120) {
            reply.update(answer);
            flushed = answer.length;
          }
        }
      }
      reply.update(answer);
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      reply.update(`⚠️ Claude couldn't answer: ${msg}`);
      throw err;
    }
  }

  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    await super.onConnect(connection, ctx);
    await this.scheduleSweep();
  }

  /**
   * Periodic sweep while sockets exist: writing to a silently-dead
   * connection (force-killed app, dropped network) is what forces TCP to
   * discover the death, which fires the close handler, which removes the
   * ghost's awareness states. Live clients just re-announce themselves.
   */
  override async onAlarm(): Promise<void> {
    this.queryAwareness();
    await this.scheduleSweep();
    // Mentions left unanswered while the daemon was alive-but-dying have no
    // update to re-trigger a scan; the sweep doubles as a retry tick.
    if (this.isContentDoc() && this.env.ANTHROPIC_API_KEY) {
      this.ctx.waitUntil(
        this.respondToMentions().catch((err) => {
          console.error(`claude peer alarm scan failed in ${this.name}`, err);
        }),
      );
    }
  }

  private queryAwareness(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_QUERY_AWARENESS);
    const message = encoding.toUint8Array(encoder);
    for (const connection of this.getConnections()) {
      try {
        connection.send(message);
      } catch {
        // Socket already closing; its awareness is gone anyway.
      }
    }
  }

  private async scheduleSweep(): Promise<void> {
    if ([...this.getConnections()].length === 0) return; // hibernate in peace
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    }
  }

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

  /**
   * Auto-checkpoint at most every CKPT_INTERVAL_MS. The latest timestamp
   * lives in its own key: list({prefix}) materializes every checkpoint's
   * bytes, far too heavy for a per-save check.
   */
  private async maybeCheckpoint(): Promise<void> {
    const latest = await this.ctx.storage.get<number>("ckptLatestTs");
    if (latest && Date.now() - latest < CKPT_INTERVAL_MS) return;
    await this.checkpointNow();
  }

  private async checkpointNow(): Promise<number | null> {
    const update = Y.encodeStateAsUpdate(this.document);
    if (update.byteLength > CKPT_MAX_BYTES) {
      console.warn(`checkpoint skipped for "${this.name}": ${update.byteLength} bytes`);
      return null;
    }
    const ts = Date.now();
    await this.ctx.storage.put({ [ckptKey(ts)]: update, ckptLatestTs: ts });
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

    // Daemon liveness beacon. Any room accepts it (the daemon posts to every
    // doc it watches) — a fresh beat tells this DO's fallback brain to stay
    // quiet because the subscription-billed daemon will answer instead.
    if (url.pathname.endsWith("/peer-heartbeat") && request.method === "POST") {
      await this.ctx.storage.put(PEER_HEARTBEAT_KEY, Date.now());
      return new Response(null, { status: 204 });
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

    return this.handleCheckpointFetch(url, request);
  }

  /**
   * Read-only WebSocket enforcement. The edge (onBeforeConnect) already
   * verified the token's HMAC — inside the DO we only parse the signed
   * scope back out of the upgrade URL, which hibernation preserves.
   */
  override isReadOnly(connection: { uri: string | null }): boolean {
    const uri = connection.uri;
    if (!uri) return true;
    let token: string;
    try {
      token = new URL(uri, "https://do").searchParams.get("token") ?? "";
    } catch {
      return true;
    }
    if (this.env.SHARED_SECRET && timingSafeEqual(token, this.env.SHARED_SECRET)) return false;
    return token.split(".")[2] !== "rw";
  }

  private async handleCheckpointFetch(url: URL, request: Request): Promise<Response> {
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

// Invite tokens: `b64url(name).expiryMs.scope.sig` where sig is the first 32
// hex chars of HMAC(secret, "invite:<name-b64>:<expiry>:<scope>"). Verified
// at the edge; the signed scope is then trusted inside the DO. No revocation
// list — tokens expire, and rotating the secret kills everything at once.
interface AuthResult {
  scope: "rw" | "ro";
}

async function verifyInvite(secret: string, token: string): Promise<AuthResult | null> {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [nameB64, expiryStr, scope, sig] = parts;
  if (scope !== "rw" && scope !== "ro") return null;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return null;
  const expected = (await hmacHex(secret, `invite:${nameB64}:${expiryStr}:${scope}`)).slice(0, 32);
  if (!timingSafeEqual(sig, expected)) return null;
  return { scope };
}

async function authorize(request: Request, env: Env): Promise<AuthResult | Response> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!env.SHARED_SECRET) return new Response("unauthorized", { status: 403 });
  if (timingSafeEqual(token, env.SHARED_SECRET)) return { scope: "rw" };
  const invite = await verifyInvite(env.SHARED_SECRET, token);
  if (invite) return invite;
  return new Response("unauthorized", { status: 403 });
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

async function checkToken(request: Request, env: Env): Promise<Request | Response> {
  const auth = await authorize(request, env);
  if (auth instanceof Response) return auth;
  if (auth.scope === "ro" && !READ_METHODS.has(request.method)) {
    return new Response("read-only token", { status: 403 });
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
  if (!env.SHARED_SECRET) return new Response("not found", { status: 404 });
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
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Blocks javascript: links and any script execution on this origin
      // (marked doesn't sanitize URL schemes).
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:",
    },
  });
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
      const auth = await checkToken(request, env);
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
