// Coedit Claude peer — Mac-daemon brain. Connects to the sync server as a
// headless collaborator, watches shared docs for @claude mentions, answers
// them via the local `claude` CLI (subscription-billed), and streams the
// reply into the note so it reads like a collaborator typing. Presence via
// awareness; a heartbeat to the server lets the Durable Object brain (if an
// API key is configured there) take over whenever this daemon is offline.
//
// Config: peer/config.json — see config.example.json. Run: node peer.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import YProvider from "y-partyserver/provider";
import * as Y from "yjs";
import {
  DAILY_CAP,
  MAX_REPLY_CHARS,
  addsNewMentions,
  claimReply,
  locateMentionUnit,
  contentHash,
  editSystemPrompt,
  findUnansweredMentions,
  parseEditInstruction,
  stripLine,
  systemPrompt,
} from "../shared/mentions.mjs";
import DiffMatchPatch from "diff-match-patch";
import { createTextEdit } from "../shared/text-edit.mjs";

const { mergeAroundUnit, setTextTo } = createTextEdit(DiffMatchPatch);

const CONFIG = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const STATE_URL = new URL("./state.json", import.meta.url);
const SCAN_DEBOUNCE_MS = 1500;
const HEARTBEAT_MS = 60 * 1000;
const CLAUDE_TIMEOUT_MS = 3 * 60 * 1000;
/** Streamed-typing chunking: collaborative feel without one-op-per-char. */
const TYPE_CHUNK = 80;
const TYPE_INTERVAL_MS = 120;

const scheme = /^(localhost|127\.)/.test(CONFIG.host) ? "http" : "https";

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---- daily cap ----------------------------------------------------------
function readCapState() {
  try {
    const state = JSON.parse(readFileSync(STATE_URL, "utf8"));
    if (state.day === new Date().toISOString().slice(0, 10)) return state;
  } catch {
    // first run
  }
  return { day: new Date().toISOString().slice(0, 10), count: 0 };
}

const atCap = () => readCapState().count >= DAILY_CAP;

function bumpCap() {
  const state = readCapState();
  state.count++;
  writeFileSync(STATE_URL, JSON.stringify(state));
}

