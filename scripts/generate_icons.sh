#!/usr/bin/env bash
# Regenerate every PWA icon size from icon/icon.png with ImageMagick.
# Run from the project root: bash scripts/generate_icons.sh
set -euo pipefail

SRC="icon/icon.png"
OUT="icons"
PAD_BG="#000206"   # matches the icon's own background corner

mkdir -p "$OUT"

for size in 72 96 128 144 152 167 180 192 256 384 512; do
  magick "$SRC" -resize ${size}x${size} -strip "$OUT/icon-${size}.png"
done

# Maskable variants: 80% safe-zone (Android adaptive icons crop up to 10%).
magick "$SRC" -resize 154x154 -background "$PAD_BG" -gravity center -extent 192x192 -strip "$OUT/icon-maskable-192.png"
magick "$SRC" -resize 410x410 -background "$PAD_BG" -gravity center -extent 512x512 -strip "$OUT/icon-maskable-512.png"

# Multi-resolution favicon for the browser tab.
magick "$SRC" -define icon:auto-resize=16,32,48 favicon.ico

echo "Generated $(ls $OUT | wc -l) icons in $OUT/ and favicon.ico"
