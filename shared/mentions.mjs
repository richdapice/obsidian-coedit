// The @claude mention protocol, shared VERBATIM by both brains (the Mac
// daemon and the Durable Object responder) so they agree byte-for-byte on
// what counts as a mention, what counts as answered, and what a reply looks
// like. Plain ESM so Node imports it directly and wrangler bundles it.

/** Reply block header prefix. An Obsidian callout: renders titled and collapsible. */
export const REPLY_HEADER = "> [!quote]+ 🤖 Claude";

/** Ownership tag appended to the header: which brain claimed it, and when. */
const CLAIM_TAG_RE = /<!--claude:([a-z0-9-]+:(\d+):[a-z0-9]+)-->/;

/** A claim whose body is still the placeholder after this long is orphaned
 *  (its brain crashed mid-answer) and may be adopted by any brain. */
export const STALE_CLAIM_MS = 3 * 60 * 1000;

/** Requests-per-UTC-day cap for the daemon brain. */
export const DAILY_CAP = 50;
/** Hard ceiling on reply length (characters) inserted into a note. */
export const MAX_REPLY_CHARS = 8000;

const PLACEHOLDER = "…";

/**
 * A mention is a line containing "@claude" that is not itself quoted (so
 * replies and quoted history can never re-trigger — the anti-loop rule this
 * codebase has earned the hard way).
 */
const MENTION_RE = /(^|\s)@claude\b/;

/** Consecutive quoted lines starting at `line`. */
function quotedRun(lines, line) {
  let n = 0;
  while (line + n < lines.length && lines[line + n].startsWith(">")) n++;
  return n;
}

const endMarker = (nonce) => `> <!--/claude:${nonce}-->`;

/**
 * Extent (line count incl. header) of the reply block at `headerLine`.
 * Blocks written by this protocol end with a nonce-scoped marker line, so
 * their extent is exact BY CONSTRUCTION — a user blockquote directly below
 * the reply must never be absorbed into our bounds (review found claim/
 * retract deleting a quoted email that followed a mention). Blocks without
 * a tag (foreign/legacy) fall back to the contiguous quoted run.
 */
function blockExtent(lines, headerLine) {
  const tag = lines[headerLine].match(CLAIM_TAG_RE);
  const run = quotedRun(lines, headerLine);
  if (tag) {
    const marker = endMarker(tag[1]);
    for (let j = 1; j < run; j++) {
      if (lines[headerLine + j] === marker) return j + 1;
    }
    // Tagged but the marker is gone (user edited inside the block): the
    // block's true extent is unknowable. Returning the contiguous run here
    // absorbed — and destroyed — user quotes below the block in review;
    // report "unknown" instead so writers halt rather than guess.
    return -1;
  }
  return run;
}

/**
 * Scan a note and return actionable mentions: unanswered ones, plus ones
 * whose claim is an orphaned placeholder older than STALE_CLAIM_MS
 * (returned with staleClaim=true so the answering brain replaces the block).
 * A mention counts as answered when a REPLY_HEADER appears within the next
 * two lines (the reply sits directly under the mention's paragraph).
 */
export function findUnansweredMentions(text, now = Date.now()) {
  const lines = text.split("\n");
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(">")) continue; // quoted — never a trigger
    if (!MENTION_RE.test(line)) continue;
    let headerLine = -1;
    for (const j of [i + 1, i + 2]) {
      if ((lines[j] ?? "").startsWith(REPLY_HEADER)) {
        headerLine = j;
        break;
      }
    }
    let staleClaim = false;
    if (headerLine !== -1) {
      const extent = blockExtent(lines, headerLine);
      if (extent === -1) continue; // damaged block: leave the mention alone
      const tag = lines[headerLine].match(CLAIM_TAG_RE);
      const body = lines
        .slice(headerLine + 1, headerLine + extent)
        .filter((l) => !/^> <!--\/claude:/.test(l))
        .map((l) => l.replace(/^> ?/, ""))
        .join("\n")
        .trim();
      const claimedAt = tag ? Number(tag[2]) : NaN;
      const orphaned =
        tag !== null && body === PLACEHOLDER && now - claimedAt > STALE_CLAIM_MS;
      if (!orphaned) continue; // genuinely answered (or actively being answered)
      staleClaim = true;
    }
    let offset = 0;
    for (let j = 0; j < i; j++) offset += lines[j].length + 1;
    found.push({ line: i, endOffset: offset + line.length, prompt: line, staleClaim });
  }
  return found;
}

/** Quote an answer's lines; defang @claude with a zero-width space so a
 *  reply can never look like a mention even if quoting breaks. */
function quoteBody(answer) {
  return answer
    .replace(/@claude/gi, "@\u200Bclaude")
    .split("\n")
    .map((l) => (l.length > 0 ? `> ${l}` : ">"))
    .join("\n");
}

/** A full untagged reply block (tests + display). */
export function formatReply(answer) {
  return `\n${REPLY_HEADER}\n${quoteBody(answer)}`;
}

/** System prompt shared by both brains. */
export function systemPrompt(notePath) {
  const where = notePath ? `the note "${notePath}"` : "a shared note";
  return [
    "You are Claude, a collaborator inside a family's shared Obsidian folder for planning a Japan trip.",
    `You were mentioned in ${where}. The full note is provided; answer the @claude request in it.`,
    "Reply in concise Markdown suitable for pasting into the note. No preamble, no sign-off.",
    "Never write the literal text @claude in your reply.",
  ].join(" ");
}

