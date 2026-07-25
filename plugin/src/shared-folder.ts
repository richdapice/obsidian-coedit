import { type App, Notice, TFile, TFolder, type TAbstractFile, type Vault } from "obsidian";
import { IndexeddbPersistence } from "y-indexeddb";
import type YProvider from "y-partyserver/provider";
import * as Y from "yjs";
import { createProvider, whenSynced } from "./collab";
import { applyDiskDiff, isWholesaleChange, mergeTypedEdits } from "./disk-sync";
import { DocManager } from "./doc-manager";
import { pullBlob, pushBlob, roomName } from "./net";
import {
  classifyMapDelta,
  classifyOpenModify,
  contentHash,
  type FileMeta,
  isReadOnlyToken,
  isUnder,
  joinPath,
  sha256Hex,
  toRelative,
} from "./paths";
import { Tracer } from "./perf";
import type { CoeditSettings, SharedFolderConfig } from "./settings";
import type { VaultApplier } from "./vault-applier";

/** Origin tag for our own index-map transactions. */
const LOCAL = "coedit-local";
/** Attachments above this size are skipped (Worker request-body headroom). */
const MAX_BLOB_BYTES = 25 * 1024 * 1024;

/** Last hash at which disk and CRDT were seen to agree, per guid. */
export interface SyncStateStore {
  get(guid: string): string | undefined;
  set(guid: string, hash: string): void;
}

/**
 * One shared folder: an always-connected index Y.Doc mapping relative path →
 * {guid, hash, mtime}, plus a DocManager for the per-file content docs.
 * Files are identified by guid; paths are mutable metadata.
 *
 * Sync-order invariant: offline disk edits are folded into the local
 * (IndexedDB-persisted) doc BEFORE that doc receives remote updates, so Yjs
 * itself merges local and remote edits. Diffing after a remote merge would
 * delete the remote edits (see disk-sync tests). Since lingering sockets can
 * feed remote updates into closed docs, "before any remote update" is
 * verified by HASH (doc still at the last disk agreement recorded in
 * syncState), never assumed from provider state; docs past that point merge
 * via fuzzy patches or fall back to a conflict copy.
 */
export class SharedFolder {
  readonly doc = new Y.Doc();
  readonly files: Y.Map<FileMeta>;
  readonly provider: YProvider;
  readonly docs: DocManager;
  private idb: IndexeddbPersistence;
  /** Docs whose local state the server may lack (failed pushes to retry). */
  private pendingPush = new Set<string>();

  constructor(
    private app: App,
    private getSettings: () => CoeditSettings,
    readonly config: SharedFolderConfig,
    private applier: VaultApplier,
    readonly syncState: SyncStateStore,
    dbPrefix: string,
  ) {
    this.files = this.doc.getMap<FileMeta>("files");
    this.docs = new DocManager(getSettings, config.folderId, dbPrefix);
    this.idb = new IndexeddbPersistence(`${dbPrefix}-index`, this.doc);
    this.provider = createProvider(getSettings(), roomName(config.folderId, "index"), this.doc);
    this.files.observe((event, txn) => {
      // Skip our own transactions AND IndexedDB's startup replay — the
      // persisted map is old news, not a remote delta; reconcile() covers it.
      if (txn.origin === LOCAL || txn.origin === this.idb) return;
      void this.applyRemoteDelta(event).catch((err) => {
        console.error("coedit: failed to apply remote folder changes", err);
      });
    });
  }

  whenConnected(): Promise<void> {
    return whenSynced(this.provider);
  }

  destroy(): void {
    this.provider.destroy();
    this.docs.destroy();
    void this.idb.destroy();
    this.doc.destroy();
  }

  // ---- paths

  contains(path: string): boolean {
    return isUnder(this.config.localPath, path);
  }

  private rel(vaultPath: string): string {
    return toRelative(this.config.localPath, vaultPath);
  }

  private abs(relPath: string): string {
    return joinPath(this.config.localPath, relPath);
  }

  metaFor(vaultPath: string): FileMeta | undefined {
    return this.files.get(this.rel(vaultPath));
  }

  /** Public path helpers for presence/follow features. */
  relPath(vaultPath: string): string {
    return this.rel(vaultPath);
  }

  absPath(relPath: string): string {
    return this.abs(relPath);
  }

