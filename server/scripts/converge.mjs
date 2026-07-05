// Smoke test against a running `wrangler dev`: two providers on one room must
// converge, and the /as-update HTTP endpoint must return the merged state.
import WebSocket from "ws";
import YProvider from "y-partyserver/provider";
import * as Y from "yjs";

const host = process.env.HOST ?? "localhost:8787";
const token = process.env.TOKEN ?? "dev-secret";
const room = `converge-test-${Date.now()}`;

function connect(doc) {
  return new YProvider(host, room, doc, {
    party: "y-doc-server",
    params: { token },
    WebSocketPolyfill: WebSocket,
    disableBc: true,
  });
}

function until(check, what, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${what}`));
      }
    }, 50);
  });
}

const docA = new Y.Doc();
const docB = new Y.Doc();
const providerA = connect(docA);
const providerB = connect(docB);

await until(() => providerA.synced && providerB.synced, "both providers to sync");
console.log("✓ both providers synced");

docA.getText("contents").insert(0, "hello from A. ");
docB.getText("contents").insert(0, "hello from B. ");

await until(
  () => docA.getText("contents").toString() === docB.getText("contents").toString() &&
        docA.getText("contents").toString().length > 0,
  "docs to converge",
);
console.log(`✓ converged on: "${docA.getText("contents").toString()}"`);

const res = await fetch(`http://${host}/parties/y-doc-server/${room}/as-update?token=${token}`);
if (res.status !== 200) throw new Error(`as-update returned ${res.status}`);
const viaHttp = new Y.Doc();
Y.applyUpdate(viaHttp, new Uint8Array(await res.arrayBuffer()));
if (viaHttp.getText("contents").toString() !== docA.getText("contents").toString()) {
  throw new Error("as-update state does not match live docs");
}
console.log("✓ /as-update matches live state");

const unauth = await fetch(`http://${host}/parties/y-doc-server/${room}/as-update?token=wrong`);
if (unauth.status !== 403) throw new Error(`expected 403 for bad token, got ${unauth.status}`);
console.log("✓ bad token rejected");

providerA.destroy();
providerB.destroy();
process.exit(0);
