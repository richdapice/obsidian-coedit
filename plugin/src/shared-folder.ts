import { type App, TFile, TFolder, type TAbstractFile, type Vault } from "obsidian";
import type YProvider from "y-partyserver/provider";
import * as Y from "yjs";
import { createProvider, whenSynced } from "./collab";
import { DocManager } from "./doc-manager";
import { roomName } from "./net";
import {
  classifyMapDelta,
  contentHash,
  type FileMeta,
  isUnder,
  joinPath,
  toRelative,
} from "./paths";
import type { RelayCloneSettings, SharedFolderConfig } from "./settings";
import type { VaultApplier } from "./vault-applier";

/** Origin tag for our own index-map transactions. */
const LOCAL = "relay-clone-local";

/**
 * One shared folder: an always-connected index Y.Doc mapping relative path →
 * {guid, hash, mtime}, plus a DocManager for the per-file content docs.
 * Files are identified by guid; paths are mutable metadata.
 */
export class SharedFolder {
  readonly doc = new Y.Doc();
  readonly files: Y.Map<FileMeta>;
  readonly provider: YProvider;
  readonly docs: DocManager;

  constructor(
    private app: App,
    private getSettings: () => RelayCloneSettings,
    readonly config: SharedFolderConfig,
    private applier: VaultApplier,
  ) {
    this.files = this.doc.getMap<FileMeta>("files");
    this.docs = new DocManager(getSettings, config.folderId);
    this.provider = createProvider(getSettings(), roomName(config.folderId, "index"), this.doc);
    this.files.observe((event, txn) => {
      if (txn.origin === LOCAL) return;
      void this.applyRemoteDelta(event).catch((err) => {
        console.error("relay-clone: failed to apply remote folder changes", err);
      });
    });
  }

  whenConnected(): Promise<void> {
    return whenSynced(this.provider);
  }

  destroy(): void {
    this.provider.destroy();
    this.docs.destroy();
    this.doc.destroy();
  }

  // ---- paths

  contains(path: string): boolean {
    return isUnder(this.config.localPath, path);
  }

  private rel(vaultPath: string): string {
    return toRelative(this.config.localPath, vaultPath);
  }

  private abs(relPath: string): string {
    return joinPath(this.config.localPath, relPath);
  }

  metaFor(vaultPath: string): FileMeta | undefined {
    return this.files.get(this.rel(vaultPath));
  }

  private transact(fn: () => void): void {
    this.doc.transact(fn, LOCAL);
  }

  private get vault(): Vault {
    return this.app.vault;
  }

  // ---- share/join/startup reconciliation (call only after whenConnected)

  /** Two-way structural reconcile: pull down remote-only files, enroll local-only files. */
  async reconcile(): Promise<{ materialized: number; enrolled: number }> {
    const materialized = await this.materializeMissing();
    const enrolled = await this.enrollMissing();
    return { materialized, enrolled };
  }

  /** Create local files for index entries we don't have yet. */
  private async materializeMissing(): Promise<number> {
    let count = 0;
    for (const [relPath, meta] of this.files.entries()) {
      const path = this.abs(relPath);
      if (this.vault.getAbstractFileByPath(path)) continue;
      const entry = await this.docs.pull(meta.guid);
      await this.applier.writeFile(path, entry.ytext.toString());
      count++;
    }
    return count;
  }

  /** Enroll local markdown files the index doesn't know about (sharer's first run, or files created while the plugin was off). */
  private async enrollMissing(): Promise<number> {
    const files = this.vault
      .getMarkdownFiles()
      .filter((f) => this.contains(f.path) && !this.files.has(this.rel(f.path)));
    for (const file of files) {
      await this.enroll(file);
    }
    return files.length;
  }

  /** Seed a content doc from disk and register the file. Creator-seeds rule: only the peer that creates the index entry ever seeds. */
  private async enroll(file: TFile): Promise<void> {
    const content = await this.vault.cachedRead(file);
    const guid = crypto.randomUUID();
    const entry = this.docs.get(guid);
    if (content.length > 0) entry.ytext.insert(0, content);
    await this.docs.push(guid);
    this.transact(() =>
      this.files.set(this.rel(file.path), {
        guid,
        hash: contentHash(content),
        mtime: file.stat.mtime,
      }),
    );
  }

  // ---- local vault events → index map

  async onLocalCreate(file: TAbstractFile): Promise<void> {
    if (this.applier.consumeCreate(file.path)) return;
    if (!(file instanceof TFile) || file.extension !== "md") return;
    if (this.files.has(this.rel(file.path))) return;
    await this.enroll(file);
  }

