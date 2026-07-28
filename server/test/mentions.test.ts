import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  findUnansweredMentions,
  formatReply,
  REPLY_HEADER,
} from "../../shared/mentions.mjs";
import type { YDocServer } from "../src/index";

const BASE = "https://example.com/parties/y-doc-server";

describe("mention protocol", () => {
  it("finds a bare mention and reports the end of its line", () => {
    const text = "# Note\n\n@claude what should we pack?\nmore text\n";
    const found = findUnansweredMentions(text);
    expect(found).toHaveLength(1);
    expect(text.slice(0, found[0].endOffset).endsWith("@claude what should we pack?")).toBe(true);
  });

  it("ignores quoted mentions (replies can never re-trigger)", () => {
    expect(findUnansweredMentions("> someone said @claude hi\n")).toHaveLength(0);
    expect(findUnansweredMentions(`${REPLY_HEADER}\n> @claude nested\n`)).toHaveLength(0);
  });

  it("treats a mention followed by a reply header as answered", () => {
    const text = `@claude hello\n${REPLY_HEADER}\n> hi!\n`;
    expect(findUnansweredMentions(text)).toHaveLength(0);
  });

  it("does not match emails or mid-word text", () => {
    expect(findUnansweredMentions("mail me@claudehotel.com please\n")).toHaveLength(0);
  });

  it("formatReply quotes every line and defangs @claude", () => {
    const reply = formatReply("Take two bags.\n\nAlso @claude says hi.");
    expect(reply.startsWith(`\n${REPLY_HEADER}\n`)).toBe(true);
    expect(reply).toContain("> Take two bags.");
    expect(reply).not.toMatch(/(^|\s)@claude\b/m);
    // A formatted reply inserted after a mention marks it answered.
    expect(findUnansweredMentions(`@claude hi${reply}\n`)).toHaveLength(0);
  });
});

describe("peer heartbeat endpoint", () => {
  it("stores a heartbeat and gates the fallback brain", async () => {
    const room = "room-hb-1";
    const res = await SELF.fetch(`${BASE}/${room}/peer-heartbeat?token=test-secret`, {
      method: "POST",
    });
    expect(res.status).toBe(204);
    const id = env.YDocServer.idFromName(room);
    await runInDurableObject(env.YDocServer.get(id), async (instance: YDocServer) => {
      const beat = await instance.ctx.storage.get<number>("peer:heartbeat");
      expect(typeof beat).toBe("number");
      expect(Date.now() - (beat as number)).toBeLessThan(10_000);
    });
  });

  it("rejects unauthenticated heartbeats", async () => {
    const res = await SELF.fetch(`${BASE}/room-hb2/peer-heartbeat`, { method: "POST" });
    expect(res.status).toBe(403);
  });
});

import { claimReply, STALE_CLAIM_MS } from "../../shared/mentions.mjs";

function twinDocs() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const sync = () => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  };
  return { a, b, sync };
}

