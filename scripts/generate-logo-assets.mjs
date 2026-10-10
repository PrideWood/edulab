// Trace the supplied artwork; never replace its geometry with a redesigned mark.
// Run from the repository root: node scripts/generate-logo-assets.mjs
import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";

const source = "public/brand/logo-source.jpg";
const { data, info: { width, height } } = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const { data: smooth } = await sharp(source).removeAlpha().blur(0.8).raw().toBuffer({ resolveWithObject: true });
const palette = [
  { name: "panel", rgb: [225, 242, 233] },
  { name: "negative-space", rgb: [246, 250, 244] },
  { name: "liquid", rgb: [151, 196, 169] },
  { name: "molecule", rgb: [85, 141, 112] },
  { name: "outline", rgb: [16, 55, 40] },
];
const labels = new Uint8Array(width * height);
const samples = palette.map(() => [[], [], []]);
for (let i = 0; i < labels.length; i++) {
  const rgb = [smooth[i * 3], smooth[i * 3 + 1], smooth[i * 3 + 2]];
  let nearest = 0, distance = Infinity;
  for (let k = 0; k < palette.length; k++) {
    const d = palette[k].rgb.reduce((sum, c, j) => sum + (rgb[j] - c) ** 2, 0);
    if (d < distance) { distance = d; nearest = k; }
  }
  labels[i] = nearest;
  if (distance < 100) for (let j = 0; j < 3; j++) samples[nearest][j].push(data[i * 3 + j]);
}
const colors = samples.map(channels => `#${channels.map(values => {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)].toString(16).padStart(2, "0");
}).join("")}`);

