const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 128;
const buf = Buffer.alloc(SIZE * SIZE * 4);

function set(x, y, r, g, b, a) {
  const i = (y * SIZE + x) * 4;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
  buf[i + 3] = a;
}

function inRoundedRect(x, y, pad, radius) {
  const min = pad;
  const max = SIZE - pad;
  if (x < min || x > max || y < min || y > max) return false;
  const cxs = [min + radius, max - radius];
  const cys = [min + radius, max - radius];
  const nearLeft = x < cxs[0];
  const nearRight = x > cxs[1];
  const nearTop = y < cys[0];
  const nearBottom = y > cys[1];
  if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
    const cx = nearLeft ? cxs[0] : cxs[1];
    const cy = nearTop ? cys[0] : cys[1];
    return Math.hypot(x - cx, y - cy) <= radius;
  }
  return true;
}

function inTriangle(x, y) {
  const ax = 50,
    ay = 40,
    bx = 50,
    by = 88,
    cx = 92,
    cy = 64;
  const d = (x1, y1, x2, y2, px, py) =>
    (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
  const d1 = d(ax, ay, bx, by, x, y);
  const d2 = d(bx, by, cx, cy, x, y);
  const d3 = d(cx, cy, ax, ay, x, y);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (!inRoundedRect(x, y, 8, 28)) {
      set(x, y, 0, 0, 0, 0);
      continue;
    }
    if (inTriangle(x, y)) {
      set(x, y, 255, 255, 255, 255);
    } else {
      const t = y / SIZE;
      set(x, y, Math.round(10 + 30 * t), Math.round(132 - 20 * t), 255, 255);
    }
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(__dirname, "..", "media", "icon.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log("wrote", out, png.length, "bytes");
