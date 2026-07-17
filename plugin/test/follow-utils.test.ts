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

describe("soleInserter", () => {
  it("accepts the target when only they inserted", async () => {
    const { soleInserter } = await import("../src/follow-utils");
    const alice = new Y.Doc();
    const bob = new Y.Doc();
    alice.getText("t").insert(0, "base ");
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    let sole = false;
    alice.getText("t").observe((_e, txn) => {
      sole = soleInserter(txn, bob.clientID);
    });
    bob.getText("t").insert(5, "bob");
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob, Y.encodeStateVector(alice)));
    expect(sole).toBe(true);
  });

  it("rejects batched transactions carrying several authors' inserts", async () => {
    const { soleInserter } = await import("../src/follow-utils");
    // Bob and carol both edit; alice receives everything in ONE batched
    // update (reconnect catch-up shape).
    const alice = new Y.Doc();
    const bob = new Y.Doc();
    const carol = new Y.Doc();
    alice.getText("t").insert(0, "base ");
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    Y.applyUpdate(carol, Y.encodeStateAsUpdate(alice));

    bob.getText("t").insert(5, "bob");
    Y.applyUpdate(carol, Y.encodeStateAsUpdate(bob, Y.encodeStateVector(carol)));
    carol.getText("t").insert(0, "carol ");

    let soleBob = true;
    let soleCarol = true;
    alice.getText("t").observe((_e, txn) => {
      soleBob = soleInserter(txn, bob.clientID);
      soleCarol = soleInserter(txn, carol.clientID);
    });
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(carol, Y.encodeStateVector(alice)));
    expect(soleBob).toBe(false);
    expect(soleCarol).toBe(false);
  });
});
