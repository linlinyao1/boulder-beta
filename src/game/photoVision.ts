import { getReferenceClimberForGrade } from './climber';
import { estimateRouteGrade, nextUid, suggestBeta } from './generator';
import { HOLD_COLORS, renumberHolds } from './holds';
import { clamp, dist } from './ik';
import {
  Hold,
  HoldStyleFamily,
  HoldType,
  Vec2,
  WALL_HEIGHT_CM,
  WALL_WIDTH_CM,
} from './types';

export type QuadCorners = [Vec2, Vec2, Vec2, Vec2]; // [TL, TR, BR, BL] in normalized 0..1 coords

export interface ColorSample {
  x: number; // rectified pixel x [0..400]
  y: number; // rectified pixel y [0..450]
  rgb: [number, number, number];
  lab: [number, number, number];
  kind: 'include' | 'exclude';
}

export interface RecognitionOptions {
  tolerance: number; // 12..55 (default 26)
  minHoldAreaPx: number; // 16..140 (default 34)
  wallAngleDeg: number;
  enablePhysicsCalibration: boolean;
}

export interface RecognizedHoldDetail {
  hold: Hold;
  areaPx: number;
  aspectRatio: number;
  confidence: number;
  reason: string;
}

export interface RecognitionResult {
  holds: Hold[];
  details: RecognizedHoldDetail[];
  dominantHex: string;
  estimatedGrade: string;
  solved: boolean;
  calibrationNotes: string[];
  elapsedMs: number;
  maskWidth: number;
  maskHeight: number;
}

export interface RgbaBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Exact sRGB [0..255] -> CIELAB (D65) conversion for perceptually uniform,
 * chalk- and shadow-tolerant climbing hold segmentation.
 */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const sr = r / 255;
  const sg = g / 255;
  const sb = b / 255;

  const linR = sr > 0.04045 ? Math.pow((sr + 0.055) / 1.055, 2.4) : sr / 12.92;
  const linG = sg > 0.04045 ? Math.pow((sg + 0.055) / 1.055, 2.4) : sg / 12.92;
  const linB = sb > 0.04045 ? Math.pow((sb + 0.055) / 1.055, 2.4) : sb / 12.92;

  // D65 reference white
  const x = (linR * 0.4124564 + linG * 0.3575761 + linB * 0.1804375) / 0.95047;
  const y = (linR * 0.2126729 + linG * 0.7151522 + linB * 0.072175) / 1.0;
  const z = (linR * 0.0193339 + linG * 0.119192 + linB * 0.9503041) / 1.08883;

  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  const L = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const bLab = 200 * (fy - fz);
  return [L, a, bLab];
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

/**
 * Maps an arbitrary sampled RGB color cleanly to either a clean vivid hex or closest gym hold palette hex.
 */
function normalizeHoldHex(rgb: [number, number, number]): string {
  const lab = rgbToLab(rgb[0], rgb[1], rgb[2]);
  const chroma = Math.hypot(lab[1], lab[2]);
  if (chroma < 12) {
    return lab[0] < 48 ? '#3D434C' : '#CBD5E1';
  }
  // Check if close to one of our curated gym hold colors; otherwise preserve vibrant sampled hue!
  let bestHex = rgbToHex(rgb[0], rgb[1], rgb[2]);
  let bestDist = Infinity;
  for (const c of HOLD_COLORS) {
    const clean = c.hex.replace('#', '');
    const cr = parseInt(clean.slice(0, 2), 16);
    const cg = parseInt(clean.slice(2, 4), 16);
    const cb = parseInt(clean.slice(4, 6), 16);
    const clab = rgbToLab(cr, cg, cb);
    const d = Math.hypot(lab[1] - clab[1], lab[2] - clab[2]) + Math.abs(lab[0] - clab[0]) * 0.25;
    if (d < bestDist) {
      bestDist = d;
      bestHex = c.hex;
    }
  }
  return bestDist < 22 ? bestHex : rgbToHex(rgb[0], rgb[1], rgb[2]);
}

/**
 * Solves an 8x8 linear system Ax = b via Gaussian elimination with partial pivoting.
 */
function solveLinear8(A: number[][], b: number[]): number[] | null {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxVal = Math.abs(M[col][col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(M[row][col]);
      if (v > maxVal) {
        maxVal = v;
        pivotRow = row;
      }
    }
    if (maxVal < 1e-10) return null;
    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }

    const pivot = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= pivot;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row][col];
      if (Math.abs(factor) < 1e-12) continue;
      for (let j = col; j <= n; j++) {
        M[row][j] -= factor * M[col][j];
      }
    }
  }

  return M.map((row) => row[n]);
}

/**
 * Computes the 3x3 homography matrix mapping destination pixel (u, v) in [0..dstW, 0..dstH]
 * directly to source pixel (sx, sy) inside the user-selected quadrilateral.
 */
