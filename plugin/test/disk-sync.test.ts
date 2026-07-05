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
