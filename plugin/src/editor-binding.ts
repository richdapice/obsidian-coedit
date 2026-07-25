import { Compartment, type Extension, Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import { editorInfoField, type MarkdownView, Notice } from "obsidian";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { whenSynced } from "./collab";
import { commentsExtension } from "./comments";
import { edgeIndicators } from "./edge-indicators";
import { remoteCursors } from "./remote-cursors";
import { applyDiskDiff, diffToChanges, mergeTypedEdits } from "./disk-sync";
import type CoeditPlugin from "./main";
import { contentHash } from "./paths";
import { Tracer } from "./perf";
import type { SharedFolder } from "./shared-folder";

interface BindToken {
  guid: string;
  path: string;
  /** The folder session this binding belongs to (release must hit the same DocManager). */
  folder: SharedFolder;
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
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      const file = view.file;
      if (!cm) continue;
      const token = this.bound.get(cm);
      const folder = file ? this.plugin.folderFor(file.path) : undefined;
      let meta = file && folder ? folder.metaFor(file.path) : undefined;
      // Blobs are LWW binaries, not CRDT docs — never bind an editor to one.
      if (meta?.kind === "blob") meta = undefined;
      if (meta && file && folder) {
        if (token?.guid !== meta.guid || token.folder !== folder) {
          if (token) this.detach(cm);
          void this.attach(cm, folder, meta.guid, file.path);
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

  private async attach(
    cm: EditorView,
    folder: SharedFolder,
    guid: string,
    path: string,
  ): Promise<void> {
    const token: BindToken = { guid, path, folder, active: false };
    this.bound.set(cm, token);

    const stale = () => this.bound.get(cm) !== token || !this.plugin.folders.includes(folder);

    // Take a ref BEFORE the first await: isOpen() is now true for the whole
    // attach, so the closed-file pipeline won't touch the doc (and can't
    // evict it out from under us — the July 2026 corruption race).
    const entry = folder.docs.retain(guid);
    let ownsRef = true;
    const bail = () => {
      if (ownsRef) {
        ownsRef = false;
        if (this.plugin.folders.includes(folder)) folder.docs.release(guid);
      }
      if (this.bound.get(cm) === token) this.bound.delete(cm);
    };

    const tracer = new Tracer(`attach ${path}`);
    try {
      await entry.ready;
      tracer.mark("idb-load");
      if (stale()) return bail();

      // Everything from fold to bind runs in ONE lock hold: an unlocked gap
      // between them lets a queued save (onLocalModify) merge a delta the
      // bind-time merge below re-applies from its own snapshot — duplicated
      // text for every peer. Snapshot and validate INSIDE the lock: Obsidian
      // swaps the editor's content to a new file before the file-open event
      // fires, so a pre-lock snapshot can be a DIFFERENT note's text —
      // folding that in was the note-corruption bug.
      let bound = false;
      await folder.docs.withLock(guid, async () => {
        tracer.mark("lock-wait");
        if (stale()) return;
        const info = cm.state.field(editorInfoField, false);
        if (info?.file?.path !== path) return;
        const baseText = cm.state.doc.toString();
        const docText = entry.ytext.toString();
        const agreedHash = folder.syncState.get(guid);
        if (
          entry.ytext.length > 0 &&
          baseText !== docText &&
          contentHash(baseText) !== agreedHash
        ) {
          // Divergence at open should be the exception (offline edits, first
          // open after an external write) — if it shows up on EVERY open,
          // something upstream stopped recording agreement; leave a scent.
          console.debug(
            `coedit: attach fold ${path}: editor=${baseText.length} doc=${docText.length} agreed=${agreedHash === undefined ? "none" : "stale"}`,
          );
          if (agreedHash !== undefined && contentHash(docText) === agreedHash) {
            // The doc still sits at the last disk agreement, so the editor
            // text is that state plus offline edits — equality-fold captures
            // exactly those edits.
            applyDiskDiff(entry.doc, entry.ytext, baseText);
          } else if (
            entry.lastAgreedText === undefined ||
            agreedHash === undefined ||
            contentHash(entry.lastAgreedText) !== agreedHash ||
            !mergeTypedEdits(entry.doc, entry.ytext, entry.lastAgreedText, baseText)
          ) {
            // The doc moved past the agreement (a lingering socket streamed
            // remote updates in) or the agreement is unknown (lost
            // syncState), and there's no clean merge base. applyDiskDiff
            // here would delete the remote edits and push the deletion —
            // keep the disk text as a conflict copy instead; the binding
            // below shows the doc's version.
            const copyRel = await folder.saveConflictCopy(folder.relPath(path), baseText);
            new Notice(
              `Coedit: this note received unsynced remote edits that couldn't be merged with ` +
                `your local version. Your version was kept as "${copyRel}".`,
              10000,
            );
          }
        }

        tracer.mark("fold");
        folder.docs.ensureProvider(guid);
        // Bind-local-first: with a loaded, non-empty local doc there is no
        // reason to block the click path on a server round-trip — remote
        // updates merge in through the CRDT whenever the socket catches up.
        // Only the recovery-seed case (empty local doc, non-empty editor)
        // needs the server's word before proceeding.
        if (entry.ytext.length === 0 && cm.state.doc.length > 0) {
          let online = true;
          if (entry.provider) {
            try {
              await whenSynced(entry.provider);
            } catch (err) {
              online = false;
              console.warn("coedit: editor attach offline", err);
            }
          } else {
            online = false;
          }
          if (stale()) return;
          if (entry.ytext.length === 0 && cm.state.doc.length > 0) {
            // Seeding needs BOTH: a synced provider (server really is empty)
            // and a completed IndexedDB load (`loaded`, never set by the
            // ready timeout) — seeding an unloaded doc would duplicate the
            // note when the slow load lands on top. Otherwise stay unbound;
            // edits still sync via the closed-file pipeline, and the next
            // scan retries.
            if (online && entry.loaded) {
              // Recovery seeding for a doc the server lost; normally the
              // creator seeded it at enroll time and this branch never runs.
              entry.ytext.insert(0, cm.state.doc.toString());
            } else {
              new Notice("Coedit: this note isn't ready to bind yet — it will connect automatically.");
              return;
            }
          }
        }
        tracer.mark("provider");
        if (stale()) return;
        const info2 = cm.state.field(editorInfoField, false);
        if (info2?.file?.path !== path || !entry.provider) return;

        // Anything typed while we were binding exists only in the editor;
        // merge it into the CRDT (fuzzy-positioned) rather than wiping it.
        // If the merge can't place, stay unbound — the editor keeps showing
        // the typed text, it reaches the doc through the closed-file
        // pipeline on save, and the next scan retries the bind.
        const typedText = cm.state.doc.toString();
        if (typedText !== baseText && !mergeTypedEdits(entry.doc, entry.ytext, baseText, typedText)) {
          return;
        }

        const target = entry.ytext.toString();
        entry.lastAgreedText = target;
        // Minimal diff instead of a whole-document replace: a full replace
        // forces a complete re-parse/re-highlight (a visible hitch, worst on
        // phones) and loses the scroll position.
        cm.dispatch({
          changes: diffToChanges(typedText, target),
          effects: this.compartment.reconfigure([
            // No awareness → yCollab skips its widget-based remote cursors,
            // which leave paint artifacts when Obsidian re-styles lines
            // (headings). remoteCursors() renders them as CM layers instead
            // and takes over publishing our own cursor.
            yCollab(entry.ytext, null),
            Prec.high(keymap.of(yUndoManagerKeymap)),
            commentsExtension(entry),
            edgeIndicators(entry, entry.provider.awareness),
            remoteCursors(entry, entry.provider.awareness),
          ]),
        });
        // Success: the ref now belongs to the binding; detach releases it.
        // No syncState update here: disk still holds baseText until
        // Obsidian's autosave, and recording agreement early arms a
        // destructive fold if we crash first. The first onLocalModify
        // records it once disk really matches.
        tracer.mark("dispatch");
        token.active = true;
        entry.boundCount++;
        bound = true;
      });
      if (!bound) return bail();
      ownsRef = false;
    } catch (err) {
      // Fail closed: never leave an active-looking token with no binding —
      // that silently stops the file from syncing in either direction.
      console.error("coedit: editor attach failed", err);
      try {
        cm.dispatch({ effects: this.compartment.reconfigure([]) });
      } catch {
        // View already gone.
      }
      bail();
    } finally {
      tracer.end();
    }
  }

  private detach(cm: EditorView): void {
    const token = this.bound.get(cm);
    if (!token) return;
    this.bound.delete(cm);
    // Pending attaches own their ref and release it themselves.
    if (token.active && this.plugin.folders.includes(token.folder)) {
      const entry = token.folder.docs.get(token.guid);
      if (entry.boundCount > 0) entry.boundCount--;
      token.folder.docs.release(token.guid);
    }
    cm.dispatch({ effects: this.compartment.reconfigure([]) });
  }
}
