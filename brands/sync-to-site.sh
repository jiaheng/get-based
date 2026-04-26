#!/usr/bin/env bash
# Mirror brands/ → ../get-based-site/brands/ so the landing site stays
# in lock-step with the app's vendor asset library.
#
# Run from anywhere — the script resolves paths relative to itself.

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
SITE="${SITE:-$DIR/../../get-based-site}"

if [ ! -d "$SITE/.git" ]; then
  echo "Site repo not found at $SITE — set SITE=/path/to/get-based-site"
  exit 2
fi

rsync -av --delete --exclude='sync-to-site.sh' "$DIR/" "$SITE/brands/"
echo
echo "✓ Synced to $SITE/brands"
echo "  Review with:  cd \"$SITE\" && git status brands/"