/**
 * The write path both brains share. All positions are RE-LOCATED BY TEXT
 * SCAN at every write (the nonce in our header makes our block findable) —
 * never carried as offsets across awaits, because offset arithmetic under
 * concurrent edits destroys user text. Flow:
 *
 *   const reply = claimReply(doc, ytext, prompt, brainId);
 *   if (!reply) return;                              // gone / already claimed
 *   await settle(); if (!reply.ownsClaim()) return;  // lost a claim race
 *   reply.update(partialAnswer); ... reply.update(fullAnswer);
 *
 * Claim races converge: after sync both brains see the same block order;
 * ownsClaim() keeps only the first block after the mention, and the loser
 * deletes its own.
 */
export function claimReply(doc, ytext, prompt, brainId) {
  // Millisecond timestamps collide for same-tick claims (seen in tests) —
  // the random suffix makes every claim's nonce unique.
  const nonce = `${brainId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const header = `${REPLY_HEADER} <!--claude:${nonce}-->`;

  /** Bounds of OUR block: [start, end) — start is the leading newline we
   *  inserted; end is just past the last quoted character, EXCLUDING the
   *  newline that separates the block from the rest of the note. */
  const locateOwn = () => {
    const text = ytext.toString();
    const lines = text.split("\n");
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(REPLY_HEADER) && lines[i].includes(nonce)) {
        const count = blockExtent(lines, i);
        if (count === -1) return null; // our marker vanished: stop writing
        let end = offset;
        for (let j = 0; j < count; j++) end += lines[i + j].length + 1;
        end = Math.min(end - 1, text.length); // back off the trailing newline
        const start = offset > 0 && text[offset - 1] === "\n" ? offset - 1 : offset;
        return { start, end };
      }
      offset += lines[i].length + 1;
    }
    return null;
  };

  /** Bounds ([start, end), same semantics as locateOwn) of whatever reply
   *  block is currently attached to `mention`, whoever wrote it. */
  const locateAttached = (text, mention) => {
    const lines = text.split("\n");
    for (const j of [mention.line + 1, mention.line + 2]) {
      if ((lines[j] ?? "").startsWith(REPLY_HEADER)) {
        let offset = 0;
        for (let k = 0; k < j; k++) offset += lines[k].length + 1;
        const count = blockExtent(lines, j);
        if (count === -1) return null; // damaged block: don't touch it
        let end = offset;
        for (let k = 0; k < count; k++) end += lines[j + k].length + 1;
        end = Math.min(end - 1, text.length);
        return { start: offset - 1, end };
      }
    }
    return null;
  };

  // Fresh scan at claim time: the mention may have been answered, moved, or
  // edited since the caller scanned. Stale-claim adoption and the new claim
  // happen in ONE transaction so no scanner ever sees the in-between state.
  doc.transact(() => {
    const current = findUnansweredMentions(ytext.toString()).find((m) => m.prompt === prompt);
    if (!current) return;
    if (current.staleClaim) {
      const dead = locateAttached(ytext.toString(), current);
      if (dead) ytext.delete(dead.start, dead.end - dead.start);
    }
    const fresh = findUnansweredMentions(ytext.toString(), 0).find((m) => m.prompt === prompt);
    if (fresh && !fresh.staleClaim)
      ytext.insert(fresh.endOffset, `\n${header}\n> ${PLACEHOLDER}\n${endMarker(nonce)}`);
  });
  if (locateOwn() === null) return null;

  return {
    /**
     * True while OUR block is the first reply attached to the mention.
     * A losing racer deletes its own block and reports false.
     */
    ownsClaim() {
      // Instance-adjacent: identify the mention by walking UP from OUR
      // block, not by searching for the prompt text — duplicate identical
      // mention lines otherwise made a legitimate second claim look foreign
      // and churn forever (review-confirmed loop).
      const lines = ytext.toString().split("\n");
      let h = -1;
      let offset = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith(REPLY_HEADER) && lines[i].includes(nonce)) {
          h = i;
          break;
        }
        offset += lines[i].length + 1;
      }
      if (h > 0) {
        let m = h - 1;
        if ((lines[m] ?? "").trim() === "" && m > 0) m--; // tolerate one blank
        const l = lines[m] ?? "";
        if (!l.startsWith(">") && l === prompt) return true;
      }
      this.retract();
      return false;
    },

    /** Replace our block's body with (a longer prefix of) the answer. */
    update(answer) {
      const bounds = locateOwn();
      if (!bounds) return false;
      const replacement = `\n${header}\n${quoteBody(answer.slice(0, MAX_REPLY_CHARS))}\n${endMarker(nonce)}`;
      doc.transact(() => {
        ytext.delete(bounds.start, bounds.end - bounds.start);
        ytext.insert(bounds.start, replacement);
      });
      return true;
    },

    /** Delete our block (lost race / mention vanished). */
    retract() {
      const bounds = locateOwn();
      if (!bounds) return;
      doc.transact(() => ytext.delete(bounds.start, bounds.end - bounds.start));
    },
  };
}
