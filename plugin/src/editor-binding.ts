import { Compartment, type Extension, Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import { editorInfoField, type MarkdownView, Notice } from "obsidian";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { whenSynced } from "./collab";
import { applyDiskDiff } from "./disk-sync";
import type RelayClonePlugin from "./main";
import { contentHash } from "./paths";

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

    // Load the locally persisted doc and fold offline disk edits into it
    // BEFORE it sees any remote updates, so Yjs merges the two histories
    // instead of the diff clobbering remote edits (see disk-sync.ts).
    const entry = folder.docs.get(guid);
    await entry.ready;
    if (this.bound.get(cm)?.guid !== guid) return;
    const editorText = cm.state.doc.toString();
    if (
      entry.ytext.length > 0 &&
      editorText !== entry.ytext.toString() &&
      contentHash(editorText) !== folder.syncState.get(guid)
    ) {
      applyDiskDiff(entry.doc, entry.ytext, editorText);
    }

    folder.docs.connect(guid);
    let online = true;
    try {
      await whenSynced(entry.provider!);
    } catch (err) {
      online = false;
      console.warn("relay-clone: editor attach offline", err);
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

    if (entry.ytext.length === 0 && editorText.length > 0) {
      if (online) {
        // Recovery seeding for a doc the server lost; normally the creator
        // seeded it at enroll time and this branch never runs.
        entry.ytext.insert(0, editorText);
      } else {
        // Can't verify the server is really empty; binding now could clear
        // the note or double-seed later. Stay unbound; edits still sync via
        // the closed-file pipeline, and the next scan retries.
        this.bound.delete(cm);
        folder.docs.release(guid);
        new Notice("Relay Clone: offline — will bind this note when the server is reachable.");
        return;
      }
    }
    const target = entry.ytext.toString();
    const currentText = cm.state.doc.toString();
    cm.dispatch({
      ...(target !== currentText
        ? { changes: { from: 0, to: cm.state.doc.length, insert: target } }
        : {}),
      effects: this.compartment.reconfigure([
        yCollab(entry.ytext, entry.provider!.awareness),
        Prec.high(keymap.of(yUndoManagerKeymap)),
      ]),
    });
    folder.syncState.set(guid, contentHash(target));
  }

  private detach(cm: EditorView): void {
    const bound = this.bound.get(cm);
    if (!bound) return;
    this.bound.delete(cm);
    this.plugin.folder?.docs.release(bound.guid);
    cm.dispatch({ effects: this.compartment.reconfigure([]) });
  }
}