  private transact(fn: () => void): void {
    this.doc.transact(fn, LOCAL);
  }

  /** Last warned content-hash per path, so retries don't stack Notices. */
  private warnedWholesale = new Map<string, string>();

  /** Loud, user-visible warning when a note's content is mostly replaced. */
  private warnWholesale(relPath: string, source: string, resultHash: string): void {
    if (this.warnedWholesale.get(relPath) === resultHash) return;
    this.warnedWholesale.set(relPath, resultHash);
    console.warn(`coedit: "${relPath}" was almost entirely rewritten ${source}`);
    new Notice(
      `Coedit: "${relPath}" was almost entirely rewritten ${source}. ` +
        `If that's unexpected, use "Version history for current note" to restore it.`,
      10000,
    );
  }

  /** Conflict Notices shown recently; after a few in a burst, console-only
   *  (a lost syncState store would otherwise bury the user in per-file
   *  Notices). A quiet 10 minutes resets the budget. */
  private conflictNotices = 0;
  private lastConflictAt = 0;

  private notifyConflict(relPath: string, copyRel: string): void {
    if (Date.now() - this.lastConflictAt > 10 * 60 * 1000) this.conflictNotices = 0;
    this.lastConflictAt = Date.now();
    this.conflictNotices++;
    if (this.conflictNotices === 4) {
      new Notice("Coedit: more unmerged conflicts — see the developer console for the full list.", 10000);
    }
    if (this.conflictNotices >= 4) return;
    new Notice(
      `Coedit: "${relPath}" changed on disk while unsynced edits arrived and the two ` +
        `couldn't be merged. Your disk version was kept as "${copyRel}".`,
      10000,
    );
  }

  /**
   * Preserve diverged disk text as a sibling file. Created via the vault (not
   * the applier) ON PURPOSE: the create event enrolls the copy into the
   * share, so it reaches every peer and can be merged from anywhere.
   */
  async saveConflictCopy(relPath: string, text: string): Promise<string> {
    const dot = relPath.lastIndexOf(".");
    const stem = dot === -1 ? relPath : relPath.slice(0, dot);
    const ext = dot === -1 ? "" : relPath.slice(dot);
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
    let copyRel = `${stem} (conflict ${stamp})${ext}`;
    for (let n = 2; this.vault.getAbstractFileByPath(this.abs(copyRel)) !== null; n++) {
      copyRel = `${stem} (conflict ${stamp} ${n})${ext}`;
    }
    await this.vault.create(this.abs(copyRel), text);
    return copyRel;
  }

  private get vault(): Vault {
    return this.app.vault;
  }

  // ---- the per-file sync pipeline (files with no editor bound)

  /**
   * Bring one closed file to convergence: fold offline disk edits into the
   * local doc, merge remote state, seed lost docs, write the result to disk,
   * and publish hash/state. Serialized per guid; skips docs an editor holds.
   */
  async syncClosedFile(relPath: string, meta: FileMeta): Promise<void> {
    const tracer = new Tracer(`closed-sync ${relPath}`);
    try {
      await this.syncClosedFileLocked(relPath, meta, tracer);
    } finally {
      tracer.end();
    }
  }

