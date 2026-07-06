import { Compartment, type Extension, Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import { editorInfoField, type MarkdownView, Notice } from "obsidian";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { whenSynced } from "./collab";
import { applyDiskDiff, mergeTypedEdits } from "./disk-sync";
import type CoeditPlugin from "./main";
import { contentHash } from "./paths";

interface BindToken {
  guid: string;
  path: string;
  /** True once the binding is installed and owns a connect() ref. */
  active: boolean;
}

/**
 * Binds CodeMirror editors showing shared files to their per-guid Y.Docs via
 * a Compartment that is empty by default and reconfigured per view.
 *
 * Ref accounting: an in-flight attach owns the connect() ref it takes and
 * releases it itself on every bail path; detach() only releases refs of
 * ACTIVE bindings. This keeps a pane switching files mid-attach from
 * destroying a provider another pane is using.
 */
export class EditorBindingManager {
  private compartment = new Compartment();
  private bound = new WeakMap<EditorView, BindToken>();

  constructor(private plugin: CoeditPlugin) {}

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
      const token = this.bound.get(cm);
      const meta = file && folder?.contains(file.path) ? folder.metaFor(file.path) : undefined;
      if (meta && file) {
        if (token?.guid !== meta.guid) {
          if (token) this.detach(cm);
          void this.attach(cm, meta.guid, file.path);
        }
      } else if (token) {
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
    const token: BindToken = { guid, path, active: false };
    this.bound.set(cm, token);

    const stale = () => this.bound.get(cm) !== token || this.plugin.folder !== folder;

    // Load the locally persisted doc; nothing to release yet if we bail.
    const entry = folder.docs.get(guid);
    await entry.ready;
    if (stale()) return;

    // Snapshot what the editor showed when we started; fold it (== disk
    // state) into the local doc BEFORE any remote update lands, under the
    // same lock the closed-file pipeline uses.
    const baseText = cm.state.doc.toString();
    await folder.docs.withLock(guid, async () => {
      if (stale()) return;
      if (
        entry.ytext.length > 0 &&
        baseText !== entry.ytext.toString() &&
        contentHash(baseText) !== folder.syncState.get(guid)
      ) {
        applyDiskDiff(entry.doc, entry.ytext, baseText);
      }
    });
    if (stale()) return;

    // From here on we own one connect() ref until success hands it to detach.
    folder.docs.connect(guid);
    const bail = () => {
      folder.docs.release(guid);
      if (this.bound.get(cm) === token) this.bound.delete(cm);
    };

    let online = true;
    try {
      await whenSynced(entry.provider!);
    } catch (err) {
      online = false;
      console.warn("coedit: editor attach offline", err);
    }
    if (stale()) {
      bail();
      return;
    }
    const info = cm.state.field(editorInfoField, false);
    if (info?.file?.path !== path) {
      bail();
      return;
    }

    if (entry.ytext.length === 0 && cm.state.doc.length > 0) {
      if (online) {
        // Recovery seeding for a doc the server lost; normally the creator
        // seeded it at enroll time and this branch never runs.
        entry.ytext.insert(0, cm.state.doc.toString());
      } else {
        // Can't verify the server is really empty; binding now could clear
        // the note or double-seed later. Stay unbound; edits still sync via
        // the closed-file pipeline, and the next scan retries.
        bail();
        new Notice("Coedit: offline — will bind this note when the server is reachable.");
        return;
      }
    }

    // Anything typed while we were syncing exists only in the editor; merge
    // it into the CRDT (fuzzy-positioned) rather than wiping it.
    const typedText = cm.state.doc.toString();
    if (typedText !== baseText) {
      mergeTypedEdits(entry.doc, entry.ytext, baseText, typedText);
    }

    const target = entry.ytext.toString();
    token.active = true;
    cm.dispatch({
      ...(target !== typedText
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
    const token = this.bound.get(cm);
    if (!token) return;
    this.bound.delete(cm);
    // Pending attaches own their ref and release it themselves.
    if (token.active) this.plugin.folder?.docs.release(token.guid);
    cm.dispatch({ effects: this.compartment.reconfigure([]) });
  }
}