// Follow pixel boundaries into closed contours. The source is blurred only for
// contour detection; all retained PNG pixels come from the untouched JPEG.
function contours(mask) {
  const edges = new Map();
  const key = (x, y) => y * (width + 1) + x;
  const add = (x1, y1, x2, y2) => {
    const a = key(x1, y1), b = key(x2, y2);
    const next = edges.get(a) ?? [];
    next.push(b); edges.set(a, next);
  };
  const on = (x, y) => x >= 0 && x < width && y >= 0 && y < height && mask[y * width + x];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!on(x, y)) continue;
    if (!on(x, y - 1)) add(x, y, x + 1, y);
    if (!on(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!on(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!on(x - 1, y)) add(x, y + 1, x, y);
  }
  const rings = [];
  while (edges.size) {
    const start = edges.keys().next().value;
    let current = start;
    const ring = [];
    do {
      ring.push([current % (width + 1), Math.floor(current / (width + 1))]);
      const next = edges.get(current);
      if (!next) break;
      const target = next.pop();
      if (!next.length) edges.delete(current);
      current = target;
    } while (current !== start);
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}
function area(ring) {
  return ring.reduce((sum, a, i) => {
    const b = ring[(i + 1) % ring.length];
    return sum + a[0] * b[1] - b[0] * a[1];
  }, 0) / 2;
}
function simplify(points, tolerance = 0.85) {
  if (points.length < 3) return points;
  const a = points[0], b = points.at(-1);
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let furthest = 0, max = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
    if (d > max) { max = d; furthest = i; }
  }
  return max > tolerance
    ? [...simplify(points.slice(0, furthest + 1), tolerance).slice(0, -1), ...simplify(points.slice(furthest), tolerance)]
    : [a, b];
}
function path(rings, tolerance = 0.85) {
  return rings.map(ring => {
    const half = Math.floor(ring.length / 2);
    const points = [...simplify(ring.slice(0, half + 1), tolerance).slice(0, -1), ...simplify([...ring.slice(half), ring[0]], tolerance).slice(0, -1)];
    // Quadratic midpoints smooth the subpixel stair steps without altering the
    // traced silhouette by more than the contour approximation tolerance.
    const midpoint = (a, b) => `${((a[0] + b[0]) / 2).toFixed(1)} ${((a[1] + b[1]) / 2).toFixed(1)}`;
    return `M${midpoint(points.at(-1), points[0])} ` + points.map((p, i) => {
      const previous = points[(i + points.length - 1) % points.length];
      const next = points[(i + 1) % points.length];
      const incoming = [p[0] - previous[0], p[1] - previous[1]];
      const outgoing = [next[0] - p[0], next[1] - p[1]];
      const cosine = (incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) / (Math.hypot(...incoming) * Math.hypot(...outgoing));
      // Preserve deliberate corners, including the flask neck and pointed tip.
      return cosine < 0.85 ? `L${p.join(" ")} L${midpoint(p, next)}` : `Q${p.join(" ")} ${midpoint(p, next)}`;
    }).join(" ") + " Z";
  }).join(" ");
}
const exteriorMask = Uint8Array.from(labels, (_, i) => smooth[i * 3 + 1] - smooth[i * 3] > 7);
const panel = contours(exteriorMask).sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)))[0];
const panelPath = path([panel], 0.9);
const svgHeader = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`;
const parts = [svgHeader, "<title>EduLab</title>", `<path fill="${colors[0]}" d="${panelPath}"/>`];
function componentAt(k, x, y) {
  const mask = new Uint8Array(labels.length);
  const start = y * width + x;
  if (labels[start] !== k) throw new Error(`Invalid ${palette[k].name} trace seed`);
  const queue = [start]; mask[start] = 1;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const i = queue[cursor];
    const neighbors = [i - width, i + width];
    if (i % width) neighbors.push(i - 1);
    if (i % width !== width - 1) neighbors.push(i + 1);
    for (const n of neighbors) if (n >= 0 && n < labels.length && !mask[n] && labels[n] === k) {
      mask[n] = 1; queue.push(n);
    }
  }
  return mask;
}
for (let k = 1; k < palette.length; k++) {
  // Isolate the real liquid and molecule; transition pixels along the dark
  // contour can otherwise be mistaken for a separate medium-green shape.
  const mask = k === 2 ? componentAt(k, 600, 800)
    : k === 3 ? componentAt(k, 661, 496)
    : Uint8Array.from(labels, value => value === k);
  const rings = contours(mask).filter(ring => {
    if (Math.abs(area(ring)) < 60) return false;
    // Exterior near-white corners are not part of the white interior artwork.
    if (k === 1 && ring.some(([x, y]) => x <= 2 || y <= 2 || x >= width - 2 || y >= height - 2)) return false;
    // The exterior's negative-winding panel hole must not become white fill.
    if (k === 1 && Math.abs(area(ring)) > width * height * 0.5) return false;
    return true;
  });
  parts.push(`<path fill="${colors[k]}" fill-rule="evenodd" d="${path(rings)}"/>`);
}
parts.push("</svg>");
const svg = parts.join("\n") + "\n";
await writeFile("public/logo.svg", svg);
await writeFile("public/favicon.svg", svg);

// Apply the traced exterior as an antialiased alpha mask. Keep original RGB
// values, proportions and all internal whites; remove JPEG white edge matte.
const maskSvg = `${svgHeader}<path fill="white" d="${panelPath}"/></svg>`;
const { data: mask } = await sharp(Buffer.from(maskSvg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const rgba = Buffer.alloc(width * height * 4);
for (let i = 0; i < labels.length; i++) {
  const alpha = mask[i * 4 + 3];
  for (let j = 0; j < 3; j++) {
    const original = data[i * 3 + j];
    // Fractional edge pixels contain the old white background. Decontaminate
    // that matte only at the exterior, never inside the illustration.
    rgba[i * 4 + j] = alpha > 0 && alpha < 255
      ? Math.max(0, Math.min(255, Math.round((original - 255 * (1 - alpha / 255)) / (alpha / 255))))
      : original;
  }
  rgba[i * 4 + 3] = alpha;
}
await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile("public/logo.png");
const png = await readFile("public/logo.png");
await sharp(png).resize(32, 32).png().toFile("public/favicon-32.png");
await sharp(png).resize(180, 180).png().toFile("public/apple-touch-icon.png");

// An ICO directory with PNG frames supports both classic and high-DPI tabs.
const sizes = [16, 32, 48, 64, 128, 256];
const frames = await Promise.all(sizes.map(size => sharp(png).resize(size, size).png().toBuffer()));
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2); directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
frames.forEach((frame, i) => {
  const entry = 6 + i * 16;
  directory[entry] = sizes[i] === 256 ? 0 : sizes[i];
  directory[entry + 1] = directory[entry];
  directory.writeUInt16LE(1, entry + 4); directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(frame.length, entry + 8); directory.writeUInt32LE(offset, entry + 12);
  offset += frame.length;
});
await writeFile("public/favicon.ico", Buffer.concat([directory, ...frames]));
console.log({ source, width, height, colors, icoSizes: sizes });