export function computeHomographyDstToSrc(
  srcQuadPx: QuadCorners,
  dstW: number,
  dstH: number
): number[] {
  const dstPts: Vec2[] = [
    { x: 0, y: 0 },
    { x: dstW, y: 0 },
    { x: dstW, y: dstH },
    { x: 0, y: dstH },
  ];

  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const u = dstPts[i].x;
    const v = dstPts[i].y;
    const x = srcQuadPx[i].x;
    const y = srcQuadPx[i].y;
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }

  const h = solveLinear8(A, b);
  if (!h) {
    // Degenerate quad fallback: simple scale identity
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/**
 * Perspective-warps a source RGBA buffer inside `quadNorm` (0..1 corners [TL, TR, BR, BL])
 * into an orthographic `outW x outH` RGBA buffer using bilinear interpolation.
 */
export function warpRgbaPerspective(
  src: RgbaBuffer,
  quadNorm: QuadCorners,
  outW = WALL_WIDTH_CM,
  outH = WALL_HEIGHT_CM
): RgbaBuffer {
  const srcQuadPx: QuadCorners = [
    { x: quadNorm[0].x * (src.width - 1), y: quadNorm[0].y * (src.height - 1) },
    { x: quadNorm[1].x * (src.width - 1), y: quadNorm[1].y * (src.height - 1) },
    { x: quadNorm[2].x * (src.width - 1), y: quadNorm[2].y * (src.height - 1) },
    { x: quadNorm[3].x * (src.width - 1), y: quadNorm[3].y * (src.height - 1) },
  ];

  const H = computeHomographyDstToSrc(srcQuadPx, outW - 1, outH - 1);
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sw = src.width;
  const sh = src.height;
  const sData = src.data;

  for (let y = 0; y < outH; y++) {
    const h0y = H[1] * y + H[2];
    const h1y = H[4] * y + H[5];
    const h2y = H[7] * y + H[8];
    const rowOff = y * outW * 4;

    for (let x = 0; x < outW; x++) {
      const denom = H[6] * x + h2y;
      const sx = (H[0] * x + h0y) / denom;
      const sy = (H[3] * x + h1y) / denom;

      const idx = rowOff + x * 4;
      if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) {
        const cx = clamp(Math.round(sx), 0, sw - 1);
        const cy = clamp(Math.round(sy), 0, sh - 1);
        const si = (cy * sw + cx) * 4;
        out[idx] = sData[si];
        out[idx + 1] = sData[si + 1];
        out[idx + 2] = sData[si + 2];
        out[idx + 3] = 255;
        continue;
      }

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;

      out[idx] = Math.round(
        sData[i00] * w00 + sData[i10] * w10 + sData[i01] * w01 + sData[i11] * w11
      );
      out[idx + 1] = Math.round(
        sData[i00 + 1] * w00 + sData[i10 + 1] * w10 + sData[i01 + 1] * w01 + sData[i11 + 1] * w11
      );
      out[idx + 2] = Math.round(
        sData[i00 + 2] * w00 + sData[i10 + 2] * w10 + sData[i01 + 2] * w01 + sData[i11 + 2] * w11
      );
      out[idx + 3] = 255;
    }
  }

  return { data: out, width: outW, height: outH };
}

/**
 * Samples a chalk-resistant representative color in a small circular patch around (cx, cy).
 * Prefers the richer chromatic pixels inside the patch so clicking on a slightly chalky hold
 * captures its true pigment rather than chalk dust.
 */
export function samplePatchColor(
  buf: RgbaBuffer,
  cx: number,
  cy: number,
  radius = 4
): { rgb: [number, number, number]; lab: [number, number, number] } {
  const pixels: Array<{ r: number; g: number; b: number; lab: [number, number, number]; chroma: number }> = [];
  const x0 = Math.max(0, Math.round(cx - radius));
  const x1 = Math.min(buf.width - 1, Math.round(cx + radius));
  const y0 = Math.max(0, Math.round(cy - radius));
  const y1 = Math.min(buf.height - 1, Math.round(cy + radius));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > radius * radius) continue;
      const i = (y * buf.width + x) * 4;
      const r = buf.data[i];
      const g = buf.data[i + 1];
      const b = buf.data[i + 2];
      const lab = rgbToLab(r, g, b);
      pixels.push({ r, g, b, lab, chroma: Math.hypot(lab[1], lab[2]) });
    }
  }

  if (pixels.length === 0) {
    return { rgb: [214, 69, 58], lab: rgbToLab(214, 69, 58) };
  }

  // Sort by chroma descending; if hold is colorful, pick the upper-middle quartile (rejecting chalk highlights!)
  pixels.sort((a, b) => b.chroma - a.chroma);
  const topChroma = pixels[Math.floor(pixels.length * 0.25)].chroma;
  const subset = topChroma >= 15 ? pixels.slice(0, Math.max(1, Math.ceil(pixels.length * 0.55))) : pixels;

  const rs = subset.map((p) => p.r).sort((a, b) => a - b);
  const gs = subset.map((p) => p.g).sort((a, b) => a - b);
  const bs = subset.map((p) => p.b).sort((a, b) => a - b);
  const mid = Math.floor(subset.length / 2);
  const rgb: [number, number, number] = [rs[mid], gs[mid], bs[mid]];
  return { rgb, lab: rgbToLab(rgb[0], rgb[1], rgb[2]) };
}

