import { EditorView } from "@codemirror/view";
import { FuzzySuggestModal, MarkdownView, Notice } from "obsidian";
import * as Y from "yjs";
import type CoeditPlugin from "./main";
import type { DocEntry } from "./doc-manager";
import { clientInserted, deltaChangePosition, type DeltaOp } from "./follow-utils";
import type { SharedFolder } from "./shared-folder";

/** Shape of the file-explorer view's internals we rely on (stable for years, but not public API). */
interface FileExplorerView {
  fileItems?: Record<string, { selfEl?: HTMLElement; titleEl?: HTMLElement }>;
}

export interface PeerLocation {
  name: string;
  color: string;
  folder: SharedFolder;
  vaultPath: string;
}

/**
 * Publishes which file we have open on each folder's index awareness, and
 * renders a colored dot in the file explorer next to files remote peers
 * have open.
 */
export class PresenceManager {
  private refreshQueued = false;

  constructor(private plugin: CoeditPlugin) {}

  /** Announce the active file (folder-relative) on every folder's awareness. */
  publishActiveFile(): void {
    const active = this.plugin.app.workspace.getActiveFile();
    for (const folder of this.plugin.folders) {
      const rel = active && folder.contains(active.path) ? folder.relPath(active.path) : null;
      folder.provider.awareness.setLocalStateField("activeFile", rel);
    }
  }

  /**
   * Everyone else's current file, across all folders. Deduped by display
   * name: a force-killed app leaves a ghost connection behind until the
   * server sweep reaps it, and the same person shouldn't show twice.
   */
  peerLocations(): PeerLocation[] {
    const byName = new Map<string, PeerLocation>();
    for (const folder of this.plugin.folders) {
      const awareness = folder.provider.awareness;
      for (const [clientId, state] of awareness.getStates()) {
        if (clientId === awareness.clientID) continue;
        const user = (state as { user?: { name?: string; color?: string } }).user;
        const rel = (state as { activeFile?: string | null }).activeFile;
        if (!user?.name || !rel) continue;
        byName.set(user.name, {
          name: user.name,
          color: user.color ?? "var(--text-accent)",
          folder,
          vaultPath: folder.absPath(rel),
        });
      }
    }
    return [...byName.values()];
  }

  /** Distinct remote display names (ghost connections collapse). */
  peerNames(): Set<string> {
    const names = new Set<string>();
    for (const folder of this.plugin.folders) {
      const awareness = folder.provider.awareness;
      for (const [clientId, state] of awareness.getStates()) {
        if (clientId === awareness.clientID) continue;
        const name = (state as { user?: { name?: string } }).user?.name;
        if (name) names.add(name);
      }
    }
    return names;
  }

  queueRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    window.requestAnimationFrame(() => {
      this.refreshQueued = false;
      this.refresh();
    });
  }

  refresh(): void {
    for (const el of Array.from(document.querySelectorAll(".coedit-presence-dot"))) {
      el.remove();
    }
    const explorer = this.plugin.app.workspace.getLeavesOfType("file-explorer")[0]?.view as
      | FileExplorerView
      | undefined;
    if (!explorer?.fileItems) return;
    for (const peer of this.peerLocations()) {
      const item = explorer.fileItems[peer.vaultPath];
      const host = item?.selfEl ?? item?.titleEl;
      if (!host) continue;
      const dot = host.createSpan({ cls: "coedit-presence-dot" });
      dot.style.backgroundColor = peer.color;
      dot.setAttribute("aria-label", peer.name);
    }
  }

  destroy(): void {
    for (const el of Array.from(document.querySelectorAll(".coedit-presence-dot"))) {
      el.remove();
    }
  }
}

export class PeerSuggestModal extends FuzzySuggestModal<PeerLocation> {
  constructor(
    plugin: CoeditPlugin,
    private peers: PeerLocation[],
    private onPick: (peer: PeerLocation) => void,
  ) {
    super(plugin.app);
    this.setPlaceholder("Jump to collaborator…");
  }

  getItems(): PeerLocation[] {
    return this.peers;
  }

  getItemText(peer: PeerLocation): string {
    return `${peer.name} — ${peer.vaultPath}`;
  }

  onChooseItem(peer: PeerLocation): void {
    this.onPick(peer);
  }
}

/** Open the peer's file; best-effort scroll to their cursor once bound. */
export async function jumpToPeer(plugin: CoeditPlugin, peer: PeerLocation): Promise<void> {
  const file = plugin.app.vault.getFileByPath(peer.vaultPath);
  if (!file) {
    new Notice(`Coedit: ${peer.name}'s file isn't synced here yet.`);
    return;
  }
  await plugin.app.workspace.getLeaf(false).openFile(file);
}

/**
 * Follow a peer: open whatever file they move to and keep their cursor in
 * view. Event-driven off awareness changes, so it also behaves after mobile
 * resume, where a one-shot "jump" can sample presence before it arrives.
 */
export class FollowManager {
  private targetName: string | null = null;
  private cursorCleanup: (() => void) | null = null;
  private lastOpenedPath: string | null = null;
  private openTimer: number | null = null;

  constructor(private plugin: CoeditPlugin) {}

  get target(): string | null {
    return this.targetName;
  }

  toggle(name: string): void {
    if (this.targetName) this.stop();
    else this.start(name);
  }

