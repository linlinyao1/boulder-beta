import { computeAnatomy } from './climber';
import { getHoldHitRadius, getHoldOptimalPullDir, getWallAngleLabel, LIMB_META } from './holds';
import { clamp, lerp, lerpVec } from './ik';
import { BetaTraceStep, getDynoEnvelope } from './physics';
import {
  BetaStep,
  ClimberProfile,
  FreeLimbMap,
  GameMode,
  Hold,
  LimbAssignment,
  LimbId,
  MoveEvaluation,
  PlanContactMode,
  SolvedPose,
  Vec2,
  WALL_HEIGHT_CM,
  WALL_WIDTH_CM,
} from './types';
import { emptyFreeMap } from './contact';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  life: number;
  maxLife: number;
  color: string;
  gravity: number;
}

export interface CameraView {
  zoom: number; // 1.0 .. 3.2
  panX: number; // screen px offset
  panY: number; // screen px offset
}

export interface WallTransform {
  wallLeft: number;
  wallTop: number;
  wallBottom: number;
  wallCenterX: number;
  wallPixelW: number;
  wallPixelH: number;
  padPixelH: number;
  scale: number; // px per cm
  wallAngleDeg: number;
  topScale: number;
  botScale: number;
}

export interface RenderContextState {
  camera?: CameraView;
  wallAngleDeg?: number;
  mode: GameMode;
  holds: Hold[];
  profile: ClimberProfile;
  pose: SolvedPose;
  assignment: LimbAssignment;
  freeLimbs?: FreeLimbMap;
  // Setter mode
  selectedHoldId: string | null;
  hoveredHoldId: string | null;
  // Plan mode
  activeLimb: LimbId;
  planContactMode?: PlanContactMode;
  wallHoverPos?: Vec2 | null;
  betaSteps: BetaStep[];
  betaTraces: BetaTraceStep[];
  inspectedStepIndex: number; // -1 = start stance, 0..N-1 = after step i
  previewEvaluations: Map<string, MoveEvaluation>;
  showReachArc: boolean;
  showComLine: boolean;
  showBetaArrows: boolean;
  // Climb mode
  isClimbing: boolean;
  activeClimbStep: number;
  stamina: number;
  strainLevel: number; // 0..1 tremor intensity
  lookTarget: Vec2 | null;
  fallingState: {
    active: boolean;
    offsetX: number;
    offsetY: number;
    rotation: number;
    pose: SolvedPose;
  } | null;
  particles: Particle[];
  timeSec: number;
}

// Geometric birch wall panel polygons in normalized [0..1] wall coords
const WALL_FACETS: { pts: [number, number][]; fill: string }[] = [
  { pts: [[0, 0], [0.34, 0], [0.28, 0.32], [0, 0.26]], fill: '#D9C5A3' },
  { pts: [[0.34, 0], [0.72, 0], [0.64, 0.29], [0.28, 0.32]], fill: '#D2BC96' },
  { pts: [[0.72, 0], [1, 0], [1, 0.35], [0.64, 0.29]], fill: '#DECBA9' },
  { pts: [[0, 0.26], [0.28, 0.32], [0.38, 0.64], [0, 0.58]], fill: '#CFB891' },
  { pts: [[0.28, 0.32], [0.64, 0.29], [0.74, 0.61], [0.38, 0.64]], fill: '#DAC6A4' },
  { pts: [[0.64, 0.29], [1, 0.35], [1, 0.66], [0.74, 0.61]], fill: '#D0B992' },
  { pts: [[0, 0.58], [0.38, 0.64], [0.3, 1], [0, 1]], fill: '#D8C3A0' },
  { pts: [[0.38, 0.64], [0.74, 0.61], [0.68, 1], [0.3, 1]], fill: '#CDB58D' },
  { pts: [[0.74, 0.61], [1, 0.66], [1, 1], [0.68, 1]], fill: '#D7C29F' },
];

export function computeWallTransform(
  canvasW: number,
  canvasH: number,
  camera?: CameraView,
  wallAngleDeg = 0
): WallTransform {
  const padRatio = 0.085; // crash pad height as fraction of wall height
  const isCompact = canvasW <= 680;
  const marginX = isCompact ? 34 : 52;
  const marginTop = isCompact ? 16 : 64;
  const marginBottom = isCompact ? 10 : 20;

  const availW = Math.max(200, canvasW - marginX * 2);
  const availH = Math.max(240, canvasH - marginTop - marginBottom);

  const totalUnitsH = WALL_HEIGHT_CM * (1 + padRatio);
  // Reserve a bit of horizontal room so steep 55° overhang top flare never clips
  const baseScale = Math.min(availW / (WALL_WIDTH_CM * 1.09), availH / totalUnitsH);

  const baseW = WALL_WIDTH_CM * baseScale;
  const baseH = WALL_HEIGHT_CM * baseScale;
  const basePadH = baseH * padRatio;

  const baseLeft = (canvasW - baseW) / 2;
  const baseTop = marginTop + (availH - baseH - basePadH) / 2;

  const zoom = camera ? clamp(camera.zoom, 1, 3.2) : 1;
  const panX = camera ? camera.panX : 0;
  const panY = camera ? camera.panY : 0;

  const cx = canvasW / 2;
  const cy = canvasH / 2;

  const angle = clamp(wallAngleDeg, -10, 55);
  const rad = (angle * Math.PI) / 180;
  const tilt = Math.sin(rad); // -0.174 (slab) .. 0 (vert) .. +0.819 (55° overhang)
  // Overhang: top leans closer to viewer (wider) & bottom recedes (narrower); Slab: inverse!
  const topScale = 1 + tilt * 0.11;
  const botScale = 1 - tilt * 0.165;
  // Vertical foreshortening of tilted panel anchored at the crash pad
  const heightFactor = 0.72 + 0.28 * Math.cos(rad);

  const scale = baseScale * zoom;
  const wallPixelW = baseW * zoom;
  const fullWallPixelH = baseH * zoom;
  const wallPixelH = fullWallPixelH * heightFactor;
  const padPixelH = basePadH * zoom;
  const wallLeft = cx + (baseLeft - cx) * zoom + panX;
  const wallCenterX = wallLeft + wallPixelW / 2;
  const nominalWallTop = cy + (baseTop - cy) * zoom + panY;
  const wallBottom = nominalWallTop + fullWallPixelH;
  const wallTop = wallBottom - wallPixelH;

  return {
    wallLeft,
    wallTop,
    wallBottom,
    wallCenterX,
    wallPixelW,
    wallPixelH,
    padPixelH,
    scale,
    wallAngleDeg: angle,
    topScale,
    botScale,
  };
}

export function worldToScreen(pt: Vec2, tr: WallTransform): Vec2 {
  const u = pt.y / WALL_HEIGHT_CM;
  const rowScale = tr.botScale + (tr.topScale - tr.botScale) * u;
  return {
    x: tr.wallCenterX + (pt.x - WALL_WIDTH_CM / 2) * tr.scale * rowScale,
    y: tr.wallBottom - u * tr.wallPixelH,
  };
}

export function screenToWorld(pt: Vec2, tr: WallTransform): Vec2 {
  const u = (tr.wallBottom - pt.y) / Math.max(1, tr.wallPixelH);
  const rowScale = Math.max(0.4, tr.botScale + (tr.topScale - tr.botScale) * u);
  return {
    x: WALL_WIDTH_CM / 2 + (pt.x - tr.wallCenterX) / Math.max(0.01, tr.scale * rowScale),
    y: u * WALL_HEIGHT_CM,
  };
}

function shadeHex(hex: string, amount: number): string {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  const r = clamp(((num >> 16) & 0xff) + amount, 0, 255);
  const g = clamp(((num >> 8) & 0xff) + amount, 0, 255);
  const b = clamp((num & 0xff) + amount, 0, 255);
  return `rgb(${r}, ${g}, ${b})`;
}