// ---- claude CLI brain ---------------------------------------------------
function askClaude(notePath, noteText) {
  // Test hook: lets e2e runs verify the full mention->reply pipeline
  // without a model call.
  if (process.env.COEDIT_FAKE_BRAIN) {
    return Promise.resolve(process.env.COEDIT_FAKE_BRAIN);
  }
  // Prompt over STDIN, not argv: giant notes would blow the argv limit, and
  // argv leaks note content into `ps` output.
  const prompt = `${systemPrompt(notePath)}\n\n--- NOTE CONTENT ---\n${noteText}`;
  return new Promise((resolve, reject) => {
    const child = spawn(CONFIG.claudeBin ?? "claude", ["-p"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: CLAUDE_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      reject(
        err.code === "ENOENT"
          ? new Error(`claude CLI not found at "${CONFIG.claudeBin ?? "claude"}" — set "claudeBin" in config.json to an absolute path (launchd has a minimal PATH)`)
          : err,
      );
    });
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 300)}`));
      resolve(stdout.trim().slice(0, MAX_REPLY_CHARS));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Run claude with Read/Edit tools in a scratch dir holding note.md; return
 *  the edited file. Sandboxed: Claude touches only the scratch copy — the
 *  live doc is updated by US through the hardened merge path. */
function editClaude(notePath, baseText, instruction) {
  if (process.env.COEDIT_FAKE_EDIT_APPEND) {
    return Promise.resolve(`${baseText.replace(/\n+$/, "\n")}${process.env.COEDIT_FAKE_EDIT_APPEND}\n`);
  }
  const dir = mkdtempSync(join(tmpdir(), "coedit-edit-"));
  writeFileSync(join(dir, "note.md"), baseText);
  return new Promise((resolve, reject) => {
    const child = spawn(
      CONFIG.claudeBin ?? "claude",
      ["-p", "--allowedTools", "Read,Edit,Write", "--permission-mode", "acceptEdits"],
      { cwd: dir, stdio: ["pipe", "pipe", "pipe"], timeout: CLAUDE_TIMEOUT_MS },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      rmSync(dir, { recursive: true, force: true });
      reject(err);
    });
    child.on("close", (code) => {
      try {
        if (code !== 0) throw new Error(`claude edit exited ${code}: ${stderr.slice(0, 300)}`);
        const edited = readFileSync(join(dir, "note.md"), "utf8");
        if (!edited.trim()) throw new Error("edit produced an empty file");
        resolve(edited);
      } catch (err) {
        reject(err);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    child.stdin.write(editSystemPrompt(notePath, instruction));
    child.stdin.end();
  });
}

// ---- per-folder session -------------------------------------------------
class FolderSession {
  constructor(folderId) {
    this.folderId = folderId;
    this.indexDoc = new Y.Doc();
    this.docs = new Map(); // guid -> {doc, provider, timer, busy:Set<line>}
    this.indexProvider = this.connect(`${folderId}:index`, this.indexDoc);
    this.files = this.indexDoc.getMap("files");
    this.files.observe(() => this.syncDocSet());
    this.indexProvider.on("synced", () => this.syncDocSet());
  }

  connect(room, doc) {
    const provider = new YProvider(CONFIG.host, encodeURIComponent(room), doc, {
      party: "y-doc-server",
      protocol: scheme === "http" ? "ws" : "wss",
      params: { token: CONFIG.token },
      WebSocketPolyfill: WebSocket,
      disableBc: true,
    });
    provider.awareness.setLocalStateField("user", {
      name: "Claude",
      color: "#d97757",
      colorLight: "#d9775733",
    });
    return provider;
  }

  /** Keep one connected doc per markdown file in the index. */
  syncDocSet() {
    const wanted = new Map();
    for (const [path, meta] of this.files.entries()) {
      if (meta.kind === "blob" || !path.endsWith(".md")) continue;
      wanted.set(meta.guid, path);
    }
    for (const [guid, entry] of this.docs) {
      if (!wanted.has(guid)) {
        entry.provider.destroy();
        entry.doc.destroy();
        this.docs.delete(guid);
      }
    }
    for (const [guid, path] of wanted) {
      const existing = this.docs.get(guid);
      if (existing) {
        existing.path = path;
        continue;
      }
      const doc = new Y.Doc();
      const provider = this.connect(`${this.folderId}:${guid}`, doc);
      // Beat this room immediately: a mention typed into a brand-new note
      // must not find a beat-less DO (both brains eligible = claim race).
      void beatRoom(`${this.folderId}:${guid}`);
      const entry = { doc, provider, path, guid, timer: null, busy: new Set() };
      doc.getText("contents").observe(() => {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timer = null;
          this.scan(entry).catch((err) => log(`scan failed for ${entry.path}:`, err.message));
        }, SCAN_DEBOUNCE_MS);
      });
      this.docs.set(guid, entry);
    }
  }

  async scan(entry) {
    const ytext = entry.doc.getText("contents");
    // Re-scan after every answer (each reply shifts later mentions'
    // offsets). Each prompt gets ONE attempt per pass — whatever the
    // outcome — so a raced/failed/duplicate mention can never spin this
    // loop; the next external doc update starts a fresh pass. The cap check
    // BREAKS the pass: an unclaimed mention stays in the scan results.
    const handled = new Set();
    for (;;) {
      if (atCap()) {
        log(`daily cap (${DAILY_CAP}) reached; leaving mentions for the fallback brain`);
        return;
      }
      const mention = findUnansweredMentions(ytext.toString()).find(
        (m) => !entry.busy.has(m.prompt) && !handled.has(m.prompt),
      );
      if (!mention) return;
      handled.add(mention.prompt);
      entry.busy.add(mention.prompt);
      try {
        await this.answer(entry, mention);
      } catch (err) {
        log(`answer failed in ${entry.path}:`, err.message);
      } finally {
        entry.busy.delete(mention.prompt);
      }
    }
  }

  /** Returns true if a claim was made (successful or retracted after). */
  async answer(entry, mention) {
    const ytext = entry.doc.getText("contents");
    const text0 = ytext.toString();
    const reply = claimReply(entry.doc, ytext, mention.prompt, "mac");
    if (!reply) return false;
    // Let a racing claim from the other brain propagate, then keep only the
    // first block; the loser retracts itself inside ownsClaim().
    await new Promise((r) => setTimeout(r, 1500));
    if (!reply.ownsClaim()) {
      log(`lost claim race in ${entry.path}; retracted`);
      return true;
    }
    bumpCap();
    const instruction = parseEditInstruction(mention.prompt);
    if (instruction !== null) {
      await this.edit(entry, mention, reply, text0, instruction);
      this.advertise(entry);
      return true;
    }
    log(`answering mention in ${entry.path}: ${mention.prompt.slice(0, 80)}`);
    let answer;
    try {
      answer = await askClaude(entry.path, ytext.toString());
    } catch (err) {
      log(`claude CLI failed:`, err.message);
      reply.update(`⚠️ Claude couldn't answer: ${err.message.split("\n")[0]}`);
      return true;
    }
    // "Type" the reply in growing prefixes for the collaborative feel; every
    // step re-locates the block by its nonce, so no offset survives an await.
    for (let n = TYPE_CHUNK; n < answer.length; n += TYPE_CHUNK) {
      if (!reply.update(answer.slice(0, n))) return true;
      await new Promise((r) => setTimeout(r, TYPE_INTERVAL_MS));
    }
    reply.update(answer);
    this.advertise(entry);
    log(`answered in ${entry.path} (${answer.length} chars)`);
    return true;
  }

  /** Closed notes on other devices only pull when the index hash moves. */
  advertise(entry) {
    const meta = this.files.get(entry.path);
    if (!meta) return;
    this.files.set(entry.path, {
      ...meta,
      hash: contentHash(entry.doc.getText("contents").toString()),
      mtime: Date.now(),
    });
  }

  /**
   * "@claude edit:" — Claude edits a scratch copy with real tools; the delta
   * is fuzzy-merged into the live doc (concurrent human edits win; on any
   * conflict nothing is forced). A checkpoint precedes every applied edit so
   * undo is one version-history click away.
   */
  async edit(entry, mention, reply, text0, instruction) {
    log(`editing ${entry.path}: ${instruction.slice(0, 80)}`);
    const ytext = entry.doc.getText("contents");
    // Claude works on the note WITHOUT the mention line — the instruction
    // travels in the prompt, and patches stay clear of the mention region.
    const base = stripLine(text0, mention.prompt);
    let edited;
    try {
      edited = await editClaude(entry.path, base, instruction);
    } catch (err) {
      log(`edit failed:`, err.message);
      reply.update(`⚠️ Couldn't make the edit: ${err.message.split("\n")[0]}`);
      return;
    }
    if (edited === base) {
      reply.update("✏️ Looked at it — nothing needed changing.");
      return;
    }
    // Growth-relative balloon guard, not an absolute cap: big itineraries
    // must stay editable.
    if (edited.length > Math.max(base.length * 2, base.length + MAX_REPLY_CHARS)) {
      reply.update("⚠️ The edit ballooned the note suspiciously — refusing to apply it.");
      return;
    }
    if (addsNewMentions(base, edited)) {
      reply.update("⚠️ The edit tried to add a new @\u200Bclaude mention — refusing to apply it (that way lies an infinite loop).");
      return;
    }
    // Checkpoint BEFORE applying. The confirmation SELLS undo-via-history;
    // without a fresh checkpoint that promise could roll back hours of
    // human edits, so a failed checkpoint refuses the edit.
    try {
      const res = await fetch(
        `${scheme}://${CONFIG.host}/parties/y-doc-server/${encodeURIComponent(`${this.folderId}:${entry.guid}`)}/checkpoints?token=${CONFIG.token}`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`checkpoint returned ${res.status}`);
    } catch (err) {
      log("pre-edit checkpoint failed; refusing edit:", err.message);
      reply.update("⚠️ Couldn't save an undo checkpoint, so I didn't touch the note. Try again in a moment.");
      return;
    }
    // Merge against the live text with the mention+claim unit REMOVED, then
    // splice it back — fuzzy patches otherwise get displaced onto identical
    // twin lines near the mention (review demonstrated a checkmark landing
    // on the wrong item). No awaits from here to setTextTo.
    const live = ytext.toString();
    const unitBounds = locateMentionUnit(live, mention.prompt, reply.nonce);
    // ownsClaim() FIRST and unconditionally: it retracts our block when the
    // mention was edited away, so a canceled edit never leaves a dangling
    // "…" block (short-circuiting past it did — review round 2).
    const owns = reply.ownsClaim();
    if (!unitBounds || !owns) {
      // Mention or claim removed mid-run — the natural cancel gesture.
      log(`edit canceled in ${entry.path} (mention/claim removed)`);
      return;
    }
    const final = mergeAroundUnit(base, edited, live, unitBounds);
    if (final === null) {
      reply.update(
        "⚠️ The note changed while I was editing and the changes couldn't be merged safely — nothing was applied. Try again.",
      );
      return;
    }
    setTextTo(entry.doc, ytext, final);
    reply.update(`✏️ Done — ${instruction}\nUndo anytime: “Version history for current note”.`);
    log(`edited ${entry.path} (${base.length} -> ${edited.length} chars)`);
  }
}

