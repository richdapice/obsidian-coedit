import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { YDocServer } from "../src/index";

const BASE = "https://example.com/parties/y-doc-server";

describe("auth", () => {
  it("rejects requests without a token", async () => {
    const res = await SELF.fetch(`${BASE}/room-a/as-update`);
    expect(res.status).toBe(403);
  });

  it("rejects requests with a wrong token", async () => {
    const res = await SELF.fetch(`${BASE}/room-a/as-update?token=nope`);
    expect(res.status).toBe(403);
  });

  it("accepts the shared secret", async () => {
    const res = await SELF.fetch(`${BASE}/room-a/as-update?token=test-secret`);
    expect(res.status).toBe(200);
  });
});

describe("as-update", () => {
  it("returns doc state applicable to a fresh Y.Doc", async () => {
    const id = env.YDocServer.idFromName("room-b");
    const stub = env.YDocServer.get(id);
    // Route one request through the worker so partyserver initializes the
    // server name, then mutate the doc in place and read it back over HTTP.
    await SELF.fetch(`${BASE}/room-b/as-update?token=test-secret`);
    await runInDurableObject(stub, async (instance: YDocServer) => {
      instance.document.getText("contents").insert(0, "hello from the DO");
    });

    const res = await SELF.fetch(`${BASE}/room-b/as-update?token=test-secret`);
    expect(res.status).toBe(200);
    const update = new Uint8Array(await res.arrayBuffer());
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    expect(doc.getText("contents").toString()).toBe("hello from the DO");
  });

  it("accepts pushed updates over POST and reflects them in GET", async () => {
    const src = new Y.Doc();
    src.getText("contents").insert(0, "pushed over http");
    const res = await SELF.fetch(`${BASE}/room-e/as-update?token=test-secret`, {
      method: "POST",
      body: Y.encodeStateAsUpdate(src) as Uint8Array<ArrayBuffer>,
    });
    expect(res.status).toBe(204);

    const back = await SELF.fetch(`${BASE}/room-e/as-update?token=test-secret`);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(await back.arrayBuffer()));
    expect(doc.getText("contents").toString()).toBe("pushed over http");
  });

  it("rejects malformed POST bodies", async () => {
    const res = await SELF.fetch(`${BASE}/room-f/as-update?token=test-secret`, {
      method: "POST",
      body: new Uint8Array([1, 2, 3, 4]) as Uint8Array<ArrayBuffer>,
    });
    expect(res.status).toBe(400);
  });

  it("404s unknown DO paths", async () => {
    const res = await SELF.fetch(`${BASE}/room-c/bogus?token=test-secret`);
    expect(res.status).toBe(404);
  });
});

describe("persistence", () => {
  it("round-trips the doc through onSave/onLoad chunked storage", async () => {
    const id = env.YDocServer.idFromName("room-d");
    const stub = env.YDocServer.get(id);
    await SELF.fetch(`${BASE}/room-d/as-update?token=test-secret`);

    const stored = await runInDurableObject(stub, async (instance: YDocServer, state) => {
      instance.document.getText("contents").insert(0, "persist me");
      await instance.onSave();
      const chunks = await state.storage.list<Uint8Array>({ prefix: "ydoc:snapshot:" });
      const total = [...chunks.values()].reduce((n, c) => n + c.byteLength, 0);
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks.values()) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { joined, chunkCount: chunks.size };
    });

    expect(stored.chunkCount).toBeGreaterThan(0);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, stored.joined);
    expect(doc.getText("contents").toString()).toBe("persist me");
  });

  it("loads legacy single-key snapshots", async () => {
    const id = env.YDocServer.idFromName("room-legacy");
    const stub = env.YDocServer.get(id);
    await SELF.fetch(`${BASE}/room-legacy/as-update?token=test-secret`);

    const text = await runInDurableObject(stub, async (instance: YDocServer, state) => {
      const src = new Y.Doc();
      src.getText("contents").insert(0, "from the old format");
      await state.storage.put("ydoc:snapshot", Y.encodeStateAsUpdate(src));
      // No chunked snapshot exists for this room, so onLoad takes the
      // legacy path and applies it to the (empty) live doc.
      await instance.onLoad();
      return instance.document.getText("contents").toString();
    });

    expect(text).toBe("from the old format");
  });
});

