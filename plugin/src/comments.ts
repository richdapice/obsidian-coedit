import { Annotation, type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  hoverTooltip,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { type App, Modal, Setting } from "obsidian";
import * as Y from "yjs";
import type { DocEntry } from "./doc-manager";

/** Stored in the note's own Y.Doc under getMap("comments") — syncs and checkpoints with the content. */
export interface CommentRecord {
  id: string;
  author: string;
  color: string;
  text: string;
  createdAt: number;
  /** JSON-encoded Y.RelativePosition range into getText("contents"). */
  from: string;
  to: string;
  resolved?: boolean;
}

const commentsChanged = Annotation.define<boolean>();

/** Comment records sync from peers — never inject their color into CSS unvalidated. */
function safeColor(color: string): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : "var(--text-accent)";
}

function commentsMap(entry: DocEntry): Y.Map<CommentRecord> {
  return entry.doc.getMap<CommentRecord>("comments");
}

/** Resolve a comment's anchors to current doc offsets; null if the text is gone. */
function absRange(entry: DocEntry, c: CommentRecord): { from: number; to: number } | null {
  try {
    const from = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(JSON.parse(c.from)),
      entry.doc,
    );
    const to = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(JSON.parse(c.to)),
      entry.doc,
    );
    if (!from || !to) return null;
    const len = entry.ytext.length;
    const a = Math.min(from.index, len);
    const b = Math.min(Math.max(to.index, a), len);
    return { from: a, to: b === a ? Math.min(a + 1, len) : b };
  } catch {
    return null;
  }
}

export function addComment(
  entry: DocEntry,
  range: { from: number; to: number },
  author: { name: string; color: string },
  text: string,
): void {
  const record: CommentRecord = {
    id: crypto.randomUUID(),
    author: author.name,
    color: author.color,
    text,
    createdAt: Date.now(),
    from: JSON.stringify(Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(entry.ytext, range.from),
    )),
    to: JSON.stringify(Y.relativePositionToJSON(
      // Left association: the range hugs the commented text instead of
      // swallowing whatever gets typed right after it.
      Y.createRelativePositionFromTypeIndex(entry.ytext, range.to, -1),
    )),
  };
  entry.doc.transact(() => commentsMap(entry).set(record.id, record));
}

/** Decorations + hover tooltip (with resolve button) for one bound doc. */
export function commentsExtension(entry: DocEntry): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private observer: () => void;

      constructor(private view: EditorView) {
        this.decorations = this.build();
        this.observer = () => {
          // Dispatch async: the observer may fire inside a Yjs transaction.
          window.setTimeout(() => {
            this.view.dispatch({ annotations: commentsChanged.of(true) });
          }, 0);
        };
        commentsMap(entry).observe(this.observer);
      }

      update(u: ViewUpdate): void {
        if (u.docChanged || u.transactions.some((t) => t.annotation(commentsChanged))) {
          this.decorations = this.build();
        }
      }

      destroy(): void {
        commentsMap(entry).unobserve(this.observer);
      }

      private build(): DecorationSet {
        const ranges: Array<{ from: number; to: number; color: string }> = [];
        for (const c of commentsMap(entry).values()) {
          if (c.resolved) continue;
          const range = absRange(entry, c);
          if (!range || range.from === range.to) continue;
          ranges.push({ ...range, color: c.color });
        }
        ranges.sort((a, b) => a.from - b.from || a.to - b.to);
        const builder = new RangeSetBuilder<Decoration>();
        const docLen = this.view.state.doc.length;
        for (const r of ranges) {
          if (r.from >= docLen) continue;
          builder.add(
            r.from,
            Math.min(r.to, docLen),
            Decoration.mark({
              class: "coedit-comment",
              attributes: { style: `text-decoration-color: ${safeColor(r.color)}` },
            }),
          );
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );

  const tooltip = hoverTooltip((view, pos) => {
    const hits = [...commentsMap(entry).values()].filter((c) => {
      if (c.resolved) return false;
      const range = absRange(entry, c);
      return range !== null && pos >= range.from && pos <= range.to;
    });
    if (hits.length === 0) return null;
    return {
      pos,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "coedit-comment-tooltip";
        for (const c of hits) {
          const item = dom.createDiv({ cls: "coedit-comment-item" });
          const head = item.createDiv({ cls: "coedit-comment-head" });
          head.createSpan({ text: c.author, cls: "coedit-comment-author" }).style.color =
            safeColor(c.color);
          head.createSpan({
            text: new Date(c.createdAt).toLocaleString(),
            cls: "coedit-comment-time",
          });
          const resolve = head.createEl("button", { text: "✓ resolve" });
          resolve.addEventListener("click", () => {
            entry.doc.transact(() => commentsMap(entry).set(c.id, { ...c, resolved: true }));
            item.remove();
          });
          item.createDiv({ text: c.text });
        }
        return { dom };
      },
    };
  });

  return [plugin, tooltip];
}

export class CommentModal extends Modal {
  private text = "";

  constructor(
    app: App,
    private onSubmit: (text: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Add comment");
    const input = this.contentEl.createEl("textarea", {
      cls: "coedit-comment-input",
      attr: { rows: "4", placeholder: "Comment…" },
    });
    input.addEventListener("input", () => (this.text = input.value));
    input.focus();
    new Setting(this.contentEl).addButton((btn) =>
      btn
        .setButtonText("Comment")
        .setCta()
        .onClick(() => {
          if (!this.text.trim()) return;
          this.close();
          this.onSubmit(this.text.trim());
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