describe("claimReply write path", () => {
  it("claims, updates, and leaves surrounding text intact", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("contents");
    ytext.insert(0, "# N\n\n@claude best ramen?\n\ntail text\n");
    const reply = claimReply(doc, ytext, "@claude best ramen?", "t1");
    expect(reply).not.toBeNull();
    expect(reply!.ownsClaim()).toBe(true);
    reply!.update("Ichiran.\nTry the kae-dama.");
    const text = ytext.toString();
    expect(text).toContain("@claude best ramen?\n> [!quote]+ 🤖 Claude");
    expect(text).toContain("> Ichiran.\n> Try the kae-dama.");
    expect(text).toContain("\n\ntail text\n"); // trailing structure untouched
    expect(findUnansweredMentions(text)).toHaveLength(0);
  });

  it("answers two mentions in one note at the right positions", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("contents");
    ytext.insert(0, "@claude first?\n\nmiddle\n\n@claude second?\n\nend\n");
    const r1 = claimReply(doc, ytext, "@claude first?", "t2");
    r1!.update("answer one");
    const r2 = claimReply(doc, ytext, "@claude second?", "t2");
    r2!.update("answer two");
    const text = ytext.toString();
    expect(text.indexOf("@claude first?\n> [!quote]")).toBeGreaterThan(-1);
    expect(text.indexOf("@claude second?\n> [!quote]")).toBeGreaterThan(-1);
    expect(text).toMatch(/> answer one\n> <!--\/claude:.*-->\n\nmiddle/);
    expect(text).toMatch(/> answer two\n> <!--\/claude:.*-->\n\nend/);
  });

  it("preserves user text typed at the mention/reply boundary mid-answer", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("contents");
    ytext.insert(0, "@claude pick a day\nrest\n");
    const reply = claimReply(doc, ytext, "@claude pick a day", "t3");
    // User keeps typing at the end of their mention line while "…" shows.
    const pos = ytext.toString().indexOf("pick a day") + "pick a day".length;
    ytext.insert(pos, " in October");
    reply!.update("The 24th.");
    const text = ytext.toString();
    expect(text).toContain("@claude pick a day in October");
    expect(text).toContain("> The 24th.");
    expect(text).toContain("\nrest\n");
  });

  it("converges to exactly one reply block when two brains race", () => {
    const { a, b, sync } = twinDocs();
    a.getText("contents").insert(0, "@claude race?\nafter\n");
    sync();
    const ra = claimReply(a, a.getText("contents"), "@claude race?", "brain-a");
    const rb = claimReply(b, b.getText("contents"), "@claude race?", "brain-b");
    expect(ra).not.toBeNull();
    expect(rb).not.toBeNull();
    sync();
    const owns = [ra!.ownsClaim(), rb!.ownsClaim()];
    sync();
    expect(owns.filter(Boolean)).toHaveLength(1);
    const text = a.getText("contents").toString();
    expect(text.match(/> \[!quote\]/g)).toHaveLength(1);
    expect(b.getText("contents").toString()).toBe(text);
    const winner = owns[0] ? ra! : rb!;
    winner.update("won the race");
    sync();
    expect(a.getText("contents").toString()).toContain("> won the race");
    expect(a.getText("contents").toString()).toContain("\nafter\n");
  });

  it("adopts an orphaned placeholder claim after STALE_CLAIM_MS", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("contents");
    const oldTs = Date.now() - STALE_CLAIM_MS - 60_000;
    ytext.insert(
      0,
      `@claude stuck?\n> [!quote]+ 🤖 Claude <!--claude:dead:${oldTs}:abc123-->\n> …\n> <!--/claude:dead:${oldTs}:abc123-->\nrest\n`,
    );
    expect(findUnansweredMentions(ytext.toString())[0]?.staleClaim).toBe(true);
    const reply = claimReply(doc, ytext, "@claude stuck?", "rescuer");
    expect(reply).not.toBeNull();
    reply!.update("rescued answer");
    const text = ytext.toString();
    expect(text.match(/> \[!quote\]/g)).toHaveLength(1);
    expect(text).toContain("rescuer");
    expect(text).not.toContain("claude:dead");
    expect(text).toContain("> rescued answer");
    expect(text).toContain("\nrest\n");
  });
});

describe("review-found critical fixtures", () => {
  it("never absorbs a user blockquote directly below the mention", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("contents");
    ytext.insert(
      0,
      "@claude summarize this:\n> IMPORTANT quoted email line 1\n> quoted line 2\nrest\n",
    );
    const reply = claimReply(doc, ytext, "@claude summarize this:", "t5");
    expect(reply).not.toBeNull();
    expect(reply!.ownsClaim()).toBe(true);
    reply!.update("Summary: it's important.");
    const text = ytext.toString();
    expect(text).toContain("> IMPORTANT quoted email line 1");
    expect(text).toContain("> quoted line 2");
    expect(text).toContain("> Summary: it's important.");
    expect(text).toContain("\nrest\n");
    // And a retract must not touch the user's quotes either.
    const doc2 = new Y.Doc();
    const yt2 = doc2.getText("contents");
    yt2.insert(0, "@claude summarize this:\n> keep me\nrest\n");
    const r2 = claimReply(doc2, yt2, "@claude summarize this:", "t5");
    r2!.retract();
    expect(yt2.toString()).toBe("@claude summarize this:\n> keep me\nrest\n");
  });

  it("answers duplicate identical mention lines without churn", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("contents");
    ytext.insert(0, "@claude same question\n\nmiddle\n\n@claude same question\n\nend\n");
    const r1 = claimReply(doc, ytext, "@claude same question", "t6");
    expect(r1!.ownsClaim()).toBe(true);
    r1!.update("first instance answer");
    // Second identical mention must be claimable and OWNED (the old
    // prompt-text lookup saw the first instance's block and retracted).
    const r2 = claimReply(doc, ytext, "@claude same question", "t6");
    expect(r2).not.toBeNull();
    expect(r2!.ownsClaim()).toBe(true);
    r2!.update("second instance answer");
    const text = ytext.toString();
    expect(text).toContain("first instance answer");
    expect(text).toContain("second instance answer");
    expect(findUnansweredMentions(text)).toHaveLength(0);
    expect(text.match(/> \[!quote\]/g)).toHaveLength(2);
  });
});

