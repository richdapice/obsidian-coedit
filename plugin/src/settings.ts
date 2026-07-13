import { type App, PluginSettingTab, Setting } from "obsidian";
import type CoeditPlugin from "./main";

export interface SharedFolderConfig {
  /** Vault-relative folder path, no trailing slash. */
  localPath: string;
  /** UUID shared by everyone syncing this folder. */
  folderId: string;
}

export interface CoeditSettings {
  /** host[:port] without scheme; ws/http for localhost & LAN, wss/https otherwise. */
  serverHost: string;
  token: string;
  displayName: string;
  sharedFolders: SharedFolderConfig[];
}

export const DEFAULT_SETTINGS: CoeditSettings = {
  serverHost: "localhost:8787",
  token: "",
  displayName: "",
  sharedFolders: [],
};

export class CoeditSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: CoeditPlugin,
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

    new Setting(containerEl).setName("Shared folders").setHeading();
    if (this.plugin.settings.sharedFolders.length === 0) {
      new Setting(containerEl)
        .setName("None yet")
        .setDesc("Use the “Share folder…” or “Join shared folder…” command to add one.");
    }
    for (const folder of this.plugin.settings.sharedFolders) {
      new Setting(containerEl)
        .setName(folder.localPath)
        .setDesc(`ID ${folder.folderId}`)
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
              this.plugin.settings.sharedFolders = this.plugin.settings.sharedFolders.filter(
                (f) => f !== folder,
              );
              await this.plugin.saveSettings();
              this.plugin.restartSession();
              this.display();
            }),
        );
    }
  }
}
