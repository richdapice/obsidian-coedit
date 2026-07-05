#!/usr/bin/env bash
# Create (or refresh) two test vaults with the plugin installed and a shared
# folder pre-configured (same folder ID in both, so no share/join clicking).
# Run `npm run build` in plugin/ first; re-run this after every rebuild to
# push the new main.js into both vaults.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
plugin="$root/plugin"
folder_id="dev-folder-0001"

if [[ ! -f "$plugin/main.js" ]]; then
  echo "plugin/main.js missing — run 'npm run build' in plugin/ first" >&2
  exit 1
fi

for name in alice bob; do
  vault="$root/dev/vaults/$name"
  plugdir="$vault/.obsidian/plugins/relay-clone"
  mkdir -p "$plugdir"
  cp "$plugin/main.js" "$plugin/manifest.json" "$plugdir/"
  echo '["relay-clone"]' > "$vault/.obsidian/community-plugins.json"
  cat > "$plugdir/data.json" <<EOF
{
  "serverHost": "localhost:8787",
  "token": "dev-secret",
  "displayName": "$name",
  "sharedFolder": { "localPath": "Shared", "folderId": "$folder_id" }
}
EOF
done

# Alice starts with content (she enrolls it on first run); Bob starts empty
# and should materialize it after joining.
mkdir -p "$root/dev/vaults/alice/Shared"
note="$root/dev/vaults/alice/Shared/Note.md"
[[ -f "$note" ]] || printf '# Shared note\n\nSeeded by alice.\n' > "$note"

echo "vaults ready:"
echo "  $root/dev/vaults/alice"
echo "  $root/dev/vaults/bob"
echo "Open both in Obsidian (Open folder as vault) and accept the plugin trust prompt once per vault."