/**
 * Estimates the dominant plywood/wall background CIELAB color via coarse grid median.
 */
function estimateWallBackgroundLab(buf: RgbaBuffer): [number, number, number] {
  const ls: number[] = [];
  const as: number[] = [];
  const bs: number[] = [];
  const stepX = Math.max(4, Math.floor(buf.width / 24));
  const stepY = Math.max(4, Math.floor(buf.height / 24));

  for (let y = 4; y < buf.height - 4; y += stepY) {
    for (let x = 4; x < buf.width - 4; x += stepX) {
      const i = (y * buf.width + x) * 4;
      const lab = rgbToLab(buf.data[i], buf.data[i + 1], buf.data[i + 2]);
      ls.push(lab[0]);
      as.push(lab[1]);
      bs.push(lab[2]);
    }
  }

  ls.sort((a, b) => a - b);
  as.sort((a, b) => a - b);
  bs.sort((a, b) => a - b);
  const m = Math.floor(ls.length / 2);
  return [ls[m] ?? 70, as[m] ?? 4, bs[m] ?? 16];
}

/**
 * Chalk- & shadow-tolerant CIELAB distance between a pixel and a hold color sample.
 */
function holdColorDistance(
  pxLab: [number, number, number],
  sampleLab: [number, number, number]
): number {
  const sampleChroma = Math.hypot(sampleLab[1], sampleLab[2]);
  const dL = pxLab[0] - sampleLab[0];
  const da = pxLab[1] - sampleLab[1];
  const db = pxLab[2] - sampleLab[2];

  if (sampleChroma < 14) {
    // Achromatic holds (black / white / grey): rely primarily on lightness & neutrality!
    return Math.hypot(dL * 0.92, da * 0.85, db * 0.85);
  }

  const pxChroma = Math.hypot(pxLab[1], pxLab[2]);
  let chromaDist = Math.hypot(da, db);

  // Chalk forgiveness: white magnesium chalk raises L* and slightly washes out chroma along the same hue ray
  if (dL > 8 && pxChroma >= 7) {
    const cosHue = (pxLab[1] * sampleLab[1] + pxLab[2] * sampleLab[2]) / (pxChroma * sampleChroma);
    if (cosHue > 0.84) {
      chromaDist *= 0.74;
    }
  }
  // Overhang shadow forgiveness: shadowed undersides drop L* & shrink chroma radially toward origin
  if (dL < -10 && pxChroma >= 5) {
    const cosHue = (pxLab[1] * sampleLab[1] + pxLab[2] * sampleLab[2]) / (pxChroma * sampleChroma);
    if (cosHue > 0.84) {
      chromaDist *= 0.8;
    }
  }

  return Math.hypot(chromaDist, dL * 0.3);
}

/**
 * 3x3 morphological closing (dilation followed by erosion) to bridge chalk smudges and bolt sockets.
 */
function morphologicalClose(mask: Uint8Array, w: number, h: number): Uint8Array {
  const dil = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = row + x;
      if (
        mask[idx] ||
        mask[idx - 1] ||
        mask[idx + 1] ||
        mask[idx - w] ||
        mask[idx + w] ||
        mask[idx - w - 1] ||
        mask[idx - w + 1] ||
        mask[idx + w - 1] ||
        mask[idx + w + 1]
      ) {
        dil[idx] = 1;
      }
    }
  }

  const closed = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = row + x;
      if (
        dil[idx] &&
        dil[idx - 1] &&
        dil[idx + 1] &&
        dil[idx - w] &&
        dil[idx + w]
      ) {
        closed[idx] = 1;
      }
    }
  }
  return closed;
}

interface RawBlob {
  pixels: number[]; // flat indices y*w + x
  area: number;
  cx: number;
  cy: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  majorLen: number;
  minorLen: number;
  aspectRatio: number;
  principalDeg: number; // angle of major axis in degrees [-90..90]
  solidity: number;
  innerDarkDelta: number; // outer L* - inner core L* (positive => pocket cavity!)
  specularRatio: number; // fraction of bright gloss pixels (Dual-Tex indicator!)
  lipGradAngleDeg: number; // estimated pull-direction angle from bright/chalky lip offset
  lipContrast: number;
}