// ---- heartbeat: lets the DO brain defer while this daemon is alive ------
// Posted to EVERY watched doc room: each Durable Object only sees its own
// storage, so the beacon must land wherever a mention could appear.
async function beatRoom(room) {
  try {
    await fetch(
      `${scheme}://${CONFIG.host}/parties/y-doc-server/${encodeURIComponent(room)}/peer-heartbeat?token=${CONFIG.token}`,
      { method: "POST" },
    );
  } catch (err) {
    log("heartbeat failed:", err.message);
  }
}

async function heartbeat(sessions) {
  // At the daily cap this daemon can't answer — stop beating so the metered
  // fallback brain (if configured) takes over instead of mentions stalling
  // until UTC midnight.
  if (atCap()) return;
  for (const session of sessions) {
    await beatRoom(`${session.folderId}:index`);
    for (const guid of session.docs.keys()) await beatRoom(`${session.folderId}:${guid}`);
  }
}

const sessions = CONFIG.folders.map((folderId) => new FolderSession(folderId));
setTimeout(() => void heartbeat(sessions), 5000); // after doc set settles
setInterval(() => void heartbeat(sessions), HEARTBEAT_MS);
log(`coedit Claude peer up: ${CONFIG.folders.length} folder(s) on ${CONFIG.host}, cap ${DAILY_CAP}/day`);
