import DiffMatchPatch from "diff-match-patch";
import type * as Y from "yjs";

/** Origin tag for transactions produced by disk reconciliation. */
const DISK_MERGE_ORIGIN = "coedit-disk-merge";

/**
 * Character-level diffing runs on the MAIN THREAD and hits dmp's 1-second
 * internal timeout on checklist-heavy notes (dozens of near-identical
 * "- [ ]" lines are Myers-diff's worst case) — measured as a full 1s UI
 * freeze per divergent note open. Everything here diffs line-first (the
 * standard dmp recipe, orders of magnitude faster) and caps the residual
 * character passes hard.
 */
const DIFF_TIMEOUT_S = 0.2;

/** Changed spans above this size stay line-coarse (a wholesale replace has
 *  no granularity worth preserving and char-diffing it is the slow case). */
const REFINE_MAX_CHARS = 3000;

/**
 * Line-first diff of a → b, with small changed spans re-diffed char-level.
 * The refinement is NOT cosmetic: whole-line delete+reinsert ops destroy the
 * CRDT anchors that a peer's concurrent edit inside or beside that line
 * attached to, scrambling the merge (see the offline-edits-survive test).
 * Char-precision ops within changed lines preserve those anchors; only
 * spans over REFINE_MAX_CHARS — where nothing fine-grained can be at stake —
 * stay coarse.
 */
function lineDiff(a: string, b: string): Array<[number, string]> {
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = DIFF_TIMEOUT_S;
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(a, b);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);
  const refined: Array<[number, string]> = [];
  for (let i = 0; i < diffs.length; i++) {
    const [op, text] = diffs[i];
    const next = diffs[i + 1];
    if (
      op === DiffMatchPatch.DIFF_DELETE &&
      next?.[0] === DiffMatchPatch.DIFF_INSERT &&
      text.length <= REFINE_MAX_CHARS &&
      next[1].length <= REFINE_MAX_CHARS
    ) {
      const sub = dmp.diff_main(text, next[1]);
      dmp.diff_cleanupSemantic(sub);
      refined.push(...sub);
      i++;
    } else {
      refined.push(diffs[i]);
    }
  }
  return refined;
}

/**
 * Fold a disk snapshot into a Y.Text by applying a diff as CRDT operations
 * in one transaction. This makes the Y.Text EQUAL the disk text — it is not
 * a merge. Callers must therefore fold disk edits into the local doc BEFORE
 * it receives remote updates; folding after a remote merge deletes the
 * remote edits (see disk-sync tests). Concurrent edits from other peers
 * arriving *after* this transaction merge through Yjs as usual.
 */
export function applyDiskDiff(doc: Y.Doc, ytext: Y.Text, diskText: string): void {
  const current = ytext.toString();
  if (current === diskText) return;
  const diffs = lineDiff(current, diskText);
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
  // Char-level here on purpose — fuzzy patches need character context to
  // re-place against a moved doc — but capped so a wholesale rewrite can't
  // stall the UI for the full internal 1s default.
  dmp.Diff_Timeout = DIFF_TIMEOUT_S;
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
  // Char-level ON PURPOSE: this feeds editor dispatches, where minimal
  // changes are the whole point (cursor/scroll stability). Inputs here are
  // near-identical (typed-while-binding delta), so it's fast; the timeout
  // cap bounds the pathological case.
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = DIFF_TIMEOUT_S;
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
  // Line granularity keeps this honest as well as fast: unrelated texts
  // share scattered characters but rarely whole lines.
  const diffs = lineDiff(before, after);
  let kept = 0;
  for (const [op, text] of diffs) {
    if (op === DiffMatchPatch.DIFF_EQUAL) kept += text.length;
  }
  return kept / before.length < 0.3;
}
