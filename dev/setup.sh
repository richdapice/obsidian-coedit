#!/usr/bin/env bash
# Create (or refresh) two test vaults with the plugin installed.
# Run `npm run build` in plugin/ first, then this script; re-run it after
# every rebuild to push the new main.js into both vaults.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
plugin="$root/plugin"

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
  if [[ ! -f "$plugdir/data.json" ]]; then
    cat > "$plugdir/data.json" <<EOF
{
  "serverHost": "localhost:8787",
  "token": "dev-secret",
  "sharedNotePath": "Shared.md",
  "displayName": "$name"
}
EOF
  fi
done

# Alice starts with content (she seeds the server doc); Bob starts empty.
alice_note="$root/dev/vaults/alice/Shared.md"
bob_note="$root/dev/vaults/bob/Shared.md"
[[ -f "$alice_note" ]] || printf '# Shared note\n\nSeeded by alice.\n' > "$alice_note"
[[ -f "$bob_note" ]] || : > "$bob_note"

echo "vaults ready:"
echo "  $root/dev/vaults/alice"
echo "  $root/dev/vaults/bob"
echo "Open them in Obsidian (Open folder as vault) and accept the plugin trust prompt once per vault."
