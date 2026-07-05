import { type App, Modal, Setting } from "obsidian";

export class ShareFolderModal extends Modal {
  private folderPath: string;

  constructor(
    app: App,
    defaultPath: string,
    private onSubmit: (folderPath: string) => void,
  ) {
    super(app);
    this.folderPath = defaultPath;
  }

  onOpen(): void {
    this.setTitle("Share a folder");
    new Setting(this.contentEl)
      .setName("Folder")
      .setDesc("Vault-relative path of the folder to share.")
      .addText((text) =>
        text.setValue(this.folderPath).onChange((v) => (this.folderPath = v.trim())),
      );
    new Setting(this.contentEl).addButton((btn) =>
      btn
        .setButtonText("Share")
        .setCta()
        .onClick(() => {
          if (!this.folderPath) return;
          this.close();
          this.onSubmit(this.folderPath.replace(/\/+$/, ""));
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class JoinFolderModal extends Modal {
  private folderId = "";
  private localPath = "";

  constructor(
    app: App,
    private onSubmit: (folderId: string, localPath: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Join a shared folder");
    new Setting(this.contentEl)
      .setName("Folder ID")
      .setDesc("The ID the sharer gave you.")
      .addText((text) => text.onChange((v) => (this.folderId = v.trim())));
    new Setting(this.contentEl)
      .setName("Local folder")
      .setDesc("Vault-relative folder to sync into (created if missing).")
      .addText((text) => text.onChange((v) => (this.localPath = v.trim())));
    new Setting(this.contentEl).addButton((btn) =>
      btn
        .setButtonText("Join")
        .setCta()
        .onClick(() => {
          if (!this.folderId || !this.localPath) return;
          this.close();
          this.onSubmit(this.folderId, this.localPath.replace(/\/+$/, ""));
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
