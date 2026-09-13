#!/usr/bin/env node
'use strict';

/**
 * Render the Lina symbol as an Android notification small icon.
 *
 * Android draws a notification's small icon as a silhouette: it keeps the alpha
 * channel and throws the colours away, so the asset has to be white on
 * transparent or it arrives as a grey blob. The brand PNGs are the full mark on
 * its dark rounded surface, which is exactly the wrong thing, so this writes a
 * separate `assets/notification-icon.png`.
 *
 * `packages/brand/lina-symbol.svg` is the source. Its two paths are rectilinear,
 * so the whole glyph is three axis-aligned rectangles in the 64-unit viewBox:
 *
 *     M12 8H26V38H54V52H12V8Z   ->  (12,8)-(26,52) and (26,38)-(54,52)
 *     M41 8H54V21H41V8Z         ->  (41,8)-(54,21)
 *
 * which means it can be rasterized exactly here, with no image library and no
 * dependency added to this app. 4x4 supersampling keeps the scaled edges clean.
 *
 * Run `node scripts/make-notification-icon.cjs` after the vector changes.
 * `scripts/config.test.cjs` checks the output exists and is the right size.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/** Android wants the small icon at 96x96 for xxxhdpi; it is scaled down below. */
const SIZE = 96;
/** Clear space around the glyph, in output pixels. */
const MARGIN = 8;
/** How many samples per pixel axis when testing coverage. */
const SAMPLES = 4;

/** The symbol, as rectangles in the SVG's 64-unit viewBox. */
const RECTS = [
  { x0: 12, y0: 8, x1: 26, y1: 52 },
  { x0: 26, y0: 38, x1: 54, y1: 52 },
  { x0: 41, y0: 8, x1: 54, y1: 21 },
];

function artBounds() {
  return {
    x0: Math.min(...RECTS.map(r => r.x0)),
    y0: Math.min(...RECTS.map(r => r.y0)),
    x1: Math.max(...RECTS.map(r => r.x1)),
    y1: Math.max(...RECTS.map(r => r.y1)),
  };
}

/** RGBA pixels: white everywhere, alpha from the glyph's coverage. */
function renderPixels(size, margin) {
  const bounds = artBounds();
  const artWidth = bounds.x1 - bounds.x0;
  const artHeight = bounds.y1 - bounds.y0;
  const box = size - margin * 2;
  const scale = Math.min(box / artWidth, box / artHeight);
  const offsetX = (size - artWidth * scale) / 2 - bounds.x0 * scale;
  const offsetY = (size - artHeight * scale) / 2 - bounds.y0 * scale;

  const pixels = Buffer.alloc(size * size * 4, 0);
  const step = 1 / SAMPLES;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          // Back-project the sample into the SVG's own coordinates.
          const px = (x + (sx + 0.5) * step - offsetX) / scale;
          const py = (y + (sy + 0.5) * step - offsetY) / scale;
          if (RECTS.some(r => px >= r.x0 && px < r.x1 && py >= r.y0 && py < r.y1)) hits += 1;
        }
      }
      if (!hits) continue;
      const alpha = Math.round((hits / (SAMPLES * SAMPLES)) * 255);
      const at = (y * size + x) * 4;
      pixels[at] = 255;
      pixels[at + 1] = 255;
      pixels[at + 2] = 255;
      pixels[at + 3] = alpha;
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** Minimal 8-bit RGBA PNG, one filter-0 scanline per row. */
function encodePng(pixels, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function main() {
  const out = path.resolve(__dirname, '..', 'assets', 'notification-icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encodePng(renderPixels(SIZE, MARGIN), SIZE));
  process.stdout.write(`WROTE ${out} (${SIZE}x${SIZE})\n`);
}

if (require.main === module) main();

module.exports = { RECTS, SIZE, encodePng, renderPixels };