  private async syncClosedFileLocked(relPath: string, meta: FileMeta, tracer: Tracer): Promise<void> {
    await this.docs.withLock(meta.guid, async () => {
      tracer.mark("lock-wait");
      if (this.docs.isOpen(meta.guid)) return; // the editor binding owns it
      // Re-check liveness inside the lock: a sync queued behind a remote
      // delete/rename must not resurrect the file from doc state.
      const live = this.files.get(relPath);
      if (live?.guid !== meta.guid) return;
      const path = this.abs(relPath);
      const af = this.vault.getAbstractFileByPath(path);
      const diskText = af instanceof TFile ? await this.vault.cachedRead(af) : null;
      const entry = this.docs.get(meta.guid);
      await entry.ready;
      tracer.mark("read");

      const lingering = this.docs.hasProvider(meta.guid);
      const beforeText = entry.ytext.toString();
      const agreedHash = this.syncState.get(meta.guid);

      // 1. Fold local disk edits in. applyDiskDiff makes ytext EQUAL disk —
      //    that is only safe while ytext still sits at the state the disk
      //    text was derived from (its hash matches syncState). A doc that
      //    moved past that point — a lingering socket streamed remote
      //    updates in, now or in a previous run (they survive via
      //    IndexedDB) — must merge instead: folding would delete the remote
      //    edits and push the deletion. Keyed on hashes, NOT on provider
      //    presence, so the hazard doesn't resurface after linger expiry or
      //    a restart.
      let folded = false;
      let diskHandled = false;
      let conflict = false;
      let echoConfirmed = false;
      if (
        diskText !== null &&
        entry.ytext.length > 0 &&
        contentHash(diskText) !== agreedHash &&
        diskText !== beforeText
      ) {
        diskHandled = true;
        const docAtAgreement = agreedHash !== undefined && contentHash(beforeText) === agreedHash;
        if (docAtAgreement) {
          applyDiskDiff(entry.doc, entry.ytext, diskText);
          folded = true;
        } else if (lingering && entry.recentTextHashes.includes(contentHash(diskText))) {
          // Stale autosave echo of an earlier doc state; the doc is strictly
          // ahead, and the final write below refreshes disk from it. That
          // write must happen THIS round even offline: the echo knowledge
          // dies with the linger, and a later round would misread the stale
          // disk as a real edit and re-merge already-applied deltas.
          echoConfirmed = true;
        } else if (
          entry.lastAgreedText !== undefined &&
          agreedHash !== undefined &&
          contentHash(entry.lastAgreedText) === agreedHash &&
          mergeTypedEdits(entry.doc, entry.ytext, entry.lastAgreedText, diskText)
        ) {
          folded = true;
        } else {
          // Disk and doc both moved with no usable merge base (restart after
          // a linger, or the fuzzy patches failed to place). Never guess:
          // keep the disk text as a conflict copy and let the doc own the
          // path — handled after the pull below.
          conflict = true;
        }
      }
      const foldWholesale = folded && isWholesaleChange(beforeText, entry.ytext.toString());

      // 2. Merge the server's state.
      tracer.mark("fold");
      let pulled = false;
      try {
        await this.docs.pull(meta.guid);
        pulled = true;
      } catch (err) {
        console.warn(`coedit: pull failed for ${relPath}; continuing offline`, err);
      }
      tracer.mark("pull");

      // 2b. The both-moved conflict from step 1: only resolvable against a
      //     verified doc. Offline, leave everything untouched and retry.
      if (conflict) {
        if (!pulled || diskText === null) return;
        // Nothing to preserve when the post-pull doc already contains the
        // disk text verbatim (e.g. a lost-syncState restart where only the
        // doc really moved) — skip the copy and just converge.
        if (!entry.ytext.toString().includes(diskText)) {
          try {
            const copyRel = await this.saveConflictCopy(relPath, diskText);
            console.warn(`coedit: kept diverged disk copy of "${relPath}" as "${copyRel}"`);
            this.notifyConflict(relPath, copyRel);
          } catch (err) {
            // Without the copy, overwriting disk below would destroy the edit.
            console.error(`coedit: failed to save conflict copy for ${relPath}`, err);
            return;
          }
        }
      }

      // 3. Fresh-device path collision: local file text never entered any
      //    doc. Fold it into the pulled state (positional merge). Skip when
      //    step 1 already made a call about this disk text.
      if (
        !folded &&
        !diskHandled &&
        pulled &&
        diskText !== null &&
        diskText.length > 0 &&
        entry.ytext.length > 0 &&
        diskText !== entry.ytext.toString() &&
        contentHash(diskText) !== this.syncState.get(meta.guid)
      ) {
        applyDiskDiff(entry.doc, entry.ytext, diskText);
        folded = true;
      }

      // 4. Recovery seeding — ONLY when a successful pull proved the doc is
      //    really empty. Seeding while offline risks a double seed (the
      //    enroller's copy plus ours) that duplicates the whole text.
      if (entry.ytext.length === 0 && diskText !== null && diskText.length > 0) {
        if (!pulled) {
          // Can't decide safely; leave everything untouched and let the next
          // reconcile retry.
          return;
        }
        entry.ytext.insert(0, diskText);
        folded = true;
      }

      // Push when we changed the doc, when an earlier push failed, or when
      // our doc disagrees with the advertised hash (heals hash ping-pong
      // after a lost push).
      const finalText = entry.ytext.toString();
      const finalHash = contentHash(finalText);
      const advertised = this.files.get(relPath);
      tracer.mark("merge");
      if (
        !isReadOnlyToken(this.getSettings().token) &&
        (folded ||
          this.pendingPush.has(meta.guid) ||
          (pulled && advertised?.guid === meta.guid && advertised.hash !== finalHash))
      ) {
        try {
          await this.docs.push(meta.guid);
          this.pendingPush.delete(meta.guid);
        } catch (err) {
          this.pendingPush.add(meta.guid);
          console.warn(`coedit: push failed for ${relPath}; queued for retry`, err);
        }
      }
      tracer.mark("push");

      // Never rewrite disk from an UNVERIFIED doc: offline with nothing
      // folded means we learned nothing this round — leaving the file alone
      // is always safe, while writing stale/poisoned doc state over it (and
      // recording syncState to match) destroyed on-disk edits in the July
      // 2026 incident. A confirmed stale echo is the exception: the disk is
      // proven to be an old snapshot OF THIS DOC, so refreshing it from the
      // doc is safe (and required) even offline.
      if (!pulled && !folded && !echoConfirmed) return;

      // Tripwire: a note being almost entirely replaced is occasionally
      // legitimate (scripted notes) but is also the signature of a paste-
      // into-the-wrong-note accident or a sync bug. Never let it be silent.
      // foldWholesale was measured BEFORE the pull so remote rewrites aren't
      // blamed on the disk; the conflict path already produced its own Notice.
      if (foldWholesale) {
        this.warnWholesale(relPath, "from a disk edit", finalHash);
      } else if (!conflict && diskText !== null && isWholesaleChange(diskText, finalText)) {
        this.warnWholesale(relPath, "by remote content", finalHash);
      }

      if (diskText !== finalText) {
        await this.applier.writeFile(path, finalText);
      }
      this.syncState.set(meta.guid, finalHash);
      if (lingering) entry.lastAgreedText = finalText;
      const current = this.files.get(relPath);
      if (current?.guid === meta.guid && current.hash !== finalHash) {
        this.transact(() =>
          this.files.set(relPath, { ...current, hash: finalHash, mtime: Date.now() }),
        );
      }
      tracer.mark("write");
    });
  }

