import { Hold, HoldStyleFamily } from './types';

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface ResolvedHoldVisual {
  family: HoldStyleFamily;
  variant: number; // 0..2 (or 0..3 for volume)
  flipX: number; // 1 or -1 subtle organic asymmetry
  dualTex: boolean;
  thumbCatch: boolean;
  seed: number;
}

export function resolveHoldVisual(hold: Hold): ResolvedHoldVisual {
  const seed = hashString(hold.id);
  const families: HoldStyleFamily[] = ['organic', 'comp', 'geometric'];
  const family: HoldStyleFamily = hold.styleFamily ?? families[seed % 3];
  const mod = hold.type === 'volume' ? 4 : 3;
  const variant =
    typeof hold.shapeVariant === 'number'
      ? ((Math.round(hold.shapeVariant) % mod) + mod) % mod
      : (seed >>> 4) % mod;
  const flipX = (seed & 8) === 0 ? 1 : -1;
  return {
    family,
    variant,
    flipX,
    dualTex: Boolean(hold.dualTex),
    thumbCatch: Boolean(hold.thumbCatch),
    seed,
  };
}

function shadeHex(hex: string, amount: number): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full, 16);
  const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clampByte((num >> 16) + amount);
  const g = clampByte(((num >> 8) & 0xff) + amount);
  const b = clampByte((num & 0xff) + amount);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Traces the outer silhouette path of a climbing hold in local hold space
 * (centered at 0,0; top edge at -y is the active pulling surface when angle = 0).
 */
