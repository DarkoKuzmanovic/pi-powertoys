#!/usr/bin/env bash
# Uninstall pi-powertoys — removes symlinks from Pi's extensions directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOYS_DIR="$SCRIPT_DIR/toys"
EXT_DIR="$HOME/.pi/agent/extensions"

count=0
for ts in "$TOYS_DIR"/*.ts; do
  [ -f "$ts" ] || continue
  base="$(basename "$ts")"
  link="$EXT_DIR/$base"
  if [ -L "$link" ]; then
    rm "$link"
    echo "  ✗ $base"
    ((count++)) || true
  fi
done

echo ""
echo "Removed $count toy(s) from $EXT_DIR"
echo "Restart Pi or run /reload to apply."
