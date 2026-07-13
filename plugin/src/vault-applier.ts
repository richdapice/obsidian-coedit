import { type App, TFile } from "obsidian";

/**
 * Applies remote changes to the vault while remembering what it did, so the
 * vault event handlers can tell self-caused events from real user actions.
 * Guards are consumed exactly once per operation.
 */
export class VaultApplier {
  private expectedCreates = new Set<string>();
  private expectedRenames = new Set<string>();
  private expectedDeletes = new Set<string>();
  private expectedModifies = new Set<string>();

  constructor(private app: App) {}

  consumeCreate(path: string): boolean {
    return this.expectedCreates.delete(path);
  }

  consumeRename(oldPath: string, newPath: string): boolean {
    return this.expectedRenames.delete(`${oldPath}\u0000${newPath}`);
  }

  consumeDelete(path: string): boolean {
    return this.expectedDeletes.delete(path);
  }

  consumeModify(path: string): boolean {
    return this.expectedModifies.delete(path);
  }

  async ensureFolder(path: string): Promise<void> {
    const parts = path.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (this.app.vault.getAbstractFileByPath(current)) continue;
      await this.guarded(this.expectedCreates, current, async () => {
        await this.app.vault.createFolder(current);
      });
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.guarded(this.expectedModifies, path, async () => {
        await this.app.vault.modify(existing, content);
      });
      return;
    }
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);
    await this.guarded(this.expectedCreates, path, async () => {
      await this.app.vault.create(path, content);
    });
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.guarded(this.expectedModifies, path, async () => {
        await this.app.vault.modifyBinary(existing, data);
      });
      return;
    }
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);
    await this.guarded(this.expectedCreates, path, async () => {
      await this.app.vault.createBinary(path, data);
    });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(oldPath);
    if (!file) return;
    const parent = newPath.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);
    await this.guarded(this.expectedRenames, `${oldPath}\u0000${newPath}`, async () => {
      await this.app.fileManager.renameFile(file, newPath);
    });
  }

  async trash(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return;
    await this.guarded(this.expectedDeletes, path, async () => {
      await this.app.vault.trash(file, true);
    });
  }

  /** Roll the guard back if the operation never happened. */
  private async guarded(set: Set<string>, key: string, op: () => Promise<void>): Promise<void> {
    set.add(key);
    try {
      await op();
    } catch (err) {
      set.delete(key);
      throw err;
    }
  }
}
