import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyDiskDiff, mergeTypedEdits } from "../src/disk-sync";

function docWith(text: string): { doc: Y.Doc; ytext: Y.Text } {
  const doc = new Y.Doc();
  const ytext = doc.getText("contents");
  ytext.insert(0, text);
  return { doc, ytext };
}

/** Two-way sync between docs, as providers would do. */
function syncDocs(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

describe("applyDiskDiff", () => {
  it("replays offline local edits as minimal ops", () => {
    const { doc, ytext } = docWith("hello world\nsecond line\n");
    applyDiskDiff(doc, ytext, "hello brave world\nsecond line\n");
    expect(ytext.toString()).toBe("hello brave world\nsecond line\n");
  });

  it("offline local edits survive CRDT merge with concurrent remote edits", () => {
    // Both peers start from the same synced base.
    const { doc: local, ytext: localText } = docWith("hello world\nsecond line\n");
    const remote = new Y.Doc();
    syncDocs(local, remote);
    const remoteText = remote.getText("contents");

    // Remote edits the second line while we're offline...
    remoteText.insert(remoteText.toString().indexOf("second"), "the ");
    // ...and our user edited the first line on disk, outside the CRDT.
    applyDiskDiff(local, localText, "hello brave world\nsecond line\n");

    syncDocs(local, remote);
    expect(localText.toString()).toBe("hello brave world\nthe second line\n");
    expect(remoteText.toString()).toBe(localText.toString());
  });

  it("makes the CRDT equal the disk snapshot (NOT a merge — callers must fold disk in before remote updates)", () => {
    // This documents why sync order matters: if remote edits are already in
    // the Y.Text and the disk snapshot predates them, the diff removes them.
    // The sync pipeline therefore folds disk edits into the idb-persisted
    // local doc BEFORE connecting/pulling, and lets Yjs merge remote edits.
    const { doc, ytext } = docWith("alpha\nbeta\ngamma\n");
    ytext.insert(ytext.toString().indexOf("gamma"), "remote-inserted\n");
    applyDiskDiff(doc, ytext, "alpha edited\nbeta\ngamma\n");
    expect(ytext.toString()).toBe("alpha edited\nbeta\ngamma\n");
  });

  it("no-ops on identical content", () => {
    const { doc, ytext } = docWith("same\n");
    const before = Y.encodeStateVector(doc);
    applyDiskDiff(doc, ytext, "same\n");
    expect(Y.encodeStateVector(doc)).toEqual(before);
  });
});

describe("mergeTypedEdits", () => {
  it("keeps remote edits that arrived while the user was typing unbound", () => {
    // Editor loaded baseText; user typed on line 1 while a remote edit to
    // line 3 landed in the CRDT.
    const base = "alpha\nbeta\ngamma\n";
    const { doc, ytext } = docWith(base);
    ytext.insert(ytext.toString().indexOf("gamma"), "remote-inserted\n");

    mergeTypedEdits(doc, ytext, base, "alpha typed\nbeta\ngamma\n");

    const result = ytext.toString();
    expect(result).toContain("alpha typed");
    expect(result).toContain("remote-inserted");
  });

  it("no-ops when nothing was typed", () => {
    const { doc, ytext } = docWith("text\n");
    const before = Y.encodeStateVector(doc);
    mergeTypedEdits(doc, ytext, "text\n", "text\n");
    expect(Y.encodeStateVector(doc)).toEqual(before);
  });
});

describe("diffToChanges", () => {
  const apply = (text: string, changes: Array<{ from: number; to: number; insert: string }>) => {
    // Apply like CM does: all positions refer to the original document.
    let result = "";
    let last = 0;
    for (const c of [...changes].sort((a, b) => a.from - b.from)) {
      result += text.slice(last, c.from) + c.insert;
      last = c.to;
    }
    return result + text.slice(last);
  };

  it("returns no changes for identical text", async () => {
    const { diffToChanges } = await import("../src/disk-sync");
    expect(diffToChanges("same", "same")).toEqual([]);
  });

  it("produces a small change for a small edit", async () => {
    const { diffToChanges } = await import("../src/disk-sync");
    const a = "line one\nline two\nline three\n";
    const b = "line one\nline 2\nline three\n";
    const changes = diffToChanges(a, b);
    expect(apply(a, changes)).toBe(b);
    // The edit is localized — nowhere near a full-document replace.
    const touched = changes.reduce((n, c) => n + (c.to - c.from) + c.insert.length, 0);
    expect(touched).toBeLessThan(12);
  });

  it("handles replaces, pure inserts, and pure deletes", async () => {
    const { diffToChanges } = await import("../src/disk-sync");
    const cases: Array<[string, string]> = [
      ["abc def ghi", "abc XYZ ghi"],
      ["abc ghi", "abc def ghi"],
      ["abc def ghi", "abc ghi"],
      ["", "hello"],
      ["hello", ""],
      ["a\nb\nc", "c\nb\na"],
    ];
    for (const [a, b] of cases) {
      expect(apply(a, diffToChanges(a, b))).toBe(b);
    }
  });
});

describe("isWholesaleChange", () => {
  it("flags a near-total replacement", async () => {
    const { isWholesaleChange } = await import("../src/disk-sync");
    const packing = "# Packing\n" + "- socks\n- shirts\n- chargers\n".repeat(30);
    const tickets = "# Ticket Watch\n" + "- USJ express pass\n- teamLab slots\n".repeat(30);
    expect(isWholesaleChange(packing, tickets)).toBe(true);
  });
  it("does not flag ordinary edits or short docs", async () => {
    const { isWholesaleChange } = await import("../src/disk-sync");
    const doc = "# Notes\n" + "line of steady content here\n".repeat(40);
    expect(isWholesaleChange(doc, doc + "one new line\n")).toBe(false);
    expect(isWholesaleChange("tiny", "different")).toBe(false);
  });
});

describe("mergeTypedEdits all-or-nothing", () => {
  it("returns true and merges when patches place cleanly", async () => {
    const Y = await import("yjs");
    const { mergeTypedEdits } = await import("../src/disk-sync");
    const doc = new Y.Doc();
    const ytext = doc.getText("contents");
    ytext.insert(0, "alpha\nbravo\ncharlie\n");
    // Remote edit already in the doc:
    ytext.insert(0, "REMOTE\n");
    const ok = mergeTypedEdits(doc, ytext, "alpha\nbravo\ncharlie\n", "alpha\nbravo EDIT\ncharlie\n");
    expect(ok).toBe(true);
    expect(ytext.toString()).toBe("REMOTE\nalpha\nbravo EDIT\ncharlie\n");
  });

  it("leaves the doc untouched and returns false when a patch cannot place", async () => {
    const Y = await import("yjs");
    const { mergeTypedEdits } = await import("../src/disk-sync");
    const doc = new Y.Doc();
    const ytext = doc.getText("contents");
    ytext.insert(0, "completely unrelated document text with nothing in common at all\n".repeat(4));
    const before = ytext.toString();
    const base = "the quick brown fox\njumps over\nthe lazy dog\n";
    const typed = "the quick brown fox\njumps over EDIT\nthe lazy dog\n";
    const ok = mergeTypedEdits(doc, ytext, base, typed);
    expect(ok).toBe(false);
    expect(ytext.toString()).toBe(before);
  });
});