  async onLocalRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (this.applier.consumeRename(oldPath, file.path)) return;
    const wasIn = isUnder(this.config.localPath, oldPath);
    const nowIn = this.contains(file.path);

    if (file instanceof TFolder) {
      if (wasIn) {
        const oldPrefix = `${toRelative(this.config.localPath, oldPath)}/`;
        this.transact(() => {
          for (const [key, meta] of [...this.files.entries()]) {
            if (!key.startsWith(oldPrefix)) continue;
            this.files.delete(key);
            if (nowIn) {
              this.files.set(`${this.rel(file.path)}/${key.slice(oldPrefix.length)}`, meta);
            }
          }
        });
      }
      if (!wasIn && nowIn) {
        // A folder moved into the share: enroll its markdown files.
        await this.enrollMissing();
      }
      return;
    }

    if (!(file instanceof TFile)) return;
    if (wasIn && nowIn) {
      const meta = this.files.get(toRelative(this.config.localPath, oldPath));
      if (!meta) {
        await this.onLocalCreate(file);
        return;
      }
      this.transact(() => {
        this.files.delete(toRelative(this.config.localPath, oldPath));
        this.files.set(this.rel(file.path), meta);
      });
    } else if (wasIn) {
      this.transact(() => this.files.delete(toRelative(this.config.localPath, oldPath)));
    } else if (nowIn && file.extension === "md") {
      await this.onLocalCreate(file);
    }
  }

  onLocalDelete(file: TAbstractFile, path: string): void {
    if (this.applier.consumeDelete(path)) return;
    const rel = toRelative(this.config.localPath, path);
    if (file instanceof TFolder) {
      this.transact(() => {
        for (const key of [...this.files.keys()]) {
          if (key.startsWith(`${rel}/`)) this.files.delete(key);
        }
      });
      return;
    }
    if (this.files.has(rel)) {
      this.transact(() => this.files.delete(rel));
    }
  }

  /**
   * Obsidian saved a file (its own autosave for open editors, or another
   * source). Keep the index hash fresh so peers with the file closed know to
   * pull; if nothing has the file open here, fold the disk text into ytext.
   */
  async onLocalModify(file: TFile): Promise<void> {
    if (this.applier.consumeModify(file.path)) return;
    const rel = this.rel(file.path);
    const meta = this.files.get(rel);
    if (!meta) return;
    const content = await this.vault.cachedRead(file);
    const hash = contentHash(content);
    if (hash === meta.hash) return;

    if (!this.docs.isOpen(meta.guid)) {
      // No editor bound here, so ytext didn't get this change: replace and
      // push. (Milestone 4 turns this into a diff-based merge.)
      const entry = this.docs.get(meta.guid);
      if (entry.ytext.toString() !== content) {
        entry.doc.transact(() => {
          entry.ytext.delete(0, entry.ytext.length);
          entry.ytext.insert(0, content);
        });
      }
      await this.docs.push(meta.guid);
    }
    this.transact(() => this.files.set(rel, { ...meta, hash, mtime: file.stat.mtime }));
  }

  // ---- remote index changes → disk

  private async applyRemoteDelta(event: Y.YMapEvent<FileMeta>): Promise<void> {
    const delta = classifyMapDelta(event.changes.keys, (k) => this.files.get(k));

    for (const r of delta.renamed) {
      await this.applier.rename(this.abs(r.from), this.abs(r.to));
    }
    for (const a of delta.added) {
      const path = this.abs(a.path);
      const entry = await this.docs.pull(a.meta.guid);
      const existing = this.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        // Path collision: the remote guid wins. If the remote doc is still
        // empty, our text seeds it; otherwise remote content replaces disk.
        const local = await this.vault.cachedRead(existing);
        if (entry.ytext.length === 0 && local.length > 0) {
          entry.ytext.insert(0, local);
          await this.docs.push(a.meta.guid);
          continue;
        }
      }
      await this.applier.writeFile(path, entry.ytext.toString());
    }
    for (const d of delta.removed) {
      await this.applier.trash(this.abs(d.path));
    }
    for (const u of delta.updated) {
      if (this.docs.isOpen(u.meta.guid)) continue; // the editor binding owns it
      const path = this.abs(u.path);
      const file = this.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      const current = await this.vault.cachedRead(file);
      if (contentHash(current) === u.meta.hash) continue;
      const entry = await this.docs.pull(u.meta.guid);
      await this.applier.writeFile(path, entry.ytext.toString());
    }
  }
}
