import { describe, expect, it } from "vitest";
import {
  classifyOpenModify,
  classifyMapDelta,
  contentHash,
  type FileMeta,
  isUnder,
  joinPath,
  toRelative,
} from "../src/paths";

const meta = (guid: string): FileMeta => ({ guid, hash: "h", mtime: 0 });

describe("path helpers", () => {
  it("isUnder matches strict children only", () => {
    expect(isUnder("Shared", "Shared/a.md")).toBe(true);
    expect(isUnder("Shared", "Shared/sub/a.md")).toBe(true);
    expect(isUnder("Shared", "Shared")).toBe(false);
    expect(isUnder("Shared", "SharedNot/a.md")).toBe(false);
    expect(isUnder("Shared", "Other/a.md")).toBe(false);
  });

  it("round-trips relative paths", () => {
    expect(toRelative("Shared", "Shared/sub/a.md")).toBe("sub/a.md");
    expect(joinPath("Shared", "sub/a.md")).toBe("Shared/sub/a.md");
  });

  it("hashes differ on content changes", () => {
    expect(contentHash("hello")).not.toBe(contentHash("hello!"));
    expect(contentHash("hello")).toBe(contentHash("hello"));
  });
});

describe("classifyMapDelta", () => {
  it("classifies plain adds, updates, and deletes", () => {
    const current = new Map([
      ["new.md", meta("g1")],
      ["changed.md", meta("g2")],
    ]);
    const delta = classifyMapDelta(
      new Map([
        ["new.md", { action: "add", oldValue: undefined }],
        ["changed.md", { action: "update", oldValue: meta("g2") }],
        ["gone.md", { action: "delete", oldValue: meta("g3") }],
      ]),
      (k) => current.get(k),
    );
    expect(delta.added.map((a) => a.path)).toEqual(["new.md"]);
    expect(delta.updated.map((u) => u.path)).toEqual(["changed.md"]);
    expect(delta.removed.map((r) => r.path)).toEqual(["gone.md"]);
    expect(delta.renamed).toEqual([]);
  });

  it("pairs a same-guid delete+add into a rename", () => {
    const current = new Map([["after.md", meta("g1")]]);
    const delta = classifyMapDelta(
      new Map([
        ["before.md", { action: "delete", oldValue: meta("g1") }],
        ["after.md", { action: "add", oldValue: undefined }],
      ]),
      (k) => current.get(k),
    );
    expect(delta.renamed).toEqual([{ from: "before.md", to: "after.md", meta: meta("g1") }]);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
  });

  it("does not pair different guids as a rename", () => {
    const current = new Map([["b.md", meta("g2")]]);
    const delta = classifyMapDelta(
      new Map([
        ["a.md", { action: "delete", oldValue: meta("g1") }],
        ["b.md", { action: "add", oldValue: undefined }],
      ]),
      (k) => current.get(k),
    );
    expect(delta.renamed).toEqual([]);
    expect(delta.added.map((a) => a.path)).toEqual(["b.md"]);
    expect(delta.removed.map((r) => r.path)).toEqual(["a.md"]);
  });

  it("handles a folder rename (several files moving at once)", () => {
    const current = new Map([
      ["new/a.md", meta("g1")],
      ["new/b.md", meta("g2")],
    ]);
    const delta = classifyMapDelta(
      new Map([
        ["old/a.md", { action: "delete", oldValue: meta("g1") }],
        ["old/b.md", { action: "delete", oldValue: meta("g2") }],
        ["new/a.md", { action: "add", oldValue: undefined }],
        ["new/b.md", { action: "add", oldValue: undefined }],
      ]),
      (k) => current.get(k),
    );
    expect(delta.renamed).toHaveLength(2);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
  });
});

describe("sha256Hex", () => {
  it("matches a known vector", async () => {
    const bytes = new TextEncoder().encode("abc");
    const { sha256Hex } = await import("../src/paths");
    expect(await sha256Hex(bytes.buffer as ArrayBuffer)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("classifyOpenModify", () => {
  const h = contentHash;
  it("in-sync when disk equals the CRDT", () => {
    expect(classifyOpenModify(h("text"), h("text"), [])).toBe("in-sync");
  });
  it("stale-echo when disk matches a recent ytext state (autosave lag)", () => {
    const recent = [h("v1"), h("v2"), h("v3")];
    expect(classifyOpenModify(h("v2"), h("v3"), recent)).toBe("stale-echo");
  });
  it("bypass when disk content never existed in the editor stream", () => {
    const recent = [h("v1"), h("v2")];
    expect(classifyOpenModify(h("v2 + checkbox toggled"), h("v2"), recent)).toBe("bypass");
  });
});

describe("invite token helpers", () => {
  it("detects invite tokens vs the master secret", async () => {
    const { isInviteToken, isReadOnlyToken } = await import("../src/paths");
    expect(isInviteToken("a".repeat(40))).toBe(false);
    expect(isInviteToken("bmFtZQ.123.rw.abcd")).toBe(true);
    expect(isReadOnlyToken("bmFtZQ.123.ro.abcd")).toBe(true);
    expect(isReadOnlyToken("bmFtZQ.123.rw.abcd")).toBe(false);
  });
});

describe("base64UrlEncode", () => {
  it("handles non-Latin-1 input without throwing", async () => {
    const { base64UrlEncode } = await import("../src/paths");
    expect(() => base64UrlEncode("田中")).not.toThrow();
    expect(base64UrlEncode("abc")).toBe("YWJj");
  });
});
