import DiffMatchPatch from "diff-match-patch";
import type * as Y from "yjs";
import { contentHash } from "./paths";

/** Origin tag for transactions produced by disk reconciliation. */
export const DISK_MERGE_ORIGIN = "relay-clone-disk-merge";

export type SyncAction =
  | "noop" // disk and CRDT agree
  | "write-disk" // CRDT moved ahead; disk is stale
  | "apply-local" // disk has offline local edits; CRDT is at our last-synced state
  | "merge-diverged"; // both moved; fold disk into CRDT positionally

/**
 * Decide how to reconcile a file from three hashes: the disk content, the
 * CRDT text, and the hash we recorded the last time we saw them agree.
 * With no record (fresh join, cleared state) both-differ falls through to a
 * positional merge, which is safe but may interleave imperfectly.
 */
export function decideSyncAction(
  diskHash: string,
  ytextHash: string,
  lastSyncedHash: string | undefined,
): SyncAction {
  if (diskHash === ytextHash) return "noop";
  if (diskHash === lastSyncedHash) return "write-disk";
  if (ytextHash === lastSyncedHash) return "apply-local";
  return "merge-diverged";
}

/**
 * Fold a disk snapshot into a Y.Text by applying a diff-match-patch diff as
 * CRDT operations in one transaction. Concurrent remote edits already in the
 * Y.Text survive wherever the diff doesn't touch them; edits made by other
 * peers *after* this transaction merge through Yjs as usual.
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

/** Convenience wrapper used by callers that only have strings. */
export function hashOf(text: string): string {
  return contentHash(text);
}
