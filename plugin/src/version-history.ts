import { FuzzySuggestModal, Notice } from "obsidian";
import * as Y from "yjs";
import type CoeditPlugin from "./main";
import { type CheckpointInfo, createCheckpoint, listCheckpoints, pullCheckpoint, roomName } from "./net";
import type { FileMeta } from "./paths";
import type { SharedFolder } from "./shared-folder";

class CheckpointSuggestModal extends FuzzySuggestModal<CheckpointInfo> {
  constructor(
    plugin: CoeditPlugin,
    private checkpoints: CheckpointInfo[],
    private onPick: (ckpt: CheckpointInfo) => void,
  ) {
    super(plugin.app);
    this.setPlaceholder("Restore this note to…");
  }

  getItems(): CheckpointInfo[] {
    return [...this.checkpoints].sort((a, b) => b.ts - a.ts);
  }

  getItemText(ckpt: CheckpointInfo): string {
    return `${new Date(ckpt.ts).toLocaleString()} (${(ckpt.bytes / 1024).toFixed(1)} KB)`;
  }

  onChooseItem(ckpt: CheckpointInfo): void {
    this.onPick(ckpt);
  }
}

/** List a note's checkpoints; picking one restores it (current state is checkpointed first). */
export async function showVersionHistory(
  plugin: CoeditPlugin,
  folder: SharedFolder,
  relPath: string,
  meta: FileMeta,
): Promise<void> {
  const room = roomName(folder.config.folderId, meta.guid);
  let checkpoints: CheckpointInfo[];
  try {
    checkpoints = await listCheckpoints(plugin.settings, room);
  } catch (err) {
    new Notice(`Coedit: could not load history — ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (checkpoints.length === 0) {
    new Notice("Coedit: no checkpoints yet for this note (they accrue as you edit).");
    return;
  }
  new CheckpointSuggestModal(plugin, checkpoints, (ckpt) => {
    void (async () => {
      try {
        // Preserve the current state as its own checkpoint before rewinding.
        await createCheckpoint(plugin.settings, room);
        const update = await pullCheckpoint(plugin.settings, room, ckpt.ts);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, update);
        const text = doc.getText("contents").toString();
        await folder.restoreText(relPath, meta, text);
        new Notice(`Coedit: restored to ${new Date(ckpt.ts).toLocaleString()}.`);
      } catch (err) {
        new Notice(`Coedit: restore failed — ${err instanceof Error ? err.message : err}`);
      }
    })();
  }).open();
}