export function renderScene(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  state: RenderContextState
): WallTransform {
  const wallAngle = state.wallAngleDeg ?? 0;
  const tr = computeWallTransform(width, height, state.camera, wallAngle);
  ctx.clearRect(0, 0, width, height);

  // Studio concrete backdrop
  ctx.fillStyle = '#E5E8E3';
  ctx.fillRect(0, 0, width, height);

  const tl = worldToScreen({ x: 0, y: WALL_HEIGHT_CM }, tr);
  const trPt = worldToScreen({ x: WALL_WIDTH_CM, y: WALL_HEIGHT_CM }, tr);
  const br = worldToScreen({ x: WALL_WIDTH_CM, y: 0 }, tr);
  const bl = worldToScreen({ x: 0, y: 0 }, tr);

  // Rear structural hydraulic Kilter frame & 3D angled wooden side cheeks!
  drawWall3DStructure(ctx, tr, tl, trPt, br, bl, wallAngle);

  // Subtle wall drop shadow against studio wall (grows dramatically deeper on overhang!)
  const overhangRatio = clamp(wallAngle / 55, 0, 1);
  const slabRatio = clamp(-wallAngle / 10, 0, 1);
  ctx.save();
  ctx.shadowColor = `rgba(20, 24, 30, ${0.16 + overhangRatio * 0.24})`;
  ctx.shadowBlur = 22 + overhangRatio * 24;
  ctx.shadowOffsetY = 8 + overhangRatio * 18;
  ctx.fillStyle = '#D5BF9B';
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y);
  ctx.lineTo(trPt.x, trPt.y);
  ctx.lineTo(br.x, br.y);
  ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Clip inside tilted wall trapezoid
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y);
  ctx.lineTo(trPt.x, trPt.y);
  ctx.lineTo(br.x, br.y);
  ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.clip();

  // 1. Birch plywood geometric facets projected into 3D tilted plane
  for (const facet of WALL_FACETS) {
    ctx.beginPath();
    facet.pts.forEach(([nx, ny], idx) => {
      const p = worldToScreen({ x: nx * WALL_WIDTH_CM, y: (1 - ny) * WALL_HEIGHT_CM }, tr);
      if (idx === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.fillStyle = facet.fill;
    ctx.fill();
    ctx.strokeStyle = 'rgba(92, 72, 46, 0.18)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // Dynamic studio lighting gradient across wall (adapts strongly to overhang/slab angle!)
  const lightGrad = ctx.createLinearGradient(0, tr.wallTop, 0, tr.wallBottom);
  if (overhangRatio > 0.04) {
    // Steep overhang casts rich dark underside shading from above while catching warm bounce light below
    lightGrad.addColorStop(0, `rgba(18, 16, 20, ${0.14 + overhangRatio * 0.3})`);
    lightGrad.addColorStop(0.5, `rgba(26, 20, 16, ${0.06 + overhangRatio * 0.16})`);
    lightGrad.addColorStop(1, `rgba(255, 248, 234, ${0.04 + overhangRatio * 0.08})`);
  } else {
    // Vertical / Slab catches bright skylight across the upper wall face
    lightGrad.addColorStop(0, `rgba(255, 253, 246, ${0.16 + slabRatio * 0.24})`);
    lightGrad.addColorStop(0.6, `rgba(255, 255, 255, ${slabRatio * 0.08})`);
    lightGrad.addColorStop(1, 'rgba(42, 32, 20, 0.14)');
  }
  ctx.fillStyle = lightGrad;
  ctx.fillRect(
    Math.min(tl.x, bl.x) - 4,
    tr.wallTop - 4,
    Math.max(trPt.x, br.x) - Math.min(tl.x, bl.x) + 8,
    tr.wallPixelH + 8
  );

  // Top roof lip highlight (for overhang) or receding bevel (for slab)
  if (overhangRatio > 0.08) {
    ctx.fillStyle = `rgba(255, 255, 255, ${0.12 + overhangRatio * 0.16})`;
    ctx.fillRect(tl.x, tl.y, trPt.x - tl.x, Math.max(2, 5 * overhangRatio));
  }

  // 2. T-nut bolt grid (every 25cm, naturally converges in 3D perspective!)
  ctx.fillStyle = 'rgba(84, 66, 44, 0.24)';
  for (let wx = 25; wx < WALL_WIDTH_CM; wx += 25) {
    for (let wy = 25; wy < WALL_HEIGHT_CM; wy += 25) {
      const p = worldToScreen({ x: wx, y: wy }, tr);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1.1, 1.35 * tr.scale), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 3. Faint chalk smudges around holds
  for (const hold of state.holds) {
    if (hold.type === 'foothold') continue;
    const p = worldToScreen(hold, tr);
    const rad = getHoldHitRadius(hold) * tr.scale * 1.45;
    const g = ctx.createRadialGradient(p.x, p.y - rad * 0.18, rad * 0.1, p.x, p.y, rad);
    g.addColorStop(0, 'rgba(255, 255, 255, 0.28)');
    g.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  // 4. Plan mode: Reach Arc around active limb root
  if (state.mode === 'plan' && state.showReachArc) {
    drawReachArc(ctx, tr, state);
  }

  // 5. Beta path arrows
  if ((state.mode === 'plan' || state.mode === 'climb') && state.showBetaArrows && state.betaSteps.length > 0) {
    drawBetaArrows(ctx, tr, state);
  }

  // 5b. Free contacts (smear / flag) markers
  drawFreeContacts(ctx, tr, state);

  // 6. Holds
  for (const hold of state.holds) {
    drawHold(ctx, tr, hold, state);
  }

  // 7. CoM vertical plumb line (when in plan or climb mode)
  if ((state.mode === 'plan' || state.mode === 'climb') && state.showComLine && !state.fallingState?.active) {
    drawComPlumbLine(ctx, tr, state.pose);
  }

  ctx.restore();

  // Wall outer architectural trapezoid frame
  ctx.strokeStyle = overhangRatio > 0.2 ? '#5A4A38' : '#9C8768';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y);
  ctx.lineTo(trPt.x, trPt.y);
  ctx.lineTo(br.x, br.y);
  ctx.lineTo(bl.x, bl.y);
  ctx.closePath();
  ctx.stroke();

  // Metric height ticks along the tilted left wall edge (1m, 2m, 3m, 4m)
  drawHeightRuler(ctx, tr);

  // 8. Crash pad mat at the bottom (with real overhanging shadow cast onto pad!)
  drawCrashPad(ctx, tr, bl, br, wallAngle);

  // 9. Climber (drawn after wall frame so limbs / falls onto crash pad overlap cleanly!)
  if (state.mode !== 'setter') {
    if (state.fallingState?.active) {
      drawFallingClimber(ctx, tr, state.fallingState, state.profile);
    } else {
      drawClimber(ctx, tr, state.pose, state.profile, state.assignment, state.freeLimbs, state.strainLevel, state.lookTarget, state.timeSec);
    }
  } else {
    drawSetterScaleGhost(ctx, tr, state.profile);
  }

  // 10. Particles (chalk puffs, confetti)
  for (const pt of state.particles) {
    const sp = worldToScreen({ x: pt.x, y: pt.y }, tr);
    ctx.save();
    ctx.globalAlpha = clamp(pt.alpha, 0, 1);
    ctx.fillStyle = pt.color;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, pt.size * tr.scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 11. Prominent architectural side-profile wall cross-section diagram (always unobscured!)
  drawWallSideProfileWidget(ctx, width, wallAngle);

  return tr;
}

/**
 * Draws the 3D wooden side cheeks, rear vertical truss, and hydraulic tilt struts
 * behind the tilted Kilter climbing wall so overhang/slab angles read unmistakably!
 */
function drawWall3DStructure(
  ctx: CanvasRenderingContext2D,
  tr: WallTransform,
  tl: Vec2,
  trPt: Vec2,
  br: Vec2,
  bl: Vec2,
  wallAngleDeg: number
): void {
  const rad = (clamp(wallAngleDeg, -10, 55) * Math.PI) / 180;
  const sinA = Math.sin(rad);
  if (Math.abs(sinA) < 0.02) return;

  ctx.save();
  const frameInset = Math.abs(sinA) * tr.wallPixelW * 0.08 + 6;

  if (sinA > 0) {
    // OVERHANG: wall looms forward above the floor; draw rear A-frame steel legs & overhanging timber cap!
    const sideDepthTop = 5 + sinA * 12;

    // Rear freestanding steel A-frame support legs tucked cleanly inside the overhang silhouette
    const rearLegXLeft = bl.x - 4 - sinA * 10;
    const rearLegXRight = br.x + 4 + sinA * 10;
    const rearMidY = tr.wallBottom - tr.wallPixelH * 0.42;

    // Subtle dark void shadow directly behind the lower recessed base of the wall
    ctx.fillStyle = `rgba(30, 36, 44, ${0.12 + sinA * 0.16})`;
    ctx.beginPath();
    ctx.moveTo(tl.x + 12, tl.y + 10);
    ctx.lineTo(trPt.x - 12, trPt.y + 10);
    ctx.lineTo(rearLegXRight, tr.wallBottom);
    ctx.lineTo(rearLegXLeft, tr.wallBottom);
    ctx.closePath();
    ctx.fill();

    // Steel hydraulic support legs visible along the lower-left and lower-right flanks
    ctx.strokeStyle = '#525C68';
    ctx.lineWidth = Math.max(2.6, 3.4 * tr.scale);
    ctx.lineCap = 'round';
    ctx.beginPath();
    // Left steel support strut
    ctx.moveTo(rearLegXLeft, tr.wallBottom - 2);
    ctx.lineTo(lerp(bl.x, tl.x, 0.52), rearMidY);
    // Right steel support strut
    ctx.moveTo(rearLegXRight, tr.wallBottom - 2);
    ctx.lineTo(lerp(br.x, trPt.x, 0.52), rearMidY);
    ctx.stroke();

    // Left & right thick angled timber flanks
    ctx.fillStyle = '#7A6347';
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tl.x - sideDepthTop * 0.35, tl.y + 4);
    ctx.lineTo(bl.x - 2, bl.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#6A543B';
    ctx.beginPath();
    ctx.moveTo(trPt.x, trPt.y);
    ctx.lineTo(trPt.x + sideDepthTop * 0.35, trPt.y + 4);
    ctx.lineTo(br.x + 2, br.y);
    ctx.lineTo(br.x, br.y);
    ctx.closePath();
    ctx.fill();

    // Top extruded roof header beam (thick dark timber cap above the looming edge)
    const capH = 4 + sinA * 10;
    ctx.fillStyle = '#7E684C';
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(trPt.x, trPt.y);
    ctx.lineTo(trPt.x - frameInset * 0.25, trPt.y - capH);
    ctx.lineTo(tl.x + frameInset * 0.25, tl.y - capH);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(24, 29, 34, 0.32)';
    ctx.lineWidth = 1;
    ctx.stroke();
  } else {
    // SLAB (-10°..-5°): wall leans gently backward; show bright bevel cheeks receding away!
    const sAbs = Math.abs(sinA);
    const sideW = 6 + sAbs * 22;
    ctx.fillStyle = '#B8A07E';
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tl.x - sideW * 0.45, tl.y + 6);
    ctx.lineTo(bl.x - sideW * 0.2, bl.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#A8906E';
    ctx.beginPath();
    ctx.moveTo(trPt.x, trPt.y);
    ctx.lineTo(trPt.x + sideW * 0.45, trPt.y + 6);
    ctx.lineTo(br.x + sideW * 0.2, br.y);
    ctx.lineTo(br.x, br.y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawHeightRuler(ctx: CanvasRenderingContext2D, tr: WallTransform): void {
  ctx.save();
  ctx.font = '500 10px "JetBrains Mono", monospace';
  ctx.fillStyle = '#6A737D';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let m = 1; m <= 4; m++) {
    const p = worldToScreen({ x: 0, y: m * 100 }, tr);
    ctx.strokeStyle = 'rgba(106, 115, 125, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.x - 6, p.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.fillText(`${m}m`, p.x - 9, p.y);
  }
  ctx.restore();
}

function drawWallSideProfileWidget(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  angleDeg: number
): void {
  const isCompact = canvasW <= 680;
  const bx = isCompact ? 10 : 14;
  const by = isCompact ? 10 : 14;
  const bw = isCompact ? 82 : 94;
  const bh = isCompact ? 78 : 88;
  const rad = (clamp(angleDeg, -10, 55) * Math.PI) / 180;
  const isOverhang = angleDeg >= 10;
  const isSteep = angleDeg >= 35;
  const isSlab = angleDeg < 0;

  ctx.save();
  ctx.fillStyle = 'rgba(24, 29, 34, 0.84)';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.16)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 9);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = isSteep
    ? 'rgba(249, 115, 22, 0.55)'
    : isSlab
      ? 'rgba(56, 189, 248, 0.5)'
      : 'rgba(255, 255, 255, 0.14)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Header label
  ctx.font = '700 9px "Space Grotesk", "PingFang SC", sans-serif';
  ctx.fillStyle = 'rgba(247, 248, 245, 0.65)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('侧面倾角剖面', bx + bw / 2, by + 6);

  // Side profile geometry
  const ox = bx + (isCompact ? 26 : 30);
  const oy = by + bh - 22;
  const wallLen = isCompact ? 34 : 38;

  // Crash pad floor bar
  ctx.fillStyle = '#4B5563';
  ctx.fillRect(bx + 10, oy, bw - 20, 4);

  // 0° vertical dashed plumb line
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  ctx.lineTo(ox, oy - wallLen - 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Filled angle wedge sector
  if (Math.abs(angleDeg) >= 2) {
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    const startA = -Math.PI / 2;
    const endA = -Math.PI / 2 + rad;
    ctx.arc(ox, oy, 16, Math.min(startA, endA), Math.max(startA, endA));
    ctx.closePath();
    ctx.fillStyle = isSteep
      ? 'rgba(249, 115, 22, 0.35)'
      : isSlab
        ? 'rgba(56, 189, 248, 0.35)'
        : 'rgba(250, 204, 21, 0.28)';
    ctx.fill();
  }

  // Tilted climbing wall slab (overhang leans right over mat, slab leans left)
  const tx = ox + Math.sin(rad) * wallLen;
  const ty = oy - Math.cos(rad) * wallLen;
  ctx.strokeStyle = isSteep ? '#FB923C' : isSlab ? '#38BDF8' : isOverhang ? '#FACC15' : '#F7F8F5';
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  ctx.lineTo(tx, ty);
  ctx.stroke();

  // Mini side-view climber silhouette clinging to the front face of the wall!
  const midX = ox + Math.sin(rad) * (wallLen * 0.56);
  const midY = oy - Math.cos(rad) * (wallLen * 0.56);
  // Outward normal from front face of wall (+x direction when vertical)
  const nx = Math.cos(rad);
  const ny = Math.sin(rad);
  const bodyX = midX + nx * 6.5;
  const bodyY = midY + ny * 6.5;
  ctx.fillStyle = '#F7F8F5';
  ctx.beginPath();
  ctx.arc(bodyX + Math.sin(rad) * 4, bodyY - Math.cos(rad) * 4, 2.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#F7F8F5';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  // Torso hanging vertically by gravity while hand reaches up to wall
  ctx.moveTo(midX + Math.sin(rad) * 6, midY - Math.cos(rad) * 6);
  ctx.lineTo(bodyX, bodyY);
  ctx.lineTo(bodyX - 1.5, bodyY + 8);
  ctx.lineTo(midX - Math.sin(rad) * 7, midY + Math.cos(rad) * 7);
  ctx.stroke();

  // Angle text readout at bottom
  ctx.font = '700 10.5px "JetBrains Mono", "PingFang SC", sans-serif';
  ctx.fillStyle = isSteep ? '#FDBA74' : isSlab ? '#7DD3FC' : '#F7F8F5';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(getWallAngleLabel(Math.round(angleDeg)), bx + bw / 2, by + bh - 4);
  ctx.restore();
}

function drawCrashPad(
  ctx: CanvasRenderingContext2D,
  tr: WallTransform,
  bl: Vec2,
  br: Vec2,
  wallAngleDeg: number
): void {
  const matTop = tr.wallBottom;
  const padSpan = Math.max(br.x - bl.x, tr.wallPixelW * 0.94);
  const matLeft = tr.wallCenterX - padSpan / 2 - 14;
  const matW = padSpan + 28;
  const matH = tr.padPixelH;
  const overhangRatio = clamp(wallAngleDeg / 55, 0, 1);

  ctx.save();
  // Mat top bevel
  const grad = ctx.createLinearGradient(0, matTop, 0, matTop + matH);
  grad.addColorStop(0, '#363D47');
  grad.addColorStop(0.18, '#282E36');
  grad.addColorStop(1, '#1E232A');

  ctx.beginPath();
  ctx.roundRect(matLeft, matTop, matW, matH, [6, 6, 8, 8]);
  ctx.fillStyle = grad;
  ctx.fill();

  // Overhanging wall casts a deep shadow across the crash pad beneath it!
  if (overhangRatio > 0.04) {
    const shGrad = ctx.createLinearGradient(0, matTop, 0, matTop + matH * (0.45 + overhangRatio * 0.55));
    shGrad.addColorStop(0, `rgba(0, 0, 0, ${0.28 + overhangRatio * 0.42})`);
    shGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = shGrad;
    ctx.beginPath();
    ctx.roundRect(matLeft, matTop, matW, matH, [6, 6, 8, 8]);
    ctx.fill();
  }

  // Mat stitching seam
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(matLeft + 10, matTop + 5);
  ctx.lineTo(matLeft + matW - 10, matTop + 5);
  ctx.stroke();

  // Subtle floor brand mark
  ctx.font = '600 10px "Space Grotesk", sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.34)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    `CRASH PAD · 4.0m × 4.5m · ${getWallAngleLabel(Math.round(wallAngleDeg))}`,
    tr.wallCenterX,
    matTop + matH * 0.56
  );
  ctx.restore();
}

function drawReachArc(ctx: CanvasRenderingContext2D, tr: WallTransform, state: RenderContextState): void {
  const anatomy = computeAnatomy(state.profile);
  const limb = state.activeLimb;
  const meta = LIMB_META[limb];
  const isDynoMode = state.planContactMode === 'dyno' || state.planContactMode === 'doubleDyno';

  if (isDynoMode) {
    const isDouble = state.planContactMode === 'doubleDyno';
    const otherHand: LimbId = limb === 'lh' ? 'rh' : 'lh';
    const env = getDynoEnvelope(
      state.assignment,
      state.freeLimbs ?? emptyFreeMap(),
      state.holds,
      state.profile,
      isDouble,
      isDouble ? undefined : otherHand,
      state.wallAngleDeg ?? 0
    );
    if (!env.canLaunch) return;

    const launchCenter = worldToScreen(env.launchOrigin, tr);
    const launchU = clamp(env.launchOrigin.y / WALL_HEIGHT_CM, 0, 1);
    const perspScale = tr.botScale + (tr.topScale - tr.botScale) * launchU;
    const rx = env.maxLatReach * tr.scale * perspScale;
    const ry = env.maxUpReach * (tr.wallPixelH / WALL_HEIGHT_CM);

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(launchCenter.x, launchCenter.y, rx, ry, 0, Math.PI, Math.PI * 2);
    ctx.ellipse(launchCenter.x, launchCenter.y, rx, ry * 0.65, 0, 0, Math.PI);
    ctx.closePath();
    ctx.fillStyle = 'rgba(217, 119, 6, 0.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(217, 119, 6, 0.78)';
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const root = meta.isHand
    ? state.pose.shoulders[limb as 'lh' | 'rh']
    : state.pose.hips[limb as 'lf' | 'rf'];
  const maxR = meta.isHand ? anatomy.maxArmReach : anatomy.maxLegReach;

  const radY = tr.wallPixelH / WALL_HEIGHT_CM;
  const center = worldToScreen(root, tr);
  const rootU = clamp(root.y / WALL_HEIGHT_CM, 0, 1);
  const perspScale = tr.botScale + (tr.topScale - tr.botScale) * rootU;
  const staticPxX = maxR * 1.03 * tr.scale * perspScale;
  const staticPxY = maxR * 1.03 * radY;

  ctx.save();
  // Soft tinted reach disk (foreshortened cleanly with wall tilt)
  ctx.beginPath();
  ctx.ellipse(center.x, center.y, staticPxX, staticPxY, 0, 0, Math.PI * 2);
  ctx.fillStyle = `${meta.color}0E`;
  ctx.fill();
  ctx.strokeStyle = `${meta.color}70`;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 5]);
  ctx.stroke();

  // Outer Dyno reach hint for hands
  if (meta.isHand) {
    ctx.beginPath();
    ctx.ellipse(center.x, center.y, maxR * 1.2 * tr.scale * perspScale, maxR * 1.2 * radY, 0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(217, 119, 6, 0.34)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 6]);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHold(ctx: CanvasRenderingContext2D, tr: WallTransform, hold: Hold, state: RenderContextState): void {
  const pos = worldToScreen(hold, tr);
  const u = hold.y / WALL_HEIGHT_CM;
  const perspScale = tr.botScale + (tr.topScale - tr.botScale) * u;
  const r = getHoldHitRadius(hold) * tr.scale * perspScale;
  const rad = (hold.angle * Math.PI) / 180;
  const isSelected = state.mode === 'setter' && state.selectedHoldId === hold.id;
  const isHovered = state.hoveredHoldId === hold.id;
  const overhangRatio = clamp(tr.wallAngleDeg / 55, 0, 1);

  // Plan mode feasibility halo
  const previewEval = state.mode === 'plan' ? state.previewEvaluations.get(hold.id) : undefined;
  if (previewEval && state.assignment[state.activeLimb] !== hold.id) {
    ctx.save();
    let ringColor = '#16A34A'; // solid
    if (!previewEval.feasible) ringColor = '#DC2626';
    else if (previewEval.rating === 'dyno') ringColor = '#D97706';
    else if (previewEval.rating === 'hard') ringColor = '#EA580C';

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r + (isHovered ? 7 : 4.5), 0, Math.PI * 2);
    ctx.strokeStyle = previewEval.feasible ? ringColor : 'rgba(220, 38, 38, 0.35)';
    ctx.lineWidth = isHovered ? 3 : previewEval.feasible ? 2 : 1.25;
    if (!previewEval.feasible) ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.restore();
  }

  // Start / Top gym tape beneath hold
  if (hold.role === 'start') {
    drawGymTape(ctx, pos, r, 'start');
  } else if (hold.role === 'top') {
    drawGymTape(ctx, pos, r, 'top');
  }

  // Hold body
  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(rad);

  // Drop shadow on plywood (deepens and extends downward on steep overhangs!)
  ctx.shadowColor = `rgba(24, 18, 12, ${0.36 + overhangRatio * 0.24})`;
  ctx.shadowBlur = Math.max(4, r * (0.42 + overhangRatio * 0.4));
  ctx.shadowOffsetX = 2 + overhangRatio * 2;
  ctx.shadowOffsetY = 3.5 + overhangRatio * 6.5;

  const baseFill = hold.color;
  const lightFill = shadeHex(baseFill, 34);
  const darkFill = shadeHex(baseFill, -36);

  ctx.beginPath();
  if (hold.type === 'jug') {
    // Bean / ergonomic bucket shape with deep top lip
    ctx.moveTo(-r * 1.15, -r * 0.15);
    ctx.bezierCurveTo(-r * 1.1, -r * 0.85, r * 1.1, -r * 0.85, r * 1.15, -r * 0.15);
    ctx.bezierCurveTo(r * 1.12, r * 0.65, r * 0.45, r * 0.78, 0, r * 0.68);
    ctx.bezierCurveTo(-r * 0.55, r * 0.82, -r * 1.1, r * 0.62, -r * 1.15, -r * 0.15);
  } else if (hold.type === 'crimp') {
    // Sharp narrow horizontal bar edge (15-20mm)
    ctx.roundRect(-r * 1.2, -r * 0.42, r * 2.4, r * 0.84, r * 0.25);
  } else if (hold.type === 'microcrimp') {
    // Razor-thin 6-10mm micro edge strip
    ctx.roundRect(-r * 1.32, -r * 0.3, r * 2.64, r * 0.6, r * 0.16);
  } else if (hold.type === 'pinch') {
    // Vertical-ish sculpted trapezoid pinch block
    ctx.moveTo(-r * 0.72, -r * 0.88);
    ctx.lineTo(r * 0.72, -r * 0.88);
    ctx.quadraticCurveTo(r * 1.0, 0, r * 0.62, r * 0.9);
    ctx.lineTo(-r * 0.62, r * 0.9);
    ctx.quadraticCurveTo(-r * 1.0, 0, -r * 0.72, -r * 0.88);
  } else if (hold.type === 'sloper') {
    // Smooth dome
    ctx.ellipse(0, 0, r * 1.15, r * 0.85, 0, 0, Math.PI * 2);
  } else if (hold.type === 'foothold') {
    // Compact angular jib
    ctx.moveTo(-r * 1.0, -r * 0.35);
    ctx.lineTo(r * 0.85, -r * 0.55);
    ctx.lineTo(r * 1.05, r * 0.45);
    ctx.lineTo(-r * 0.85, r * 0.6);
  } else {
    // Volume: large geometric triangle prism
    ctx.moveTo(0, -r * 1.08);
    ctx.lineTo(r * 1.15, r * 0.78);
    ctx.lineTo(-r * 1.15, r * 0.78);
  }
  ctx.closePath();

  const holdGrad = ctx.createLinearGradient(0, -r, 0, r);
  holdGrad.addColorStop(0, lightFill);
  holdGrad.addColorStop(0.55, baseFill);
  holdGrad.addColorStop(1, darkFill);
  ctx.fillStyle = holdGrad;
  ctx.fill();

  // Crisp edge outline
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = isSelected ? '#111827' : 'rgba(20, 20, 20, 0.28)';
  ctx.lineWidth = isSelected ? 2.4 : 1;
  ctx.stroke();

  // Sculpted active gripping lip (shows pull orientation clearly!)
  if (hold.type === 'jug' || hold.type === 'crimp') {
    ctx.beginPath();
    ctx.moveTo(-r * 0.78, -r * 0.25);
    ctx.quadraticCurveTo(0, -r * 0.56, r * 0.78, -r * 0.25);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.58)';
    ctx.lineWidth = Math.max(1.5, r * 0.16);
    ctx.lineCap = 'round';
    ctx.stroke();
  } else if (hold.type === 'microcrimp') {
    // Razor-crisp bright edge crease to distinguish 6-10mm microcrimp immediately
    ctx.beginPath();
    ctx.moveTo(-r * 1.05, -r * 0.14);
    ctx.lineTo(r * 1.05, -r * 0.14);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
    ctx.lineWidth = Math.max(1.3, r * 0.15);
    ctx.lineCap = 'butt';
    ctx.stroke();
  } else if (hold.type === 'sloper') {
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.24, r * 0.62, r * 0.26, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.24)';
    ctx.fill();
  } else if (hold.type === 'volume') {
    // Facet crease lines on volume
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.08);
    ctx.lineTo(0, r * 0.15);
    ctx.lineTo(r * 1.15, r * 0.78);
    ctx.moveTo(0, r * 0.15);
    ctx.lineTo(-r * 1.15, r * 0.78);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // Stainless steel bolt socket
  ctx.beginPath();
  ctx.arc(0, r * 0.12, Math.max(1.5, r * 0.13), 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(28, 32, 38, 0.55)';
  ctx.fill();

  ctx.restore();

  // Pull-direction arrow indicator when selected or hovered (for non-footholds)
  if ((isSelected || isHovered) && hold.type !== 'foothold') {
    const dir = getHoldOptimalPullDir(hold.angle);
    // In screen coords, +y world is -y screen
    const arrowLen = r + 14;
    const endX = pos.x + dir.x * arrowLen;
    const endY = pos.y - dir.y * arrowLen;
    ctx.save();
    ctx.strokeStyle = 'rgba(24, 29, 34, 0.72)';
    ctx.fillStyle = 'rgba(24, 29, 34, 0.72)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(pos.x + dir.x * (r * 0.7), pos.y - dir.y * (r * 0.7));
    ctx.lineTo(endX, endY);
    ctx.stroke();
    // Tiny arrowhead
    const ang = Math.atan2(-dir.y, dir.x);
    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - Math.cos(ang - 0.5) * 6, endY - Math.sin(ang - 0.5) * 6);
    ctx.lineTo(endX - Math.cos(ang + 0.5) * 6, endY - Math.sin(ang + 0.5) * 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Selection ring in setter mode
  if (isSelected) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r + 6, 0, Math.PI * 2);
    ctx.strokeStyle = '#181D22';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.restore();
  }

  // Hold index label pill (subtle, crisp)
  ctx.save();
  ctx.font = '600 9.5px "JetBrains Mono", monospace';
  const badgeX = pos.x + r * 0.82 + 4;
  const badgeY = pos.y - r * 0.65 - 2;
  ctx.fillStyle = 'rgba(247, 248, 245, 0.86)';
  ctx.beginPath();
  ctx.arc(badgeX, badgeY, 7.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(24, 29, 34, 0.18)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.fillStyle = '#242A30';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(hold.label), badgeX, badgeY + 0.5);
  ctx.restore();
}

function drawGymTape(ctx: CanvasRenderingContext2D, pos: Vec2, r: number, role: 'start' | 'top'): void {
  ctx.save();
  if (role === 'start') {
    // Classic V-tape below start hold
    ctx.strokeStyle = '#F7F8F5';
    ctx.lineWidth = 4;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(pos.x - r * 0.9, pos.y + r * 0.95);
    ctx.lineTo(pos.x - r * 0.2, pos.y + r * 0.5);
    ctx.moveTo(pos.x + r * 0.9, pos.y + r * 0.95);
    ctx.lineTo(pos.x + r * 0.2, pos.y + r * 0.5);
    ctx.stroke();

    ctx.strokeStyle = '#181D22';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  } else {
    // Top tape tag above top hold
    const tagW = 34;
    const tagH = 14;
    const ty = pos.y - r - 17;
    ctx.fillStyle = '#181D22';
    ctx.beginPath();
    ctx.roundRect(pos.x - tagW / 2, ty, tagW, tagH, 3);
    ctx.fill();
    ctx.font = '700 8.5px "Space Grotesk", sans-serif';
    ctx.fillStyle = '#F7F8F5';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('TOP', pos.x, ty + tagH / 2 + 0.5);
  }
  ctx.restore();
}

function resolveTraceTarget(trace: BetaTraceStep, holdMap: Map<string, Hold>): Vec2 | null {
  const t = trace.step.target;
  if (t.kind === 'hold' || t.kind === 'dyno') {
    const h = holdMap.get(t.holdId);
    return h ? { x: h.x, y: h.y } : null;
  }
  return { x: t.x, y: t.y };
}

function resolveTracePrev(
  trace: BetaTraceStep,
  holdMap: Map<string, Hold>
): Vec2 | null {
  const limb = trace.step.limb;
  const prevId = trace.assignmentBefore[limb];
  if (prevId) {
    const h = holdMap.get(prevId);
    return h ? { x: h.x, y: h.y } : null;
  }
  const free = trace.freeBefore?.[limb];
  if (free) return { x: free.x, y: free.y };
  return null;
}

function drawFreeContacts(
  ctx: CanvasRenderingContext2D,
  tr: WallTransform,
  state: RenderContextState
): void {
  const free = state.freeLimbs ?? emptyFreeMap();
  for (const limb of ['lh', 'rh', 'lf', 'rf'] as LimbId[]) {
    const c = free[limb];
    if (!c) continue;
    const p = worldToScreen({ x: c.x, y: c.y }, tr);
    const meta = LIMB_META[limb];
    ctx.save();
    if (c.mode === 'smear') {
      // Foot/hand smear footprint
      ctx.strokeStyle = meta.color;
      ctx.fillStyle = `${meta.color}33`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 14, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = '700 9px "JetBrains Mono", monospace';
      ctx.fillStyle = meta.color;
      ctx.textAlign = 'center';
      ctx.fillText('踩墙', p.x, p.y - 14);
    } else {
      // Flag dangling marker
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = meta.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '700 9px "JetBrains Mono", monospace';
      ctx.fillStyle = meta.color;
      ctx.textAlign = 'center';
      ctx.fillText('悬空', p.x, p.y - 14);
    }
    ctx.restore();
  }

  // Wall hover ghost for smear/flag placement
  if (
    state.mode === 'plan' &&
    state.wallHoverPos &&
    (state.planContactMode === 'smear' || state.planContactMode === 'flag')
  ) {
    const p = worldToScreen(state.wallHoverPos, tr);
    const meta = LIMB_META[state.activeLimb];
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = meta.color;
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (state.planContactMode === 'smear') {
      ctx.ellipse(p.x, p.y, 15, 10, 0, 0, Math.PI * 2);
    } else {
      ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
    }
    ctx.stroke();
    ctx.restore();
  }
}

function drawBetaArrows(ctx: CanvasRenderingContext2D, tr: WallTransform, state: RenderContextState): void {
  const holdMap = new Map(state.holds.map((h) => [h.id, h]));

  state.betaTraces.forEach((trace, idx) => {
    const nextPos = resolveTraceTarget(trace, holdMap);
    if (!nextPos) return;

    const prevPos = resolveTracePrev(trace, holdMap);
    const p2 = worldToScreen(nextPos, tr);
    const p1 = prevPos
      ? worldToScreen(prevPos, tr)
      : { x: p2.x, y: p2.y + 34 };

    const meta = LIMB_META[trace.step.limb];
    const isActive =
      (state.mode === 'plan' && idx === state.inspectedStepIndex) ||
      (state.mode === 'climb' && idx === state.activeClimbStep);
    const isPast =
      (state.mode === 'plan' && state.inspectedStepIndex >= 0 && idx < state.inspectedStepIndex) ||
      (state.mode === 'climb' && idx < state.activeClimbStep);

    const alpha = state.mode === 'climb' ? (isActive ? 0.9 : 0.24) : isActive ? 0.95 : isPast ? 0.55 : 0.72;

    // Slight curve perpendicular to segment so overlapping limb paths stay readable
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const curveSign = meta.side === 'left' ? -1 : 1;
    const bend = Math.min(26, len * 0.22) * curveSign;
    const cx = (p1.x + p2.x) / 2 + (-dy / len) * bend;
    const cy = (p1.y + p2.y) / 2 + (dx / len) * bend;

    const isExplicitDyno = trace.step.target.kind === 'dyno';
    const isDoubleDyno = trace.step.target.kind === 'dyno' && trace.step.target.bothHands;
    const strokeCol = !trace.evaluation.feasible
      ? '#DC2626'
      : isExplicitDyno
        ? '#D97706'
        : meta.color;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = isActive ? 3.2 : isExplicitDyno ? 2.6 : 2;
    if (trace.evaluation.isDyno) {
      ctx.setLineDash([7, 4]);
    } else if (!trace.evaluation.feasible) {
      ctx.setLineDash([3, 3]);
    }

    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.quadraticCurveTo(cx, cy, p2.x, p2.y);
    ctx.stroke();

    // Arrowhead near p2
    const tArrow = 0.84;
    const ax = (1 - tArrow) * (1 - tArrow) * p1.x + 2 * (1 - tArrow) * tArrow * cx + tArrow * tArrow * p2.x;
    const ay = (1 - tArrow) * (1 - tArrow) * p1.y + 2 * (1 - tArrow) * tArrow * cy + tArrow * tArrow * p2.y;
    const tanX = 2 * (1 - tArrow) * (cx - p1.x) + 2 * tArrow * (p2.x - cx);
    const tanY = 2 * (1 - tArrow) * (cy - p1.y) + 2 * tArrow * (p2.y - cy);
    const ang = Math.atan2(tanY, tanX);

    ctx.setLineDash([]);
    ctx.fillStyle = strokeCol;
    ctx.beginPath();
    ctx.moveTo(ax + Math.cos(ang) * 5, ay + Math.sin(ang) * 5);
    ctx.lineTo(ax - Math.cos(ang - 0.55) * 7, ay - Math.sin(ang - 0.55) * 7);
    ctx.lineTo(ax - Math.cos(ang + 0.55) * 7, ay - Math.sin(ang + 0.55) * 7);
    ctx.closePath();
    ctx.fill();

    // Step number pill at midpoint of curve
    const mx = 0.25 * p1.x + 0.5 * cx + 0.25 * p2.x;
    const my = 0.25 * p1.y + 0.5 * cy + 0.25 * p2.y;
    ctx.beginPath();
    ctx.arc(mx, my, isActive ? 10 : 8.5, 0, Math.PI * 2);
    ctx.fillStyle = strokeCol;
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = '700 9.5px "JetBrains Mono", monospace';
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(idx + 1), mx, my + 0.5);

    if (isExplicitDyno) {
      ctx.font = '700 8.5px "Space Grotesk", sans-serif';
      ctx.fillStyle = strokeCol;
      ctx.fillText(isDoubleDyno ? '双飞' : 'DYNO', mx, my - 13);
    }
    ctx.restore();
  });
}

function drawComPlumbLine(ctx: CanvasRenderingContext2D, tr: WallTransform, pose: SolvedPose): void {
  const com = worldToScreen(pose.com, tr);
  const floorY = tr.wallBottom;

  ctx.save();
  ctx.strokeStyle = 'rgba(24, 29, 34, 0.34)';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(com.x, com.y);
  ctx.lineTo(com.x, floorY);
  ctx.stroke();

  // CoM crosshair marker
  ctx.setLineDash([]);
  ctx.fillStyle = '#F7F8F5';
  ctx.strokeStyle = '#181D22';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(com.x, com.y, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(com.x, com.y, 1.6, 0, Math.PI * 2);
  ctx.fillStyle = '#181D22';
  ctx.fill();
  ctx.restore();
}

function drawTaperedLimb(
  ctx: CanvasRenderingContext2D,
  a: Vec2,
  b: Vec2,
  rStart: number,
  rEnd: number,
  fill: string,
  outline?: string
): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return;
  const ang = Math.atan2(dy, dx);

  ctx.save();
  ctx.beginPath();
  ctx.arc(a.x, a.y, rStart, ang + Math.PI / 2, ang - Math.PI / 2, false);
  ctx.arc(b.x, b.y, rEnd, ang - Math.PI / 2, ang + Math.PI / 2, false);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (outline) {
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.1;
    ctx.stroke();
  }
  ctx.restore();
}

function drawClimber(
  ctx: CanvasRenderingContext2D,
  tr: WallTransform,
  pose: SolvedPose,
  profile: ClimberProfile,
  assignment: LimbAssignment,
  freeLimbs: FreeLimbMap | undefined,
  strainLevel: number,
  lookTarget: Vec2 | null,
  timeSec: number
): void {
  const anatomy = computeAnatomy(profile);
  const s = tr.scale;

  // Subtle strain tremor on tough moves / low stamina
  const jitterAmp = strainLevel > 0.25 ? (strainLevel - 0.25) * 2.0 : 0;
  const jx = jitterAmp * Math.sin(timeSec * 46);
  const jy = jitterAmp * Math.cos(timeSec * 39);

  const pt = (v: Vec2, applyJitter = true): Vec2 => {
    const p = worldToScreen(v, tr);
    return applyJitter ? { x: p.x + jx, y: p.y + jy } : p;
  };

  const pelvis = pt(pose.pelvis);
  const chest = pt(pose.chest);
  const head = pt(pose.head);
  const shL = pt(pose.shoulders.lh);
  const shR = pt(pose.shoulders.rh);
  const hipL = pt(pose.hips.lf);
  const hipR = pt(pose.hips.rf);
  const elL = pt(pose.elbows.lh);
  const elR = pt(pose.elbows.rh);
  const knL = pt(pose.knees.lf);
  const knR = pt(pose.knees.rf);
  const lh = pt(pose.limbs.lh, assignment.lh === null);
  const rh = pt(pose.limbs.rh, assignment.rh === null);
  const lf = pt(pose.limbs.lf, assignment.lf === null);
  const rf = pt(pose.limbs.rf, assignment.rf === null);

  // Wall cast shadow (separates away from body on steep overhangs as gravity pulls torso off wall!)
  const overhangRatio = clamp(tr.wallAngleDeg / 55, 0, 1);
  const slabRatio = clamp(-tr.wallAngleDeg / 10, 0, 1);
  const shadowOffX = 6.5 + overhangRatio * 10 - slabRatio * 2.5;
  const shadowOffY = 7.5 + overhangRatio * 22 - slabRatio * 3.5;
  ctx.save();
  ctx.translate(shadowOffX, shadowOffY);
  ctx.globalAlpha = clamp(0.15 + overhangRatio * 0.14, 0.1, 0.32);
  const shadowColor = '#1E1A14';
  drawTaperedLimb(ctx, hipL, knL, 5.2 * s, 4.0 * s, shadowColor);
  drawTaperedLimb(ctx, knL, lf, 3.8 * s, 2.7 * s, shadowColor);
  drawTaperedLimb(ctx, hipR, knR, 5.2 * s, 4.0 * s, shadowColor);
  drawTaperedLimb(ctx, knR, rf, 3.8 * s, 2.7 * s, shadowColor);
  drawTaperedLimb(ctx, shL, elL, 4.2 * s, 3.2 * s, shadowColor);
  drawTaperedLimb(ctx, elL, lh, 3.0 * s, 2.3 * s, shadowColor);
  drawTaperedLimb(ctx, shR, elR, 4.2 * s, 3.2 * s, shadowColor);
  drawTaperedLimb(ctx, elR, rh, 3.0 * s, 2.3 * s, shadowColor);
  ctx.beginPath();
  ctx.moveTo(shL.x, shL.y);
  ctx.lineTo(shR.x, shR.y);
  ctx.lineTo(hipR.x, hipR.y);
  ctx.lineTo(hipL.x, hipL.y);
  ctx.closePath();
  ctx.fillStyle = shadowColor;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(head.x, head.y, anatomy.headRadius * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const skinColor = '#E7B996';
  const skinFar = '#D6A480';
  const skinOutline = 'rgba(42, 34, 28, 0.35)';
  const pantsNear = '#3B444E';
  const pantsFar = '#2F3740';
  const calfNear = '#303841';
  const calfFar = '#252C34';
  const sleeveNear = '#EAECE6';
  const sleeveFar = '#D8DCD4';

  const drawLeg = (side: 'left' | 'right', isFar: boolean) => {
    const hip = side === 'left' ? hipL : hipR;
    const knee = side === 'left' ? knL : knR;
    const foot = side === 'left' ? lf : rf;
    const depth = side === 'left' ? pose.jointDepth.lf : pose.jointDepth.rf;
    const limbColor = side === 'left' ? LIMB_META.lf.color : LIMB_META.rf.color;

    // 2.5D foreshortening: knee closer to viewer appears slightly fuller & brighter
    const kneeScale = 1 + depth * 0.22;
    const thighFill = isFar ? pantsFar : pantsNear;
    const shinFill = isFar ? calfFar : calfNear;
    const outline = 'rgba(20,24,28,0.28)';

    // Draw shin behind thigh when knee projects outward toward viewer (realistic depth!)
    drawTaperedLimb(ctx, knee, foot, 3.8 * s * kneeScale, 2.7 * s, shinFill, outline);
    drawClimbingShoe(ctx, foot, knee, 5.1 * s, limbColor);
    drawTaperedLimb(ctx, hip, knee, 5.2 * s, 4.1 * s * kneeScale, thighFill, outline);

    // Subtle knee cap highlight when bent toward camera
    if (depth > 0.22) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(knee.x, knee.y, 3.4 * s * kneeScale, 0, Math.PI * 2);
      ctx.fillStyle = isFar ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.12)';
      ctx.fill();
      ctx.restore();
    }
  };

  const drawArm = (side: 'left' | 'right', isFar: boolean) => {
    const sh = side === 'left' ? shL : shR;
    const el = side === 'left' ? elL : elR;
    const hand = side === 'left' ? lh : rh;
    const depth = side === 'left' ? pose.jointDepth.lh : pose.jointDepth.rh;
    const anchored = side === 'left' ? assignment.lh !== null : assignment.rh !== null;
    const limbColor = side === 'left' ? LIMB_META.lh.color : LIMB_META.rh.color;
    const sk = isFar ? skinFar : skinColor;
    const elbowScale = 1 + depth * 0.14;

    drawTaperedLimb(ctx, el, hand, 3.0 * s * elbowScale, 2.2 * s, sk, skinOutline);
    drawTaperedLimb(ctx, sh, el, 4.0 * s, 3.1 * s * elbowScale, sk, skinOutline);
    // Athletic sleeve cap
    drawTaperedLimb(
      ctx,
      sh,
      { x: lerp(sh.x, el.x, 0.35), y: lerp(sh.y, el.y, 0.35) },
      4.8 * s,
      4.0 * s,
      isFar ? sleeveFar : sleeveNear,
      'rgba(42, 49, 57, 0.25)'
    );
    drawHandMarker(ctx, hand, 4.1 * s, limbColor, anchored);
  };

  // Depth layering: back-flagging leg draws behind the standing leg; otherwise use hipTurn
  const rightIsNear = pose.hipTurn >= 0;
  const lfIsFlag = freeLimbs?.lf?.mode === 'flag';
  const rfIsFlag = freeLimbs?.rf?.mode === 'flag';
  const farLeg: 'left' | 'right' =
    lfIsFlag && !rfIsFlag ? 'left' : rfIsFlag && !lfIsFlag ? 'right' : rightIsNear ? 'left' : 'right';
  const nearLeg: 'left' | 'right' = farLeg === 'left' ? 'right' : 'left';

  // 1. Far leg & far arm behind torso
  drawLeg(farLeg, true);
  drawArm(rightIsNear ? 'left' : 'right', true);

  // 2. Near leg
  drawLeg(nearLeg, false);

  // 3. Organic athletic torso with waist taper & hip shorts
  ctx.save();
  const waistL = lerpVec(shL, hipL, 0.62);
  const waistR = lerpVec(shR, hipR, 0.62);
  const waistMid = lerpVec(waistL, waistR, 0.5);
  const inL = lerpVec(waistL, waistMid, 0.14);
  const inR = lerpVec(waistR, waistMid, 0.14);

  // Pelvis / climbing pants seat
  ctx.beginPath();
  ctx.moveTo(inL.x, inL.y);
  ctx.lineTo(inR.x, inR.y);
  ctx.quadraticCurveTo(hipR.x + 2 * s, hipR.y, hipR.x, hipR.y + 3 * s);
  ctx.lineTo(hipL.x, hipL.y + 3 * s);
  ctx.quadraticCurveTo(hipL.x - 2 * s, hipL.y, inL.x, inL.y);
  ctx.closePath();
  ctx.fillStyle = pantsNear;
  ctx.fill();

  // Tee shirt with subtle rounded shoulders & 3D turn shading
  const torsoGrad = ctx.createLinearGradient(shL.x, shL.y, shR.x, shR.y);
  if (pose.hipTurn >= 0) {
    torsoGrad.addColorStop(0, '#E1E4DD');
    torsoGrad.addColorStop(0.55, '#F4F5F0');
    torsoGrad.addColorStop(1, '#ECEDE7');
  } else {
    torsoGrad.addColorStop(0, '#ECEDE7');
    torsoGrad.addColorStop(0.45, '#F4F5F0');
    torsoGrad.addColorStop(1, '#E1E4DD');
  }

  ctx.beginPath();
  ctx.moveTo(shL.x, shL.y);
  ctx.quadraticCurveTo(chest.x, chest.y - 3.5 * s, shR.x, shR.y);
  ctx.quadraticCurveTo(inR.x + 1.5 * s, inR.y, hipR.x, hipR.y - 1.5 * s);
  ctx.quadraticCurveTo(pelvis.x, pelvis.y + 1.5 * s, hipL.x, hipL.y - 1.5 * s);
  ctx.quadraticCurveTo(inL.x - 1.5 * s, inL.y, shL.x, shL.y);
  ctx.closePath();
  ctx.fillStyle = torsoGrad;
  ctx.fill();
  ctx.strokeStyle = '#2A3139';
  ctx.lineWidth = Math.max(1.2, 1.5 * s);
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Subtle spine seam shifted with hipTurn
  const spineShift = -pose.hipTurn * 4.5 * s;
  ctx.beginPath();
  ctx.moveTo(chest.x + spineShift, chest.y);
  ctx.lineTo(pelvis.x + spineShift, pelvis.y);
  ctx.strokeStyle = 'rgba(42, 49, 57, 0.14)';
  ctx.lineWidth = Math.max(1.1, 1.6 * s);
  ctx.stroke();

  // Chalk bag clipped to lower back (shifts smoothly with hipTurn!)
  const bagX = pelvis.x + spineShift;
  const bagY = pelvis.y - 1.5 * s;
  ctx.beginPath();
  ctx.roundRect(bagX - 5.2 * s, bagY - 2.2 * s, 10.4 * s, 10.2 * s, 3 * s);
  ctx.fillStyle = '#D95D39';
  ctx.fill();
  ctx.strokeStyle = '#1E232A';
  ctx.lineWidth = 1.1;
  ctx.stroke();
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(bagX - 3.8 * s, bagY - 1.8 * s, 7.6 * s, 2.0 * s);
  ctx.restore();

  // 4. Neck & head
  drawTaperedLimb(ctx, chest, lerpVec(chest, head, 0.56), 3.0 * s, 2.5 * s, skinColor);

  const headR = anatomy.headRadius * s;
  ctx.save();
  ctx.beginPath();
  ctx.arc(head.x, head.y, headR, 0, Math.PI * 2);
  ctx.fillStyle = skinColor;
  ctx.fill();
  ctx.strokeStyle = '#252B33';
  ctx.lineWidth = 1.3;
  ctx.stroke();

  // Hair silhouette shifted slightly by look direction
  let gazeBiasX = pose.hipTurn * 2.2;
  if (lookTarget) {
    const lt = worldToScreen(lookTarget, tr);
    gazeBiasX = clamp((lt.x - head.x) / 60, -1, 1) * 2.5;
  }
  ctx.beginPath();
  ctx.arc(head.x - gazeBiasX * 0.35, head.y - 0.5 * s, headR * 1.03, Math.PI * 0.92, Math.PI * 2.08);
  ctx.fillStyle = '#252B33';
  ctx.fill();
  ctx.restore();

  // 5. Near arm in front
  drawArm(rightIsNear ? 'right' : 'left', false);
}

function drawHandMarker(ctx: CanvasRenderingContext2D, p: Vec2, r: number, color: string, anchored: boolean): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = anchored ? '#F7F8F5' : '#E7B996';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = anchored ? 2.4 : 1.6;
  ctx.stroke();
  ctx.restore();
}

