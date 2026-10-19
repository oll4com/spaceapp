#!/bin/sh
# Space Memory names (naming invariant 2026-10-13): an install made before 1.1.7 keeps its memory in
# gemini_history*.md. Move those files to the space_memory names once and keep the old names as links.
# Usage: memory-names.sh <memory root>
set -eu
move_legacy() {
  if [ -f "$1" ] && [ ! -L "$1" ] && [ ! -e "$2" ]; then
    mv "$1" "$2"
    ln -s "$(basename "$2")" "$1"
  fi
}
move_legacy "$1/gemini_history.md" "$1/space_memory.md"
move_legacy "$1/gemini_history_monthly.md" "$1/space_memory_monthly.md"
