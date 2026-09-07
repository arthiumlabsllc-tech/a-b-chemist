#!/usr/bin/env node
/**
 * Generates the PWA icons.
 *
 * Written rather than dropped in as binaries for one reason: an icon that is
 * committed as a file has no provenance, so the next person who needs a different
 * size or a recoloured mark starts over in an image editor. This is reproducible,
 * reviewable as a diff, and produces exactly the two sizes the manifest names.
 *
 * The mark is a gold cross on Ghana green, drawn inside the central 60% of the
 * canvas. That is deliberate: a `maskable` icon is cropped to a circle of roughly
 * 80% of the canvas by the platform, so anything drawn near the edge disappears
 * on an Android home screen.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.resolve(__dirname, '..', 'frontend', 'public', 'icons');

const SIZES = [192, 512];

const GREEN = [0x00, 0x87, 0x53];
const GOLD = [0xfc, 0xd1, 0x16];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Encodes an 8-bit truecolour PNG. No alpha channel: the icon is a solid square,
 * and a transparent corner under a circular platform mask shows the wallpaper
 * through in a way that looks like a rendering bug.
 */
function encodePng(size, pixelAt) {
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(size * stride);
  let offset = 0;

  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // filter type 0 (None) for every scanline
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const pixel = pixelAt(x, y);
      raw[offset] = pixel[0];
      raw[offset + 1] = pixel[1];
      raw[offset + 2] = pixel[2];
      offset += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour, no alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pharmacyMark(size) {
  const centre = size / 2;
  const armLength = size * 0.6;
  const thickness = size * 0.2;

  return (x, y) => {
    // Sampled at the pixel centre so the cross stays symmetric at odd sizes.
    const dx = Math.abs(x + 0.5 - centre);
    const dy = Math.abs(y + 0.5 - centre);
    const horizontalBar = dx <= armLength / 2 && dy <= thickness / 2;
    const verticalBar = dy <= armLength / 2 && dx <= thickness / 2;
    return horizontalBar || verticalBar ? GOLD : GREEN;
  };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const size of SIZES) {
    const file = path.join(OUT_DIR, `icon-${size}.png`);
    fs.writeFileSync(file, encodePng(size, pharmacyMark(size)));
    const bytes = fs.statSync(file).size;
    process.stdout.write(`wrote ${path.relative(process.cwd(), file)} (${bytes} bytes)\n`);
  }
}

main();
