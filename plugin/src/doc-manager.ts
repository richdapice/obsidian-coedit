import { IndexeddbPersistence } from "y-indexeddb";
import type YProvider from "y-partyserver/provider";
import * as Y from "yjs";
import { createProvider } from "./collab";
import { pullDocState, pushDocState, roomName } from "./net";
import { contentHash } from "./paths";
import type { CoeditSettings } from "./settings";

export interface DocEntry {
  guid: string;
  doc: Y.Doc;
  ytext: Y.Text;
  provider: YProvider | null;
  /** Number of editors currently showing this doc. */
  refs: number;
  /** Resolves once the locally persisted (IndexedDB) state is loaded. */
  ready: Promise<void>;
  /**
   * Last text at which disk and CRDT agreed while the doc was open. Base for
   * fuzzy-merging edits that bypass the bound editor (reading-view checkbox
   * taps, other plugins writing the file).
   */
  lastAgreedText?: string;
  /**
   * Hashes of recent ytext states while connected. Lets the modify handler
   * recognize a stale autosave echo (already-applied deltas) and skip it
   * instead of re-merging it into the CRDT.
   */
  recentTextHashes: string[];
  /** Doc-update observer feeding recentTextHashes; active while connected. */
  historyObserver?: () => void;
}

const RECENT_HASHES_MAX = 64;

/**
 * Per-file Y.Docs, keyed by guid, each persisted to IndexedDB so offline
 * edits survive restarts. Open editors hold a live WebSocket via
 * connect/release; everything else moves over HTTP pull/push so a big folder
 * doesn't mean a socket per file.
 *
 * All mutations of a doc (disk folds, pulls, editor connects) must run under
 * withLock(guid, …): interleaving a disk fold with a remote merge deletes
 * remote edits (see disk-sync.ts).
 */
export class DocManager {
  private entries = new Map<string, DocEntry>();
  private idbs = new Map<string, IndexeddbPersistence>();
  private locks = new Map<string, Promise<unknown>>();
  private destroyed = false;

  constructor(
    private getSettings: () => CoeditSettings,
    private folderId: string,
    private dbPrefix: string,
  ) {}

  /** Serialize async work per guid. Never nest withLock calls. */
  withLock<T>(guid: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(guid) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(
      guid,
      run.catch(() => {}),
    );
    return run;
  }

  get(guid: string): DocEntry {
    if (this.destroyed) throw new Error("DocManager used after destroy");
    let entry = this.entries.get(guid);
    if (!entry) {
      const doc = new Y.Doc();
      const idb = new IndexeddbPersistence(`${this.dbPrefix}-${guid}`, doc);
      this.idbs.set(guid, idb);
      entry = {
        guid,
        doc,
        ytext: doc.getText("contents"),
        provider: null,
        refs: 0,
        ready: idb.whenSynced.then(() => undefined),
        recentTextHashes: [],
      };
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
    if (!entry.historyObserver) {
      const record = () => {
        entry.recentTextHashes.push(contentHash(entry.ytext.toString()));
        if (entry.recentTextHashes.length > RECENT_HASHES_MAX) {
          entry.recentTextHashes.splice(0, entry.recentTextHashes.length - RECENT_HASHES_MAX);
        }
      };
      record();
      entry.doc.on("update", record);
      entry.historyObserver = record;
    }
    return entry;
  }

  /** An editor closed the file: drop the socket when nobody is looking. */
  release(guid: string): void {
    const entry = this.entries.get(guid);
    if (!entry || entry.refs === 0) return;
    entry.refs--;
    if (entry.refs === 0) {
      if (entry.provider) {
        entry.provider.destroy();
        entry.provider = null;
      }
      if (entry.historyObserver) {
        entry.doc.off("update", entry.historyObserver);
        entry.historyObserver = undefined;
        entry.recentTextHashes = [];
      }
    }
  }

  isOpen(guid: string): boolean {
    return (this.entries.get(guid)?.refs ?? 0) > 0;
  }

  /**
   * Free the doc and its IndexedDB handle if no editor holds it (data stays
   * in IndexedDB). Call only while holding the guid's lock.
   */
  evictIfClosed(guid: string): void {
    const entry = this.entries.get(guid);
    if (!entry || entry.refs > 0) return;
    entry.provider?.destroy();
    void this.idbs.get(guid)?.destroy();
    entry.doc.destroy();
    this.entries.delete(guid);
    this.idbs.delete(guid);
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
    this.destroyed = true;
    for (const idb of this.idbs.values()) {
      void idb.destroy();
    }
    for (const entry of this.entries.values()) {
      entry.provider?.destroy();
      entry.doc.destroy();
    }
    this.entries.clear();
    this.idbs.clear();
    this.locks.clear();
  }
}
