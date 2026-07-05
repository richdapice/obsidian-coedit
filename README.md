# Relay Clone

Real-time collaborative editing for Obsidian, in the spirit of
[Relay](https://relay.md): share a vault folder, and its markdown files sync
live between vaults — remote cursors included — through a self-hosted
Cloudflare Durable Objects backend. Yjs CRDTs do the merging.

## Layout

- `server/` — Cloudflare Worker. One Durable Object per Y.Doc
  (`y-partyserver` with WebSocket hibernation), shared-secret auth checked
  before upgrade, chunked snapshot persistence in DO storage, and an HTTP
  `GET/POST …/as-update` endpoint so background sync never holds sockets.
- `plugin/` — the Obsidian plugin. A folder-level index Y.Doc maps
  relative path → `{guid, hash, mtime}`; each file is its own Y.Doc
  (`getText("contents")`) identified by guid, so renames move map keys only.
  Open editors bind via `y-codemirror.next` over WebSocket; closed files
  reconcile over HTTP. Per-doc IndexedDB persistence + diff-match-patch
  folding make offline edits merge instead of clobber.
- `dev/` — `setup.sh` builds two throwaway vaults (alice/bob) wired to
  `localhost:8787` with a pre-shared folder `Shared/`.

## Quick start (local)

```sh
cd server && npm i && npm run dev        # terminal 1
cd plugin && npm i && npm run build      # terminal 2
../dev/setup.sh
```

Open `dev/vaults/alice` and `dev/vaults/bob` as vaults in Obsidian (trust the
plugin once per vault). Open `Shared/Note.md` in both windows and type.

Verification helpers (with `wrangler dev` running):

```sh
cd server
npm test                          # DO unit/integration tests
node scripts/converge.mjs         # two headless clients converge via WS + HTTP
node scripts/probe-folder.mjs     # drives create/rename/delete against live vaults
```

## Deploying

```sh
cd server
npx wrangler deploy
npx wrangler secret put SHARED_SECRET
```

Then in the plugin settings set the server host to
`<worker>.<account>.workers.dev` and the shared secret, and use the
"Share folder…" / "Join shared folder…" commands.

## Known limitations (deliberate MVP cuts)

- One shared folder per vault; markdown files only (no attachments).
- Auth is a single shared secret for everyone; no per-user permissions.
- Renaming/deleting a file while Obsidian is fully closed re-materializes it
  on next launch (the reconciler can't distinguish an offline rename from a
  never-downloaded file). Rename with Obsidian running.
- Divergent offline edits merge positionally (diff-match-patch), not via
  3-way diff; overlapping edits resolve in favor of the disk/typist side.
- Undo uses Y.UndoManager and may interact oddly with Obsidian's native
  history in edge cases.