function traceHoldSilhouette(
  ctx: CanvasRenderingContext2D,
  hold: Hold,
  r: number,
  vis: ResolvedHoldVisual
): void {
  const f = vis.flipX;
  const v = vis.variant;
  ctx.beginPath();

  if (hold.type === 'jug') {
    if (v === 0) {
      // 0: Organic sandstone bucket (asymmetric multi-lobe bean)
      ctx.moveTo(-r * 1.18, -r * 0.14);
      ctx.bezierCurveTo(-r * 1.12, -r * 0.86, -r * 0.25, -r * 0.94, r * 0.25 * f, -r * 0.84);
      ctx.bezierCurveTo(r * 0.92, -r * 0.86, r * 1.24, -r * 0.48, r * 1.18, r * 0.08);
      ctx.bezierCurveTo(r * 1.12, r * 0.72, r * 0.42, r * 0.84, -r * 0.08 * f, r * 0.68);
      ctx.bezierCurveTo(-r * 0.68, r * 0.86, -r * 1.16, r * 0.56, -r * 1.18, -r * 0.14);
    } else if (v === 1) {
      // 1: Flathold-style curved crescent / ear jug (swooping sculptural arc)
      ctx.moveTo(-r * 1.24, r * 0.28);
      ctx.bezierCurveTo(-r * 1.22, -r * 0.76, -r * 0.3, -r * 1.02, r * 0.58, -r * 0.78);
      ctx.bezierCurveTo(r * 1.18, -r * 0.62, r * 1.28, -r * 0.04, r * 1.06, r * 0.36);
      ctx.bezierCurveTo(r * 0.76, r * 0.76, r * 0.22, r * 0.36, -r * 0.26, r * 0.44);
      ctx.bezierCurveTo(-r * 0.72, r * 0.54, -r * 1.08, r * 0.78, -r * 1.24, r * 0.28);
    } else {
      // 2: Geometric / Horn twin-groove rail jug
      ctx.moveTo(-r * 1.22, -r * 0.36);
      ctx.lineTo(-r * 0.52, -r * 0.82);
      ctx.lineTo(r * 0.52, -r * 0.82);
      ctx.lineTo(r * 1.22, -r * 0.36);
      ctx.lineTo(r * 1.08, r * 0.56);
      ctx.lineTo(r * 0.32, r * 0.78);
      ctx.lineTo(-r * 0.32, r * 0.78);
      ctx.lineTo(-r * 1.08, r * 0.56);
    }
  } else if (hold.type === 'pinch') {
    if (v === 0) {
      // 0: Cheeta Taji hourglass / waisted ergonomic pinch
      ctx.moveTo(-r * 0.76, -r * 0.96);
      ctx.bezierCurveTo(-r * 0.25, -r * 1.08, r * 0.25, -r * 1.08, r * 0.76, -r * 0.96);
      ctx.bezierCurveTo(r * 0.98, -r * 0.46, r * 0.62, -r * 0.05, r * 0.88, r * 0.56);
      ctx.bezierCurveTo(r * 0.76, r * 1.02, r * 0.25, r * 1.08, -r * 0.25, r * 1.04);
      ctx.bezierCurveTo(-r * 0.86, r * 0.98, -r * 0.96, r * 0.48, -r * 0.64, -r * 0.02);
      ctx.bezierCurveTo(-r * 0.94, -r * 0.46, -r * 0.94, -r * 0.82, -r * 0.76, -r * 0.96);
    } else if (v === 1) {
      // 1: Organic Tufa / sculpted banana spine pinch
      ctx.moveTo(-r * 0.62 * f, -r * 1.05);
      ctx.bezierCurveTo(r * 0.48 * f, -r * 1.12, r * 1.02 * f, -r * 0.42, r * 0.86 * f, r * 0.32);
      ctx.bezierCurveTo(r * 0.72 * f, r * 1.04, r * 0.04 * f, r * 1.12, -r * 0.52 * f, r * 0.94);
      ctx.bezierCurveTo(-r * 0.88 * f, r * 0.68, -r * 0.58 * f, -r * 0.02, -r * 0.84 * f, -r * 0.56);
      ctx.bezierCurveTo(-r * 0.95 * f, -r * 0.86, -r * 0.84 * f, -r * 1.02, -r * 0.62 * f, -r * 1.05);
    } else {
      // 2: Faceted architectural block pinch
      ctx.moveTo(-r * 0.68, -r * 0.96);
      ctx.lineTo(r * 0.68, -r * 0.96);
      ctx.lineTo(r * 0.94, -r * 0.28);
      ctx.lineTo(r * 0.78, r * 0.88);
      ctx.lineTo(0, r * 1.04);
      ctx.lineTo(-r * 0.78, r * 0.88);
      ctx.lineTo(-r * 0.94, -r * 0.28);
    }
  } else if (hold.type === 'crimp') {
    if (v === 0) {
      // 0: Sandstone rock strata crimp (asymmetric fractured ledge)
      ctx.moveTo(-r * 1.24, -r * 0.16);
      ctx.lineTo(-r * 0.98, -r * 0.54);
      ctx.lineTo(-r * 0.22 * f, -r * 0.48);
      ctx.lineTo(r * 0.48 * f, -r * 0.58);
      ctx.lineTo(r * 1.18, -r * 0.36);
      ctx.lineTo(r * 1.26, r * 0.24);
      ctx.lineTo(r * 0.66, r * 0.56);
      ctx.lineTo(-r * 0.48, r * 0.52);
      ctx.lineTo(-r * 1.14, r * 0.38);
    } else if (v === 1) {
      // 1: Flathold Floating Point curved sleek C-crimp
      ctx.moveTo(-r * 1.26, r * 0.12);
      ctx.bezierCurveTo(-r * 1.16, -r * 0.54, -r * 0.42, -r * 0.66, 0, -r * 0.58);
      ctx.bezierCurveTo(r * 0.44, -r * 0.64, r * 1.16, -r * 0.48, r * 1.26, r * 0.14);
      ctx.bezierCurveTo(r * 1.12, r * 0.54, r * 0.54, r * 0.46, 0, r * 0.42);
      ctx.bezierCurveTo(-r * 0.54, r * 0.46, -r * 1.12, r * 0.54, -r * 1.26, r * 0.12);
    } else {
      // 2: Geometric beveled bar crimp
      ctx.moveTo(-r * 1.24, -r * 0.32);
      ctx.lineTo(-r * 0.94, -r * 0.54);
      ctx.lineTo(r * 0.94, -r * 0.54);
      ctx.lineTo(r * 1.24, -r * 0.32);
      ctx.lineTo(r * 1.16, r * 0.38);
      ctx.lineTo(r * 0.86, r * 0.54);
      ctx.lineTo(-r * 0.86, r * 0.54);
      ctx.lineTo(-r * 1.16, r * 0.38);
    }
  } else if (hold.type === 'microcrimp') {
    if (v === 0) {
      // 0: Screw-on razor resin/wood strip
      ctx.roundRect(-r * 1.38, -r * 0.34, r * 2.76, r * 0.68, r * 0.16);
    } else if (v === 1) {
      // 1: Faceted angular micro-chip
      ctx.moveTo(-r * 1.34, -r * 0.14);
      ctx.lineTo(-r * 0.92, -r * 0.42);
      ctx.lineTo(r * 0.96, -r * 0.4);
      ctx.lineTo(r * 1.36, -r * 0.08);
      ctx.lineTo(r * 1.04, r * 0.38);
      ctx.lineTo(-r * 1.06, r * 0.36);
    } else {
      // 2: Curved dual-tex micro seam (rounded bottom + thin straight top edge)
      ctx.moveTo(-r * 1.32, -r * 0.34);
      ctx.lineTo(r * 1.32, -r * 0.34);
      ctx.bezierCurveTo(r * 1.38, r * 0.24, r * 0.72, r * 0.56, 0, r * 0.54);
      ctx.bezierCurveTo(-r * 0.72, r * 0.56, -r * 1.38, r * 0.24, -r * 1.32, -r * 0.34);
    }
  } else if (hold.type === 'pocket') {
    if (v === 0) {
      // 0: Organic limestone pocket pebble
      ctx.moveTo(-r * 1.1, -r * 0.22);
      ctx.bezierCurveTo(-r * 1.02, -r * 0.92, r * 0.22 * f, -r * 1.04, r * 0.94, -r * 0.64);
      ctx.bezierCurveTo(r * 1.24, -r * 0.28, r * 1.18, r * 0.58, r * 0.64, r * 0.86);
      ctx.bezierCurveTo(r * 0.06, r * 1.04, -r * 0.84, r * 0.92, -r * 1.08, r * 0.42);
      ctx.bezierCurveTo(-r * 1.2, r * 0.14, -r * 1.14, -r * 0.04, -r * 1.1, -r * 0.22);
    } else if (v === 1) {
      // 1: Comp sculpted teardrop / donut pocket
      ctx.ellipse(0, 0, r * 1.14, r * 0.9, 0, 0, Math.PI * 2);
    } else {
      // 2: Geometric hexagonal block pocket
      ctx.moveTo(-r * 0.66, -r * 0.9);
      ctx.lineTo(r * 0.66, -r * 0.9);
      ctx.lineTo(r * 1.14, -r * 0.18);
      ctx.lineTo(r * 0.86, r * 0.84);
      ctx.lineTo(-r * 0.86, r * 0.84);
      ctx.lineTo(-r * 1.14, -r * 0.18);
    }
  } else if (hold.type === 'sloper') {
    if (v === 0) {
      // 0: Riverbed organic egg / pebble dome
      ctx.moveTo(-r * 1.18, r * 0.08);
      ctx.bezierCurveTo(-r * 1.18, -r * 0.78, -r * 0.26 * f, -r * 0.98, r * 0.48, -r * 0.84);
      ctx.bezierCurveTo(r * 1.14, -r * 0.68, r * 1.24, r * 0.04, r * 1.02, r * 0.56);
      ctx.bezierCurveTo(r * 0.74, r * 0.96, -r * 0.54, r * 0.98, -r * 1.04, r * 0.58);
      ctx.bezierCurveTo(-r * 1.16, r * 0.42, -r * 1.18, r * 0.22, -r * 1.18, r * 0.08);
    } else if (v === 1) {
      // 1: Cheeta Crater / dish circular sloper
      ctx.ellipse(0, 0, r * 1.12, r * 0.98, 0, 0, Math.PI * 2);
    } else {
      // 2: Modern comp swept wave / half-moon sloper
      ctx.moveTo(-r * 1.24, r * 0.36);
      ctx.bezierCurveTo(-r * 1.22, -r * 0.68, -r * 0.34, -r * 0.96, r * 0.42, -r * 0.88);
      ctx.bezierCurveTo(r * 1.12, -r * 0.78, r * 1.28, -r * 0.08, r * 1.12, r * 0.46);
      ctx.bezierCurveTo(r * 0.82, r * 0.84, -r * 0.76, r * 0.82, -r * 1.24, r * 0.36);
    }
  } else if (hold.type === 'foothold') {
    if (v === 0) {
      // 0: Screw-on rounded button / pebble jib
      ctx.ellipse(0, 0, r * 1.05, r * 0.72, 0.1 * f, 0, Math.PI * 2);
    } else if (v === 1) {
      // 1: Angular granite spike / triangular jib
      ctx.moveTo(-r * 1.08, r * 0.44);
      ctx.lineTo(-r * 0.24 * f, -r * 0.66);
      ctx.lineTo(r * 0.92, -r * 0.38);
      ctx.lineTo(r * 1.04, r * 0.52);
    } else {
      // 2: Compact dual-screw mini foot rail
      ctx.roundRect(-r * 1.16, -r * 0.44, r * 2.32, r * 0.88, r * 0.26);
    }
  } else {
    // Volume: 4 distinct real gym volume & fiberglass macro silhouettes!
    if (v === 0) {
      // 0: Asymmetrical 3D wooden pyramid
      ctx.moveTo(-r * 0.14 * f, -r * 1.14);
      ctx.lineTo(r * 1.2, r * 0.74);
      ctx.lineTo(-r * 1.12, r * 0.84);
    } else if (v === 1) {
      // 1: Elongated trapezoidal roof ridge volume
      ctx.moveTo(-r * 0.92, -r * 0.86);
      ctx.lineTo(r * 0.92, -r * 0.86);
      ctx.lineTo(r * 1.24, r * 0.78);
      ctx.lineTo(-r * 1.24, r * 0.78);
    } else if (v === 2) {
      // 2: Diamond / pentagonal comp slab volume
      ctx.moveTo(0, -r * 1.12);
      ctx.lineTo(r * 1.12, -r * 0.14);
      ctx.lineTo(r * 0.76, r * 0.92);
      ctx.lineTo(-r * 0.76, r * 0.92);
      ctx.lineTo(-r * 1.12, -r * 0.14);
    } else {
      // 3: Cheeta-style fiberglass macro dome shell
      ctx.moveTo(-r * 1.16, r * 0.16);
      ctx.bezierCurveTo(-r * 1.18, -r * 0.84, -r * 0.22, -r * 1.08, r * 0.44, -r * 0.96);
      ctx.bezierCurveTo(r * 1.16, -r * 0.82, r * 1.24, r * 0.12, r * 0.94, r * 0.78);
      ctx.bezierCurveTo(r * 0.44, r * 1.08, -r * 0.74, r * 1.04, -r * 1.16, r * 0.16);
    }
  }
  ctx.closePath();
}