function analyzeBlobPixels(
  pixels: number[],
  w: number,
  buf: RgbaBuffer,
  baseSampleL: number
): RawBlob {
  const area = pixels.length;
  let sumX = 0;
  let sumY = 0;
  let minX = w;
  let maxX = 0;
  let minY = buf.height;
  let maxY = 0;

  for (let i = 0; i < area; i++) {
    const idx = pixels[i];
    const y = Math.floor(idx / w);
    const x = idx - y * w;
    sumX += x;
    sumY += y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const cx = sumX / area;
  const cy = sumY / area;

  // 2nd central moments for PCA major/minor axes + luminance/chalk gradient analysis
  let mu20 = 0;
  let mu02 = 0;
  let mu11 = 0;
  let innerLSum = 0;
  let innerCount = 0;
  let outerLSum = 0;
  let outerCount = 0;
  let specCount = 0;
  let brightSumX = 0;
  let brightSumY = 0;
  let brightWeight = 0;
  let darkSumX = 0;
  let darkSumY = 0;
  let darkWeight = 0;

  const approxR = Math.max(2, Math.sqrt(area / Math.PI));

  for (let i = 0; i < area; i++) {
    const idx = pixels[i];
    const y = Math.floor(idx / w);
    const x = idx - y * w;
    const dx = x - cx;
    const dy = y - cy;
    mu20 += dx * dx;
    mu02 += dy * dy;
    mu11 += dx * dy;

    const p4 = idx * 4;
    const lum =
      (0.299 * buf.data[p4] + 0.587 * buf.data[p4 + 1] + 0.114 * buf.data[p4 + 2]) / 2.55; // 0..100 approx L*

    const rNorm = Math.hypot(dx, dy) / approxR;
    if (rNorm > 0.56) {
      outerLSum += lum;
      outerCount += 1;
    }

    if (lum > baseSampleL + 20) {
      specCount += 1;
    }

    const diffL = lum - baseSampleL;
    if (diffL > 3) {
      brightSumX += dx * diffL;
      brightSumY += dy * diffL;
      brightWeight += diffL;
    } else if (diffL < -3) {
      const wDark = -diffL;
      darkSumX += dx * wDark;
      darkSumY += dy * wDark;
      darkWeight += wDark;
    }
  }

  // Sample inner core directly from the RGBA buffer (not just masked pixels),
  // because deep finger-pocket cavities are dark enough to drop out of the color mask!
  const coreR = Math.max(2, Math.round(approxR * 0.45));
  const coreX0 = Math.max(minX, Math.floor(cx - coreR));
  const coreX1 = Math.min(maxX, Math.ceil(cx + coreR));
  const coreY0 = Math.max(minY, Math.floor(cy - coreR));
  const coreY1 = Math.min(maxY, Math.ceil(cy + coreR));
  const coreR2 = coreR * coreR;
  for (let py = coreY0; py <= coreY1; py++) {
    const dy = py - cy;
    const rowOffset = py * w;
    for (let px = coreX0; px <= coreX1; px++) {
      const dx = px - cx;
      if (dx * dx + dy * dy > coreR2) continue;
      const p4 = (rowOffset + px) * 4;
      const lum =
        (0.299 * buf.data[p4] + 0.587 * buf.data[p4 + 1] + 0.114 * buf.data[p4 + 2]) / 2.55;
      innerLSum += lum;
      innerCount += 1;
    }
  }

  mu20 /= area;
  mu02 /= area;
  mu11 /= area;

  const trace = mu20 + mu02;
  const disc = Math.sqrt(Math.max(0, (mu20 - mu02) * (mu20 - mu02) + 4 * mu11 * mu11));
  const lam1 = Math.max(0.5, (trace + disc) / 2);
  const lam2 = Math.max(0.5, (trace - disc) / 2);
  const majorLen = 4 * Math.sqrt(lam1);
  const minorLen = 4 * Math.sqrt(lam2);
  const aspectRatio = majorLen / Math.max(1, minorLen);
  const principalDeg = (0.5 * Math.atan2(2 * mu11, mu20 - mu02) * 180) / Math.PI;

  const bboxArea = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
  const solidity = area / bboxArea;

  const innerAvgL = innerCount > 0 ? innerLSum / innerCount : baseSampleL;
  const outerAvgL = outerCount > 0 ? outerLSum / outerCount : baseSampleL;
  const innerDarkDelta = outerAvgL - innerAvgL;
  const specularRatio = specCount / area;

  // Bright chalk/top-light centroid relative to hold center indicates which face is the active pulling lip!
  // In screen/image coords, -y is UP on wall (0° flat top edge).
  let lipGradAngleDeg = 0;
  let lipContrast = 0;
  if (brightWeight > area * 0.45) {
    const bx = brightSumX / brightWeight;
    const by = brightSumY / brightWeight;
    const dxDark = darkWeight > area * 0.45 ? darkSumX / darkWeight : 0;
    const dyDark = darkWeight > area * 0.45 ? darkSumY / darkWeight : 0;
    // Vector from dark underside toward bright active top lip (image y points down, so invert y for world up)
    const vx = bx - dxDark * 0.6;
    const vy = -(by - dyDark * 0.6);
    lipContrast = Math.hypot(vx, vy) / approxR;
    if (lipContrast > 0.18) {
      // 0° = lip at top (+y world => pull down); +90° = lip at right (+x => pull left sidepull)
      lipGradAngleDeg = (Math.atan2(vx, vy) * 180) / Math.PI;
    }
  }

  return {
    pixels,
    area,
    cx,
    cy,
    minX,
    maxX,
    minY,
    maxY,
    majorLen,
    minorLen,
    aspectRatio,
    principalDeg,
    solidity,
    innerDarkDelta,
    specularRatio,
    lipGradAngleDeg,
    lipContrast,
  };
}

/**
 * Extracts 8-connected hold blobs from a binary segmentation mask and merges split chalk fragments.
 */
function extractHoldBlobs(
  mask: Uint8Array,
  w: number,
  h: number,
  buf: RgbaBuffer,
  minAreaPx: number,
  baseSampleL: number
): RawBlob[] {
  const visited = new Uint8Array(w * h);
  const maxAreaPx = Math.floor(w * h * 0.16);
  const rawGroups: number[][] = [];
  const queue = new Int32Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const start = y * w + x;
      if (!mask[start] || visited[start]) continue;

      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      visited[start] = 1;
      const pixels: number[] = [];

      while (head < tail) {
        const cur = queue[head++];
        pixels.push(cur);
        const cy = Math.floor(cur / w);
        const cx = cur - cy * w;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= h) continue;
          const nRow = ny * w;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            if (nx < 0 || nx >= w) continue;
            const ni = nRow + nx;
            if (mask[ni] && !visited[ni]) {
              visited[ni] = 1;
              queue[tail++] = ni;
            }
          }
        }
      }

      if (pixels.length >= minAreaPx && pixels.length <= maxAreaPx) {
        rawGroups.push(pixels);
      }
    }
  }

  // Merge very close chalk-split fragments (centroid gap < 13px and combined span reasonable)
  const initialBlobs = rawGroups.map((px) => analyzeBlobPixels(px, w, buf, baseSampleL));
  const mergedFlags = new Array<boolean>(initialBlobs.length).fill(false);
  const finalBlobs: RawBlob[] = [];

  for (let i = 0; i < initialBlobs.length; i++) {
    if (mergedFlags[i]) continue;
    let groupPixels = initialBlobs[i].pixels;
    let cur = initialBlobs[i];
    mergedFlags[i] = true;

    for (let j = i + 1; j < initialBlobs.length; j++) {
      if (mergedFlags[j]) continue;
      const other = initialBlobs[j];
      const d = Math.hypot(cur.cx - other.cx, cur.cy - other.cy);
      const mergeThresh = Math.min(20, Math.max(12, (cur.majorLen + other.majorLen) * 0.34));
      if (d < mergeThresh) {
        groupPixels = [...groupPixels, ...other.pixels];
        cur = analyzeBlobPixels(groupPixels, w, buf, baseSampleL);
        mergedFlags[j] = true;
      }
    }
    finalBlobs.push(cur);
  }

  return finalBlobs;
}