describe("markerless-block fail-safe", () => {
  it("halts writes instead of absorbing when the end marker is deleted", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("contents");
    ytext.insert(0, "@claude go\n> keep this user quote\nrest\n");
    const reply = claimReply(doc, ytext, "@claude go", "t7");
    reply!.update("partial answer");
    // User deletes our marker line mid-stream.
    const text = ytext.toString();
    const marker = text.split("\n").find((l) => l.startsWith("> <!--/claude:"));
    const at = text.indexOf(marker);
    ytext.delete(at - 1, marker.length + 1);
    expect(reply!.update("longer partial answer")).toBe(false);
    const after = ytext.toString();
    expect(after).toContain("> keep this user quote");
    expect(after).toContain("> partial answer");
    expect(after).toContain("\nrest\n");
  });
});

import { editSystemPrompt, parseEditInstruction, stripLine } from "../../shared/mentions.mjs";
import DiffMatchPatch from "diff-match-patch";
import { createTextEdit, hasLoneSurrogate as tHasLone } from "../../shared/text-edit.mjs";
const { mergeEditedText, setTextTo } = createTextEdit(DiffMatchPatch);

describe("edit mode protocol", () => {
  it("parses explicit edit instructions only", () => {
    expect(parseEditInstruction("@claude edit: fix the typos")).toBe("fix the typos");
    expect(parseEditInstruction("- @claude EDIT:  dedupe this list ")).toBe("dedupe this list");
    expect(parseEditInstruction("@claude what should we edit?")).toBeNull();
    expect(parseEditInstruction("@claude edit:")).toBeNull();
  });

  it("stripLine removes exactly the mention line", () => {
    const text = "a\n@claude edit: go\nb\n";
    expect(stripLine(text, "@claude edit: go")).toBe("a\nb\n");
    expect(stripLine(text, "not there")).toBe(text);
  });

  it("editSystemPrompt never contains an unquoted trigger", () => {
    const p = editSystemPrompt("Trip.md", "shorten it");
    expect(findUnansweredMentions(p)).toHaveLength(0);
  });
});

describe("text-edit application", () => {
  it("setTextTo makes the doc equal the target exactly (emoji intact)", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("contents");
    ytext.insert(0, "# 🍣 List\n- [ ] a\n- [ ] b\n");
    setTextTo(doc, ytext, "# 🍜 List\n- [x] a\n- [ ] c\n");
    expect(ytext.toString()).toBe("# 🍜 List\n- [x] a\n- [ ] c\n");
    expect(tHasLone(ytext.toString())).toBe(false);
  });

  it("mergeEditedText keeps concurrent human edits", () => {
    const base = "# Packing\n- socks\n- shirts\n- chargers\n";
    const edited = "# Packing\n- socks (7 pairs)\n- shirts\n- chargers\n";
    const current = "# Packing\n- socks\n- shirts\n- chargers\n- HUMAN ADDED THIS\n";
    const merged = mergeEditedText(base, edited, current);
    expect(merged).toContain("- socks (7 pairs)");
    expect(merged).toContain("- HUMAN ADDED THIS");
  });

  it("mergeEditedText is all-or-nothing on unplaceable patches", () => {
    const base = "the quick brown fox\njumps over\nthe lazy dog\n";
    const edited = "the quick brown fox\njumps over EDIT\nthe lazy dog\n";
    const current = "completely unrelated content now\n".repeat(5);
    expect(mergeEditedText(base, edited, current)).toBeNull();
  });

  it("edit application around a live mention + claim block", () => {
    // The live doc holds the mention and our claim; patches from the
    // stripped base must still land around them.
    const doc = new Y.Doc();
    const ytext = doc.getText("contents");
    ytext.insert(0, "# Note\n\n@claude edit: capitalize the title\n\nbody line\n");
    const text0 = ytext.toString();
    const reply = claimReply(doc, ytext, "@claude edit: capitalize the title", "t-edit");
    const base = stripLine(text0, "@claude edit: capitalize the title");
    const edited = base.replace("# Note", "# NOTE");
    const merged = mergeEditedText(base, edited, ytext.toString());
    expect(merged).not.toBeNull();
    setTextTo(doc, ytext, merged!);
    reply!.update("✏️ Done — capitalized the title");
    const text = ytext.toString();
    expect(text).toContain("# NOTE");
    expect(text).toContain("@claude edit: capitalize the title");
    expect(text).toContain("> ✏️ Done — capitalized the title");
    expect(text).toContain("body line");
    expect(findUnansweredMentions(text)).toHaveLength(0);
  });
});

