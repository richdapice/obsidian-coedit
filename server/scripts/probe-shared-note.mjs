// E2E probe for milestone 2: joins the plugin's room for Shared.md, expects
// to see alice's seeded content (proves the plugin bound the editor and
// seeded the doc), then types into the doc and exits. Obsidian's editor
// should show the probe's text live, and autosave it to Shared.md on disk.
import WebSocket from "ws";
import YProvider from "y-partyserver/provider";
import * as Y from "yjs";

const host = process.env.HOST ?? "localhost:8787";
const token = process.env.TOKEN ?? "dev-secret";
const room = encodeURIComponent("note:Shared.md");
const marker = process.env.MARKER ?? `\n\nprobe was here: ${new Date().toISOString()}\n`;

const doc = new Y.Doc();
const provider = new YProvider(host, room, doc, {
  party: "y-doc-server",
  params: { token },
  WebSocketPolyfill: WebSocket,
  disableBc: true,
});

const deadline = Date.now() + 90_000;
const ytext = doc.getText("contents");

await new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    if (ytext.toString().includes("Seeded by alice")) {
      clearInterval(timer);
      resolve();
    } else if (Date.now() > deadline) {
      clearInterval(timer);
      reject(new Error(`doc never showed alice's seed; current content: ${JSON.stringify(ytext.toString().slice(0, 200))}`));
    }
  }, 250);
});
console.log("✓ plugin seeded the doc from alice's note");
console.log(`  peers in awareness: ${provider.awareness.getStates().size - 1}`);

ytext.insert(ytext.length, marker);
console.log("✓ probe inserted marker text");

// Give Obsidian time to receive the update and autosave.
await new Promise((r) => setTimeout(r, 6000));
provider.destroy();
process.exit(0);
