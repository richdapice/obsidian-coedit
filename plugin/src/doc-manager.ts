import type YProvider from "y-partyserver/provider";
import * as Y from "yjs";
import { createProvider } from "./collab";
import { pullDocState, pushDocState, roomName } from "./net";
import type { RelayCloneSettings } from "./settings";

export interface DocEntry {
  guid: string;
  doc: Y.Doc;
  ytext: Y.Text;
  provider: YProvider | null;
  /** Number of editors currently showing this doc. */
  refs: number;
}

/**
 * Per-file Y.Docs, keyed by guid. Open editors hold a live WebSocket via
 * connect/release; everything else moves over HTTP pull/push so a big folder
 * doesn't mean a socket per file.
 */
export class DocManager {
  private entries = new Map<string, DocEntry>();

  constructor(
    private getSettings: () => RelayCloneSettings,
    private folderId: string,
  ) {}

  get(guid: string): DocEntry {
    let entry = this.entries.get(guid);
    if (!entry) {
      const doc = new Y.Doc();
      entry = { guid, doc, ytext: doc.getText("contents"), provider: null, refs: 0 };
      this.entries.set(guid, entry);
    }
    return entry;
  }

  /** An editor opened the file: hold a live connection. */
  connect(guid: string): DocEntry {
    const entry = this.get(guid);
    entry.refs++;
    if (!entry.provider) {
      entry.provider = createProvider(this.getSettings(), roomName(this.folderId, guid), entry.doc);
    }
    return entry;
  }

  /** An editor closed the file: drop the socket when nobody is looking. */
  release(guid: string): void {
    const entry = this.entries.get(guid);
    if (!entry || entry.refs === 0) return;
    entry.refs--;
    if (entry.refs === 0 && entry.provider) {
      entry.provider.destroy();
      entry.provider = null;
    }
  }

  isOpen(guid: string): boolean {
    return (this.entries.get(guid)?.refs ?? 0) > 0;
  }

  /** Merge the server's state into the local doc over HTTP. */
  async pull(guid: string): Promise<DocEntry> {
    const entry = this.get(guid);
    const update = await pullDocState(this.getSettings(), roomName(this.folderId, guid));
    Y.applyUpdate(entry.doc, update, "http-pull");
    return entry;
  }

  /** Push the local doc's full state to the server over HTTP. */
  async push(guid: string): Promise<void> {
    const entry = this.get(guid);
    await pushDocState(
      this.getSettings(),
      roomName(this.folderId, guid),
      Y.encodeStateAsUpdate(entry.doc),
    );
  }

  destroy(): void {
    for (const entry of this.entries.values()) {
      entry.provider?.destroy();
      entry.doc.destroy();
    }
    this.entries.clear();
  }
}
