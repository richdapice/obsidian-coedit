import { FuzzySuggestModal, Notice } from "obsidian";
import type CoeditPlugin from "./main";
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

  /** Everyone else's current file, across all folders. */
  peerLocations(): PeerLocation[] {
    const peers: PeerLocation[] = [];
    for (const folder of this.plugin.folders) {
      const awareness = folder.provider.awareness;
      for (const [clientId, state] of awareness.getStates()) {
        if (clientId === awareness.clientID) continue;
        const user = (state as { user?: { name?: string; color?: string } }).user;
        const rel = (state as { activeFile?: string | null }).activeFile;
        if (!user?.name || !rel) continue;
        peers.push({
          name: user.name,
          color: user.color ?? "var(--text-accent)",
          folder,
          vaultPath: folder.absPath(rel),
        });
      }
    }
    return peers;
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
