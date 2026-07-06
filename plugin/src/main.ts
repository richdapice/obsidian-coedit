import { Notice, Plugin, TFile } from "obsidian";
import { EditorBindingManager } from "./editor-binding";
import { JoinFolderModal, ShareFolderModal } from "./modals";
import {
  DEFAULT_SETTINGS,
  type CoeditSettings,
  CoeditSettingTab,
  type SharedFolderConfig,
} from "./settings";
import { SharedFolder } from "./shared-folder";
import { VaultApplier } from "./vault-applier";

export default class CoeditPlugin extends Plugin {
  settings: CoeditSettings = DEFAULT_SETTINGS;
  folder: SharedFolder | null = null;

  private applier!: VaultApplier;
  private bindings!: EditorBindingManager;
  private statusEl: HTMLElement | null = null;
  /** guid → hash at which disk and CRDT last agreed. Persisted with settings. */
  private syncState: Record<string, string> = {};
  private saveTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.applier = new VaultApplier(this.app);
    this.bindings = new EditorBindingManager(this);
    this.addSettingTab(new CoeditSettingTab(this.app, this));
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
          if (this.folder?.contains(file.path)) {
            // Scan after enrollment so a freshly created note binds
            // immediately instead of waiting for the next layout event.
            void this.folder.onLocalCreate(file).then(() => this.bindings.scan());
          }
        }),
      );
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          const config = this.settings.sharedFolder;
          if (config && oldPath === config.localPath) {
            // The share root itself moved: follow it.
            config.localPath = file.path;
            void this.saveSettings();
            this.restartSession();
            return;
          }
          if (this.folder && (this.folder.contains(file.path) || this.folder.contains(oldPath))) {
            void this.folder.onLocalRename(file, oldPath);
            this.bindings.scan();
          }
        }),
      );
      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          const config = this.settings.sharedFolder;
          if (config && file.path === config.localPath) {
            // The share root was deleted: unlink rather than resurrect it.
            this.settings.sharedFolder = null;
            void this.saveSettings();
            this.restartSession();
            new Notice("Coedit: shared folder deleted — unlinked from the share.");
            return;
          }
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
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.saveSettings();
    }
  }

  async loadSettings(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Record<string, unknown>;
    const { syncState, ...settings } = data;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
    this.syncState = (syncState as Record<string, string> | undefined) ?? {};
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ ...this.settings, syncState: this.syncState });
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveSettings();
    }, 2000);
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
    const appId = (this.app as unknown as { appId?: string }).appId ?? "vault";
    this.folder = new SharedFolder(
      this.app,
      () => this.settings,
      config,
      this.applier,
      {
        get: (guid) => this.syncState[guid],
        set: (guid, hash) => {
          if (this.syncState[guid] === hash) return;
          this.syncState[guid] = hash;
          this.scheduleSave();
        },
      },
      `coedit-${appId}-${config.folderId}`,
    );
    this.wireStatus(this.folder);
    try {
      await this.folder.whenConnected();
      const { synced, enrolled } = await this.folder.reconcile();
      if (synced || enrolled) {
        new Notice(`Coedit: synced (${synced} reconciled, ${enrolled} enrolled)`);
      }
    } catch (err) {
      console.error("coedit: could not sync shared folder", err);
      new Notice(
        `Coedit: offline — ${err instanceof Error ? err.message : err}`,
      );
    }
    this.bindings.scan();
  }

  private async shareFolder(folderPath: string): Promise<void> {
    if (this.settings.sharedFolder) {
      new Notice("Coedit: a folder is already shared; unlink it first in settings.");
      return;
    }
    if (!this.app.vault.getFolderByPath(folderPath)) {
      new Notice(`Coedit: no folder at "${folderPath}"`);
      return;
    }
    const config: SharedFolderConfig = { localPath: folderPath, folderId: crypto.randomUUID() };
    this.settings.sharedFolder = config;
    await this.saveSettings();
    await this.openFolder(config);
    await navigator.clipboard.writeText(config.folderId);
    new Notice(`Coedit: shared "${folderPath}" — folder ID copied to clipboard.`);
  }

  private async joinFolder(folderId: string, localPath: string): Promise<void> {
    if (this.settings.sharedFolder) {
      new Notice("Coedit: a folder is already shared; unlink it first in settings.");
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
    provider.on("status", () => {
      refresh();
      // Back online: retry editors that declined to bind while offline.
      if (provider.wsconnected) this.bindings.scan();
    });
    provider.awareness.on("change", refresh);
    refresh();
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(`Coedit: ${text}`);
  }
}