  start(name: string): void {
    this.targetName = name;
    new Notice(`Coedit: following ${name} — run the command again to stop.`);
    this.plugin.refreshStatus();
    this.onPresenceChange();
  }

  stop(): void {
    if (!this.targetName) return;
    new Notice(`Coedit: stopped following ${this.targetName}.`);
    this.targetName = null;
    this.lastOpenedPath = null;
    this.clearCursorWatch();
    this.plugin.refreshStatus();
  }

  /** Called on every index-awareness change (and after reconnects). */
  onPresenceChange(): void {
    if (!this.targetName) return;
    const peer = this.plugin.presence
      .peerLocations()
      .find((p) => p.name === this.targetName);
    if (!peer) return; // target idle/offline — keep the subscription alive
    const active = this.plugin.app.workspace.getActiveFile();
    if (active?.path === peer.vaultPath) {
      this.lastOpenedPath = peer.vaultPath;
      this.watchCursor(peer);
      return;
    }
    if (this.lastOpenedPath === peer.vaultPath) return; // already opening it
    // Debounce: a peer flicking through files shouldn't thrash our workspace.
    if (this.openTimer !== null) window.clearTimeout(this.openTimer);
    this.openTimer = window.setTimeout(() => {
      this.openTimer = null;
      void this.openPeerFile(peer);
    }, 300);
  }

  /** Providers are being torn down (settings change/unlink). */
  onSessionRestart(): void {
    this.clearCursorWatch();
    this.lastOpenedPath = null;
  }

  destroy(): void {
    this.clearCursorWatch();
    if (this.openTimer !== null) window.clearTimeout(this.openTimer);
    this.targetName = null;
  }

  private async openPeerFile(peer: PeerLocation): Promise<void> {
    if (this.targetName !== peer.name) return;
    const file = this.plugin.app.vault.getFileByPath(peer.vaultPath);
    if (!file) return; // not materialized locally yet; next change retries
    this.lastOpenedPath = peer.vaultPath;
    await this.plugin.app.workspace.getLeaf(false).openFile(file);
    this.watchCursor(peer);
  }

  /** Subscribe to the file doc's awareness so their cursor keeps us scrolled. */
  private watchCursor(peer: PeerLocation, attempt = 0): void {
    if (this.targetName !== peer.name) return;
    const meta = peer.folder.metaFor(peer.vaultPath);
    if (!meta || meta.kind === "blob") return;
    // The editor binding connects the doc shortly after the file opens.
    if (!peer.folder.docs.isOpen(meta.guid)) {
      if (attempt < 12) window.setTimeout(() => this.watchCursor(peer, attempt + 1), 400);
      return;
    }
    const entry = peer.folder.docs.get(meta.guid);
    const awareness = entry.provider?.awareness;
    if (!awareness) {
      if (attempt < 12) window.setTimeout(() => this.watchCursor(peer, attempt + 1), 400);
      return;
    }
    this.clearCursorWatch();
    const listener = () => this.scrollToPeerCursor(entry, awareness);
    awareness.on("change", listener);
    // Cursor awareness freezes while the peer edits inside Obsidian's table
    // sub-editor (the main editor is unfocused, so y-codemirror stops
    // publishing). Their edits still arrive though — follow those instead.
    const editObserver = (event: Y.YTextEvent, txn: Y.Transaction) => {
      if (this.targetName === null || txn.local) return;
      const targetClientId = this.findClientId(awareness, this.targetName);
      if (targetClientId === null || !clientInserted(txn, targetClientId)) return;
      const pos = deltaChangePosition(event.changes.delta as DeltaOp[]);
      if (pos !== null) this.scrollTo(pos);
    };
    entry.ytext.observe(editObserver);
    this.cursorCleanup = () => {
      awareness.off("change", listener);
      entry.ytext.unobserve(editObserver);
    };
    listener();
  }

  private findClientId(
    awareness: { clientID: number; getStates(): Map<number, unknown> },
    name: string,
  ): number | null {
    for (const [clientId, state] of awareness.getStates()) {
      if (clientId === awareness.clientID) continue;
      if ((state as { user?: { name?: string } }).user?.name === name) return clientId;
    }
    return null;
  }

  private scrollTo(index: number): void {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    const cm = (view?.editor as unknown as { cm?: EditorView } | undefined)?.cm;
    if (!cm || index > cm.state.doc.length) return;
    cm.dispatch({ effects: EditorView.scrollIntoView(index, { y: "center" }) });
  }

  private scrollToPeerCursor(
    entry: DocEntry,
    awareness: { clientID: number; getStates(): Map<number, unknown> },
  ): void {
    if (!this.targetName) return;
    for (const [clientId, state] of awareness.getStates()) {
      if (clientId === awareness.clientID) continue;
      const s = state as {
        user?: { name?: string };
        cursor?: { head?: unknown } | null;
      };
      if (s.user?.name !== this.targetName || !s.cursor?.head) continue;
      try {
        const rel = Y.createRelativePositionFromJSON(s.cursor.head);
        const abs = Y.createAbsolutePositionFromRelativePosition(rel, entry.doc);
        if (!abs) return;
        this.scrollTo(abs.index);
      } catch {
        // Anchor didn't resolve (stale state); the next change retries.
      }
      return;
    }
  }

  private clearCursorWatch(): void {
    this.cursorCleanup?.();
    this.cursorCleanup = null;
  }
}
