// Pure-Node PNG icon generator for the "Agent Manager" extension.
// Renders at high resolution with supersampling, then box-downsamples for AA.
// No external deps — uses only zlib for PNG compression.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || 256;   // final size
const SS = 4;                         // supersample factor
const S = OUT * SS;                   // working resolution

// ---- helpers --------------------------------------------------------------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// canvas buffers (premultiplied straight RGBA, 0..255 float)
const R = new Float64Array(S * S);
const G = new Float64Array(S * S);
const B = new Float64Array(S * S);
const A = new Float64Array(S * S);

// "over" composite a fully-opaque color at pixel i with coverage cov (0..1)
function paint(i, r, g, b, cov) {
  const a0 = A[i] / 255, a1 = cov;
  const ao = a1 + a0 * (1 - a1);
  if (ao <= 0) return;
  R[i] = (r * a1 + R[i] * a0 * (1 - a1)) / ao;
  G[i] = (g * a1 + G[i] * a0 * (1 - a1)) / ao;
  B[i] = (b * a1 + B[i] * a0 * (1 - a1)) / ao;
  A[i] = ao * 255;
}

// signed distance to rounded box centered in canvas
function sdRoundRect(px, py, half, rr) {
  const qx = Math.abs(px - S / 2) - (half - rr);
  const qy = Math.abs(py - S / 2) - (half - rr);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - rr;
}

function pointInTri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// ---- design parameters ----------------------------------------------------
const TOP = hex('#6D5BF0');     // indigo
const BOT = hex('#9B4DF2');     // violet
const WHITE = [255, 255, 255];

const cx = S / 2, cy = S / 2;
const rr = 0.235 * S;           // background corner radius
const half = S / 2;             // full-bleed square

const ringR = 0.245 * S;        // radius of swap ring
const ringT = 0.072 * S;        // ring thickness (full)
const ht = ringT / 2;

// two arcs (degrees, math CCW, 0 = +x). Gaps at ~20° and ~200° for arrowheads.
const arc1 = [42, 198];
const arc2 = [222, 378];
// arrowheads
const arrows = [
  { a: 198, dir: +1 },
  { a: 18, dir: +1 },
];
const arrowL = ringT * 1.55;    // tip length
const arrowW = ringT * 1.15;    // half base width

// three account dots inside the ring (a small cluster = multiple accounts)
const dots = [
  { x: cx, y: cy - 0.085 * S, r: 0.045 * S },
  { x: cx - 0.075 * S, y: cy + 0.055 * S, r: 0.045 * S },
  { x: cx + 0.075 * S, y: cy + 0.055 * S, r: 0.045 * S },
];

function angleDeg(px, py) {
  let d = Math.atan2(-(py - cy), px - cx) * 180 / Math.PI;
  return (d + 360) % 360;
}
function inArc(deg, [lo, hi]) {
  if (hi <= 360) return deg >= lo && deg <= hi;
  return deg >= lo || deg <= hi - 360; // wraps past 360
}

// precompute arrow triangles
const tris = arrows.map(({ a, dir }) => {
  const Ar = a * Math.PI / 180;
  const bx = cx + ringR * Math.cos(Ar);
  const by = cy - ringR * Math.sin(Ar);
  const radx = Math.cos(Ar), rady = -Math.sin(Ar);
  const tanx = dir * -Math.sin(Ar), tany = dir * -Math.cos(Ar);
  return {
    tipx: bx + tanx * arrowL, tipy: by + tany * arrowL,
    b1x: bx + radx * arrowW, b1y: by + rady * arrowW,
    b2x: bx - radx * arrowW, b2y: by - rady * arrowW,
  };
});

// ---- rasterize ------------------------------------------------------------
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = y * S + x;
    const px = x + 0.5, py = y + 0.5;

    // background rounded rect with vertical gradient
    if (sdRoundRect(px, py, half, rr) < 0) {
      const t = py / S;
      paint(i, lerp(TOP[0], BOT[0], t), lerp(TOP[1], BOT[1], t), lerp(TOP[2], BOT[2], t), 1);
    } else {
      continue; // outside icon → stays transparent
    }

    // white swap ring (two arcs)
    const dist = Math.hypot(px - cx, py - cy);
    if (Math.abs(dist - ringR) <= ht) {
      const deg = angleDeg(px, py);
      if (inArc(deg, arc1) || inArc(deg, arc2)) {
        paint(i, WHITE[0], WHITE[1], WHITE[2], 1);
      }
    }
    // arrowheads
    for (const t of tris) {
      if (pointInTri(px, py, t.tipx, t.tipy, t.b1x, t.b1y, t.b2x, t.b2y)) {
        paint(i, WHITE[0], WHITE[1], WHITE[2], 1);
        break;
      }
    }
    // account dots
    for (const d of dots) {
      if (Math.hypot(px - d.x, py - d.y) <= d.r) {
        paint(i, WHITE[0], WHITE[1], WHITE[2], 1);
        break;
      }
    }
  }
}

// ---- downsample (box) -----------------------------------------------------
const out = Buffer.alloc(OUT * OUT * 4);
for (let y = 0; y < OUT; y++) {
  for (let x = 0; x < OUT; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = (y * SS + sy) * S + (x * SS + sx);
        const al = A[i] / 255;
        r += R[i] * al; g += G[i] * al; b += B[i] * al; a += al;
      }
    }
    const n = SS * SS;
    const o = (y * OUT + x) * 4;
    const af = a / n;
    if (af > 0) {
      out[o] = clamp(Math.round(r / a), 0, 255);
      out[o + 1] = clamp(Math.round(g / a), 0, 255);
      out[o + 2] = clamp(Math.round(b / a), 0, 255);
    }
    out[o + 3] = clamp(Math.round(af * 255), 0, 255);
  }
}

// ---- PNG encode -----------------------------------------------------------
function crc32(buf) {
  let c, t = crc32.t;
  if (!t) {
    t = crc32.t = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT, 0); ihdr.writeUInt32BE(OUT, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
// add filter byte (0) per scanline
const raw = Buffer.alloc((OUT * 4 + 1) * OUT);
for (let y = 0; y < OUT; y++) {
  raw[y * (OUT * 4 + 1)] = 0;
  out.copy(raw, y * (OUT * 4 + 1) + 1, y * OUT * 4, (y + 1) * OUT * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const dest = path.join(__dirname, '..', 'media', 'icon.png');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, png);
console.log('wrote', dest, OUT + 'x' + OUT, png.length + ' bytes');
