import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import * as Y from "yjs";
import type { DocEntry } from "./doc-manager";

/** Peers whose cursors are outside the visible editor, and which way. */
interface EdgePeer {
  name: string;
  color: string;
  pos: number;
  edge: "above" | "below";
}

interface AwarenessLike {
  clientID: number;
  getStates(): Map<number, unknown>;
  on(event: "change", cb: () => void): void;
  off(event: "change", cb: () => void): void;
}

/**
 * Clickable chips pinned to the editor's top/bottom edge showing collaborators
 * whose cursors are scrolled out of view; clicking scrolls to them.
 */
export function edgeIndicators(entry: DocEntry, awareness: AwarenessLike): Extension {
  return ViewPlugin.fromClass(
    class {
      private topEl: HTMLElement;
      private bottomEl: HTMLElement;
      private onAwareness: () => void;
      private rafPending = false;

      constructor(private view: EditorView) {
        this.topEl = this.makeContainer("coedit-edge-top");
        this.bottomEl = this.makeContainer("coedit-edge-bottom");
        this.onAwareness = () => this.scheduleRefresh();
        awareness.on("change", this.onAwareness);
        this.scheduleRefresh();
      }

      update(u: ViewUpdate): void {
        if (u.viewportChanged || u.docChanged || u.geometryChanged) this.scheduleRefresh();
      }

      destroy(): void {
        awareness.off("change", this.onAwareness);
        this.topEl.remove();
        this.bottomEl.remove();
      }

      private makeContainer(cls: string): HTMLElement {
        const el = document.createElement("div");
        el.className = `coedit-edge-indicators ${cls}`;
        this.view.dom.appendChild(el);
        return el;
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
        const peers = this.offscreenPeers();
        this.render(this.topEl, peers.filter((p) => p.edge === "above"), "▲");
        this.render(this.bottomEl, peers.filter((p) => p.edge === "below"), "▼");
      }

      private offscreenPeers(): EdgePeer[] {
        const byName = new Map<string, EdgePeer>();
        const scroller = this.view.scrollDOM.getBoundingClientRect();
        for (const [clientId, state] of awareness.getStates()) {
          if (clientId === awareness.clientID) continue;
          const s = state as {
            user?: { name?: string; color?: string };
            cursor?: { head?: unknown } | null;
          };
          if (!s.user?.name || !s.cursor?.head || byName.has(s.user.name)) continue;
          let pos: number;
          try {
            const abs = Y.createAbsolutePositionFromRelativePosition(
              Y.createRelativePositionFromJSON(s.cursor.head),
              entry.doc,
            );
            if (!abs) continue;
            pos = Math.min(abs.index, this.view.state.doc.length);
          } catch {
            continue;
          }
          let edge: "above" | "below" | null = null;
          if (pos < this.view.viewport.from) {
            edge = "above";
          } else if (pos > this.view.viewport.to) {
            edge = "below";
          } else {
            // Rendered (the viewport overscans) but possibly not visible.
            const coords = this.view.coordsAtPos(pos);
            if (coords) {
              if (coords.bottom < scroller.top + 4) edge = "above";
              else if (coords.top > scroller.bottom - 4) edge = "below";
            }
          }
          if (edge) {
            byName.set(s.user.name, {
              name: s.user.name,
              color: s.user.color ?? "var(--text-accent)",
              pos,
              edge,
            });
          }
        }
        return [...byName.values()];
      }

      private render(container: HTMLElement, peers: EdgePeer[], arrow: string): void {
        container.empty();
        for (const peer of peers.slice(0, 4)) {
          const chip = container.createDiv({ cls: "coedit-edge-chip" });
          chip.createSpan({ cls: "coedit-edge-arrow", text: arrow });
          const dot = chip.createSpan({ cls: "coedit-presence-dot" });
          if (/^#[0-9a-fA-F]{3,8}$/.test(peer.color)) dot.style.backgroundColor = peer.color;
          chip.createSpan({ text: peer.name });
          chip.addEventListener("click", () => {
            this.view.dispatch({
              effects: EditorView.scrollIntoView(peer.pos, { y: "center" }),
            });
          });
        }
      }
    },
  );
}
