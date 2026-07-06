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
 */
export function mergeTypedEdits(
  doc: Y.Doc,
  ytext: Y.Text,
  baseText: string,
  typedText: string,
): void {
  if (baseText === typedText) return;
  const dmp = new DiffMatchPatch();
  const patches = dmp.patch_make(baseText, typedText);
  const [merged] = dmp.patch_apply(patches, ytext.toString());
  applyDiskDiff(doc, ytext, merged);
}