/**
 * On-device multi-feature hold classifier: infers HoldType, scale, pull angle,
 * Dual-Tex, thumb catch, and sculptural style from geometric + photometric cues.
 */
function classifyHoldBlob(
  blob: RawBlob,
  worldX: number,
  worldY: number,
  colorHex: string,
  styleFamily: HoldStyleFamily
): RecognizedHoldDetail {
  const { area, minorLen, aspectRatio, principalDeg, solidity, innerDarkDelta, specularRatio } = blob;

  // Principal axis verticality: |principalDeg| near 90° => vertical pinch / sidepull!
  const isVertical = Math.abs(principalDeg) > 54;
  let type: HoldType = 'crimp';
  let reason = '中等边缘轮廓';
  let confidence = 0.78;

  if (area >= 1500) {
    type = 'volume';
    reason = '超大几何体块';
    confidence = 0.88;
  } else if (area < 135) {
    if (aspectRatio >= 2.25 && worldY > 125) {
      type = 'microcrimp';
      reason = '极窄细条高区点';
      confidence = 0.82;
    } else {
      type = 'foothold';
      reason = '紧凑小面积脚点';
      confidence = 0.86;
    }
  } else if (innerDarkDelta >= 9.5 && aspectRatio < 1.85 && area >= 150 && area <= 1050) {
    type = 'pocket';
    reason = '中心暗腔洞口特征';
    confidence = 0.84;
  } else if (aspectRatio >= 2.05) {
    if (isVertical && minorLen >= 10) {
      type = 'pinch';
      reason = '纵向长条对捏特征';
      confidence = 0.84;
    } else if (minorLen <= 10.5) {
      type = 'microcrimp';
      reason = '细长微抠边特征';
      confidence = 0.83;
    } else {
      type = 'crimp';
      reason = '扁平窄边抠点特征';
      confidence = 0.85;
    }
  } else if (isVertical && aspectRatio >= 1.48 && area >= 180) {
    type = 'pinch';
    reason = '竖向捏点比例';
    confidence = 0.8;
  } else if (area >= 420 && solidity >= 0.66 && blob.lipContrast < 0.34) {
    type = 'sloper';
    reason = '圆润大弧面低反差特征';
    confidence = 0.8;
  } else if (area >= 320) {
    type = 'jug';
    reason = '饱满大面积把手特征';
    confidence = 0.83;
  } else if (solidity >= 0.72 && aspectRatio < 1.38) {
    type = 'sloper';
    reason = '圆弧块面特征';
    confidence = 0.76;
  } else {
    type = 'crimp';
    reason = '中等偏窄抠点';
    confidence = 0.75;
  }

  // Estimate pull angle from major axis (for crimps/microcrimps) or bright chalk/lighting lip vector!
  let angle = 0;
  if (type === 'foothold') {
    angle = 0;
  } else if (type === 'crimp' || type === 'microcrimp') {
    // Major axis of a flat horizontal crimp is 0°; tilted crimp rotates with principalDeg!
    // Clamp realistic gym sidepull angles to [-75°, 75°] unless lighting strongly proves undercling
    angle = Math.round(clamp(principalDeg, -72, 72) / 5) * 5;
  } else if (type === 'pinch') {
    // Vertical pinch tilted slightly off vertical
    const devFromVert = principalDeg >= 0 ? principalDeg - 90 : principalDeg + 90;
    angle = Math.round(clamp(devFromVert, -55, 55) / 5) * 5;
  } else if (blob.lipContrast > 0.24) {
    angle = Math.round(clamp(blob.lipGradAngleDeg, -65, 65) / 5) * 5;
  }

  // Realistic scale relative to the hold type's base radius
  const approxRadiusCm = Math.sqrt(area / Math.PI);
  const typeBaseR =
    type === 'volume'
      ? 21
      : type === 'sloper'
        ? 14
        : type === 'jug'
          ? 13
          : type === 'pinch'
            ? 11.5
            : type === 'pocket'
              ? 10.6
              : type === 'crimp'
                ? 9.5
                : 7.4;
  const scale = Math.round(clamp(approxRadiusCm / typeBaseR, 0.78, 1.32) * 20) / 20;

  // Detect Dual-Tex from specular gloss highlight ratio inside non-foothold/non-volume blobs
  const dualTex =
    type !== 'foothold' &&
    type !== 'volume' &&
    type !== 'jug' &&
    specularRatio >= 0.08 &&
    specularRatio <= 0.42;

  // Map geometric cues cleanly to matching sculptural silhouette variant
  const shapeVariant =
    type === 'volume'
      ? solidity > 0.76
        ? 3
        : aspectRatio > 1.5
          ? 1
          : 0
      : styleFamily === 'comp'
        ? 1
        : styleFamily === 'geometric'
          ? 2
          : 0;

  const hold: Hold = {
    id: nextUid('ph'),
    label: 0,
    x: Math.round(clamp(worldX, 22, WALL_WIDTH_CM - 22)),
    y: Math.round(clamp(worldY, 22, WALL_HEIGHT_CM - 22)),
    type,
    role: 'normal',
    angle,
    scale,
    color: type === 'volume' ? '#3D434C' : colorHex,
    styleFamily,
    shapeVariant,
    dualTex,
    thumbCatch: type === 'pinch' && solidity < 0.74,
  };

  return {
    hold,
    areaPx: area,
    aspectRatio: Math.round(aspectRatio * 100) / 100,
    confidence,
    reason: dualTex ? `${reason} · 疑似双纹理` : reason,
  };
}