  // ---- share/join/startup reconciliation (call only after whenConnected)

  /** Two-way reconcile: enroll local-only files, then converge every entry that moved on either side. */
  async reconcile(): Promise<{ synced: number; enrolled: number }> {
    const enrolled = await this.enrollMissing();
    let synced = 0;
    for (const [relPath, meta] of [...this.files.entries()]) {
      const path = this.abs(relPath);
      const af = this.vault.getAbstractFileByPath(path);
      if (meta.kind === "blob") {
        if (!(af instanceof TFile)) {
          await this.syncBlobFromRemote(relPath, meta);
          synced++;
        } else {
          const sha = await sha256Hex(await this.vault.readBinary(af));
          if (sha === meta.hash) continue;
          // Binaries can't merge: last writer wins by mtime.
          if (af.stat.mtime > meta.mtime) {
            await this.onLocalBlobModify(af, relPath, meta);
          } else {
            await this.syncBlobFromRemote(relPath, meta);
          }
          synced++;
        }
        continue;
      }
      if (this.docs.isOpen(meta.guid)) continue; // the editor binding owns it
      if (af instanceof TFile) {
        const last = this.syncState.get(meta.guid);
        const diskHash = contentHash(await this.vault.cachedRead(af));
        if (diskHash === last && meta.hash === last) continue; // clean on both sides
      }
      await this.syncClosedFile(relPath, meta);
      synced++;
    }
    return { synced, enrolled };
  }

  /** Enroll local files the index doesn't know about (sharer's first run, or files created while the plugin was off). */
  async enrollMissing(): Promise<number> {
    const files = this.vault
      .getFiles()
      .filter((f) => this.contains(f.path) && !this.files.has(this.rel(f.path)));
    let enrolled = 0;
    for (const file of files) {
      if (await this.enroll(file)) enrolled++;
    }
    return enrolled;
  }

