import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import * as Y from "yjs";
import type { DocEntry } from "./doc-manager";

/** A collaborator on this note, and where they sit relative to our view. */
interface SamePagePeer {
  name: string;
  color: string;
  /** Center of their known range, for click-to-scroll; null if unknown. */
  pos: number | null;
  zone: PeerZone;
}

export type PeerZone = "above" | "below" | "here";

interface AwarenessLike {
  clientID: number;
  getStates(): Map<number, unknown>;
  setLocalStateField(field: string, value: unknown): void;
  getLocalState(): Record<string, unknown> | null;
  on(event: "change", cb: () => void): void;
  off(event: "change", cb: () => void): void;
}

/** The folder-level index awareness; only read here. */
interface IndexAwarenessLike {
  clientID: number;
  getStates(): Map<number, unknown>;
  on(event: "change", cb: () => void): void;
  off(event: "change", cb: () => void): void;
}

export interface IndexPresence {
  awareness: IndexAwarenessLike;
  /** Folder-relative path of the bound file, matched against peers' activeFile. */
  relPath: string;
}

/** Where a peer's known range sits relative to our visible range. */
export function classifyRange(
  peerFrom: number,
  peerTo: number,
  visFrom: number,
  visTo: number,
): PeerZone {
  if (peerTo < visFrom) return "above";
  if (peerFrom > visTo) return "below";
  return "here";
}

/**
 * Resolve a peer's published position into doc offsets. Their viewport (where
 * they're looking) wins over their cursor (where they last typed) — a peer
 * scrolling to read never moves their cursor.
 */
export function resolvePeerRange(
  doc: Y.Doc,
  state: unknown,
  docLength: number,
): { from: number; to: number } | null {
  const s = (state ?? {}) as {
    viewport?: { from?: unknown; to?: unknown } | null;
    cursor?: { head?: unknown } | null;
  };
  const resolve = (json: unknown): number | null => {
    if (!json) return null;
    try {
      const abs = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(json),
        doc,
      );
      return abs ? Math.min(abs.index, docLength) : null;
    } catch {
      return null;
    }
  };
  if (s.viewport) {
    const from = resolve(s.viewport.from);
    const to = resolve(s.viewport.to);
    if (from !== null && to !== null) {
      return { from: Math.min(from, to), to: Math.max(from, to) };
    }
  }
  const head = resolve(s.cursor?.head);
  return head === null ? null : { from: head, to: head };
}

/**
 * Live same-page presence, pinned to the editor's edges: every collaborator
 * whose activeFile is this note gets a chip — ▲/▼ when they're elsewhere in
 * the note (click scrolls to them), a plain dot when they're with you or
 * their position is unknown. Also publishes our own visible range on the doc
 * awareness so peers can classify us the same way.
 *
 * Same-page membership comes from the index awareness (activeFile), not the
 * doc awareness: doc connections linger after a peer moves on, and gating on
 * activeFile is what keeps those from leaving ghost chips.
 */