/**
 * Auto-assigns Start holds (lowest 1–2 handholds in realistic start zone) and TOP hold (highest handhold).
 */
function assignStartAndTopRoles(holds: Hold[]): Hold[] {
  const handIndices = holds
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h.type !== 'foothold' && h.type !== 'volume');

  if (handIndices.length === 0) {
    // Promote highest and lowest holds if everything looked small
    if (holds.length >= 2) {
      const sorted = [...holds].sort((a, b) => a.y - b.y);
      sorted[0].role = 'start';
      sorted[0].type = 'crimp';
      sorted[sorted.length - 1].role = 'top';
      sorted[sorted.length - 1].type = 'jug';
    }
    return holds;
  }

  handIndices.sort((a, b) => a.h.y - b.h.y);

  // Top hold = highest handhold
  const topEntry = handIndices[handIndices.length - 1];
  holds[topEntry.i].role = 'top';

  // Start hold(s) = lowest handhold(s) above typical foothold knee level (y >= 72cm when possible)
  const startCandidates = handIndices.filter(
    ({ h, i }) => i !== topEntry.i && h.y >= 72
  );
  const startPool = startCandidates.length > 0 ? startCandidates : handIndices.filter(({ i }) => i !== topEntry.i);

  if (startPool.length > 0) {
    const firstStart = startPool[0];
    holds[firstStart.i].role = 'start';

    // If a second handhold sits at similar height (within 32cm vertically & 110cm horizontally), make it dual-start!
    const secondStart = startPool
      .slice(1)
      .find(
        ({ h }) =>
          Math.abs(h.y - firstStart.h.y) <= 32 &&
          Math.abs(h.x - firstStart.h.x) >= 26 &&
          Math.abs(h.x - firstStart.h.x) <= 115
      );
    if (secondStart) {
      holds[secondStart.i].role = 'start';
    }
  }

  return holds;
}

