import { Compartment, type Extension, Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import { editorInfoField, type MarkdownView, Notice } from "obsidian";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { whenSynced } from "./collab";
import type RelayClonePlugin from "./main";

/**
 * Binds CodeMirror editors showing shared files to their per-guid Y.Docs via
 * a Compartment that is empty by default and reconfigured per view.
 */
export class EditorBindingManager {
  private compartment = new Compartment();
  private bound = new WeakMap<EditorView, { guid: string; path: string }>();

  constructor(private plugin: RelayClonePlugin) {}

  extension(): Extension {
    return this.compartment.of([]);
  }

  /** Reconcile every markdown editor with what it should be bound to. */
  scan(): void {
    const folder = this.plugin.folder;
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      const file = view.file;
      if (!cm) continue;
      const bound = this.bound.get(cm);
      const meta = file && folder?.contains(file.path) ? folder.metaFor(file.path) : undefined;
      if (meta && file) {
        if (bound?.guid !== meta.guid) {
          if (bound) this.detach(cm);
          void this.attach(cm, meta.guid, file.path);
        }
      } else if (bound) {
        this.detach(cm);
      }
    }
  }

  detachAll(): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (cm && this.bound.has(cm)) this.detach(cm);
    }
  }

  private async attach(cm: EditorView, guid: string, path: string): Promise<void> {
    const folder = this.plugin.folder;
    if (!folder) return;
    this.bound.set(cm, { guid, path });
    const entry = folder.docs.connect(guid);
    try {
      await whenSynced(entry.provider!);
    } catch (err) {
      this.bound.delete(cm);
      folder.docs.release(guid);
      console.error("relay-clone: editor attach failed", err);
      new Notice(`Relay Clone: could not connect — ${err instanceof Error ? err.message : err}`);
      return;
    }

    // The view may have moved on while we waited for the initial sync.
    if (this.bound.get(cm)?.guid !== guid) {
      folder.docs.release(guid);
      return;
    }
    const info = cm.state.field(editorInfoField, false);
    if (info?.file?.path !== path) {
      this.bound.delete(cm);
      folder.docs.release(guid);
      return;
    }

    const editorText = cm.state.doc.toString();
    if (entry.ytext.length === 0 && editorText.length > 0) {
      // Recovery seeding for a doc the server lost; normally the creator
      // seeded it at enroll time and this branch never runs.
      entry.ytext.insert(0, editorText);
    }
    const target = entry.ytext.toString();
    cm.dispatch({
      ...(target !== editorText
        ? { changes: { from: 0, to: cm.state.doc.length, insert: target } }
        : {}),
      effects: this.compartment.reconfigure([
        yCollab(entry.ytext, entry.provider!.awareness),
        Prec.high(keymap.of(yUndoManagerKeymap)),
      ]),
    });
  }

  private detach(cm: EditorView): void {
    const bound = this.bound.get(cm);
    if (!bound) return;
    this.bound.delete(cm);
    this.plugin.folder?.docs.release(bound.guid);
    cm.dispatch({ effects: this.compartment.reconfigure([]) });
  }
}
