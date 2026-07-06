import YProvider from "y-partyserver/provider";
import type * as Y from "yjs";
import { isLocalHost } from "./net";
import type { CoeditSettings } from "./settings";

const CURSOR_COLORS = [
  "#30bced",
  "#6eeb83",
  "#ffbc42",
  "#ecd444",
  "#ee6352",
  "#9ac2c9",
  "#8acb88",
  "#1be7ff",
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function createProvider(
  settings: CoeditSettings,
  room: string,
  doc: Y.Doc,
): YProvider {
  const provider = new YProvider(settings.serverHost, encodeURIComponent(room), doc, {
    party: "y-doc-server",
    // Explicit scheme: the library's own heuristic is a loose prefix match.
    protocol: isLocalHost(settings.serverHost) ? "ws" : "wss",
    params: { token: settings.token },
    // Vaults on one machine must sync through the server, not a
    // BroadcastChannel shortcut that would mask connection problems.
    disableBc: true,
  });
  const name = settings.displayName || "anonymous";
  const color = CURSOR_COLORS[hashString(name) % CURSOR_COLORS.length];
  provider.awareness.setLocalStateField("user", { name, color, colorLight: `${color}33` });
  return provider;
}

export function whenSynced(provider: YProvider, timeoutMs = 15000): Promise<void> {
  if (provider.synced) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onSynced = (synced: boolean) => {
      if (!synced) return;
      cleanup();
      resolve();
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`no sync from ${provider.url} within ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timer);
      provider.off("synced", onSynced);
    };
    provider.on("synced", onSynced);
  });
}
