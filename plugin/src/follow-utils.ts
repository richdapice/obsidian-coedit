import type * as Y from "yjs";

/**
 * Pure helpers for edit-based follow: when a peer edits inside Obsidian's
 * table sub-editor (or any nested widget), the main editor is unfocused and
 * y-codemirror stops publishing their cursor — but their edits still arrive,
 * and the position of those edits is where they are.
 */

export interface DeltaOp {
  retain?: number;
  insert?: string | object;
  delete?: number;
}

/** Caret-like position of the first change in a Y text delta (end of an insert, start of a delete). */
export function deltaChangePosition(delta: readonly DeltaOp[]): number | null {
  let pos = 0;
  for (const op of delta) {
    if (op.retain) {
      pos += op.retain;
      continue;
    }
    if (typeof op.insert === "string") return pos + op.insert.length;
    if (op.insert) return pos + 1;
    if (op.delete !== undefined) return pos;
  }
  return null;
}

/**
 * Did this transaction insert content authored by `clientId`? New structs
 * advance the author's clock in the state vector, so this attributes inserts
 * reliably even when several peers edit concurrently. (Deletions can't be
 * attributed this way — the delete set is keyed by the deleted content's
 * original author, not the deleter — so pure deletions are ignored.)
 */
export function clientInserted(txn: Y.Transaction, clientId: number): boolean {
  const before = txn.beforeState.get(clientId) ?? 0;
  const after = txn.afterState.get(clientId) ?? 0;
  return after > before;
}

/**
 * Is `clientId` the ONLY client whose clock advanced in this transaction?
 * Batched updates (reconnect catch-up) can carry several authors' inserts in
 * one transaction; the delta position is then ambiguous and following it
 * could jump to someone else's edit.
 */
export function soleInserter(txn: Y.Transaction, clientId: number): boolean {
  if (!clientInserted(txn, clientId)) return false;
  for (const [otherId, after] of txn.afterState) {
    if (otherId === clientId) continue;
    if (after > (txn.beforeState.get(otherId) ?? 0)) return false;
  }
  return true;
}
