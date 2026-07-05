import YProvider from "y-partyserver/provider";
import * as Y from "yjs";
import type { RelayCloneSettings } from "./settings";

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

export class CollabSession {
  readonly doc = new Y.Doc();
  readonly ytext = this.doc.getText("contents");
  readonly provider: YProvider;

  constructor(settings: RelayCloneSettings, room: string) {
    this.provider = new YProvider(settings.serverHost, encodeURIComponent(room), this.doc, {
      party: "y-doc-server",
      params: { token: settings.token },
      // Two vaults on one machine must sync through the server, not a
      // BroadcastChannel shortcut that would mask connection problems.
      disableBc: true,
    });
    const name = settings.displayName || "anonymous";
    const color = CURSOR_COLORS[hashString(name) % CURSOR_COLORS.length];
    this.provider.awareness.setLocalStateField("user", {
      name,
      color,
      colorLight: `${color}33`,
    });
  }

  whenSynced(timeoutMs = 15000): Promise<void> {
    if (this.provider.synced) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onSynced = (synced: boolean) => {
        if (!synced) return;
        cleanup();
        resolve();
      };
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error(`no sync from ${this.provider.url} within ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = () => {
        window.clearTimeout(timer);
        this.provider.off("synced", onSynced);
      };
      this.provider.on("synced", onSynced);
    });
  }

  destroy(): void {
    this.provider.awareness.setLocalState(null);
    this.provider.destroy();
    this.doc.destroy();
  }
}
