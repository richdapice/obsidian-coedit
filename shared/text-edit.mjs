// Applying an edited text back into a live Y.Text, ported from the plugin's
// battle-hardened disk-sync.ts: line-first diffing (dmp's char diff blocks
// the thread for ~1s on checklist-heavy notes), char-refined small spans
// (whole-line replaces destroy the CRDT anchors concurrent edits attach to),
// surrogate healing (op boundaries mid-emoji mangle them under concurrent
// merges), and all-or-nothing fuzzy patching (partial application + retry
// duplicates text). Used by the daemon's @claude edit mode; plain ESM with
// yjs and diff-match-patch injected by import.

// No bare imports here: shared/ has no node_modules of its own. The caller
// injects its diff-match-patch constructor via createTextEdit().
const DIFF_TIMEOUT_S = 0.2;
const REFINE_MAX_CHARS = 3000;

const isHigh = (c) => c >= "\uD800" && c <= "\uDBFF";
const isLow = (c) => c >= "\uDC00" && c <= "\uDFFF";

export function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    if (isHigh(s[i])) {
      if (i + 1 >= s.length || !isLow(s[i + 1])) return true;
      i++;
    } else if (isLow(s[i])) {
      return true;
    }
  }
  return false;
}

export function createTextEdit(DiffMatchPatch) {
function healSplitSurrogates(diffs) {
  const EQ = DiffMatchPatch.DIFF_EQUAL;
  const DEL = DiffMatchPatch.DIFF_DELETE;
  const INS = DiffMatchPatch.DIFF_INSERT;
  for (let i = 0; i < diffs.length; i++) {
    if (diffs[i][0] !== EQ) continue;
    let text = diffs[i][1];
    if (text.length > 0 && isHigh(text[text.length - 1]) && i + 1 < diffs.length) {
      const hi = text[text.length - 1];
      diffs[i] = [EQ, text.slice(0, -1)];
      let end = i + 1;
      let hasDel = false;
      let hasIns = false;
      while (end < diffs.length && diffs[end][0] !== EQ) {
        if (diffs[end][0] === DEL) hasDel = true;
        else hasIns = true;
        end++;
      }
      if (!hasDel) {
        diffs.splice(i + 1, 0, [DEL, ""]);
        end++;
      }
      if (!hasIns) {
        diffs.splice(i + 1, 0, [INS, ""]);
        end++;
      }
      for (let k = i + 1; k < end; k++) diffs[k] = [diffs[k][0], hi + diffs[k][1]];
    }
    text = diffs[i][1];
    if (text.length > 0 && isLow(text[0]) && i > 0) {
      const lo = text[0];
      diffs[i] = [EQ, text.slice(1)];
      let start = i - 1;
      let hasDel = false;
      let hasIns = false;
      while (start >= 0 && diffs[start][0] !== EQ) {
        if (diffs[start][0] === DEL) hasDel = true;
        else hasIns = true;
        start--;
      }
      if (!hasDel) {
        diffs.splice(i, 0, [DEL, ""]);
        i++;
      }
      if (!hasIns) {
        diffs.splice(i, 0, [INS, ""]);
        i++;
      }
      for (let k = start + 1; k < i; k++) diffs[k] = [diffs[k][0], diffs[k][1] + lo];
    }
  }
  return diffs.filter(([, t]) => t.length > 0);
}

function lineDiff(a, b) {
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = DIFF_TIMEOUT_S;
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(a, b);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);
  const refined = [];
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
  return healSplitSurrogates(refined);
}

/** Make ytext EQUAL target via minimal line-first ops, inside one transact. */
function setTextTo(doc, ytext, target) {
  const current = ytext.toString();
  if (current === target) return;
  const diffs = lineDiff(current, target);
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
  }, "coedit-claude-edit");
}

/**
 * Re-express base→edited as fuzzy patches and apply them to `current` (which
 * may contain concurrent human edits). All-or-nothing: returns the merged
 * string, or null if any patch fails to place or the output would carry a
 * mangled emoji neither input had.
 */
function mergeEditedText(base, edited, current) {
  if (base === edited) return current;
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = DIFF_TIMEOUT_S;
  const patches = dmp.patch_make(base, edited);
  const [merged, results] = dmp.patch_apply(patches, current);
  if (!results.every(Boolean)) return null;
  if (hasLoneSurrogate(merged) && !hasLoneSurrogate(current) && !hasLoneSurrogate(edited)) {
    return null;
  }
  return merged;
}

/**
 * Full edit application: remove the mention+claim unit from the live text,
 * fuzzy-merge base→edited into that reduced text (all-or-nothing), then
 * splice the unit back at the diff-mapped position. Returns the final live
 * text, or null when the merge can't place cleanly.
 */
function mergeAroundUnit(base, edited, live, unitBounds) {
  const reduced = live.slice(0, unitBounds.start) + live.slice(unitBounds.end);
  const merged = mergeEditedText(base, edited, reduced);
  if (merged === null) return null;
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = DIFF_TIMEOUT_S;
  const diffs = dmp.diff_main(reduced, merged);
  const pos = dmp.diff_xIndex(diffs, unitBounds.start);
  return merged.slice(0, pos) + unitBounds.unit + merged.slice(pos);
}

return { setTextTo, mergeEditedText, mergeAroundUnit };
}