function drawClimbingShoe(ctx: CanvasRenderingContext2D, foot: Vec2, knee: Vec2, r: number, color: string): void {
  const ang = Math.atan2(foot.y - knee.y, foot.x - knee.x);
  ctx.save();
  ctx.translate(foot.x, foot.y);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 1.15, r * 0.72, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#1E232A';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawFallingClimber(
  ctx: CanvasRenderingContext2D,
  tr: WallTransform,
  falling: { offsetX: number; offsetY: number; rotation: number; pose: SolvedPose },
  profile: ClimberProfile
): void {
  const comScreen = worldToScreen(
    { x: falling.pose.com.x + falling.offsetX, y: falling.pose.com.y + falling.offsetY },
    tr
  );
  const origCom = worldToScreen(falling.pose.com, tr);

  ctx.save();
  ctx.translate(comScreen.x, comScreen.y);
  ctx.rotate(falling.rotation);
  ctx.translate(-origCom.x, -origCom.y);
  drawClimber(
    ctx,
    tr,
    falling.pose,
    profile,
    { lh: null, rh: null, lf: null, rf: null },
    undefined,
    0,
    null,
    0
  );
  ctx.restore();
}

function drawSetterScaleGhost(ctx: CanvasRenderingContext2D, tr: WallTransform, profile: ClimberProfile): void {
  const anatomy = computeAnatomy(profile);
  const base = worldToScreen({ x: 34, y: 0 }, tr);
  const topH = worldToScreen({ x: 34, y: anatomy.heightCm }, tr);
  const reachY = worldToScreen({ x: 34, y: anatomy.heightCm * 1.24 + profile.apeIndexCm * 0.45 }, tr);

  ctx.save();
  ctx.globalAlpha = 0.42;
  ctx.strokeStyle = '#3B424A';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([3, 3]);
  // Standing height marker
  ctx.beginPath();
  ctx.moveTo(base.x - 10, topH.y);
  ctx.lineTo(base.x + 10, topH.y);
  ctx.moveTo(base.x, base.y);
  ctx.lineTo(base.x, reachY.y);
  ctx.moveTo(base.x - 7, reachY.y);
  ctx.lineTo(base.x + 7, reachY.y);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.font = '600 9px "JetBrains Mono", monospace';
  ctx.fillStyle = '#2D343C';
  ctx.textAlign = 'left';
  ctx.fillText(`身高 ${profile.heightCm}cm`, base.x + 12, topH.y + 3);
  ctx.fillText(`站立摸高`, base.x + 10, reachY.y + 3);
  ctx.restore();
}
