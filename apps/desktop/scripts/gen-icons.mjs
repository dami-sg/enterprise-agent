#!/usr/bin/env node
/**
 * Procedural icon generation — no design assets, no image deps. A tiny PNG
 * encoder (zlib deflate + hand-rolled chunks/CRC) renders the mark: a hub dot
 * inside a ring with three agent nodes on it, on a blue rounded square.
 *
 * Outputs:
 *   resources/icons/trayTemplate.png (+@2x)  # menu-bar icon — black+alpha; the
 *                                            # "Template" filename suffix makes
 *                                            # Electron/macOS theme-adapt it
 *   resources/icons/app.png                  # 512px — dev dock / win+linux window icon
 *   build/icon.icns                          # electron-builder mac.icon (via iconutil)
 *   build/icon.png                           # 512px fallback for other targets
 */
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const iconsDir = join(root, 'resources', 'icons');
const buildDir = join(root, 'build');

// ---------------------------------------------------------------------------
// Minimal PNG encoder (8-bit RGBA, filter 0)
// ---------------------------------------------------------------------------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Rendering — signed-distance shapes with 1px antialiasing
// ---------------------------------------------------------------------------
const clamp01 = (v) => Math.min(1, Math.max(0, v));
/** Coverage from a signed distance (≤0 inside), ~1px smooth edge. */
const cov = (sd, aa) => clamp01(0.5 - sd / aa);

/** Approx SDF of an organic blob: a circle whose radius gently undulates, so
 *  the membrane reads as a living cell rather than a hard geometric circle. */
function blobSD(px, py, cx, cy, r, amp, lobes, phase) {
  const dx = px - cx;
  const dy = py - cy;
  const ang = Math.atan2(dy, dx);
  return Math.hypot(dx, dy) - (r + amp * Math.sin(lobes * ang + phase));
}

const circleSD = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;

// Background gradient stops (top-left → bottom-right): green → deep teal (青绿).
const BG_TOP = [0x34, 0xd3, 0x99];
const BG_BOT = [0x0d, 0x77, 0x6e];

function renderMark(size, { background }) {
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const aa = Math.max(1, size / 256);
  // A cell: an undulating membrane (white cytoplasm), an off-center nucleus
  // knocked out to the gradient with a small nucleolus, plus organelle dots.
  const body = { cx: size * 0.5, cy: size * 0.52, r: size * 0.35, amp: size * 0.024, lobes: 5, phase: 0.7 };
  const nucleus = { cx: size * 0.575, cy: size * 0.45, r: size * 0.135 };
  const nucleolus = { cx: size * 0.605, cy: size * 0.415, r: size * 0.045 };
  const organelles = [
    [size * 0.35, size * 0.6, size * 0.042],
    [size * 0.44, size * 0.69, size * 0.03],
    [size * 0.4, size * 0.42, size * 0.032],
  ];
  const bgR = size * 0.225; // rounded-square corner radius (macOS-ish squircle feel)
  const bgHalf = size * 0.5 - (background ? size * 0.05 : 0);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const fx = x + 0.5;
      const fy = y + 0.5;

      let bgA = 0;
      if (background) {
        const dx = Math.max(Math.abs(fx - c) - (bgHalf - bgR), 0);
        const dy = Math.max(Math.abs(fy - c) - (bgHalf - bgR), 0);
        bgA = cov(Math.hypot(dx, dy) - bgR, aa);
      }

      const bodyCov = cov(blobSD(fx, fy, body.cx, body.cy, body.r, body.amp, body.lobes, body.phase), aa);
      let holeCov = cov(circleSD(fx, fy, nucleus.cx, nucleus.cy, nucleus.r), aa);
      for (const [ox, oy, orr] of organelles) holeCov = Math.max(holeCov, cov(circleSD(fx, fy, ox, oy, orr), aa));
      const nucleolusCov = cov(circleSD(fx, fy, nucleolus.cx, nucleolus.cy, nucleolus.r), aa);
      // White cytoplasm minus the knocked-out nucleus/organelles, with the
      // nucleolus painted back in as a white dot.
      const mark = Math.max(clamp01(bodyCov - holeCov), Math.min(nucleolusCov, bodyCov));

      if (background) {
        // Diagonal blue→indigo gradient tile with the white mark on top.
        const g = clamp01((fx + fy) / (size * 2));
        const r = BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * g;
        const gg = BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * g;
        const b = BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * g;
        px[i] = Math.round(r + (255 - r) * mark);
        px[i + 1] = Math.round(gg + (255 - gg) * mark);
        px[i + 2] = Math.round(b + (255 - b) * mark);
        px[i + 3] = Math.round(bgA * 255);
      } else {
        // Template: pure black, alpha = mark coverage (menu bar recolors it).
        px[i] = px[i + 1] = px[i + 2] = 0;
        px[i + 3] = Math.round(mark * 255);
      }
    }
  }
  return encodePng(size, px);
}

// ---------------------------------------------------------------------------
mkdirSync(iconsDir, { recursive: true });
mkdirSync(buildDir, { recursive: true });

writeFileSync(join(iconsDir, 'trayTemplate.png'), renderMark(22, { background: false }));
writeFileSync(join(iconsDir, 'trayTemplate@2x.png'), renderMark(44, { background: false }));
writeFileSync(join(iconsDir, 'app.png'), renderMark(512, { background: true }));
writeFileSync(join(buildDir, 'icon.png'), renderMark(512, { background: true }));

// macOS .icns via the system iconutil (skip elsewhere — builder falls back to png).
if (process.platform === 'darwin') {
  const iconset = join(buildDir, 'icon.iconset');
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const s of [16, 32, 128, 256, 512]) {
    writeFileSync(join(iconset, `icon_${s}x${s}.png`), renderMark(s, { background: true }));
    writeFileSync(join(iconset, `icon_${s}x${s}@2x.png`), renderMark(s * 2, { background: true }));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')]);
  rmSync(iconset, { recursive: true, force: true });
}

console.log(`[gen-icons] tray + app icons → ${iconsDir}, build icons → ${buildDir}`);
