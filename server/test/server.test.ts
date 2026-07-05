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

  it("404s unknown DO paths", async () => {
    const res = await SELF.fetch(`${BASE}/room-c/bogus?token=test-secret`);
    expect(res.status).toBe(404);
  });
});

describe("persistence", () => {
  it("round-trips the doc through onSave/onLoad storage format", async () => {
    const id = env.YDocServer.idFromName("room-d");
    const stub = env.YDocServer.get(id);
    await SELF.fetch(`${BASE}/room-d/as-update?token=test-secret`);

    const stored = await runInDurableObject(stub, async (instance: YDocServer, state) => {
      instance.document.getText("contents").insert(0, "persist me");
      await instance.onSave();
      const snapshot = await state.storage.get<Uint8Array>("ydoc:snapshot");
      return snapshot ?? null;
    });

    expect(stored).not.toBeNull();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, stored!);
    expect(doc.getText("contents").toString()).toBe("persist me");
  });
});
