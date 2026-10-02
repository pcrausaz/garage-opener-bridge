import { deflateSync } from "node:zlib";

/**
 * The picture the mock bridge serves as a camera snapshot (ADR-0021): a drawn garage seen from inside, one
 * door per simulated door, each at the height the simulator has it at. It is generated, not stored, and it
 * is deliberately a drawing — this repository is public and no real camera image belongs in it.
 */
export const ILLUSTRATION_SIZE = { width: 320, height: 180 } as const;

type Rgb = readonly [number, number, number];

const WALL: Rgb = [58, 62, 70];
const FLOOR: Rgb = [92, 94, 98];
const FRAME: Rgb = [32, 34, 40];
const PANEL: Rgb = [214, 216, 220];
const SLAT: Rgb = [168, 172, 180];
const SKY: Rgb = [148, 196, 236];
const DRIVE: Rgb = [176, 170, 158];
const LABEL: Rgb = [250, 204, 21];

/** 3×5 glyphs for the corner label, so nobody mistakes the drawing for a camera. */
const GLYPHS: Record<string, string[]> = {
  D: ["110", "101", "101", "101", "110"],
  E: ["111", "100", "110", "100", "111"],
  M: ["101", "111", "111", "101", "101"],
  O: ["111", "101", "101", "101", "111"],
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** Minimal PNG writer: 8-bit RGB, no filtering. Flat colours deflate to a kilobyte or two. */
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * `positions` holds one entry per door, 0 (on the floor) to 1 (fully open). A sectional door rolls up, so the
 * panel hangs from the top of the opening and daylight shows underneath it.
 */
export function drawGarage(positions: number[]): Buffer {
  const { width, height } = ILLUSTRATION_SIZE;
  const px = Buffer.alloc(width * height * 3);
  const rect = (x0: number, y0: number, x1: number, y1: number, c: Rgb) => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(height, Math.round(y1)); y++) {
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(width, Math.round(x1)); x++) px.set(c, (y * width + x) * 3);
    }
  };
  const floorY = 150;
  rect(0, 0, width, floorY, WALL);
  rect(0, floorY, width, height, FLOOR);

  const n = Math.max(1, positions.length);
  const gap = 16;
  const doorW = (width - gap * (n + 1)) / n;
  const top = 34;
  positions.forEach((raw, i) => {
    const p = Math.min(1, Math.max(0, raw));
    const x0 = gap + i * (doorW + gap);
    const x1 = x0 + doorW;
    rect(x0 - 4, top - 4, x1 + 4, floorY, FRAME);
    // What is outside: sky over a driveway.
    rect(x0, top, x1, floorY - 26, SKY);
    rect(x0, floorY - 26, x1, floorY, DRIVE);
    // The panel covers the opening from the top down to its bottom edge.
    const edge = floorY - (floorY - top) * p;
    rect(x0, top, x1, edge, PANEL);
    for (let y = top + 14; y < edge - 2; y += 16) rect(x0, y, x1, y + 2, SLAT);
    if (p > 0 && p < 1) rect(x0, edge - 3, x1, edge, FRAME);
  });

  const scale = 3;
  [..."DEMO"].forEach((ch, i) => {
    GLYPHS[ch]!.forEach((row, gy) => {
      [...row].forEach((bit, gx) => {
        if (bit === "1") rect(8 + (i * 4 + gx) * scale, 8 + gy * scale, 8 + (i * 4 + gx + 1) * scale, 8 + (gy + 1) * scale, LABEL);
      });
    });
  });
  return encodePng(width, height, px);
}
