import { CLIMBER_PRESETS, computeAnatomy } from './climber';
import { ALL_LIMBS, getHoldHitRadius, HOLD_COLORS, HOLD_SPECS, LIMB_META, renumberHolds } from './holds';
import { clamp, dist } from './ik';
import { applyLimbTarget, dynoTarget, emptyFreeMap, holdTarget } from './contact';
import { buildHoldMap, evaluateBetaSequence, evaluateMove, getInitialAssignment, isTopReached } from './physics';
import {
  BetaStep,
  ClimberProfile,
  Hold,
  HoldType,
  LimbAssignment,
  LimbId,
  LimbTarget,
  RouteProblem,
  WALL_WIDTH_CM,
} from './types';

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

let uidCounter = 1;
export function nextUid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidCounter}`;
}

/**
 * Minimum center-to-center clearance (cm) so two holds (including shapes, tapes & badges) never overlap.
 */
function minHoldClearance(a: Hold, b: Hold): number {
  return getHoldHitRadius(a) * 1.18 + getHoldHitRadius(b) * 1.18 + 12;
}

function hasOverlap(candidate: Hold, existing: Hold[]): boolean {
  return existing.some((h) => dist(candidate, h) < minHoldClearance(candidate, h));
}

/**
 * Places a hold cleanly without overlapping any existing hold on the wall.
 * If the initial position collides, searches concentric rings nearby for the closest clear spot.
 */
function placeHoldWithoutOverlap(
  holds: Hold[],
  candidate: Hold,
  required = true,
  bounds: { minX?: number; maxX?: number; minY?: number; maxY?: number } = {}
): Hold | null {
  const minX = bounds.minX ?? 38;
  const maxX = bounds.maxX ?? WALL_WIDTH_CM - 38;
  const minY = bounds.minY ?? 32;
  const maxY = bounds.maxY ?? 418;

  const base: Hold = {
    ...candidate,
    x: Math.round(clamp(candidate.x, minX, maxX)),
    y: Math.round(clamp(candidate.y, minY, maxY)),
  };

  if (!hasOverlap(base, holds)) {
    holds.push(base);
    return base;
  }

  // Try concentric rings around desired spot to nudge hold into nearest clear space
  const radii = required ? [14, 24, 34, 46, 58] : [14, 24, 34];
  const angles = 12;
  for (const r of radii) {
    for (let k = 0; k < angles; k++) {
      const ang = (k / angles) * Math.PI * 2 + (r * 0.13);
      const nx = Math.round(clamp(base.x + Math.cos(ang) * r, minX, maxX));
      const ny = Math.round(clamp(base.y + Math.sin(ang) * r, minY, maxY));
      const trial: Hold = { ...base, x: nx, y: ny };
      if (!hasOverlap(trial, holds)) {
        holds.push(trial);
        return trial;
      }
    }
  }

  return null;
}

interface GradeBlueprint {
  numHands: number;
  minDy: number;
  maxDy: number;
  minDx: number;
  maxDx: number;
  maxAngle: number;
  handPool: HoldType[];
  startPool: HoldType[];
  topPool: HoldType[];
  twoStartsProb: number;
  footBonusProb: number; // chance of extra forgiving foothold
  volumeProb: number;
  scaleBase: number;
  cruxBoostDy: number; // extra crux span injected near upper-mid wall
}

const GRADE_BLUEPRINTS: Record<number, GradeBlueprint> = {
  0: {
    numHands: 6,
    minDy: 34,
    maxDy: 44,
    minDx: 14,
    maxDx: 34,
    maxAngle: 0,
    handPool: ['jug'],
    startPool: ['jug'],
    topPool: ['jug'],
    twoStartsProb: 1.0,
    footBonusProb: 0.9,
    volumeProb: 0,
    scaleBase: 1.22,
    cruxBoostDy: 0,
  },
  1: {
    numHands: 6,
    minDy: 38,
    maxDy: 49,
    minDx: 22,
    maxDx: 44,
    maxAngle: 12,
    handPool: ['jug', 'jug', 'jug', 'pinch'],
    startPool: ['jug'],
    topPool: ['jug'],
    twoStartsProb: 0.95,
    footBonusProb: 0.78,
    volumeProb: 0.15,
    scaleBase: 1.15,
    cruxBoostDy: 0,
  },
  2: {
    numHands: 5,
    minDy: 44,
    maxDy: 56,
    minDx: 30,
    maxDx: 56,
    maxAngle: 26,
    handPool: ['jug', 'pinch', 'pinch', 'jug'],
    startPool: ['jug', 'pinch'],
    topPool: ['jug'],
    twoStartsProb: 0.85,
    footBonusProb: 0.65,
    volumeProb: 0.3,
    scaleBase: 1.08,
    cruxBoostDy: 4,
  },
  3: {
    numHands: 5,
    minDy: 48,
    maxDy: 63,
    minDx: 38,
    maxDx: 70,
    maxAngle: 44,
    handPool: ['pinch', 'crimp', 'jug', 'pinch', 'sloper'],
    startPool: ['jug', 'pinch'],
    topPool: ['jug', 'pinch'],
    twoStartsProb: 0.75,
    footBonusProb: 0.45,
    volumeProb: 0.4,
    scaleBase: 1.02,
    cruxBoostDy: 10,
  },
  4: {
    numHands: 5,
    minDy: 52,
    maxDy: 68,
    minDx: 44,
    maxDx: 82,
    maxAngle: 56,
    handPool: ['crimp', 'pinch', 'sloper', 'crimp'],
    startPool: ['pinch', 'jug'],
    topPool: ['jug', 'pinch'],
    twoStartsProb: 0.55,
    footBonusProb: 0.25,
    volumeProb: 0.38,
    scaleBase: 0.96,
    cruxBoostDy: 15,
  },
  5: {
    numHands: 4,
    minDy: 58,
    maxDy: 76,
    minDx: 50,
    maxDx: 94,
    maxAngle: 64,
    handPool: ['crimp', 'sloper', 'crimp', 'pinch'],
    startPool: ['pinch', 'crimp'],
    topPool: ['pinch', 'jug'],
    twoStartsProb: 0.45,
    footBonusProb: 0.14,
    volumeProb: 0.3,
    scaleBase: 0.92,
    cruxBoostDy: 20,
  },
  6: {
    numHands: 4,
    minDy: 62,
    maxDy: 82,
    minDx: 56,
    maxDx: 104,
    maxAngle: 72,
    handPool: ['crimp', 'sloper', 'sloper', 'crimp'],
    startPool: ['crimp', 'sloper', 'pinch'],
    topPool: ['pinch', 'sloper', 'jug'],
    twoStartsProb: 0.35,
    footBonusProb: 0.08,
    volumeProb: 0.25,
    scaleBase: 0.88,
    cruxBoostDy: 24,
  },
  7: {
    numHands: 4,
    minDy: 66,
    maxDy: 88,
    minDx: 62,
    maxDx: 112,
    maxAngle: 80,
    handPool: ['crimp', 'sloper', 'crimp'],
    startPool: ['crimp', 'sloper'],
    topPool: ['sloper', 'pinch', 'crimp'],
    twoStartsProb: 0.25,
    footBonusProb: 0.04,
    volumeProb: 0.2,
    scaleBase: 0.84,
    cruxBoostDy: 28,
  },
};

export interface MeasuredDifficulty {
  estimatedGrade: number; // 0..7 continuous
  staminaSpent: number;
  hardMoves: number;
  dynoMoves: number;
  minGrip: number;
  maxReach: number;
  stepCount: number;
}

/**
 * Measures the real physical difficulty of a solved route against the standard 172cm climber.
 */
export function measureRouteDifficulty(
  holds: Hold[],
  steps: BetaStep[],
  profile: ClimberProfile = CLIMBER_PRESETS[1]
): MeasuredDifficulty {
  const init = getInitialAssignment(holds, profile);
  const seq = evaluateBetaSequence(init, steps, holds, profile);
  const staminaSpent = Math.round(100 - seq.finalStamina);

  let hardMoves = 0;
  let dynoMoves = 0;
  let minGrip = 100;
  let maxReach = 0;
  let maxBarnDoor = 0;

  for (const tr of seq.traces) {
    const ev = tr.evaluation;
    if (ev.rating === 'hard') hardMoves += 1;
    if (ev.isDyno || tr.step.target.kind === 'dyno') dynoMoves += 1;
    if (LIMB_META[tr.step.limb].isHand) {
      minGrip = Math.min(minGrip, ev.gripScore);
      maxReach = Math.max(maxReach, ev.reachRatio);
    }
    maxBarnDoor = Math.max(maxBarnDoor, ev.barnDoorRisk);
  }

  // Weighted physical grade score (calibrated so V0~0.4, V3~3.0, V6~6.0, V7~7.0)
  const staminaTerm = clamp((staminaSpent - 24) / 11.5, 0, 5.2);
  const hardTerm = Math.min(2.6, hardMoves * 0.65);
  const dynoTerm = Math.min(2.0, dynoMoves * 1.15);
  const gripTerm = clamp((88 - minGrip) / 18, 0, 2.2);
  const reachTerm = clamp((maxReach - 0.78) * 5.2, 0, 1.8);
  const balanceTerm = clamp((maxBarnDoor - 0.25) * 2.2, 0, 1.0);

  const rawGrade =
    staminaTerm * 0.52 +
    hardTerm * 0.55 +
    dynoTerm * 0.6 +
    gripTerm * 0.55 +
    reachTerm * 0.45 +
    balanceTerm * 0.35;

  return {
    estimatedGrade: clamp(Math.round(rawGrade * 10) / 10, 0, 7.5),
    staminaSpent,
    hardMoves,
    dynoMoves,
    minGrip,
    maxReach: Math.round(maxReach * 100) / 100,
    stepCount: steps.length,
  };
}

/**
 * Generates a realistic, physics-calibrated bouldering route for a target V-grade (0..7).
 * Uses objective 172cm reference grading and selects the candidate whose measured difficulty
 * matches the target V-grade most closely (while guaranteed solvable!).
 */
export function generateRoute(gradeNum: number, referenceProfile?: ClimberProfile): RouteProblem {
  const g = clamp(Math.round(gradeNum), 0, 7);
  const profile = referenceProfile ?? CLIMBER_PRESETS[1]; // Standard 172cm reference
  const bp = GRADE_BLUEPRINTS[g];
  const colorObj = pick(HOLD_COLORS.slice(0, 5));
  const color = colorObj.hex;

  const gradeNames: Record<number, string[]> = {
    0: ['新手阶梯', '大把手入门', '轻松直上'],
    1: ['平衡漫步', '初阶转角', '热身节奏'],
    2: ['对角节拍', '中段换手', '侧身过渡'],
    3: ['侧拉韵律', '折返线路', '重心考题'],
    4: ['指力试炼', '交错谜题', '动态衔接'],
    5: ['大跨距难点', '技术抠点', '边角突破'],
    6: ['圆弧危机', '精准压重心', '极限平衡'],
    7: ['冠军定线', '绝壁死点', '大师考题'],
  };

  let bestHolds: Hold[] = [];
  let bestMetrics: MeasuredDifficulty | null = null;
  let bestScoreError = Infinity;
  const anatomy = computeAnatomy(profile);

  // Sample up to 8 fast candidates and pick the solvable route closest to target V-grade!
  const maxAttempts = g >= 5 ? 8 : 6;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const holds: Hold[] = [];

    // Start zone
    const startX = rand(110, 290);
    const startY = g >= 5 ? rand(108, 126) : rand(120, 138);
    const twoStarts = Math.random() < bp.twoStartsProb;

    if (twoStarts) {
      const gap = rand(52, 74);
      placeHoldWithoutOverlap(
        holds,
        {
          id: nextUid('h'),
          label: 0,
          x: clamp(startX - gap / 2, 52, WALL_WIDTH_CM - 52),
          y: startY,
          type: pick(bp.startPool),
          role: 'start',
          angle: g <= 1 ? 0 : Math.round(rand(-bp.maxAngle * 0.45, 5)),
          scale: clamp(bp.scaleBase, 0.85, 1.24),
          color,
        },
        true,
        { minX: 48, maxX: WALL_WIDTH_CM - 48, minY: 104, maxY: 155 }
      );
      placeHoldWithoutOverlap(
        holds,
        {
          id: nextUid('h'),
          label: 0,
          x: clamp(startX + gap / 2, 52, WALL_WIDTH_CM - 52),
          y: startY + rand(-6, 10),
          type: pick(bp.startPool),
          role: 'start',
          angle: g <= 1 ? 0 : Math.round(rand(-5, bp.maxAngle * 0.45)),
          scale: clamp(bp.scaleBase, 0.85, 1.24),
          color,
        },
        true,
        { minX: 48, maxX: WALL_WIDTH_CM - 48, minY: 104, maxY: 155 }
      );
    } else {
      placeHoldWithoutOverlap(
        holds,
        {
          id: nextUid('h'),
          label: 0,
          x: startX,
          y: startY,
          type: pick(bp.startPool),
          role: 'start',
          angle: g <= 2 ? 0 : Math.round(rand(-15, 15)),
          scale: clamp(bp.scaleBase, 0.88, 1.18),
          color,
        },
        true,
        { minX: 52, maxX: WALL_WIDTH_CM - 52, minY: 106, maxY: 150 }
      );
    }

    // Starting footholds
    const startFootY = g >= 5 ? rand(30, 44) : rand(40, 58);
    placeHoldWithoutOverlap(
      holds,
      {
        id: nextUid('h'),
        label: 0,
        x: clamp(startX - rand(30, 52), 42, WALL_WIDTH_CM - 42),
        y: startFootY,
        type: 'foothold',
        role: 'normal',
        angle: 0,
        scale: clamp(bp.scaleBase * 0.96, 0.84, 1.18),
        color,
      },
      true,
      { minX: 38, maxX: WALL_WIDTH_CM - 38, minY: 28, maxY: 78 }
    );
    placeHoldWithoutOverlap(
      holds,
      {
        id: nextUid('h'),
        label: 0,
        x: clamp(startX + rand(30, 52), 42, WALL_WIDTH_CM - 42),
        y: startFootY + rand(2, 14),
        type: 'foothold',
        role: 'normal',
        angle: 0,
        scale: clamp(bp.scaleBase * 0.96, 0.84, 1.18),
        color,
      },
      true,
      { minX: 38, maxX: WALL_WIDTH_CM - 38, minY: 28, maxY: 82 }
    );

    // Build upward progression with grade-appropriate spacing, crux, and footholds
    let prevX = startX;
    let prevY = startY;
    let dir = startX > WALL_WIDTH_CM / 2 ? -1 : 1;
    const cruxIdx = Math.max(1, Math.floor(bp.numHands / 2));

    for (let i = 0; i < bp.numHands; i++) {
      const isCrux = i === cruxIdx && bp.cruxBoostDy > 0;
      const stepDy = rand(bp.minDy, bp.maxDy) + (isCrux ? bp.cruxBoostDy : 0);
      const targetY = clamp(prevY + stepDy, prevY + 34, 344);

      if (Math.random() < (g <= 1 ? 0.55 : 0.78)) dir *= -1;
      let targetX = prevX + dir * rand(bp.minDx, bp.maxDx);
      if (targetX < 56 || targetX > WALL_WIDTH_CM - 56) {
        dir *= -1;
        targetX = clamp(prevX + dir * rand(bp.minDx, bp.maxDx * 0.88), 56, WALL_WIDTH_CM - 56);
      }

      const type = pick(bp.handPool);
      let angle = 0;
      if (bp.maxAngle > 0) {
        if (type === 'sloper') {
          angle = Math.round(rand(-Math.min(34, bp.maxAngle * 0.55), Math.min(34, bp.maxAngle * 0.55)));
        } else {
          const bias = targetX > prevX ? 1 : -1;
          angle = Math.round(bias * rand(bp.maxAngle * 0.32, bp.maxAngle));
        }
      }

      const placedHand = placeHoldWithoutOverlap(
        holds,
        {
          id: nextUid('h'),
          label: 0,
          x: targetX,
          y: targetY,
          type,
          role: 'normal',
          angle,
          scale: clamp(bp.scaleBase + rand(-0.06, 0.06), 0.78, 1.24),
          color,
        },
        true,
        { minX: 48, maxX: WALL_WIDTH_CM - 48, minY: prevY + 26, maxY: 350 }
      );
      if (!placedHand) continue;

      // Primary foothold below this move (lower & slightly farther on higher grades!)
      const footDropMin = anatomy.heightCm * (g <= 2 ? 0.4 : 0.47);
      const footDropMax = anatomy.heightCm * (g <= 2 ? 0.52 : 0.62);
      const footY = clamp(placedHand.y - rand(footDropMin, footDropMax), 66, placedHand.y - 46);
      const footX = clamp((prevX + placedHand.x) / 2 + rand(-34, 34), 44, WALL_WIDTH_CM - 44);
      const useVolume = i === 1 && Math.random() < bp.volumeProb;

      const placedPrimaryFoot = placeHoldWithoutOverlap(
        holds,
        {
          id: nextUid('h'),
          label: 0,
          x: footX,
          y: footY,
          type: useVolume ? 'volume' : 'foothold',
          role: 'normal',
          angle: useVolume ? Math.round(rand(-14, 14)) : 0,
          scale: useVolume ? 1.0 : clamp(bp.scaleBase * 0.94, 0.82, 1.15),
          color: useVolume ? '#3D434C' : color,
        },
        false,
        { minX: 42, maxX: WALL_WIDTH_CM - 42, minY: 62, maxY: placedHand.y - 40 }
      );

      if (!placedPrimaryFoot && useVolume) {
        placeHoldWithoutOverlap(
          holds,
          {
            id: nextUid('h'),
            label: 0,
            x: footX,
            y: footY,
            type: 'foothold',
            role: 'normal',
            angle: 0,
            scale: 0.92,
            color,
          },
          false,
          { minX: 42, maxX: WALL_WIDTH_CM - 42, minY: 62, maxY: placedHand.y - 40 }
        );
      }

      // Bonus opposite foothold — abundant on V0–V2, rare on V5–V7!
      if (Math.random() < bp.footBonusProb) {
        const oppFootX = clamp(placedHand.x - dir * rand(28, 60), 44, WALL_WIDTH_CM - 44);
        const oppFootY = clamp(footY + rand(12, 36), 78, placedHand.y - 40);
        placeHoldWithoutOverlap(
          holds,
          {
            id: nextUid('h'),
            label: 0,
            x: oppFootX,
            y: oppFootY,
            type: 'foothold',
            role: 'normal',
            angle: 0,
            scale: clamp(bp.scaleBase * 0.92, 0.84, 1.12),
            color,
          },
          false,
          { minX: 42, maxX: WALL_WIDTH_CM - 42, minY: 72, maxY: placedHand.y - 36 }
        );
      }

      prevX = placedHand.x;
      prevY = placedHand.y;
      if (prevY >= 324) break;
    }

    // Top hold
    const topMaxDx = g <= 1 ? 30 : g <= 3 ? 52 : 68;
    const topX = clamp(prevX + rand(-topMaxDx, topMaxDx), 74, WALL_WIDTH_CM - 74);
    const topY = clamp(
      Math.max(prevY + rand(bp.minDy, bp.maxDy + 6), g <= 1 ? 364 : 378),
      362,
      414
    );
    const placedTop = placeHoldWithoutOverlap(
      holds,
      {
        id: nextUid('h'),
        label: 0,
        x: topX,
        y: topY,
        type: pick(bp.topPool),
        role: 'top',
        angle: g >= 6 ? Math.round(rand(-18, 18)) : 0,
        scale: clamp(bp.scaleBase + 0.08, 0.92, 1.26),
        color,
      },
      true,
      { minX: 60, maxX: WALL_WIDTH_CM - 60, minY: 358, maxY: 416 }
    );

    // High foothold for topping out
    const refTopX = placedTop?.x ?? topX;
    const refTopY = placedTop?.y ?? topY;
    const highFootX = clamp(refTopX + rand(-46, 46), 54, WALL_WIDTH_CM - 54);
    const highFootY = clamp(
      refTopY - rand(g <= 2 ? 98 : 114, g <= 2 ? 126 : 148),
      210,
      305
    );
    placeHoldWithoutOverlap(
      holds,
      {
        id: nextUid('h'),
        label: 0,
        x: highFootX,
        y: highFootY,
        type: 'foothold',
        role: 'normal',
        angle: 0,
        scale: clamp(bp.scaleBase * 0.94, 0.84, 1.12),
        color,
      },
      false,
      { minX: 44, maxX: WALL_WIDTH_CM - 44, minY: 205, maxY: refTopY - 78 }
    );

    const numbered = renumberHolds(holds);
    if (bestHolds.length === 0) bestHolds = numbered;

    // Verify solvability AND measure actual physical difficulty (fast beamWidth=12 for mobile speed!)
    const sol = suggestBeta(numbered, profile, 18, 12);
    if (!sol.solved) continue;

    const metrics = measureRouteDifficulty(numbered, sol.steps, profile);
    // Reject easy routes masquerading as V5+ or brutal routes masquerading as V0–V1
    let err = Math.abs(metrics.estimatedGrade - g);
    if (g <= 1 && (metrics.dynoMoves > 0 || metrics.hardMoves > g)) err += 2.5;
    if (g >= 5 && metrics.hardMoves + metrics.dynoMoves === 0) err += 2.5;
    if (g >= 6 && metrics.staminaSpent < 45) err += 2.0;

    if (err < bestScoreError) {
      bestScoreError = err;
      bestHolds = numbered;
      bestMetrics = metrics;
      // Early exit as soon as we hit a great calibrated match!
      if (err <= 0.85) break;
    }
  }

  const baseDesc: Record<number, string> = {
    0: '纯大把手与密脚点入门线，跨距轻松无难点。',
    1: '基础大把手节奏线，练习顺畅换脚与重心转移。',
    2: '把手与捏点交替的轻斜线，考验基础脚法。',
    3: '引入侧拉点与折返路线，注意对侧脚防开门。',
    4: '抠点/圆弧与中大跨距难点，需合理分配体能。',
    5: '稀疏脚点与技术方向点，身型与高脚策略差异显著。',
    6: '高难圆弧与小抠点组合，重心压墙与角度容错极低。',
    7: '极限定线：稀疏小点 + 大跨距难点，极度考验指力或动态飞跃！',
  };

  const telemetryNote = bestMetrics
    ? `（参考：${bestMetrics.stepCount}步 · 耗能${bestMetrics.staminaSpent}% · 难点${bestMetrics.hardMoves}步${
        bestMetrics.dynoMoves > 0 ? ` · 飞跃${bestMetrics.dynoMoves}次` : ''
      }）`
    : '';

  return {
    id: nextUid('route'),
    name: `${pick(gradeNames[g])}`,
    grade: `V${g}`,
    description: `${baseDesc[g]}${telemetryNote}`,
    holdColor: color,
    holds: bestHolds,
  };
}

interface SearchNode {
  assignment: LimbAssignment;
  steps: BetaStep[];
  stamina: number;
  score: number;
  lastLimb: LimbId | null;
}

/**
 * Beam-search Beta solver that computes a valid, human-like Beta sequence
 * specifically tailored to the current climber's height, ape index, grip, and flexibility!
 */
export function suggestBeta(
  holds: Hold[],
  profile: ClimberProfile,
  maxDepth = 20,
  beamWidth = 24
): { solved: boolean; steps: BetaStep[]; bestProgressY: number } {
  const topHolds = holds.filter((h) => h.role === 'top');
  if (topHolds.length === 0 || holds.length < 2) {
    return { solved: false, steps: [], bestProgressY: 0 };
  }

  const holdMap = buildHoldMap(holds);
  const topTarget = topHolds[0];
  const initial = getInitialAssignment(holds, profile);

  if (isTopReached(initial, holds)) {
    return { solved: true, steps: [], bestProgressY: topTarget.y };
  }

  const stateKey = (a: LimbAssignment): string =>
    `${a.lh ?? '_'}|${a.rh ?? '_'}|${a.lf ?? '_'}|${a.rf ?? '_'}`;

  const scoreState = (a: LimbAssignment, stamina: number, stepCount: number): number => {
    const lh = a.lh ? holdMap.get(a.lh) : undefined;
    const rh = a.rh ? holdMap.get(a.rh) : undefined;
    const lf = a.lf ? holdMap.get(a.lf) : undefined;
    const rf = a.rf ? holdMap.get(a.rf) : undefined;

    const lhDist = lh ? dist(lh, topTarget) : 450;
    const rhDist = rh ? dist(rh, topTarget) : 450;
    const avgHandDist = (lhDist + rhDist) / 2;

    const handMaxY = Math.max(lh?.y ?? 0, rh?.y ?? 0);
    const footAvgY = ((lf?.y ?? 0) + (rf?.y ?? 0)) / 2;

    const topBonus =
      (a.lh && topHolds.some((t) => t.id === a.lh) ? 90 : 0) +
      (a.rh && topHolds.some((t) => t.id === a.rh) ? 90 : 0);

    // Prefer moving hands closer to Top, bringing feet up beneath hands, conserving stamina, fewer wasted steps
    const footFollowBonus = clamp(footAvgY - (handMaxY - 170), -90, 45) * 0.45;
    return -avgHandDist * 1.15 + topBonus + footFollowBonus + stamina * 0.85 - stepCount * 4.5;
  };

  let beam: SearchNode[] = [
    {
      assignment: initial,
      steps: [],
      stamina: 100,
      score: scoreState(initial, 100, 0),
      lastLimb: null,
    },
  ];

  const visited = new Map<string, number>();
  visited.set(stateKey(initial), 100);

  let bestNode = beam[0];

  for (let depth = 0; depth < maxDepth; depth++) {
    const nextBeam: SearchNode[] = [];

    for (const node of beam) {
      const lhHold = node.assignment.lh ? holdMap.get(node.assignment.lh) : undefined;
      const rhHold = node.assignment.rh ? holdMap.get(node.assignment.rh) : undefined;
      const maxHandY = Math.max(lhHold?.y ?? 120, rhHold?.y ?? 120);

      for (const limb of ALL_LIMBS) {
        const isHand = LIMB_META[limb].isHand;
        const currentHoldId = node.assignment[limb];
        const currentHold = currentHoldId ? holdMap.get(currentHoldId) : undefined;

        // Filter plausible target holds to keep search blazingly fast (<15ms)
        const candidates = holds.filter((h) => {
          if (h.id === currentHoldId) return false;
          if (isHand) {
            if (h.type === 'foothold') return false;
            // Hands generally progress upward or toward top
            if (currentHold && h.y < currentHold.y - 35) return false;
            // Don't move a hand already on Top away from Top
            if (currentHold?.role === 'top') return false;
          } else {
            // Feet shouldn't go way above hands or drop significantly backward
            if (h.y > maxHandY - 12) return false;
            if (currentHold && h.y < currentHold.y - 25) return false;
            // Avoid both feet crowding the same tiny foothold unless necessary
            const otherFootId = limb === 'lf' ? node.assignment.rf : node.assignment.lf;
            if (otherFootId === h.id && HOLD_SPECS[h.type].baseRadiusCm < 12) return false;
            // Strictly prevent left foot stepping past right foot (no leg pass-through)
            const otherFootHold = otherFootId ? holdMap.get(otherFootId) : undefined;
            if (otherFootHold) {
              if (limb === 'lf' && h.x > otherFootHold.x + 4) return false;
              if (limb === 'rf' && h.x < otherFootHold.x - 4) return false;
            }
          }
          return true;
        });

        for (const target of candidates) {
          const freeMap = emptyFreeMap();
          const candidatesTargets: LimbTarget[] = [holdTarget(target.id)];
          // For hands on catchable holds above current stance, also allow explicit Single/Double Dyno!
          if (isHand && target.y > maxHandY + 12) {
            candidatesTargets.push(dynoTarget(target.id, false));
            if (limb === 'rh') {
              // Only evaluate Double Dyno once per hold per node
              candidatesTargets.push(dynoTarget(target.id, true));
            }
          }

          for (const limbTarget of candidatesTargets) {
            const ev = evaluateMove(node.assignment, freeMap, limb, limbTarget, holds, profile);
            if (!ev.feasible) continue;

            // Skip explicit dyno if static hold already worked cleanly for the same hold
            if (limbTarget.kind === 'dyno' && !limbTarget.bothHands) {
              const staticEv = evaluateMove(node.assignment, freeMap, limb, holdTarget(target.id), holds, profile);
              if (staticEv.feasible) continue;
            }

            const newStamina = node.stamina - ev.staminaCost;
            if (newStamina <= 2) continue;

            const applied = applyLimbTarget(
              node.assignment,
              freeMap,
              limb,
              limbTarget,
              Boolean(ev.cutsFeet)
            );
            const nextAssignment = applied.assignment;
            const key = stateKey(nextAssignment);
            const prevBestStam = visited.get(key);
            if (prevBestStam !== undefined && prevBestStam >= newStamina - 1) continue;
            visited.set(key, newStamina);

            const step: BetaStep = {
              id: nextUid('step'),
              limb,
              target: limbTarget,
            };
            const steps = [...node.steps, step];

            if (isTopReached(nextAssignment, holds)) {
              return { solved: true, steps, bestProgressY: topTarget.y };
            }

            const altBonus = node.lastLimb !== limb ? 4 : 0;
            const ratingPenalty =
              limbTarget.kind === 'dyno' ? -12 : ev.rating === 'dyno' ? -8 : ev.rating === 'hard' ? -3 : 0;
            const sc = scoreState(nextAssignment, newStamina, steps.length) + altBonus + ratingPenalty;

            const child: SearchNode = {
              assignment: nextAssignment,
              steps,
              stamina: newStamina,
              score: sc,
              lastLimb: limb,
            };

            if (sc > bestNode.score) bestNode = child;
            nextBeam.push(child);
          }
        }
      }
    }

    if (nextBeam.length === 0) break;
    nextBeam.sort((a, b) => b.score - a.score);
    beam = nextBeam.slice(0, beamWidth);
  }

  const bestLh = bestNode.assignment.lh ? holdMap.get(bestNode.assignment.lh) : undefined;
  const bestRh = bestNode.assignment.rh ? holdMap.get(bestNode.assignment.rh) : undefined;
  return {
    solved: false,
    steps: bestNode.steps,
    bestProgressY: Math.max(bestLh?.y ?? 0, bestRh?.y ?? 0),
  };
}
