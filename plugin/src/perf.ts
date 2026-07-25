/**
 * Lightweight phase tracer for hunting UI latency (tab-switch lag). Traces
 * accumulate in a ring buffer surfaced by the "Show performance log" command,
 * so slow attaches can be diagnosed on mobile where there is no console.
 */
import { type App, Modal } from "obsidian";

export interface Trace {
  label: string;
  startedAt: number;
  /** [phase name, duration ms] in order. */
  phases: Array<[string, number]>;
  total: number;
}

const MAX_TRACES = 50;
const SLOW_MS = 200;

const traces: Trace[] = [];

export function recentTraces(): readonly Trace[] {
  return traces;
}

export class Tracer {
  private phases: Array<[string, number]> = [];
  private t0 = performance.now();
  private last = this.t0;

  constructor(private label: string) {}

  /** Record the time since the previous mark under `phase`. */
  mark(phase: string): void {
    const now = performance.now();
    this.phases.push([phase, now - this.last]);
    this.last = now;
  }

  end(): void {
    const total = performance.now() - this.t0;
    const trace: Trace = {
      label: this.label,
      startedAt: Date.now(),
      phases: this.phases,
      total,
    };
    traces.push(trace);
    if (traces.length > MAX_TRACES) traces.splice(0, traces.length - MAX_TRACES);
    const detail = this.phases.map(([p, ms]) => `${p}=${ms.toFixed(1)}ms`).join(" ");
    if (total >= SLOW_MS) {
      console.warn(`coedit: slow ${this.label}: ${total.toFixed(0)}ms (${detail})`);
    } else {
      console.debug(`coedit: ${this.label}: ${total.toFixed(0)}ms (${detail})`);
    }
  }
}

/** Recent traces, newest first, in a copyable monospace list. */
export class PerfLogModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Coedit performance log");
    const list = [...recentTraces()].reverse();
    if (list.length === 0) {
      this.contentEl.createEl("p", { text: "Nothing recorded yet — switch between some shared notes first." });
      return;
    }
    const pre = this.contentEl.createEl("pre", { cls: "coedit-perf-log" });
    pre.setText(
      list
        .map((t) => {
          const time = new Date(t.startedAt).toLocaleTimeString();
          const phases = t.phases.map(([p, ms]) => `${p}=${ms.toFixed(0)}`).join(" ");
          return `${time} ${t.total.toFixed(0).padStart(5)}ms  ${t.label}\n            ${phases}`;
        })
        .join("\n"),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
