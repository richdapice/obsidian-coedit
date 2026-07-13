import type { EditorView } from "@codemirror/view";
import { Notice, Plugin, TFile } from "obsidian";
import { userIdentity } from "./collab";
import { addComment, CommentModal } from "./comments";
import { EditorBindingManager } from "./editor-binding";
import { InviteModal, JoinFolderModal, ShareFolderModal } from "./modals";
import { isLocalHost, roomName } from "./net";
import { base64UrlEncode, hmacHex, isUnder } from "./paths";
import { jumpToPeer, PeerSuggestModal, PresenceManager } from "./presence";
import { showVersionHistory } from "./version-history";
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
  folders: SharedFolder[] = [];

  private applier!: VaultApplier;
  private bindings!: EditorBindingManager;
  private presence!: PresenceManager;
  private statusEl: HTMLElement | null = null;
  /** guid → hash at which disk and CRDT last agreed. Persisted with settings. */
  private syncState: Record<string, string> = {};
  private saveTimer: number | null = null;

  /** The shared folder (if any) containing this vault path. */
  folderFor(path: string): SharedFolder | undefined {
    return this.folders.find((f) => f.contains(path));
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.applier = new VaultApplier(this.app);
    this.bindings = new EditorBindingManager(this);
    this.presence = new PresenceManager(this);
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
    this.addCommand({
      id: "version-history",
      name: "Version history for current note",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        const folder = file ? this.folderFor(file.path) : undefined;
        const meta = file && folder ? folder.metaFor(file.path) : undefined;
        if (!file || !folder || !meta || meta.kind === "blob") {
          new Notice("Coedit: the active note isn't in a shared folder.");
          return;
        }
        void showVersionHistory(this, folder, folder.relPath(file.path), meta);
      },
    });
    this.addCommand({
      id: "create-invite",
      name: "Create invite token…",
      callback: () => {
        new InviteModal(this.app, (name, days, readOnly) => {
          void (async () => {
            const scope = readOnly ? "ro" : "rw";
            const nameB64 = base64UrlEncode(name);
            const expiry = Date.now() + days * 86_400_000;
            const sig = (
              await hmacHex(this.settings.token, `invite:${nameB64}:${expiry}:${scope}`)
            ).slice(0, 32);
            const token = `${nameB64}.${expiry}.${scope}.${sig}`;
            await navigator.clipboard.writeText(token);
            new Notice(
              `Coedit: invite for ${name} copied (${scope}, ${days}d). They paste it as their Shared secret.`,
            );
          })();
        }).open();
      },
    });
    this.addCommand({
      id: "comment-on-selection",
      name: "Comment on selection",
      editorCallback: (editor, ctx) => {
        const file = ctx.file;
        const folder = file ? this.folderFor(file.path) : undefined;
        const meta = file && folder ? folder.metaFor(file.path) : undefined;
        if (!file || !folder || !meta || meta.kind === "blob") {
          new Notice("Coedit: the active note isn't in a shared folder.");
          return;
        }
        if (!folder.docs.isOpen(meta.guid)) {
          new Notice("Coedit: still connecting this note — try again in a moment.");
          return;
        }
        const cm = (editor as unknown as { cm?: EditorView }).cm;
        if (!cm) return;
        const { from, to } = cm.state.selection.main;
        new CommentModal(this.app, (text) => {
          addComment(folder.docs.get(meta.guid), { from, to }, userIdentity(this.settings), text);
        }).open();
      },
    });
    this.addCommand({
      id: "copy-public-link",
      name: "Copy public link for current note",
      callback: () => {
        void (async () => {
          const file = this.app.workspace.getActiveFile();
          const folder = file ? this.folderFor(file.path) : undefined;
          const meta = file && folder ? folder.metaFor(file.path) : undefined;
          if (!file || !folder || !meta || meta.kind === "blob") {
            new Notice("Coedit: the active note isn't in a shared folder.");
            return;
          }
          const room = roomName(folder.config.folderId, meta.guid);
          const sig = (await hmacHex(this.settings.token, `publish:${room}`)).slice(0, 16);
          const scheme = isLocalHost(this.settings.serverHost) ? "http" : "https";
          const url = `${scheme}://${this.settings.serverHost}/p/${base64UrlEncode(room)}.${sig}`;
          await navigator.clipboard.writeText(url);
          new Notice("Coedit: public link copied. Anyone with the link can read this note.");
        })();
      },
    });
    this.addCommand({
      id: "jump-to-collaborator",
      name: "Jump to collaborator",
      callback: () => {
        const peers = this.presence.peerLocations();
        if (peers.length === 0) {
          new Notice("Coedit: no one else has a shared file open right now.");
        } else if (peers.length === 1) {
          void jumpToPeer(this, peers[0]);
        } else {
          new PeerSuggestModal(this, peers, (peer) => void jumpToPeer(this, peer)).open();
        }
      },
    });

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          const folder = this.folderFor(file.path);
          if (folder) {
            // Scan after enrollment so a freshly created note binds
            // immediately instead of waiting for the next layout event.
            void folder.onLocalCreate(file).then(() => this.bindings.scan());
          }
        }),
      );
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          const rootMoved = this.settings.sharedFolders.find((c) => c.localPath === oldPath);
          if (rootMoved) {
            // The share root itself moved: follow it.
            rootMoved.localPath = file.path;
            void this.saveSettings();
            this.restartSession();
            return;
          }
          const from = this.folderFor(oldPath);
          const to = this.folderFor(file.path);
          if (from && from === to) {
            void from.onLocalRename(file, oldPath);
          } else {
            // Crossing a share boundary (or entering/leaving one) is a
            // delete on one side and a create on the other.
            if (from) from.onLocalDelete(file, oldPath);
            if (to) void to.onLocalCreate(file).then(() => this.bindings.scan());
          }
          this.bindings.scan();
        }),
      );
      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          const rootGone = this.settings.sharedFolders.find((c) => c.localPath === file.path);
          if (rootGone) {
            // The share root was deleted: unlink rather than resurrect it.
            this.settings.sharedFolders = this.settings.sharedFolders.filter((c) => c !== rootGone);
            void this.saveSettings();
            this.restartSession();
            new Notice(`Coedit: "${rootGone.localPath}" deleted — unlinked from the share.`);
            return;
          }
          this.folderFor(file.path)?.onLocalDelete(file, file.path);
        }),
      );
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (!(file instanceof TFile)) return;
          const folder = this.folderFor(file.path);
          if (folder) void folder.onLocalModify(file);
        }),
      );
      this.registerEvent(
        this.app.workspace.on("file-open", () => {
          this.bindings.scan();
          this.presence.publishActiveFile();
        }),
      );
      this.registerEvent(
        this.app.workspace.on("layout-change", () => {
          this.bindings.scan();
          this.presence.queueRefresh();
        }),
      );

      void this.openAllFolders();
    });
  }

  onunload(): void {
    this.presence.destroy();
    for (const folder of this.folders) folder.destroy();
    this.folders = [];
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.saveSettings();
    }
  }

  async loadSettings(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Record<string, unknown>;
    const { syncState, sharedFolder, ...settings } = data as Record<string, unknown> & {
      sharedFolder?: SharedFolderConfig | null;
    };
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
    // Migrate the pre-multi-folder shape.
    if (!Array.isArray(this.settings.sharedFolders)) this.settings.sharedFolders = [];
    if (sharedFolder && this.settings.sharedFolders.length === 0) {
      this.settings.sharedFolders = [sharedFolder];
    }
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
    for (const folder of this.folders) folder.destroy();
    this.folders = [];
    this.setStatus("idle");
    void this.openAllFolders();
  }

  private async openAllFolders(): Promise<void> {
    await Promise.all(this.settings.sharedFolders.map((config) => this.openFolder(config)));
    this.refreshStatus();
  }

  private async openFolder(config: SharedFolderConfig): Promise<SharedFolder> {
    const appId = (this.app as unknown as { appId?: string }).appId ?? "vault";
    const folder = new SharedFolder(
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
    this.folders.push(folder);
    this.wireStatus(folder);
    try {
      await folder.whenConnected();
      const { synced, enrolled } = await folder.reconcile();
      if (synced || enrolled) {
        new Notice(`Coedit: "${config.localPath}" synced (${synced} reconciled, ${enrolled} enrolled)`);
      }
    } catch (err) {
      console.error(`coedit: could not sync "${config.localPath}"`, err);
      new Notice(`Coedit: "${config.localPath}" offline — ${err instanceof Error ? err.message : err}`);
    }
    this.bindings.scan();
    return folder;
  }

  /** Reject shares that nest inside (or swallow) an existing share. */
  private overlapsExisting(path: string): SharedFolderConfig | undefined {
    return this.settings.sharedFolders.find(
      (c) => c.localPath === path || isUnder(c.localPath, path) || isUnder(path, c.localPath),
    );
  }

  private async shareFolder(folderPath: string): Promise<void> {
    const clash = this.overlapsExisting(folderPath);
    if (clash) {
      new Notice(`Coedit: "${folderPath}" overlaps the existing share "${clash.localPath}".`);
      return;
    }
    if (!this.app.vault.getFolderByPath(folderPath)) {
      new Notice(`Coedit: no folder at "${folderPath}"`);
      return;
    }
    const config: SharedFolderConfig = { localPath: folderPath, folderId: crypto.randomUUID() };
    this.settings.sharedFolders.push(config);
    await this.saveSettings();
    await this.openFolder(config);
    await navigator.clipboard.writeText(config.folderId);
    new Notice(`Coedit: shared "${folderPath}" — folder ID copied to clipboard.`);
  }

  private async joinFolder(folderId: string, localPath: string): Promise<void> {
    const clash = this.overlapsExisting(localPath);
    if (clash) {
      new Notice(`Coedit: "${localPath}" overlaps the existing share "${clash.localPath}".`);
      return;
    }
    if (this.settings.sharedFolders.some((c) => c.folderId === folderId)) {
      new Notice("Coedit: that folder ID is already joined.");
      return;
    }
    if (!this.app.vault.getFolderByPath(localPath)) {
      await this.app.vault.createFolder(localPath);
    }
    const config: SharedFolderConfig = { localPath, folderId };
    this.settings.sharedFolders.push(config);
    await this.saveSettings();
    await this.openFolder(config);
  }

  private wireStatus(folder: SharedFolder): void {
    const provider = folder.provider;
    provider.on("status", () => {
      this.refreshStatus();
      // Back online: retry editors that declined to bind while offline.
      if (provider.wsconnected) this.bindings.scan();
    });
    provider.awareness.on("change", () => {
      this.refreshStatus();
      this.presence.queueRefresh();
    });
    this.presence.publishActiveFile();
    this.refreshStatus();
  }

  refreshStatus(): void {
    if (this.folders.length === 0) {
      this.setStatus("idle");
      return;
    }
    const connected = this.folders.filter((f) => f.provider.wsconnected);
    if (connected.length === 0) {
      const connecting = this.folders.some((f) => f.provider.wsconnecting);
      this.setStatus(connecting ? "connecting…" : "offline");
      return;
    }
    const peers = Math.max(...connected.map((f) => f.provider.awareness.getStates().size - 1));
    const scope = connected.length === this.folders.length ? "connected" : `${connected.length}/${this.folders.length} connected`;
    this.setStatus(`${scope} · ${peers} peer${peers === 1 ? "" : "s"} online`);
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(`Coedit: ${text}`);
  }
}
