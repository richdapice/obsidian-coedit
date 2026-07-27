# Coedit

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

## @claude peer

Mention `@claude` on any line of a shared note and a Claude collaborator
answers in a quoted callout beneath it. Two interchangeable brains:

- **Daemon** (`peer/`): runs on a Mac via launchd, answers through the local
  `claude` CLI (subscription-billed). Copy `config.example.json` to
  `config.json` (host, shared secret, folder ids, absolute `claudeBin`),
  `npm install`, then load the plist (edit PEER_DIR placeholders first).
- **Durable Object fallback** (server): dormant unless the
  `ANTHROPIC_API_KEY` worker secret is set (`wrangler secret put
  ANTHROPIC_API_KEY`, metered billing). It answers only when the daemon's
  heartbeat has been quiet for 5 minutes, so the subscription brain always
  wins while its Mac is awake.

Protocol notes: replies are `> [!quote]` callouts carrying an ownership
nonce; caps are 50/day (daemon) and 10/day per note (fallback); read-only
invitees can't trigger answers (their connections can't write). Scripted
notes that rewrite themselves (ticket watchers) re-ask on every rewrite if
you put a mention in one — don't.
