import { Compartment, Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import { editorInfoField, type MarkdownView, Notice, Plugin } from "obsidian";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { CollabSession } from "./collab";
import { DEFAULT_SETTINGS, type RelayCloneSettings, RelayCloneSettingTab } from "./settings";

export default class RelayClonePlugin extends Plugin {
  settings: RelayCloneSettings = DEFAULT_SETTINGS;

  private compartment = new Compartment();
  /** EditorViews currently bound (or binding) to the shared doc, by note path. */
  private attachedPaths = new WeakMap<EditorView, string>();
  private session: CollabSession | null = null;
  private statusEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new RelayCloneSettingTab(this.app, this));
    this.registerEditorExtension(this.compartment.of([]));
    this.statusEl = this.addStatusBarItem();
    this.setStatus("idle");

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.workspace.on("file-open", () => this.scanEditors()));
      this.registerEvent(this.app.workspace.on("layout-change", () => this.scanEditors()));
      this.scanEditors();
    });
  }

  onunload(): void {
    this.session?.destroy();
    this.session = null;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Tear down the connection and re-bind open editors (used after settings changes). */
  restartSession(): void {
    for (const cm of this.boundEditors()) {
      this.detach(cm);
    }
    this.session?.destroy();
    this.session = null;
    this.setStatus("idle");
    this.scanEditors();
  }

  private *boundEditors(): Iterable<EditorView> {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (cm && this.attachedPaths.has(cm)) yield cm;
    }
  }

  private scanEditors(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      const file = view.file;
      if (!cm || !file) continue;
      const attached = this.attachedPaths.get(cm);
      if (file.path === this.settings.sharedNotePath) {
        if (attached !== file.path) void this.attach(cm, file.path);
      } else if (attached) {
        this.detach(cm);
      }
    }
  }

  private async attach(cm: EditorView, path: string): Promise<void> {
    this.attachedPaths.set(cm, path);
    try {
      if (!this.session) {
        this.session = new CollabSession(this.settings, `note:${path}`);
        this.wireStatus(this.session);
      }
      const session = this.session;
      await session.whenSynced();

      // The view may have moved to another file (or been detached) while we
      // waited for the initial sync.
      if (this.attachedPaths.get(cm) !== path) return;
      const info = cm.state.field(editorInfoField, false);
      if (info?.file?.path !== path) {
        this.attachedPaths.delete(cm);
        return;
      }

      const editorText = cm.state.doc.toString();
      if (session.ytext.length === 0 && editorText.length > 0) {
        // First peer on an empty server doc seeds it from the local note.
        session.ytext.insert(0, editorText);
      }
      const target = session.ytext.toString();
      cm.dispatch({
        ...(target !== cm.state.doc.toString()
          ? { changes: { from: 0, to: cm.state.doc.length, insert: target } }
          : {}),
        effects: this.compartment.reconfigure([
          yCollab(session.ytext, session.provider.awareness),
          Prec.high(keymap.of(yUndoManagerKeymap)),
        ]),
      });
    } catch (err) {
      this.attachedPaths.delete(cm);
      console.error("relay-clone: attach failed", err);
      new Notice(`Relay Clone: could not connect — ${err instanceof Error ? err.message : err}`);
      this.setStatus("offline");
    }
  }

  private detach(cm: EditorView): void {
    this.attachedPaths.delete(cm);
    cm.dispatch({ effects: this.compartment.reconfigure([]) });
  }

  private wireStatus(session: CollabSession): void {
    const provider = session.provider;
    const refresh = () => {
      if (this.session !== session) return;
      if (!provider.wsconnected) {
        this.setStatus(provider.wsconnecting ? "connecting…" : "offline");
        return;
      }
      const peers = provider.awareness.getStates().size - 1;
      this.setStatus(`connected · ${peers} peer${peers === 1 ? "" : "s"}`);
    };
    provider.on("status", refresh);
    provider.awareness.on("change", refresh);
    refresh();
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(`Relay: ${text}`);
  }
}
