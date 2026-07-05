import { type App, PluginSettingTab, Setting } from "obsidian";
import type RelayClonePlugin from "./main";

export interface RelayCloneSettings {
  /** host[:port] without scheme; ws:// is used for localhost/LAN, wss:// otherwise. */
  serverHost: string;
  token: string;
  /** Milestone 2: a single vault-relative note path that syncs live. */
  sharedNotePath: string;
  displayName: string;
}

export const DEFAULT_SETTINGS: RelayCloneSettings = {
  serverHost: "localhost:8787",
  token: "",
  sharedNotePath: "Shared.md",
  displayName: "",
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

    const update = (apply: (value: string) => void) => async (value: string) => {
      apply(value.trim());
      await this.plugin.saveSettings();
      this.plugin.restartSession();
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
      .setName("Shared note path")
      .setDesc("Vault-relative path of the note to co-edit (temporary, until shared folders land).")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.sharedNotePath)
          .setValue(this.plugin.settings.sharedNotePath)
          .onChange(update((v) => (this.plugin.settings.sharedNotePath = v))),
      );

    new Setting(containerEl)
      .setName("Display name")
      .setDesc("Shown on your remote cursor.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.displayName)
          .onChange(update((v) => (this.plugin.settings.displayName = v))),
      );
  }
}