describe("edit self-trigger guard", () => {
  it("flags edits that mint new mentions and passes edits that don't", async () => {
    const { addsNewMentions } = await import("../../shared/mentions.mjs");
    const base = "# N\n\n@claude keep me\n\nbody\n";
    expect(addsNewMentions(base, base.replace("body", "body\n@claude new trigger"))).toBe(true);
    expect(addsNewMentions(base, base.replace("body", "changed body"))).toBe(false);
  });
});

import { locateMentionUnit } from "../../shared/mentions.mjs";
const { mergeAroundUnit } = createTextEdit(DiffMatchPatch);

describe("edit misplacement regression (review-demonstrated)", () => {
  it("checks off the twin BELOW the mention, not the identical twin above", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("contents");
    ytext.insert(
      0,
      "# Tickets\n- [ ] buy tickets\n@claude edit: check off the item below\n- [ ] buy tickets\nrest\n",
    );
    const text0 = ytext.toString();
    const prompt = "@claude edit: check off the item below";
    const reply = claimReply(doc, ytext, prompt, "t-twin");
    const base = stripLine(text0, prompt);
    // Claude checks the SECOND twin (the one below the mention in base order).
    const edited = base.replace(
      "- [ ] buy tickets\n- [ ] buy tickets",
      "- [ ] buy tickets\n- [x] buy tickets",
    );
    const live = ytext.toString();
    const unit = locateMentionUnit(live, prompt, reply!.nonce);
    expect(unit).not.toBeNull();
    const final = mergeAroundUnit(base, edited, live, unit!);
    expect(final).not.toBeNull();
    setTextTo(doc, ytext, final!);
    reply!.update("✏️ Done");
    const text = ytext.toString();
    const above = text.indexOf("- [ ] buy tickets");
    const mentionAt = text.indexOf(prompt);
    const below = text.indexOf("- [x] buy tickets");
    // Unchecked twin stays ABOVE the mention; checked twin sits BELOW it.
    expect(above).toBeGreaterThan(-1);
    expect(above).toBeLessThan(mentionAt);
    expect(below).toBeGreaterThan(mentionAt);
    expect(text).toContain("rest");
  });

  it("keeps concurrent human edits while splicing the unit back", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("contents");
    ytext.insert(0, "alpha\n@claude edit: tweak beta\nbeta\ngamma\n");
    const prompt = "@claude edit: tweak beta";
    const text0 = ytext.toString();
    const reply = claimReply(doc, ytext, prompt, "t-cc");
    const base = stripLine(text0, prompt);
    const edited = base.replace("beta", "beta (tweaked)");
    // Human edits far away while Claude works:
    ytext.insert(ytext.toString().indexOf("gamma"), "HUMAN\n");
    const live = ytext.toString();
    const unit = locateMentionUnit(live, prompt, reply!.nonce);
    const final = mergeAroundUnit(base, edited, live, unit!);
    expect(final).toContain("beta (tweaked)");
    expect(final).toContain("HUMAN");
    expect(final).toContain(prompt);
  });
});

describe("edit guard strength", () => {
  it("addsNewMentions catches swap-one-for-another", async () => {
    const { addsNewMentions } = await import("../../shared/mentions.mjs");
    const base = "@claude old question\nbody\n";
    const swapped = "@claude brand new question\nbody\n";
    expect(addsNewMentions(base, swapped)).toBe(true);
  });
});

describe("deployment context", () => {
  it("prompts use the injected context and a generic default", async () => {
    const { systemPrompt, editSystemPrompt, DEFAULT_CONTEXT } = await import("../../shared/mentions.mjs");
    expect(systemPrompt(null)).toContain(DEFAULT_CONTEXT);
    expect(systemPrompt(null, "the robotics club wiki")).toContain("the robotics club wiki");
    expect(editSystemPrompt("N.md", "fix", "the robotics club wiki")).toContain("the robotics club wiki");
    expect(systemPrompt(null)).not.toMatch(/Japan/);
    expect(editSystemPrompt("N.md", "fix")).not.toMatch(/Japan/);
  });
});