  /** Register a file: markdown becomes a CRDT doc, anything else a blob. */
  private async enroll(file: TFile): Promise<boolean> {
    if (file.extension === "md") return this.enrollDoc(file);
    return this.enrollBlob(file);
  }

  /** Seed a content doc from disk and register the file. Creator-seeds rule: only the peer that creates the index entry ever seeds. */
  private async enrollDoc(file: TFile): Promise<boolean> {
    const content = await this.vault.cachedRead(file);
    const guid = crypto.randomUUID();
    const entry = this.docs.get(guid);
    await entry.ready;
    if (content.length > 0) entry.ytext.insert(0, content);
    await this.docs.push(guid).catch((err) => {
      console.warn(`coedit: seed push failed for ${file.path}; will retry next sync`, err);
    });
    this.syncState.set(guid, contentHash(content));
    this.transact(() =>
      this.files.set(this.rel(file.path), {
        guid,
        hash: contentHash(content),
        mtime: file.stat.mtime,
      }),
    );
    return true;
  }

  /**
   * Upload a binary and register it. Registration only happens after a
   * successful upload so peers never see an entry they can't fetch;
   * failures retry on the next reconcile.
   */
  private async enrollBlob(file: TFile): Promise<boolean> {
    if (file.stat.size > MAX_BLOB_BYTES) {
      console.warn(`coedit: ${file.path} exceeds ${MAX_BLOB_BYTES} bytes; not syncing`);
      return false;
    }
    const bytes = await this.vault.readBinary(file);
    const sha = await sha256Hex(bytes);
    try {
      await pushBlob(this.getSettings(), sha, bytes);
    } catch (err) {
      console.warn(`coedit: blob upload failed for ${file.path}; will retry next sync`, err);
      return false;
    }
    const guid = crypto.randomUUID();
    this.syncState.set(guid, sha);
    this.transact(() =>
      this.files.set(this.rel(file.path), {
        guid,
        hash: sha,
        mtime: file.stat.mtime,
        kind: "blob",
      }),
    );
    return true;
  }

  /** Bring a local binary up to date with the advertised content hash. */
  private async syncBlobFromRemote(relPath: string, meta: FileMeta): Promise<void> {
    const path = this.abs(relPath);
    const af = this.vault.getAbstractFileByPath(path);
    if (af instanceof TFile) {
      const sha = await sha256Hex(await this.vault.readBinary(af));
      if (sha === meta.hash) {
        this.syncState.set(meta.guid, meta.hash);
        return;
      }
    }
    try {
      const bytes = await pullBlob(this.getSettings(), meta.hash);
      await this.applier.writeBinary(path, bytes);
      this.syncState.set(meta.guid, meta.hash);
    } catch (err) {
      console.warn(`coedit: blob download failed for ${relPath}; will retry next sync`, err);
    }
  }

  /** A local binary changed: upload and advertise the new hash. */
  private async onLocalBlobModify(file: TFile, relPath: string, meta: FileMeta): Promise<void> {
    if (file.stat.size > MAX_BLOB_BYTES) {
      console.warn(`coedit: ${file.path} exceeds ${MAX_BLOB_BYTES} bytes; not syncing`);
      return;
    }
    const bytes = await this.vault.readBinary(file);
    const sha = await sha256Hex(bytes);
    if (sha === meta.hash) return;
    try {
      await pushBlob(this.getSettings(), sha, bytes);
    } catch (err) {
      console.warn(`coedit: blob upload failed for ${relPath}; will retry next sync`, err);
      return;
    }
    this.syncState.set(meta.guid, sha);
    const current = this.files.get(relPath);
    if (current?.guid === meta.guid) {
      this.transact(() =>
        this.files.set(relPath, { ...current, hash: sha, mtime: file.stat.mtime }),
      );
    }
  }

