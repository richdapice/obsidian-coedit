import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { clientInserted, deltaChangePosition } from "../src/follow-utils";

describe("deltaChangePosition", () => {
  it("points to the end of an insertion", () => {
    expect(deltaChangePosition([{ retain: 10 }, { insert: "abc" }])).toBe(13);
  });
  it("points to the start of a deletion", () => {
    expect(deltaChangePosition([{ retain: 4 }, { delete: 2 }])).toBe(4);
  });
  it("handles a leading insertion", () => {
    expect(deltaChangePosition([{ insert: "x" }])).toBe(1);
  });
  it("returns null for retain-only deltas", () => {
    expect(deltaChangePosition([{ retain: 7 }])).toBeNull();
    expect(deltaChangePosition([])).toBeNull();
  });
});

describe("clientInserted", () => {
  it("attributes inserts to the authoring client only", () => {
    const alice = new Y.Doc();
    const bob = new Y.Doc();
    alice.getText("t").insert(0, "hello ");
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    // Bob types; alice receives the update.
    let attributedToBob = false;
    let attributedToAlice = false;
    alice.getText("t").observe((_event, txn) => {
      attributedToBob = clientInserted(txn, bob.clientID);
      attributedToAlice = clientInserted(txn, alice.clientID);
    });
    bob.getText("t").insert(6, "world");
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob, Y.encodeStateVector(alice)));

    expect(attributedToBob).toBe(true);
    expect(attributedToAlice).toBe(false);
  });

  it("does not attribute pure deletions", () => {
    const alice = new Y.Doc();
    const bob = new Y.Doc();
    alice.getText("t").insert(0, "hello world");
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    let attributed = false;
    alice.getText("t").observe((_event, txn) => {
      attributed = clientInserted(txn, bob.clientID);
    });
    bob.getText("t").delete(0, 5);
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob, Y.encodeStateVector(alice)));

    expect(attributed).toBe(false);
  });
});
