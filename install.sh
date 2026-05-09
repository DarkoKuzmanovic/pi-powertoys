#!/usr/bin/env bash
# Install pi-powertoys — symlinks each toy into Pi's extensions directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOYS_DIR="$SCRIPT_DIR/toys"
EXT_DIR="$HOME/.pi/agent/extensions"

mkdir -p "$EXT_DIR"

count=0
for ts in "$TOYS_DIR"/*.ts; do
  [ -f "$ts" ] || continue
  base="$(basename "$ts")"
  ln -sfn "$ts" "$EXT_DIR/$base"
  echo "  ✓ $base"
  ((count++)) || true
done

echo ""
echo "Installed $count toy(s) into $EXT_DIR"
echo "Restart Pi or run /reload to activate."
