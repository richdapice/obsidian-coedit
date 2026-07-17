import { Annotation, EditorSelection, type Extension } from "@codemirror/state";
import {
  EditorView,
  layer,
  RectangleMarker,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import * as Y from "yjs";
import type { DocEntry } from "./doc-manager";

/**
 * Layer-based remote cursor/selection rendering, replacing y-codemirror's
 * widget-based yRemoteSelections. Inline caret widgets aren't re-measured
 * when Obsidian re-styles lines (headings change size, `##` marks appear and
 * disappear), leaving painted artifacts until a scroll forces a redraw.
 * Layers are what CodeMirror uses for its own cursor: they re-measure on
 * every geometry change, which is exactly the case that breaks widgets.
 */

interface AwarenessLike {
  clientID: number;
  getStates(): Map<number, unknown>;
  setLocalStateField(field: string, value: unknown): void;
  getLocalState(): Record<string, unknown> | null;
  on(event: "change", cb: () => void): void;
  off(event: "change", cb: () => void): void;
}

interface RemoteCursorState {
  user?: { name?: string; color?: string; colorLight?: string };
  cursor?: { anchor?: unknown; head?: unknown } | null;
}

const awarenessChanged = Annotation.define<boolean>();

const safeColor = (c: string | undefined, fallback: string) =>
  c && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : fallback;

/** A rectangle with an inline color (and, for carets, a name flag). */
class ColoredMarker extends RectangleMarker {
  constructor(
    className: string,
    left: number,
    top: number,
    width: number | null,
    height: number,
    private color: string,
    private label: string | null,
  ) {
    super(className, left, top, width, height);
  }

  override draw(): HTMLDivElement {
    const elt = super.draw();
    this.decorate(elt);
    return elt;
  }

  override update(dom: HTMLElement, oldMarker: RectangleMarker): boolean {
    if (!super.update(dom, oldMarker)) return false;
    this.decorate(dom);
    return true;
  }

  override eq(other: RectangleMarker): boolean {
    return (
      super.eq(other) &&
      other instanceof ColoredMarker &&
      this.color === other.color &&
      this.label === other.label
    );
  }

  private decorate(elt: HTMLElement): void {
    if (this.label !== null) {
      elt.style.borderLeftColor = this.color;
      let flag = elt.querySelector<HTMLElement>(".coedit-caret-flag");
      if (!flag) {
        flag = elt.createSpan({ cls: "coedit-caret-flag" });
      }
      flag.textContent = this.label;
      flag.style.backgroundColor = this.color;
    } else {
      elt.style.backgroundColor = this.color;
    }
  }
}

function remotePositions(
  entry: DocEntry,
  awareness: AwarenessLike,
  docLength: number,
): Array<{ anchor: number; head: number; name: string; color: string; light: string }> {
  const out: Array<{ anchor: number; head: number; name: string; color: string; light: string }> =
    [];
  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === awareness.clientID) continue;
    const s = state as RemoteCursorState;
    if (!s.cursor?.head || !s.user?.name) continue;
    try {
      const head = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(s.cursor.head),
        entry.doc,
      );
      if (!head || head.index > docLength) continue;
      let anchor = head.index;
      if (s.cursor.anchor) {
        const a = Y.createAbsolutePositionFromRelativePosition(
          Y.createRelativePositionFromJSON(s.cursor.anchor),
          entry.doc,
        );
        if (a && a.index <= docLength) anchor = a.index;
      }
      const color = safeColor(s.user.color, "var(--text-accent)");
      out.push({
        anchor,
        head: head.index,
        name: s.user.name,
        color,
        light: safeColor(s.user.colorLight, `${color}33`),
      });
    } catch {
      // Stale relative position; skip until the next awareness update.
    }
  }
  return out;
}

export function remoteCursors(entry: DocEntry, awareness: AwarenessLike): Extension {
  // Nudge the layers when awareness changes (they redraw on geometry/doc
  // changes by themselves).
  const notifier = ViewPlugin.fromClass(
    class {
      private onChange: () => void;
      constructor(view: EditorView) {
        this.onChange = () => {
          window.setTimeout(() => view.dispatch({ annotations: awarenessChanged.of(true) }), 0);
        };
        awareness.on("change", this.onChange);
      }
      destroy(): void {
        awareness.off("change", this.onChange);
      }
    },
  );

  // Publish our own cursor (this replaces the upstream plugin's publisher).
  const publisher = EditorView.updateListener.of((u: ViewUpdate) => {
    const local = awareness.getLocalState();
    if (local === null) return;
    const hasFocus = u.view.hasFocus && u.view.dom.ownerDocument.hasFocus();
    if (hasFocus) {
      const sel = u.state.selection.main;
      const anchor = Y.createRelativePositionFromTypeIndex(entry.ytext, sel.anchor);
      const head = Y.createRelativePositionFromTypeIndex(entry.ytext, sel.head);
      const prev = local.cursor as { anchor?: unknown; head?: unknown } | null | undefined;
      if (
        !prev ||
        !Y.compareRelativePositions(Y.createRelativePositionFromJSON(prev.anchor), anchor) ||
        !Y.compareRelativePositions(Y.createRelativePositionFromJSON(prev.head), head)
      ) {
        awareness.setLocalStateField("cursor", {
          anchor: Y.relativePositionToJSON(anchor),
          head: Y.relativePositionToJSON(head),
        });
      }
    }
    // Deliberately keep the last cursor when unfocused (table sub-editor);
    // follow mode's edit-tracking covers movement inside those.
  });

  const needsRedraw = (u: ViewUpdate) =>
    u.docChanged ||
    u.viewportChanged ||
    u.geometryChanged ||
    u.transactions.some((t) => t.annotation(awarenessChanged) !== undefined);

  const selectionLayer = layer({
    above: false,
    class: "coedit-remote-selections",
    update: needsRedraw,
    markers(view) {
      const markers: RectangleMarker[] = [];
      for (const peer of remotePositions(entry, awareness, view.state.doc.length)) {
        if (peer.anchor === peer.head) continue;
        const range = EditorSelection.range(peer.anchor, peer.head);
        for (const rect of RectangleMarker.forRange(view, "coedit-remote-sel", range)) {
          markers.push(
            new ColoredMarker(
              "coedit-remote-sel",
              rect.left,
              rect.top,
              rect.width,
              rect.height,
              peer.light,
              null,
            ),
          );
        }
      }
      return markers;
    },
  });

  const caretLayer = layer({
    above: true,
    class: "coedit-remote-carets",
    update: needsRedraw,
    markers(view) {
      const markers: RectangleMarker[] = [];
      for (const peer of remotePositions(entry, awareness, view.state.doc.length)) {
        const cursor = EditorSelection.cursor(peer.head);
        for (const rect of RectangleMarker.forRange(view, "coedit-remote-caret", cursor)) {
          markers.push(
            new ColoredMarker(
              "coedit-remote-caret",
              rect.left,
              rect.top,
              rect.width,
              rect.height,
              peer.color,
              peer.name,
            ),
          );
        }
      }
      return markers;
    },
  });

  return [notifier, publisher, selectionLayer, caretLayer];
}