/**
 * On-device Physics-in-the-Loop route calibration:
 * Uses our local Beta solver to verify solvability and gently refine noisy CV hold angles
 * along the natural upward climbing flow if initial angles caused false slips.
 */
export function calibrateRecognizedRoute(
  rawHolds: Hold[],
  wallAngleDeg: number
): { holds: Hold[]; solved: boolean; estimatedGrade: string; notes: string[] } {
  const notes: string[] = [];
  let holds = rawHolds.map((h) => ({ ...h }));

  if (holds.length < 3 || !holds.some((h) => h.role === 'start') || !holds.some((h) => h.role === 'top')) {
    return {
      holds,
      solved: false,
      estimatedGrade: 'Custom',
      notes: ['识别岩点数量偏少，建议追加正样本色点或在定线台手动补点。'],
    };
  }

  // Test across climber tiers matching the wall angle
  const targetTierGrade = wallAngleDeg >= 45 ? 10 : wallAngleDeg >= 35 ? 8 : wallAngleDeg >= 30 ? 7 : 5;
  const refClimber = getReferenceClimberForGrade(targetTierGrade);

  let sol = suggestBeta(holds, refClimber, 20, 14, wallAngleDeg);
  if (!sol.solved) {
    // Refinement Pass 1: align noisy crimp/sloper/pocket angles gently toward upward climbing flow
    const handList = holds
      .filter((h) => h.type !== 'foothold' && h.type !== 'volume')
      .sort((a, b) => a.y - b.y);
    const refined = holds.map((h) => {
      if (h.type === 'foothold' || h.type === 'volume') return h;
      const idx = handList.findIndex((x) => x.id === h.id);
      const prev = idx > 0 ? handList[idx - 1] : null;
      let nextAngle = h.angle;
      if (prev) {
        // Pull vector points from this hold down toward prev hold (climber body side)
        const dx = prev.x - h.x;
        const dy = prev.y - h.y;
        const flowDeg = clamp((-Math.atan2(dx, -dy) * 180) / Math.PI, -48, 48);
        nextAngle = Math.round((h.angle * 0.35 + flowDeg * 0.65) / 5) * 5;
      } else {
        nextAngle = Math.round((h.angle * 0.4) / 5) * 5;
      }
      return { ...h, angle: nextAngle };
    });

    const solRefined = suggestBeta(refined, refClimber, 20, 14, wallAngleDeg);
    if (solRefined.solved) {
      holds = refined;
      sol = solRefined;
      notes.push('端侧物理校准：已按攀爬流线优化岩点发力朝向，验证可完攀');
    } else {
      // Refinement Pass 2: keep flow-aligned angles and soften extreme Dual-Tex false positives
      const softened = refined.map((h) => ({ ...h, dualTex: false, angle: Math.round((h.angle * 0.6) / 5) * 5 }));
      const solSoft = suggestBeta(softened, refClimber, 20, 14, wallAngleDeg);
      if (solSoft.solved) {
        holds = softened;
        sol = solSoft;
        notes.push('端侧物理校准：已修正反光误判的双纹理点并对齐朝向，验证可完攀');
      } else {
        notes.push('当前识别线路存在较大跨距或缺少脚点，导入后可在底图上直接补脚点或调缓墙角');
      }
    }
  } else {
    notes.push(`端侧物理验证通过（参考路线约 ${sol.steps.length} 步完攀）`);
  }

  const live = estimateRouteGrade(holds, wallAngleDeg);
  return {
    holds,
    solved: sol.solved,
    estimatedGrade: live.gradeLabel,
    notes,
  };
}

/**
 * Full on-device recognition pipeline on a perspective-rectified wall RGBA buffer (`400 x 450`).
 */