/**
 * Draws the sculpted 3D body, surface texture (including Dual-Tex glossy/matte split),
 * ergonomic thumb catch, pocket/incut depth shadow, chalk dust, and authentic bolt/screw hardware.
 * Assumes ctx is already translated to hold center and rotated by hold.angle.
 */
export function drawSculptedHoldBody(
  ctx: CanvasRenderingContext2D,
  hold: Hold,
  r: number,
  isSelected: boolean,
  overhangRatio: number
): void {
  const vis = resolveHoldVisual(hold);
  const f = vis.flipX;
  const baseFill = hold.color;
  const lightFill = shadeHex(baseFill, 36);
  const darkFill = shadeHex(baseFill, -38);
  const deepFill = shadeHex(baseFill, -58);

  // 1. Cast drop shadow onto plywood (deeper & longer on steeper overhangs)
  ctx.save();
  ctx.shadowColor = `rgba(22, 16, 10, ${0.36 + overhangRatio * 0.24})`;
  ctx.shadowBlur = Math.max(4, r * (0.42 + overhangRatio * 0.42));
  ctx.shadowOffsetX = 2 + overhangRatio * 2;
  ctx.shadowOffsetY = 3.5 + overhangRatio * 6.5;

  traceHoldSilhouette(ctx, hold, r, vis);
  const baseGrad = ctx.createLinearGradient(-r * 0.35, -r * 1.05, r * 0.45, r * 1.05);
  baseGrad.addColorStop(0, lightFill);
  baseGrad.addColorStop(0.52, baseFill);
  baseGrad.addColorStop(1, darkFill);
  ctx.fillStyle = baseGrad;
  ctx.fill();
  ctx.restore();

  // 2. Clipped interior sculpting: facets, dual-tex glossy zone, incut/pocket shadows, chalk, hardware
  ctx.save();
  traceHoldSilhouette(ctx, hold, r, vis);
  ctx.clip();

  // 2a. Volume true per-facet 3D directional lighting (much richer than flat triangles!)
  if (hold.type === 'volume') {
    if (vis.variant === 0) {
      const apexX = -r * 0.14 * f;
      const apexY = -r * 1.14;
      const peakX = r * 0.08 * f;
      const peakY = r * 0.1;
      // Top-left bright lit facet
      ctx.beginPath();
      ctx.moveTo(apexX, apexY);
      ctx.lineTo(peakX, peakY);
      ctx.lineTo(-r * 1.12, r * 0.84);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.fill();
      // Bottom shadow facet
      ctx.beginPath();
      ctx.moveTo(-r * 1.12, r * 0.84);
      ctx.lineTo(peakX, peakY);
      ctx.lineTo(r * 1.2, r * 0.74);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.24)';
      ctx.fill();
      // Facet ridge creases
      ctx.beginPath();
      ctx.moveTo(apexX, apexY);
      ctx.lineTo(peakX, peakY);
      ctx.lineTo(r * 1.2, r * 0.74);
      ctx.moveTo(peakX, peakY);
      ctx.lineTo(-r * 1.12, r * 0.84);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    } else if (vis.variant === 1) {
      // Trapezoid ridge with bright top bevel & dark lower skirt
      ctx.beginPath();
      ctx.moveTo(-r * 0.92, -r * 0.86);
      ctx.lineTo(r * 0.92, -r * 0.86);
      ctx.lineTo(r * 0.62, -r * 0.14);
      ctx.lineTo(-r * 0.62, -r * 0.14);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.17)';
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(-r * 0.62, -r * 0.14);
      ctx.lineTo(r * 0.62, -r * 0.14);
      ctx.lineTo(r * 1.24, r * 0.78);
      ctx.lineTo(-r * 1.24, r * 0.78);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(-r * 0.92, -r * 0.86);
      ctx.lineTo(-r * 0.62, -r * 0.14);
      ctx.lineTo(r * 0.62, -r * 0.14);
      ctx.lineTo(r * 0.92, -r * 0.86);
      ctx.moveTo(-r * 0.62, -r * 0.14);
      ctx.lineTo(-r * 1.24, r * 0.78);
      ctx.moveTo(r * 0.62, -r * 0.14);
      ctx.lineTo(r * 1.24, r * 0.78);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 1.15;
      ctx.stroke();
    } else if (vis.variant === 2) {
      // Pentagon dual-facet slab
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.12);
      ctx.lineTo(r * 1.12, -r * 0.14);
      ctx.lineTo(0, r * 0.08);
      ctx.lineTo(-r * 1.12, -r * 0.14);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(-r * 1.12, -r * 0.14);
      ctx.lineTo(0, r * 0.08);
      ctx.lineTo(r * 1.12, -r * 0.14);
      ctx.lineTo(r * 0.76, r * 0.92);
      ctx.lineTo(-r * 0.76, r * 0.92);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(-r * 1.12, -r * 0.14);
      ctx.lineTo(0, r * 0.08);
      ctx.lineTo(r * 1.12, -r * 0.14);
      ctx.moveTo(0, r * 0.08);
      ctx.lineTo(0, r * 0.92);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 1.15;
      ctx.stroke();
    } else {
      // Fiberglass macro dome: smooth sculpted radial highlight + dual-tex glossy collar
      const macroGrad = ctx.createRadialGradient(-r * 0.25, -r * 0.35, r * 0.08, 0, 0, r * 1.18);
      macroGrad.addColorStop(0, 'rgba(255, 255, 255, 0.26)');
      macroGrad.addColorStop(0.55, 'rgba(255, 255, 255, 0.03)');
      macroGrad.addColorStop(1, 'rgba(0, 0, 0, 0.26)');
      ctx.fillStyle = macroGrad;
      ctx.fillRect(-r * 1.4, -r * 1.4, r * 2.8, r * 2.8);
    }
  } else {
    // 2b. Style-family micro-sculpting (Sandstone strata / Geometric bevel planes / Comp smooth dome)
    if (vis.family === 'geometric' && hold.type !== 'foothold') {
      // Crisp geometric top bevel face + shaded lower face
      ctx.beginPath();
      ctx.moveTo(-r * 1.4, -r * 1.2);
      ctx.lineTo(r * 1.4, -r * 1.2);
      ctx.lineTo(r * 1.4, -r * 0.05);
      ctx.lineTo(-r * 1.4, -r * 0.22);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.13)';
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(-r * 1.3, -r * 0.18);
      ctx.lineTo(r * 1.3, -r * 0.02);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else if (vis.family === 'organic' && hold.type !== 'foothold') {
      // Subtle sandstone sedimentary layer lines
      ctx.strokeStyle = 'rgba(20, 15, 10, 0.13)';
      ctx.lineWidth = Math.max(0.8, r * 0.06);
      ctx.beginPath();
      ctx.moveTo(-r * 0.95, r * 0.18);
      ctx.quadraticCurveTo(-r * 0.15 * f, r * 0.02, r * 0.92, r * 0.26);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-r * 0.72, r * 0.44);
      ctx.quadraticCurveTo(r * 0.1 * f, r * 0.32, r * 0.76, r * 0.48);
      ctx.stroke();
    }
  }

  // 2c. Dual-Tex (glossy no-tex lower/outer body + crisp specular reflection vs matte active top lip!)
  if (vis.dualTex && hold.type !== 'foothold') {
    const splitY =
      hold.type === 'microcrimp'
        ? -r * 0.04
        : hold.type === 'crimp'
          ? r * 0.02
          : hold.type === 'sloper'
            ? r * 0.06
            : r * 0.12;

    // Glossy no-tex zone (lower & side non-grippable plastic sheen)
    ctx.beginPath();
    ctx.moveTo(-r * 1.5, splitY);
    ctx.quadraticCurveTo(0, splitY - r * 0.22, r * 1.5, splitY);
    ctx.lineTo(r * 1.5, r * 1.5);
    ctx.lineTo(-r * 1.5, r * 1.5);
    ctx.closePath();

    const glossGrad = ctx.createLinearGradient(-r, splitY, r, r * 1.1);
    glossGrad.addColorStop(0, 'rgba(12, 16, 22, 0.24)');
    glossGrad.addColorStop(0.45, 'rgba(12, 16, 22, 0.08)');
    glossGrad.addColorStop(1, 'rgba(12, 16, 22, 0.34)');
    ctx.fillStyle = glossGrad;
    ctx.fill();

    // Specular diagonal glass-like gloss streak on the smooth No-Tex zone
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-r * 0.82, splitY + r * 0.22);
    ctx.quadraticCurveTo(-r * 0.06, splitY + r * 0.08, r * 0.68, splitY + r * 0.36);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.56)';
    ctx.lineWidth = Math.max(1.4, r * 0.13);
    ctx.lineCap = 'round';
    ctx.stroke();

    // Crisp Dual-Tex boundary seam between coarse active grip & slick zone
    ctx.beginPath();
    ctx.moveTo(-r * 1.3, splitY);
    ctx.quadraticCurveTo(0, splitY - r * 0.22, r * 1.3, splitY);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // 2d. Hold-type tactile gripping anatomy (deep incut shadow, pocket crater, sloper crown, pinch spine)
  if (hold.type === 'jug') {
    // Deep recessed bucket shadow trough inside the upper lip!
    ctx.beginPath();
    ctx.moveTo(-r * 0.84, -r * 0.32);
    ctx.quadraticCurveTo(0, -r * 0.66, r * 0.84, -r * 0.32);
    ctx.quadraticCurveTo(0, -r * 0.12, -r * 0.84, -r * 0.32);
    ctx.fillStyle = 'rgba(16, 12, 8, 0.42)';
    ctx.fill();

    // Crisp outer gripping lip highlight + soft chalk dust
    ctx.beginPath();
    ctx.moveTo(-r * 0.82, -r * 0.36);
    ctx.quadraticCurveTo(0, -r * 0.68, r * 0.82, -r * 0.36);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.68)';
    ctx.lineWidth = Math.max(1.6, r * 0.16);
    ctx.lineCap = 'round';
    ctx.stroke();
  } else if (hold.type === 'crimp') {
    // Recessed incut underside crease + bright sharp 15-20mm edge
    ctx.beginPath();
    ctx.moveTo(-r * 0.96, -r * 0.26);
    ctx.quadraticCurveTo(0, -r * 0.44, r * 0.96, -r * 0.26);
    ctx.strokeStyle = 'rgba(16, 12, 8, 0.34)';
    ctx.lineWidth = Math.max(2, r * 0.22);
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(-r * 0.94, -r * 0.34);
    ctx.quadraticCurveTo(0, -r * 0.5, r * 0.94, -r * 0.34);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.lineWidth = Math.max(1.4, r * 0.14);
    ctx.lineCap = 'round';
    ctx.stroke();
  } else if (hold.type === 'microcrimp') {
    // Razor-thin 6-10mm bright edge bar + crisp underside shadow
    ctx.beginPath();
    ctx.moveTo(-r * 1.12, -r * 0.16);
    ctx.lineTo(r * 1.12, -r * 0.16);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.88)';
    ctx.lineWidth = Math.max(1.3, r * 0.16);
    ctx.lineCap = 'butt';
    ctx.stroke();
  } else if (hold.type === 'pocket') {
    // Authentic recessed 2-3 finger pocket crater!
    const holeW = vis.variant === 1 ? r * 0.64 : r * 0.56;
    const holeH = vis.variant === 1 ? r * 0.32 : r * 0.36;
    const holeY = -r * 0.14;

    // Deep dark pocket interior cavity
    ctx.beginPath();
    ctx.ellipse(0, holeY, holeW, holeH, 0, 0, Math.PI * 2);
    const cavGrad = ctx.createLinearGradient(0, holeY - holeH, 0, holeY + holeH);
    cavGrad.addColorStop(0, deepFill);
    cavGrad.addColorStop(0.55, 'rgba(14, 12, 10, 0.72)');
    cavGrad.addColorStop(1, shadeHex(baseFill, -18));
    ctx.fillStyle = cavGrad;
    ctx.fill();

    // Inner pocket wall shadow ring + bright active pulling lip (bottom rim of cavity / upper-facing edge)
    ctx.beginPath();
    ctx.ellipse(0, holeY, holeW, holeH, 0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(15, 12, 10, 0.45)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Chalky active pulling lip along top inner edge of pocket
    ctx.beginPath();
    ctx.ellipse(0, holeY - r * 0.03, holeW * 0.88, holeH * 0.76, 0, Math.PI * 1.12, Math.PI * 1.88);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.lineWidth = Math.max(1.4, r * 0.15);
    ctx.lineCap = 'round';
    ctx.stroke();
  } else if (hold.type === 'pinch') {
    // Vertical sculpted thumb/finger gripping flanks + central spine highlight
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.78);
    ctx.quadraticCurveTo(r * 0.08 * f, 0, 0, r * 0.76);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
    ctx.lineWidth = Math.max(1.5, r * 0.18);
    ctx.lineCap = 'round';
    ctx.stroke();

    // Left & right flank grip shadows
    ctx.strokeStyle = 'rgba(18, 14, 10, 0.24)';
    ctx.lineWidth = Math.max(1.2, r * 0.14);
    ctx.beginPath();
    ctx.moveTo(-r * 0.62, -r * 0.52);
    ctx.quadraticCurveTo(-r * 0.48, 0, -r * 0.56, r * 0.54);
    ctx.moveTo(r * 0.62, -r * 0.52);
    ctx.quadraticCurveTo(r * 0.48, 0, r * 0.56, r * 0.54);
    ctx.stroke();
  } else if (hold.type === 'sloper') {
    if (vis.variant === 1) {
      // Cheeta Crater concave dish ring!
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.06, r * 0.66, r * 0.48, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(18, 14, 10, 0.16)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.36)';
      ctx.lineWidth = Math.max(1.2, r * 0.1);
      ctx.stroke();
    } else {
      // Soft rounded dome highlight + broad chalky friction crown
      const domeGrad = ctx.createRadialGradient(-r * 0.18, -r * 0.36, r * 0.06, 0, -r * 0.18, r * 0.85);
      domeGrad.addColorStop(0, 'rgba(255, 255, 255, 0.34)');
      domeGrad.addColorStop(0.65, 'rgba(255, 255, 255, 0.06)');
      domeGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = domeGrad;
      ctx.fillRect(-r * 1.2, -r * 1.0, r * 2.4, r * 1.6);
    }
  }

  // 2e. Natural chalk whisper on the active upper gripping surface (not on footholds or glossy zone)
  if (hold.type !== 'foothold' && hold.type !== 'volume') {
    const chalkY = hold.type === 'pinch' ? -r * 0.32 : -r * 0.42;
    const chalkGrad = ctx.createRadialGradient(0, chalkY, r * 0.08, 0, chalkY, r * 0.78);
    chalkGrad.addColorStop(0, 'rgba(255, 255, 255, 0.24)');
    chalkGrad.addColorStop(0.6, 'rgba(255, 255, 255, 0.08)');
    chalkGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = chalkGrad;
    ctx.fillRect(-r * 1.1, -r * 1.1, r * 2.2, r * 1.2);
  }

  // 2f. Ergonomic Thumb Catch nub (visual signifier + physical grip/angle bonus!)
  if (vis.thumbCatch && hold.type !== 'foothold' && hold.type !== 'volume') {
    const tx = r * 0.56 * f;
    const ty = hold.type === 'pinch' ? -r * 0.18 : -r * 0.32;
    ctx.beginPath();
    ctx.ellipse(tx, ty, Math.max(2.2, r * 0.22), Math.max(1.8, r * 0.15), -0.35 * f, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(18, 14, 10, 0.36)';
    ctx.lineWidth = 0.9;
    ctx.stroke();
  }

  // 2g. Authentic mounting hardware (Screw-on dual micro-holes vs Countersunk hex bolt + set-screw!)
  if (hold.type === 'microcrimp' || hold.type === 'foothold') {
    // Screw-on: 2 tiny recessed countersunk wood-screw holes
    const sx = r * 0.62;
    const sy = r * 0.12;
    const sr = Math.max(1.1, r * 0.11);
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(dir * sx, sy, sr, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(24, 28, 34, 0.56)';
      ctx.fill();
    }
  } else if (hold.type === 'volume') {
    // Plywood perimeter screw dots along bottom flange
    const sr = Math.max(1.1, r * 0.055);
    const pts = [
      [-r * 0.72, r * 0.64],
      [0, r * 0.68],
      [r * 0.72, r * 0.64],
    ];
    ctx.fillStyle = 'rgba(220, 224, 230, 0.35)';
    for (const [px, py] of pts) {
      ctx.beginPath();
      ctx.arc(px, py, sr, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // Bolt-on PU hold: recessed countersunk socket + faint metallic washer ring
    const by = hold.type === 'pocket' ? r * 0.44 : r * 0.18;
    const br = Math.max(1.6, r * 0.13);
    ctx.beginPath();
    ctx.arc(0, by, br, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(24, 28, 34, 0.58)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 0.75;
    ctx.stroke();

    // Anti-spin set-screw dot on larger bolt-on holds
    if (r >= 13) {
      ctx.beginPath();
      ctx.arc(r * 0.38 * f, by + r * 0.22, Math.max(0.9, r * 0.055), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(24, 28, 34, 0.46)';
      ctx.fill();
    }
  }

  ctx.restore();

  // 3. Crisp outer silhouette outline
  ctx.save();
  traceHoldSilhouette(ctx, hold, r, vis);
  ctx.strokeStyle = isSelected
    ? '#111827'
    : vis.dualTex
      ? 'rgba(18, 22, 28, 0.42)'
      : 'rgba(20, 20, 20, 0.28)';
  ctx.lineWidth = isSelected ? 2.4 : vis.dualTex ? 1.25 : 1;
  ctx.stroke();
  ctx.restore();
}