  /**
   * Set a doc's text to an older version AS AN EDIT (history preserved, no
   * doc replacement), propagate it, and update disk/index bookkeeping.
   */
  async restoreText(relPath: string, meta: FileMeta, text: string): Promise<void> {
    await this.docs.withLock(meta.guid, async () => {
      const entry = this.docs.get(meta.guid);
      await entry.ready;
      try {
        await this.docs.pull(meta.guid);
      } catch (err) {
        console.warn(`coedit: pull before restore failed for ${relPath}`, err);
      }
      applyDiskDiff(entry.doc, entry.ytext, text);
      await this.docs.push(meta.guid).catch((err) => {
        console.warn(`coedit: push after restore failed for ${relPath}`, err);
      });
      const finalText = entry.ytext.toString();
      const finalHash = contentHash(finalText);
      if (this.docs.isOpen(meta.guid)) {
        // The binding streams the change into the editor; Obsidian saves.
        entry.lastAgreedText = finalText;
      } else {
        await this.applier.writeFile(this.abs(relPath), finalText);
      }
      this.syncState.set(meta.guid, finalHash);
      const current = this.files.get(relPath);
      if (current?.guid === meta.guid && current.hash !== finalHash) {
        this.transact(() =>
          this.files.set(relPath, { ...current, hash: finalHash, mtime: Date.now() }),
        );
      }
    });
  }

