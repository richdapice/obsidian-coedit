import { type App, PluginSettingTab, Setting } from "obsidian";
import type RelayClonePlugin from "./main";

export interface SharedFolderConfig {
  /** Vault-relative folder path, no trailing slash. */
  localPath: string;
  /** UUID shared by everyone syncing this folder. */
  folderId: string;
}

export interface RelayCloneSettings {
  /** host[:port] without scheme; ws/http for localhost & LAN, wss/https otherwise. */
  serverHost: string;
  token: string;
  displayName: string;
  sharedFolder: SharedFolderConfig | null;
}

export const DEFAULT_SETTINGS: RelayCloneSettings = {
  serverHost: "localhost:8787",
  token: "",
  displayName: "",
  sharedFolder: null,
};

export class RelayCloneSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: RelayClonePlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Save immediately, but debounce the (expensive) reconnect so typing in
    // a field doesn't tear the session down per keystroke.
    let restartTimer: number | null = null;
    const update = (apply: (value: string) => void) => async (value: string) => {
      apply(value.trim());
      await this.plugin.saveSettings();
      if (restartTimer !== null) window.clearTimeout(restartTimer);
      restartTimer = window.setTimeout(() => {
        restartTimer = null;
        this.plugin.restartSession();
      }, 1500);
    };

    new Setting(containerEl)
      .setName("Server host")
      .setDesc("host[:port] of your sync server, no scheme (e.g. localhost:8787 or my-worker.example.workers.dev).")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.serverHost)
          .setValue(this.plugin.settings.serverHost)
          .onChange(update((v) => (this.plugin.settings.serverHost = v))),
      );

    new Setting(containerEl)
      .setName("Shared secret")
      .setDesc("Must match the server's SHARED_SECRET.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setValue(this.plugin.settings.token)
          .onChange(update((v) => (this.plugin.settings.token = v)));
      });

    new Setting(containerEl)
      .setName("Display name")
      .setDesc("Shown on your remote cursor.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.displayName)
          .onChange(update((v) => (this.plugin.settings.displayName = v))),
      );

    const folder = this.plugin.settings.sharedFolder;
    if (folder) {
      new Setting(containerEl)
        .setName("Shared folder")
        .setDesc(`"${folder.localPath}" — ID ${folder.folderId}`)
        .addButton((btn) =>
          btn.setButtonText("Copy ID").onClick(() => {
            void navigator.clipboard.writeText(folder.folderId);
          }),
        )
        .addButton((btn) =>
          btn
            .setButtonText("Unlink")
            .setWarning()
            .onClick(async () => {
              this.plugin.settings.sharedFolder = null;
              await this.plugin.saveSettings();
              this.plugin.restartSession();
              this.display();
            }),
        );
    } else {
      new Setting(containerEl)
        .setName("Shared folder")
        .setDesc("None yet — use the “Share folder” or “Join shared folder” command.");
    }
  }
}
