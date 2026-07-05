// Headless third peer for the shared-folder e2e (milestone 3).
// Prereqs: wrangler dev running, both dev vaults open in Obsidian with the
// plugin enabled (dev/setup.sh state). Verifies:
//   1. alice enrolled Shared/Note.md into the index,
//   2. its content doc holds her text,
//   3. a file created/renamed/deleted by the probe appears/moves/vanishes
//      on disk in BOTH vaults.
import { existsSync, readFileSync } from "node:fs";
import WebSocket from "ws";
import YProvider from "y-partyserver/provider";
import * as Y from "yjs";

const host = process.env.HOST ?? "localhost:8787";
const token = process.env.TOKEN ?? "dev-secret";
const folderId = process.env.FOLDER_ID ?? "dev-folder-0001";
const vaultRoot = new URL("../../dev/vaults/", import.meta.url).pathname;

const connect = (room, doc) =>
  new YProvider(host, encodeURIComponent(room), doc, {
    party: "y-doc-server",
    params: { token },
    WebSocketPolyfill: WebSocket,
    disableBc: true,
  });

const until = (check, what, timeoutMs = 30000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let result;
      try {
        result = check();
      } catch (err) {
        clearInterval(timer);
        reject(err);
        return;
      }
      if (result) {
        clearInterval(timer);
        resolve(result);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${what}`));
      }
    }, 300);
  });

const pull = async (docId) => {
  const res = await fetch(
    `http://${host}/parties/y-doc-server/${encodeURIComponent(`${folderId}:${docId}`)}/as-update?token=${token}`,
  );
  if (res.status !== 200) throw new Error(`pull ${docId}: HTTP ${res.status}`);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(await res.arrayBuffer()));
  return doc;
};

const push = async (docId, doc) => {
  const res = await fetch(
    `http://${host}/parties/y-doc-server/${encodeURIComponent(`${folderId}:${docId}`)}/as-update?token=${token}`,
    { method: "POST", body: Y.encodeStateAsUpdate(doc) },
  );
  if (res.status !== 204) throw new Error(`push ${docId}: HTTP ${res.status}`);
};

const onDisk = (vault, rel) => `${vaultRoot}${vault}/Shared/${rel}`;

// 1+2: index has alice's note, content doc has her text
const index = new Y.Doc();
const files = index.getMap("files");
const provider = connect(`${folderId}:index`, index);
await until(() => files.get("Note.md"), "alice's Note.md in the index");
console.log("✓ index contains Note.md (alice enrolled it)");

const noteDoc = await pull(files.get("Note.md").guid);
if (!noteDoc.getText("contents").toString().includes("Seeded by alice")) {
  throw new Error("Note.md content doc missing alice's text");
}
console.log("✓ Note.md content doc holds alice's text");

// bob should have materialized it on disk
await until(
  () => existsSync(onDisk("bob", "Note.md")) &&
        readFileSync(onDisk("bob", "Note.md"), "utf8").includes("Seeded by alice"),
  "bob's vault to materialize Note.md",
);
console.log("✓ bob's vault materialized Note.md from the index");

// 3: probe-created file appears in both vaults
const guid = crypto.randomUUID();
const probeDoc = new Y.Doc();
probeDoc.getText("contents").insert(0, "created by the probe\n");
await push(guid, probeDoc);
files.set("FromProbe.md", { guid, hash: "probe", mtime: Date.now() });
await until(
  () => existsSync(onDisk("alice", "FromProbe.md")) && existsSync(onDisk("bob", "FromProbe.md")),
  "FromProbe.md to appear in both vaults",
);
console.log("✓ probe-created file appeared in both vaults");

// rename: delete+add same guid in one transaction
index.transact(() => {
  const meta = files.get("FromProbe.md");
  files.delete("FromProbe.md");
  files.set("RenamedByProbe.md", meta);
});
await until(
  () =>
    existsSync(onDisk("alice", "RenamedByProbe.md")) &&
    existsSync(onDisk("bob", "RenamedByProbe.md")) &&
    !existsSync(onDisk("alice", "FromProbe.md")) &&
    !existsSync(onDisk("bob", "FromProbe.md")),
  "rename to propagate to both vaults",
);
console.log("✓ rename propagated to both vaults");

// delete
files.delete("RenamedByProbe.md");
await until(
  () => !existsSync(onDisk("alice", "RenamedByProbe.md")) && !existsSync(onDisk("bob", "RenamedByProbe.md")),
  "delete to propagate to both vaults",
);
console.log("✓ delete propagated to both vaults");

provider.destroy();
console.log("\nall folder-level checks passed");
process.exit(0);
