import { AbstractInputSuggest, type App, Modal, Setting, TFolder } from "obsidian";

/** Autocomplete over existing vault folders, attached to a plain text input. */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(
    app: App,
    private inputEl: HTMLInputElement,
    private onPick: (path: string) => void,
  ) {
    super(app, inputEl);
  }

  getSuggestions(query: string): TFolder[] {
    const q = query.toLowerCase();
    return this.app.vault
      .getAllLoadedFiles()
      .filter(
        (f): f is TFolder =>
          f instanceof TFolder && f.path !== "/" && f.path.toLowerCase().includes(q),
      )
      .slice(0, 50);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.inputEl.value = folder.path;
    this.onPick(folder.path);
    this.close();
  }
}

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
      .setDesc("Pick an existing folder to share.")
      .addText((text) => {
        text.setValue(this.folderPath).onChange((v) => (this.folderPath = v.trim()));
        new FolderSuggest(this.app, text.inputEl, (path) => (this.folderPath = path));
      });
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

export class InviteModal extends Modal {
  private name = "";
  private days = 90;
  private readOnly = false;

  constructor(
    app: App,
    private onSubmit: (name: string, days: number, readOnly: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Create invite token");
    this.contentEl.createEl("p", {
      text: "Only works if your Shared secret is the server's real secret (not another invite token).",
      cls: "setting-item-description",
    });
    new Setting(this.contentEl)
      .setName("Name")
      .setDesc("Who this token is for (helps you track them).")
      .addText((text) => text.onChange((v) => (this.name = v.trim())));
    new Setting(this.contentEl)
      .setName("Valid for (days)")
      .addText((text) =>
        text.setValue("90").onChange((v) => (this.days = Math.max(1, Number(v) || 90))),
      );
    new Setting(this.contentEl)
      .setName("Read-only")
      .setDesc("They can view live but not edit.")
      .addToggle((toggle) => toggle.onChange((v) => (this.readOnly = v)));
    new Setting(this.contentEl).addButton((btn) =>
      btn
        .setButtonText("Create & copy")
        .setCta()
        .onClick(() => {
          if (!this.name) return;
          this.close();
          this.onSubmit(this.name, this.days, this.readOnly);
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
    let errorEl: HTMLElement | null = null;
    new Setting(this.contentEl)
      .setName("Folder ID")
      .setDesc("The ID copied by “Share folder…” (looks like 8-4-4-4-12 hex). NOT an invite token — that goes in Settings → Shared secret.")
      .addText((text) => text.onChange((v) => (this.folderId = v.trim())));
    new Setting(this.contentEl)
      .setName("Local folder")
      .setDesc("Pick an existing folder, or type a new path to create it.")
      .addText((text) => {
        text.onChange((v) => (this.localPath = v.trim()));
        new FolderSuggest(this.app, text.inputEl, (path) => (this.localPath = path));
      });
    new Setting(this.contentEl).addButton((btn) =>
      btn
        .setButtonText("Join")
        .setCta()
        .onClick(() => {
          if (!this.folderId || !this.localPath) return;
          errorEl?.remove();
          const showError = (msg: string) => {
            errorEl = this.contentEl.createEl("p", { text: msg, cls: "coedit-modal-error" });
          };
          // Joining a wrong ID "works" — it creates an empty folder — so the
          // common paste mistakes must be caught here, loudly.
          if (this.folderId.split(".").length === 4) {
            showError(
              "That's an invite token, not a folder ID. Invite tokens go in Settings → Coedit → Shared secret; ask the sharer for the folder ID from “Share folder…” (or its “Copy ID” button in settings).",
            );
            return;
          }
          if (!/^[0-9a-fA-F-]{16,64}$/.test(this.folderId)) {
            showError("That doesn't look like a folder ID (expected hex characters and dashes, like 8-4-4-4-12).");
            return;
          }
          this.close();
          this.onSubmit(this.folderId, this.localPath.replace(/\/+$/, ""));
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