export function recognizeHoldsFromRectifiedRgba(
  buf: RgbaBuffer,
  samples: ColorSample[],
  options: RecognitionOptions
): RecognitionResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const positives = samples.filter((s) => s.kind === 'include');
  const negatives = samples.filter((s) => s.kind === 'exclude');

  if (positives.length === 0) {
    return {
      holds: [],
      details: [],
      dominantHex: HOLD_COLORS[0].hex,
      estimatedGrade: 'Custom',
      solved: false,
      calibrationNotes: ['请点击图片上任意 1 颗目标线路的岩点开始自动识别'],
      elapsedMs: 0,
      maskWidth: buf.width,
      maskHeight: buf.height,
    };
  }

  const w = buf.width;
  const h = buf.height;
  const bgLab = estimateWallBackgroundLab(buf);
  const rawMask = new Uint8Array(w * h);

  // Average positive lightness & dominant color
  const avgR = positives.reduce((s, p) => s + p.rgb[0], 0) / positives.length;
  const avgG = positives.reduce((s, p) => s + p.rgb[1], 0) / positives.length;
  const avgB = positives.reduce((s, p) => s + p.rgb[2], 0) / positives.length;
  const baseSampleL = positives.reduce((s, p) => s + p.lab[0], 0) / positives.length;
  const dominantHex = normalizeHoldHex([avgR, avgG, avgB]);
  const tol = clamp(options.tolerance, 10, 60);

  // 1. Per-pixel CIELAB chalk-tolerant contrastive classification
  for (let i = 0, p4 = 0; i < w * h; i++, p4 += 4) {
    const pxLab = rgbToLab(buf.data[p4], buf.data[p4 + 1], buf.data[p4 + 2]);

    let minPosDist = Infinity;
    for (let k = 0; k < positives.length; k++) {
      const d = holdColorDistance(pxLab, positives[k].lab);
      if (d < minPosDist) minPosDist = d;
    }
    if (minPosDist > tol) continue;

    // Wall background rejection (prevents wood/grey wall bleed)
    const bgDist = holdColorDistance(pxLab, bgLab);
    if (bgDist < 12 && bgDist < minPosDist * 0.78) continue;

    // Contrastive negative sample rejection
    let rejected = false;
    for (let k = 0; k < negatives.length; k++) {
      const negD = holdColorDistance(pxLab, negatives[k].lab);
      if (negD < minPosDist * 0.96 || negD < 10) {
        rejected = true;
        break;
      }
    }
    if (!rejected) {
      rawMask[i] = 1;
    }
  }

  // 2. Morphological closing + connected-component blob extraction
  const closedMask = morphologicalClose(rawMask, w, h);
  const blobs = extractHoldBlobs(
    closedMask,
    w,
    h,
    buf,
    clamp(options.minHoldAreaPx, 14, 180),
    baseSampleL
  );

  // Infer cohesive style family from overall blob geometry (smooth/glossy -> comp, angular -> geometric, else organic)
  const avgSolidity =
    blobs.length > 0 ? blobs.reduce((s, b) => s + b.solidity, 0) / blobs.length : 0.65;
  const glossyHits = blobs.filter((b) => b.specularRatio >= 0.08).length;
  const styleFamily: HoldStyleFamily =
    glossyHits >= 2 ? 'comp' : avgSolidity < 0.62 ? 'geometric' : 'organic';

  // 3. Classify every extracted blob into a Hold in world cm coordinates (note: image y=0 is top => world y=WALL_HEIGHT_CM!)
  const details: RecognizedHoldDetail[] = [];
  for (const blob of blobs) {
    const worldX = (blob.cx / w) * WALL_WIDTH_CM;
    const worldY = (1 - blob.cy / h) * WALL_HEIGHT_CM;
    details.push(classifyHoldBlob(blob, worldX, worldY, dominantHex, styleFamily));
  }

  // Cap extreme noise (> 34 blobs) by keeping the most prominent & spaced blobs
  details.sort((a, b) => b.areaPx - a.areaPx);
  const keptDetails: RecognizedHoldDetail[] = [];
  for (const d of details) {
    if (keptDetails.length >= 28) break;
    if (keptDetails.some((k) => dist(k.hold, d.hold) < 15)) continue;
    keptDetails.push(d);
  }

  let holds = assignStartAndTopRoles(keptDetails.map((d) => d.hold));
  holds = renumberHolds(holds);

  // Sync updated labels & roles back to details
  const byId = new Map(holds.map((x) => [x.id, x]));
  const syncedDetails = keptDetails
    .map((d) => ({ ...d, hold: byId.get(d.hold.id) ?? d.hold }))
    .sort((a, b) => a.hold.label - b.hold.label);

  // 4. Optional on-device physics-in-the-loop calibration & live grade estimation
  let solved = false;
  let estimatedGrade = 'Custom';
  let calibrationNotes: string[] = [];

  if (options.enablePhysicsCalibration && holds.length >= 3) {
    const cal = calibrateRecognizedRoute(holds, options.wallAngleDeg);
    holds = renumberHolds(cal.holds);
    solved = cal.solved;
    estimatedGrade = cal.estimatedGrade;
    calibrationNotes = cal.notes;
  } else if (holds.length >= 3) {
    estimatedGrade = estimateRouteGrade(holds, options.wallAngleDeg).gradeLabel;
    calibrationNotes = [`已提取 ${holds.length} 个岩点（未开启物理微调）`];
  } else {
    calibrationNotes = [`已提取 ${holds.length} 个岩点，可调高色差容忍度或追加正样本点`];
  }

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    holds,
    details: syncedDetails,
    dominantHex,
    estimatedGrade,
    solved,
    calibrationNotes,
    elapsedMs: Math.max(1, Math.round(t1 - t0)),
    maskWidth: w,
    maskHeight: h,
  };
}
