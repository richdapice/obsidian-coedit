import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { classifyRange, resolvePeerRange } from "../src/edge-indicators";

const rel = (ytext: Y.Text, index: number) =>
  Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, index));

const makeDoc = (text: string) => {
  const doc = new Y.Doc();
  const ytext = doc.getText("contents");
  ytext.insert(0, text);
  return { doc, ytext };
};

describe("classifyRange", () => {
  it("is above when the peer's whole range precedes the visible range", () => {
    expect(classifyRange(0, 10, 20, 80)).toBe("above");
  });

  it("is below when the peer's whole range follows the visible range", () => {
    expect(classifyRange(90, 100, 20, 80)).toBe("below");
  });

  it("is here on any overlap, including partial and exact-boundary", () => {
    expect(classifyRange(10, 30, 20, 80)).toBe("here");
    expect(classifyRange(70, 100, 20, 80)).toBe("here");
    expect(classifyRange(0, 20, 20, 80)).toBe("here");
    expect(classifyRange(80, 90, 20, 80)).toBe("here");
    expect(classifyRange(30, 50, 20, 80)).toBe("here");
    expect(classifyRange(0, 100, 20, 80)).toBe("here");
  });
});

describe("resolvePeerRange", () => {
  it("prefers the peer's viewport over their cursor", () => {
    const { doc, ytext } = makeDoc("a".repeat(100));
    const state = {
      viewport: { from: rel(ytext, 40), to: rel(ytext, 60) },
      cursor: { head: rel(ytext, 5) },
    };
    expect(resolvePeerRange(doc, state, 100)).toEqual({ from: 40, to: 60 });
  });

  it("falls back to the cursor when there is no viewport", () => {
    const { doc, ytext } = makeDoc("a".repeat(100));
    const state = { cursor: { head: rel(ytext, 5) } };
    expect(resolvePeerRange(doc, state, 100)).toEqual({ from: 5, to: 5 });
  });

  it("falls back to the cursor when the viewport is malformed", () => {
    const { doc, ytext } = makeDoc("a".repeat(100));
    const state = {
      viewport: { from: { garbage: true }, to: rel(ytext, 60) },
      cursor: { head: rel(ytext, 5) },
    };
    expect(resolvePeerRange(doc, state, 100)).toEqual({ from: 5, to: 5 });
  });

  it("returns null with no usable state", () => {
    const { doc } = makeDoc("hello");
    expect(resolvePeerRange(doc, undefined, 5)).toBeNull();
    expect(resolvePeerRange(doc, {}, 5)).toBeNull();
    expect(resolvePeerRange(doc, { cursor: null, viewport: null }, 5)).toBeNull();
  });

  it("tracks concurrent edits through relative positions", () => {
    const { doc, ytext } = makeDoc("a".repeat(100));
    const state = { viewport: { from: rel(ytext, 40), to: rel(ytext, 60) } };
    ytext.insert(0, "b".repeat(10));
    expect(resolvePeerRange(doc, state, 110)).toEqual({ from: 50, to: 70 });
  });

  it("clamps to the editor doc length when it lags the ydoc", () => {
    const { doc, ytext } = makeDoc("a".repeat(100));
    const state = { viewport: { from: rel(ytext, 40), to: rel(ytext, 90) } };
    expect(resolvePeerRange(doc, state, 50)).toEqual({ from: 40, to: 50 });
  });

  it("normalizes a reversed viewport", () => {
    const { doc, ytext } = makeDoc("a".repeat(100));
    const state = { viewport: { from: rel(ytext, 60), to: rel(ytext, 40) } };
    expect(resolvePeerRange(doc, state, 100)).toEqual({ from: 40, to: 60 });
  });
});
