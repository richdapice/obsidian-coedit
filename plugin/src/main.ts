import { Notice, Plugin, TFile } from "obsidian";
import { EditorBindingManager } from "./editor-binding";
import { JoinFolderModal, ShareFolderModal } from "./modals";
import {
  DEFAULT_SETTINGS,
  type RelayCloneSettings,
  RelayCloneSettingTab,
  type SharedFolderConfig,
} from "./settings";
import { SharedFolder } from "./shared-folder";
import { VaultApplier } from "./vault-applier";

export default class RelayClonePlugin extends Plugin {
  settings: RelayCloneSettings = DEFAULT_SETTINGS;
  folder: SharedFolder | null = null;

  private applier!: VaultApplier;
  private bindings!: EditorBindingManager;
  private statusEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.applier = new VaultApplier(this.app);
    this.bindings = new EditorBindingManager(this);
    this.addSettingTab(new RelayCloneSettingTab(this.app, this));
    this.registerEditorExtension(this.bindings.extension());
    this.statusEl = this.addStatusBarItem();
    this.setStatus("idle");

    this.addCommand({
      id: "share-folder",
      name: "Share folder…",
      callback: () => {
        const active = this.app.workspace.getActiveFile();
        const defaultPath = active?.parent?.path && active.parent.path !== "/" ? active.parent.path : "";
        new ShareFolderModal(this.app, defaultPath, (path) => void this.shareFolder(path)).open();
      },
    });
    this.addCommand({
      id: "join-folder",
      name: "Join shared folder…",
      callback: () => {
        new JoinFolderModal(this.app, (folderId, localPath) =>
          void this.joinFolder(folderId, localPath),
        ).open();
      },
    });

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (this.folder?.contains(file.path)) void this.folder.onLocalCreate(file);
        }),
      );
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          if (this.folder && (this.folder.contains(file.path) || this.folder.contains(oldPath))) {
            void this.folder.onLocalRename(file, oldPath);
            this.bindings.scan();
          }
        }),
      );
      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          if (this.folder?.contains(file.path)) this.folder.onLocalDelete(file, file.path);
        }),
      );
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile && this.folder?.contains(file.path)) {
            void this.folder.onLocalModify(file);
          }
        }),
      );
      this.registerEvent(this.app.workspace.on("file-open", () => this.bindings.scan()));
      this.registerEvent(this.app.workspace.on("layout-change", () => this.bindings.scan()));

      if (this.settings.sharedFolder) void this.openFolder(this.settings.sharedFolder);
    });
  }

  onunload(): void {
    this.folder?.destroy();
    this.folder = null;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Tear everything down and reconnect (settings changed, unlink, etc.). */
  restartSession(): void {
    this.bindings.detachAll();
    this.folder?.destroy();
    this.folder = null;
    this.setStatus("idle");
    if (this.settings.sharedFolder) void this.openFolder(this.settings.sharedFolder);
  }

  private async openFolder(config: SharedFolderConfig): Promise<void> {
    this.folder?.destroy();
    this.folder = new SharedFolder(this.app, () => this.settings, config, this.applier);
    this.wireStatus(this.folder);
    try {
      await this.folder.whenConnected();
      const { materialized, enrolled } = await this.folder.reconcile();
      if (materialized || enrolled) {
        new Notice(`Relay Clone: synced (${materialized} pulled, ${enrolled} enrolled)`);
      }
    } catch (err) {
      console.error("relay-clone: could not sync shared folder", err);
      new Notice(
        `Relay Clone: offline — ${err instanceof Error ? err.message : err}`,
      );
    }
    this.bindings.scan();
  }

  private async shareFolder(folderPath: string): Promise<void> {
    if (this.settings.sharedFolder) {
      new Notice("Relay Clone: a folder is already shared; unlink it first in settings.");
      return;
    }
    if (!this.app.vault.getFolderByPath(folderPath)) {
      new Notice(`Relay Clone: no folder at "${folderPath}"`);
      return;
    }
    const config: SharedFolderConfig = { localPath: folderPath, folderId: crypto.randomUUID() };
    this.settings.sharedFolder = config;
    await this.saveSettings();
    await this.openFolder(config);
    await navigator.clipboard.writeText(config.folderId);
    new Notice(`Relay Clone: shared "${folderPath}" — folder ID copied to clipboard.`);
  }

  private async joinFolder(folderId: string, localPath: string): Promise<void> {
    if (this.settings.sharedFolder) {
      new Notice("Relay Clone: a folder is already shared; unlink it first in settings.");
      return;
    }
    if (!this.app.vault.getFolderByPath(localPath)) {
      await this.app.vault.createFolder(localPath);
    }
    const config: SharedFolderConfig = { localPath, folderId };
    this.settings.sharedFolder = config;
    await this.saveSettings();
    await this.openFolder(config);
  }

  private wireStatus(folder: SharedFolder): void {
    const provider = folder.provider;
    const refresh = () => {
      if (this.folder !== folder) return;
      if (!provider.wsconnected) {
        this.setStatus(provider.wsconnecting ? "connecting…" : "offline");
        return;
      }
      const peers = provider.awareness.getStates().size - 1;
      this.setStatus(`connected · ${peers} peer${peers === 1 ? "" : "s"} online`);
    };
    provider.on("status", refresh);
    provider.awareness.on("change", refresh);
    refresh();
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(`Relay: ${text}`);
  }
}
