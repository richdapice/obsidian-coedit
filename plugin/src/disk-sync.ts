import DiffMatchPatch from "diff-match-patch";
import type * as Y from "yjs";

/** Origin tag for transactions produced by disk reconciliation. */
const DISK_MERGE_ORIGIN = "coedit-disk-merge";

/**
 * Fold a disk snapshot into a Y.Text by applying a diff-match-patch diff as
 * CRDT operations in one transaction. This makes the Y.Text EQUAL the disk
 * text — it is not a merge. Callers must therefore fold disk edits into the
 * local doc BEFORE it receives remote updates; folding after a remote merge
 * deletes the remote edits (see disk-sync tests). Concurrent edits from
 * other peers arriving *after* this transaction merge through Yjs as usual.
 */
export function applyDiskDiff(doc: Y.Doc, ytext: Y.Text, diskText: string): void {
  const current = ytext.toString();
  if (current === diskText) return;
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(current, diskText);
  dmp.diff_cleanupSemantic(diffs);
  doc.transact(() => {
    let pos = 0;
    for (const [op, text] of diffs) {
      if (op === DiffMatchPatch.DIFF_EQUAL) {
        pos += text.length;
      } else if (op === DiffMatchPatch.DIFF_DELETE) {
        ytext.delete(pos, text.length);
      } else {
        ytext.insert(pos, text);
        pos += text.length;
      }
    }
  }, DISK_MERGE_ORIGIN);
}

/**
 * Merge edits typed into an unbound editor (baseText → typedText) into a
 * Y.Text that may meanwhile contain remote edits. The typed delta is
 * expressed as fuzzy patches and re-applied against the current CRDT text,
 * so remote edits survive; overlapping edits resolve in the typist's favor.
 *
 * All-or-nothing: if ANY patch fails to place, the Y.Text is left untouched
 * and false is returned. Applying a partial merge and retrying later would
 * re-apply the already-placed patches (their context now matches) and
 * duplicate the edit — the caller must handle false (conflict copy, warn).
 */
export function mergeTypedEdits(
  doc: Y.Doc,
  ytext: Y.Text,
  baseText: string,
  typedText: string,
): boolean {
  if (baseText === typedText) return true;
  const dmp = new DiffMatchPatch();
  const patches = dmp.patch_make(baseText, typedText);
  const [merged, results] = dmp.patch_apply(patches, ytext.toString());
  if (!results.every(Boolean)) return false;
  applyDiskDiff(doc, ytext, merged);
  return true;
}

/**
 * Minimal CodeMirror change spec turning `fromText` into `toText`, via
 * diff-match-patch. Replacing a whole document on editor attach forces a
 * full re-parse/re-highlight (a visible hitch, worst on phones) and loses
 * the scroll position; dispatching only the changed ranges doesn't.
 */
export function diffToChanges(
  fromText: string,
  toText: string,
): Array<{ from: number; to: number; insert: string }> {
  if (fromText === toText) return [];
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(fromText, toText);
  dmp.diff_cleanupSemantic(diffs);
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  let pos = 0;
  let pendingInsert: string | null = null;
  for (const [op, text] of diffs) {
    if (op === DiffMatchPatch.DIFF_EQUAL) {
      if (pendingInsert !== null) {
        changes.push({ from: pos, to: pos, insert: pendingInsert });
        pendingInsert = null;
      }
      pos += text.length;
    } else if (op === DiffMatchPatch.DIFF_DELETE) {
      changes.push({ from: pos, to: pos + text.length, insert: pendingInsert ?? "" });
      pendingInsert = null;
      pos += text.length;
    } else {
      // Insert: hold it in case a delete follows at the same position (a
      // replace); positions are in the ORIGINAL document for CM changespecs.
      if (pendingInsert !== null) {
        changes.push({ from: pos, to: pos, insert: pendingInsert });
      }
      pendingInsert = text;
    }
  }
  if (pendingInsert !== null) {
    changes.push({ from: pos, to: pos, insert: pendingInsert });
  }
  return changes;
}

/**
 * Does turning `before` into `after` replace most of the document? Used as a
 * tripwire: wholesale replacements are occasionally legitimate (a script
 * rewriting a generated note) but are also the signature of paste-into-the-
 * wrong-note accidents and cross-write bugs — they should never be silent.
 */
export function isWholesaleChange(before: string, after: string): boolean {
  if (before.length < 500) return false;
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(before, after);
  // Without semantic cleanup, unrelated texts still share enough scattered
  // characters that the kept ratio never drops below the threshold.
  dmp.diff_cleanupSemantic(diffs);
  let kept = 0;
  for (const [op, text] of diffs) {
    if (op === DiffMatchPatch.DIFF_EQUAL) kept += text.length;
  }
  return kept / before.length < 0.3;
}