describe("blobs", () => {
  const HASH = "a".repeat(64);
  const BLOB = "https://example.com/blobs";

  it("rejects unauthenticated blob access", async () => {
    const res = await SELF.fetch(`${BLOB}/${HASH}?token=nope`, { method: "GET" });
    expect(res.status).toBe(403);
  });

  it("round-trips a blob and is idempotent on re-upload", async () => {
    const bytes = new TextEncoder().encode("fake image bytes");
    const put = await SELF.fetch(`${BLOB}/${HASH}?token=test-secret`, {
      method: "PUT",
      body: bytes as Uint8Array<ArrayBuffer>,
      headers: { "content-length": String(bytes.byteLength) },
    });
    expect(put.status).toBe(204);

    const again = await SELF.fetch(`${BLOB}/${HASH}?token=test-secret`, {
      method: "PUT",
      body: bytes as Uint8Array<ArrayBuffer>,
      headers: { "content-length": String(bytes.byteLength) },
    });
    expect(again.status).toBe(204);

    const head = await SELF.fetch(`${BLOB}/${HASH}?token=test-secret`, { method: "HEAD" });
    expect(head.status).toBe(204);

    const got = await SELF.fetch(`${BLOB}/${HASH}?token=test-secret`);
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
  });

  it("404s a missing blob", async () => {
    const res = await SELF.fetch(`${BLOB}/${"b".repeat(64)}?token=test-secret`);
    expect(res.status).toBe(404);
  });

  it("rejects malformed hashes at the router", async () => {
    const res = await SELF.fetch(`${BLOB}/not-a-hash?token=test-secret`);
    expect(res.status).toBe(404);
  });
});

describe("checkpoints", () => {
  it("creates, lists, and serves checkpoints", async () => {
    const room = "room-ckpt";
    const id = env.YDocServer.idFromName(room);
    const stub = env.YDocServer.get(id);
    await SELF.fetch(`${BASE}/${room}/as-update?token=test-secret`);
    await runInDurableObject(stub, async (instance: YDocServer) => {
      instance.document.getText("contents").insert(0, "version one");
    });

    const created = await SELF.fetch(`${BASE}/${room}/checkpoints?token=test-secret`, {
      method: "POST",
    });
    expect(created.status).toBe(200);
    const { ts } = (await created.json()) as { ts: number };

    await runInDurableObject(stub, async (instance: YDocServer) => {
      const t = instance.document.getText("contents");
      t.delete(0, t.length);
      t.insert(0, "version two");
    });

    const listRes = await SELF.fetch(`${BASE}/${room}/checkpoints?token=test-secret`);
    const list = (await listRes.json()) as Array<{ ts: number; bytes: number }>;
    expect(list.map((c) => c.ts)).toContain(ts);

    const ckpt = await SELF.fetch(`${BASE}/${room}/checkpoints/${ts}?token=test-secret`);
    expect(ckpt.status).toBe(200);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(await ckpt.arrayBuffer()));
    expect(doc.getText("contents").toString()).toBe("version one");
  });

  it("auto-checkpoints on save but respects the interval", async () => {
    const room = "room-ckpt-auto";
    const id = env.YDocServer.idFromName(room);
    const stub = env.YDocServer.get(id);
    await SELF.fetch(`${BASE}/${room}/as-update?token=test-secret`);
    await runInDurableObject(stub, async (instance: YDocServer) => {
      instance.document.getText("contents").insert(0, "a");
      await instance.onSave();
      instance.document.getText("contents").insert(0, "b");
      await instance.onSave();
    });
    const listRes = await SELF.fetch(`${BASE}/${room}/checkpoints?token=test-secret`);
    const list = (await listRes.json()) as unknown[];
    expect(list.length).toBe(1);
  });
});