export function edgeIndicators(
  entry: DocEntry,
  awareness: AwarenessLike,
  index: IndexPresence,
): Extension {
  return ViewPlugin.fromClass(
    class {
      private topEl: HTMLElement;
      private bottomEl: HTMLElement;
      private onAwareness: () => void;
      private onScroll: () => void;
      private rafPending = false;
      private publishTimer: number | null = null;
      private lastPublished: string | null = null;

      constructor(private view: EditorView) {
        this.topEl = this.makeContainer("coedit-edge-top");
        this.bottomEl = this.makeContainer("coedit-edge-bottom");
        this.onAwareness = () => this.scheduleRefresh();
        awareness.on("change", this.onAwareness);
        index.awareness.on("change", this.onAwareness);
        // Small scrolls inside CM's overscan don't produce a ViewUpdate, so
        // chips (and our published viewport) would lag without this.
        this.onScroll = () => {
          this.scheduleRefresh();
          this.schedulePublish();
        };
        view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
        this.scheduleRefresh();
        this.schedulePublish();
      }

      update(u: ViewUpdate): void {
        if (u.viewportChanged || u.docChanged || u.geometryChanged) {
          this.scheduleRefresh();
          this.schedulePublish();
        }
      }

      destroy(): void {
        awareness.off("change", this.onAwareness);
        index.awareness.off("change", this.onAwareness);
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
        if (this.publishTimer !== null) window.clearTimeout(this.publishTimer);
        this.topEl.remove();
        this.bottomEl.remove();
        // The viewport field is left as-is on purpose: a split pane may still
        // be publishing, and receivers gate on activeFile anyway.
      }

      private makeContainer(cls: string): HTMLElement {
        const el = document.createElement("div");
        el.className = `coedit-edge-indicators ${cls}`;
        this.view.dom.appendChild(el);
        return el;
      }

      /** Our truly-visible doc range (the viewport overscans past it). */
      private visibleRange(): { from: number; to: number } {
        const rect = this.view.scrollDOM.getBoundingClientRect();
        const from = this.view.posAtCoords({ x: rect.left + 4, y: rect.top + 4 }, false);
        const to = this.view.posAtCoords({ x: rect.left + 4, y: rect.bottom - 4 }, false);
        if (from >= 0 && to >= from) return { from, to };
        return { from: this.view.viewport.from, to: this.view.viewport.to };
      }

      private schedulePublish(): void {
        if (this.publishTimer !== null) return;
        this.publishTimer = window.setTimeout(() => {
          this.publishTimer = null;
          this.publishViewport();
        }, 250);
      }

      private publishViewport(): void {
        if (awareness.getLocalState() === null) return;
        const { from, to } = this.visibleRange();
        const len = entry.ytext.length;
        const value = {
          from: Y.relativePositionToJSON(
            Y.createRelativePositionFromTypeIndex(entry.ytext, Math.min(from, len)),
          ),
          to: Y.relativePositionToJSON(
            Y.createRelativePositionFromTypeIndex(entry.ytext, Math.min(to, len)),
          ),
        };
        const key = JSON.stringify(value);
        if (key === this.lastPublished) return;
        this.lastPublished = key;
        awareness.setLocalStateField("viewport", value);
      }

      private scheduleRefresh(): void {
        if (this.rafPending) return;
        this.rafPending = true;
        window.requestAnimationFrame(() => {
          this.rafPending = false;
          this.refresh();
        });
      }

      private refresh(): void {
        const peers = this.samePagePeers();
        this.render(
          this.topEl,
          peers.filter((p) => p.zone !== "below"),
        );
        this.render(
          this.bottomEl,
          peers.filter((p) => p.zone === "below"),
        );
      }

      /** Peers whose activeFile is this note, positioned via doc awareness. */
      private samePagePeers(): SamePagePeer[] {
        const docStates = new Map<string, unknown>();
        for (const [clientId, state] of awareness.getStates()) {
          if (clientId === awareness.clientID) continue;
          const name = (state as { user?: { name?: string } }).user?.name;
          if (name && !docStates.has(name)) docStates.set(name, state);
        }
        const vis = this.visibleRange();
        const byName = new Map<string, SamePagePeer>();
        for (const [clientId, state] of index.awareness.getStates()) {
          if (clientId === index.awareness.clientID) continue;
          const s = state as {
            user?: { name?: string; color?: string };
            activeFile?: string | null;
          };
          if (!s.user?.name || s.activeFile !== index.relPath || byName.has(s.user.name)) {
            continue;
          }
          const range = resolvePeerRange(
            entry.doc,
            docStates.get(s.user.name),
            this.view.state.doc.length,
          );
          const zone = range ? classifyRange(range.from, range.to, vis.from, vis.to) : "here";
          if (zone === "here" && this.caretVisible(docStates.get(s.user.name), vis)) {
            // Their name flag is already on screen; a chip would be noise.
            continue;
          }
          byName.set(s.user.name, {
            name: s.user.name,
            color: s.user.color ?? "var(--text-accent)",
            pos: range ? Math.round((range.from + range.to) / 2) : null,
            zone,
          });
        }
        return [...byName.values()];
      }

      private caretVisible(docState: unknown, vis: { from: number; to: number }): boolean {
        const head = (docState as { cursor?: { head?: unknown } | null } | undefined)?.cursor
          ?.head;
        if (!head) return false;
        try {
          const abs = Y.createAbsolutePositionFromRelativePosition(
            Y.createRelativePositionFromJSON(head),
            entry.doc,
          );
          return abs !== null && abs.index >= vis.from && abs.index <= vis.to;
        } catch {
          return false;
        }
      }

      private render(container: HTMLElement, peers: SamePagePeer[]): void {
        container.empty();
        for (const peer of peers.slice(0, 4)) {
          const chip = container.createDiv({ cls: "coedit-edge-chip" });
          if (peer.zone !== "here") {
            chip.createSpan({
              cls: "coedit-edge-arrow",
              text: peer.zone === "above" ? "▲" : "▼",
            });
          }
          const dot = chip.createSpan({ cls: "coedit-presence-dot" });
          if (/^#[0-9a-fA-F]{3,8}$/.test(peer.color)) dot.style.backgroundColor = peer.color;
          chip.createSpan({ text: peer.name });
          const pos = peer.pos;
          if (pos !== null) {
            chip.setAttribute(
              "aria-label",
              peer.zone === "here" ? "On this note with you" : "Click to scroll to them",
            );
            chip.addEventListener("click", () => {
              this.view.dispatch({
                effects: EditorView.scrollIntoView(Math.min(pos, this.view.state.doc.length), {
                  y: "center",
                }),
              });
            });
          } else {
            chip.addClass("coedit-edge-static");
            chip.setAttribute("aria-label", "On this note");
          }
        }
      }
    },
  );
}
