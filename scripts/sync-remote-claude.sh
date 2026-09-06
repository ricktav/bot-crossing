#!/usr/bin/env bash
# Mirror remote ~/.claude/projects into data/remotes/<id>/.claude/projects for bot-crossing.
# Prefer letting the Vite server call this on a throttle (server/lib/remote-claude.mjs).
# Use this script for a one-shot sync or cron.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/server/remotes.config.json"
# Copy remotes.config.sample.json → remotes.config.json (gitignored) first.
DEST_ROOT="$ROOT/data/remotes"

if [[ ! -f "$CONFIG" ]]; then
  echo "missing $CONFIG" >&2
  exit 1
fi

# Requires jq. Falls back to a tiny node parse if jq is absent.
hosts_json() {
  if command -v jq >/dev/null 2>&1; then
    jq -c '.hosts[] | select(.enabled != false) | {id,ssh,claudePath}' "$CONFIG"
  else
    node --input-type=module -e '
      import fs from "node:fs";
      const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const h of cfg.hosts || []) {
        if (h.enabled === false) continue;
        if (!h.id || !h.ssh) continue;
        process.stdout.write(JSON.stringify({id:h.id,ssh:h.ssh,claudePath:h.claudePath||"~/.claude"})+"\n");
      }
    ' "$CONFIG"
  fi
}

while IFS= read -r row; do
  [[ -z "$row" ]] && continue
  id=$(node -e 'const h=JSON.parse(process.argv[1]); process.stdout.write(h.id)' "$row")
  ssh=$(node -e 'const h=JSON.parse(process.argv[1]); process.stdout.write(h.ssh)' "$row")
  claude=$(node -e 'const h=JSON.parse(process.argv[1]); process.stdout.write(h.claudePath||"~/.claude")' "$row")
  dest="$DEST_ROOT/$id/.claude/projects"
  mkdir -p "$dest"
  src="${ssh}:${claude%/}/projects/"
  echo "sync $id ← $src"
  rsync -az --delete     -e 'ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new'     "$src" "$dest/"
done < <(hosts_json)

echo "done → $DEST_ROOT"