  /**
   * Load every doc's IndexedDB state in the background so the first click
   * on each note doesn't pay the cold open + update-log replay. Paced with
   * small yields; safe to abandon mid-way (session restart destroys the
   * DocManager, which makes get() throw — we just stop).
   */
  async prewarmDocs(): Promise<void> {
    for (const [, meta] of [...this.files.entries()]) {
      if (meta.kind === "blob") continue;
      try {
        const entry = this.docs.get(meta.guid);
        await entry.ready;
      } catch {
        return; // manager destroyed (settings change/unlink) — stop quietly
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
  }

  // ---- local vault events → index map

  async onLocalCreate(file: TAbstractFile): Promise<void> {
    if (this.applier.consumeCreate(file.path)) return;
    if (!(file instanceof TFile)) return;
    if (this.files.has(this.rel(file.path))) return;
    await this.enroll(file);
  }

  async onLocalRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (this.applier.consumeRename(oldPath, file.path)) return;
    const wasIn = isUnder(this.config.localPath, oldPath);
    const nowIn = this.contains(file.path);

    if (file instanceof TFolder) {
      if (wasIn) {
        const oldPrefix = `${toRelative(this.config.localPath, oldPath)}/`;
        this.transact(() => {
          for (const [key, meta] of [...this.files.entries()]) {
            if (!key.startsWith(oldPrefix)) continue;
            this.files.delete(key);
            if (nowIn) {
              this.files.set(`${this.rel(file.path)}/${key.slice(oldPrefix.length)}`, meta);
            }
          }
        });
      }
      if (!wasIn && nowIn) {
        // A folder moved into the share: enroll its markdown files.
        await this.enrollMissing();
      }
      return;
    }

    if (!(file instanceof TFile)) return;
    if (wasIn && nowIn) {
      const meta = this.files.get(toRelative(this.config.localPath, oldPath));
      if (!meta) {
        await this.onLocalCreate(file);
        return;
      }
      // Renames across the .md boundary change how the file syncs (CRDT doc
      // vs LWW blob): retire the old entry and enroll fresh under a new guid.
      const wantsDoc = file.extension === "md";
      const isDoc = meta.kind !== "blob";
      if (wantsDoc !== isDoc) {
        this.transact(() => this.files.delete(toRelative(this.config.localPath, oldPath)));
        await this.enroll(file);
        return;
      }
      this.transact(() => {
        this.files.delete(toRelative(this.config.localPath, oldPath));
        this.files.set(this.rel(file.path), meta);
      });
    } else if (wasIn) {
      this.transact(() => this.files.delete(toRelative(this.config.localPath, oldPath)));
    } else if (nowIn) {
      await this.onLocalCreate(file);
    }
  }

  onLocalDelete(file: TAbstractFile, path: string): void {
    if (this.applier.consumeDelete(path)) return;
    const rel = toRelative(this.config.localPath, path);
    if (file instanceof TFolder) {
      this.transact(() => {
        for (const key of [...this.files.keys()]) {
          if (key.startsWith(`${rel}/`)) this.files.delete(key);
        }
      });
      return;
    }
    if (this.files.has(rel)) {
      this.transact(() => this.files.delete(rel));
    }
  }

  /**
   * Obsidian saved a file — its own autosave for open editors, or an edit
   * from elsewhere. For open files, edits normally arrive through the bound
   * editor and the save just confirms agreement; edits that bypassed the
   * editor (reading-view checkbox taps, other plugins writing the file) are
   * fuzzy-merged into the live doc so they reach peers instantly over the
   * open WebSocket. Closed files run the full pipeline.
   */
  async onLocalModify(file: TFile): Promise<void> {
    if (this.applier.consumeModify(file.path)) return;
    const rel = this.rel(file.path);
    const meta = this.files.get(rel);
    if (!meta) return;
    if (meta.kind === "blob") {
      await this.onLocalBlobModify(file, rel, meta);
      return;
    }

    if (this.docs.isOpen(meta.guid)) {
      await this.docs.withLock(meta.guid, async () => {
        const content = await this.vault.cachedRead(file);
        const entry = this.docs.get(meta.guid);
        // "Open" now includes an attach's pre-bind window (retain is taken
        // before the binding lands). Until a binding is INSTALLED, attach's
        // own locked fold owns every save — merging one here as well would
        // apply the same delta twice. (boundCount, not lastAgreedText:
        // closed-file syncs may set lastAgreedText for lingering docs.)
        if (entry.boundCount === 0) return;
        const kind = classifyOpenModify(
          contentHash(content),
          contentHash(entry.ytext.toString()),
          entry.recentTextHashes,
        );
        // A stale autosave echo already lives in the CRDT; merging it again
        // would duplicate the delta for every peer. Ignore it — a fresher
        // save follows.
        if (kind === "stale-echo") return;
        if (kind === "bypass") {
          // Written around the editor (checkbox tap, other plugin). Merge
          // against the last agreed base; the binding streams the merged
          // text back into the editor and Obsidian re-saves it.
          if (isWholesaleChange(entry.ytext.toString(), content)) {
            this.warnWholesale(rel, "from a disk edit", contentHash(content));
          }
          if (!mergeTypedEdits(entry.doc, entry.ytext, entry.lastAgreedText ?? content, content)) {
            // The editor still shows the doc's version, so nothing is hidden;
            // the next save retries against a fresher base.
            console.warn(`coedit: external edit to "${rel}" did not merge cleanly; will retry`);
          }
        }
        const finalText = entry.ytext.toString();
        const hash = contentHash(finalText);
        if (finalText === content) {
          entry.lastAgreedText = content;
          // Only record sync state for what is REALLY on disk — recording
          // ytext's hash while disk differs poisons the next startup fold.
          this.syncState.set(meta.guid, hash);
        }
        const current = this.files.get(rel);
        if (current?.guid === meta.guid && current.hash !== hash) {
          this.transact(() => this.files.set(rel, { ...current, hash, mtime: file.stat.mtime }));
        }
      });
    } else {
      const content = await this.vault.cachedRead(file);
      if (contentHash(content) === meta.hash) return;
      await this.syncClosedFile(rel, meta);
    }
  }

  // ---- remote index changes → disk

  private async applyRemoteDelta(event: Y.YMapEvent<FileMeta>): Promise<void> {
    const delta = classifyMapDelta(event.changes.keys, (k) => this.files.get(k));

    for (const r of delta.renamed) {
      await this.applier.rename(this.abs(r.from), this.abs(r.to));
    }
    for (const d of delta.removed) {
      await this.applier.trash(this.abs(d.path));
      // The file is really gone — this is the only time a doc gets evicted.
      await this.docs.withLock(d.meta.guid, async () => {
        this.docs.evictIfClosed(d.meta.guid);
      });
    }
    for (const a of [...delta.added, ...delta.updated]) {
      if (a.meta.kind === "blob") {
        await this.syncBlobFromRemote(a.path, a.meta);
        continue;
      }
      if (this.docs.isOpen(a.meta.guid)) continue; // live via WebSocket
      await this.syncClosedFile(a.path, a.meta);
    }
    // A peer that renamed AND edited offline delivers both in one
    // transaction; the rename above moved the file, now sync its content.
    for (const r of delta.renamed) {
      if (r.meta.hash === this.syncState.get(r.meta.guid)) continue;
      if (r.meta.kind === "blob") {
        await this.syncBlobFromRemote(r.to, r.meta);
      } else if (!this.docs.isOpen(r.meta.guid)) {
        await this.syncClosedFile(r.to, r.meta);
      }
    }
  }
}
