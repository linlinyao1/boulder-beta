import {
  CLIMBER_PRESETS,
  computeAnatomy,
  getReferenceClimberForGrade,
} from './climber';
import { applyLimbTarget, dynoTarget, emptyFreeMap, holdTarget } from './contact';
import {
  ALL_LIMBS,
  getHoldHitRadius,
  getWallAngleLabel,
  HOLD_COLORS,
  HOLD_FAMILY_LABELS,
  HOLD_SPECS,
  LIMB_META,
  renumberHolds,
} from './holds';
import { clamp, dist } from './ik';
import {
  buildHoldMap,
  evaluateBetaSequence,
  evaluateMove,
  getInitialAssignment,
  isTopReached,
} from './physics';
import {
  BetaStep,
  ClimberProfile,
  Hold,
  HoldStyleFamily,
  HoldType,
  LimbAssignment,
  LimbId,
  LimbTarget,
  RouteProblem,
  RouteStyle,
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

export const STYLE_LABELS: Record<RouteStyle, string> = {
  balanced: '综合均衡',
  power: '仰角力量',
  tech: '技术平衡',
  dyno: '动态协调',
};

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

  const radii = required ? [14, 24, 34, 46, 58] : [14, 24, 34];
  const angles = 12;
  for (const r of radii) {
    for (let k = 0; k < angles; k++) {
      const ang = (k / angles) * Math.PI * 2 + r * 0.13;
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
  wallAngles: number[];
  styles: RouteStyle[];
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
  footBonusProb: number;
  volumeProb: number;
  scaleBase: number;
  cruxBoostDy: number;
  cruxCount: number;
}

/**
 * Real-world Hueco V1–V11 routesetting blueprints aligned with:
 * - CWA commercial & competition setting standards
 * - Kilter / MoonBoard / Tension wall angle progressions
 * - Lattice Training finger-strength tiers (V1–V7 Standard 92, V8–V9 Adv 132, V10–V11 Pro 154)
 */
const GRADE_BLUEPRINTS: Record<number, GradeBlueprint> = {
  1: {
    wallAngles: [0, 5],
    styles: ['balanced'],
    numHands: 6,
    minDy: 36,
    maxDy: 46,
    minDx: 18,
    maxDx: 38,
    maxAngle: 10,
    handPool: ['jug', 'jug', 'jug', 'pinch'],
    startPool: ['jug'],
    topPool: ['jug'],
    twoStartsProb: 1.0,
    footBonusProb: 0.85,
    volumeProb: 0.12,
    scaleBase: 1.18,
    cruxBoostDy: 0,
    cruxCount: 0,
  },
  2: {
    wallAngles: [0, 5, 10],
    styles: ['balanced', 'tech'],
    numHands: 5,
    minDy: 42,
    maxDy: 54,
    minDx: 26,
    maxDx: 52,
    maxAngle: 24,
    handPool: ['jug', 'pinch', 'pinch', 'jug'],
    startPool: ['jug', 'pinch'],
    topPool: ['jug'],
    twoStartsProb: 0.88,
    footBonusProb: 0.65,
    volumeProb: 0.25,
    scaleBase: 1.1,
    cruxBoostDy: 5,
    cruxCount: 1,
  },
  3: {
    wallAngles: [5, 10, 15],
    styles: ['balanced', 'tech', 'power'],
    numHands: 5,
    minDy: 46,
    maxDy: 60,
    minDx: 34,
    maxDx: 68,
    maxAngle: 42,
    handPool: ['pinch', 'crimp', 'jug', 'pinch', 'sloper'],
    startPool: ['jug', 'pinch'],
    topPool: ['jug', 'pinch'],
    twoStartsProb: 0.76,
    footBonusProb: 0.45,
    volumeProb: 0.35,
    scaleBase: 1.02,
    cruxBoostDy: 9,
    cruxCount: 1,
  },
  4: {
    wallAngles: [15, 20],
    styles: ['balanced', 'power', 'tech', 'dyno'],
    numHands: 5,
    minDy: 50,
    maxDy: 64,
    minDx: 40,
    maxDx: 78,
    maxAngle: 56,
    handPool: ['crimp', 'pinch', 'sloper', 'pocket', 'crimp'],
    startPool: ['pinch', 'crimp'],
    topPool: ['pinch', 'crimp', 'sloper'],
    twoStartsProb: 0.58,
    footBonusProb: 0.24,
    volumeProb: 0.32,
    scaleBase: 0.96,
    cruxBoostDy: 14,
    cruxCount: 1,
  },
  5: {
    wallAngles: [20, 25],
    styles: ['power', 'tech', 'dyno'],
    numHands: 5,
    minDy: 52,
    maxDy: 68,
    minDx: 44,
    maxDx: 84,
    maxAngle: 64,
    handPool: ['crimp', 'sloper', 'pocket', 'crimp', 'sloper'],
    startPool: ['crimp', 'sloper', 'pinch'],
    topPool: ['crimp', 'sloper', 'pinch'],
    twoStartsProb: 0.48,
    footBonusProb: 0.16,
    volumeProb: 0.26,
    scaleBase: 0.92,
    cruxBoostDy: 16,
    cruxCount: 2,
  },
  6: {
    wallAngles: [25, 30],
    styles: ['power', 'tech', 'dyno'],
    numHands: 4,
    minDy: 56,
    maxDy: 74,
    minDx: 48,
    maxDx: 90,
    maxAngle: 68,
    handPool: ['crimp', 'sloper', 'pocket', 'crimp', 'sloper'],
    startPool: ['crimp', 'sloper'],
    topPool: ['crimp', 'sloper', 'pinch'],
    twoStartsProb: 0.42,
    footBonusProb: 0.12,
    volumeProb: 0.22,
    scaleBase: 0.89,
    cruxBoostDy: 19,
    cruxCount: 2,
  },
  7: {
    wallAngles: [30, 35],
    styles: ['power', 'tech', 'dyno'],
    numHands: 4,
    minDy: 58,
    maxDy: 76,
    minDx: 50,
    maxDx: 96,
    maxAngle: 72,
    handPool: ['crimp', 'sloper', 'pocket', 'crimp', 'microcrimp'],
    startPool: ['crimp', 'sloper', 'pinch'],
    topPool: ['sloper', 'crimp', 'pinch'],
    twoStartsProb: 0.36,
    footBonusProb: 0.1,
    volumeProb: 0.18,
    scaleBase: 0.88,
    cruxBoostDy: 20,
    cruxCount: 2,
  },
  // V8–V9: Advanced tier (verified with V9 Climber, grip 132)
  8: {
    wallAngles: [35, 40],
    styles: ['power', 'dyno', 'tech'],
    numHands: 4,
    minDy: 58,
    maxDy: 78,
    minDx: 52,
    maxDx: 100,
    maxAngle: 70,
    handPool: ['crimp', 'microcrimp', 'pocket', 'sloper', 'crimp'],
    startPool: ['crimp', 'pinch'],
    topPool: ['crimp', 'pinch', 'sloper'],
    twoStartsProb: 0.35,
    footBonusProb: 0.12,
    volumeProb: 0.18,
    scaleBase: 0.89,
    cruxBoostDy: 20,
    cruxCount: 2,
  },
  9: {
    wallAngles: [40, 45],
    styles: ['power', 'dyno'],
    numHands: 4,
    minDy: 60,
    maxDy: 82,
    minDx: 54,
    maxDx: 104,
    maxAngle: 74,
    handPool: ['microcrimp', 'crimp', 'sloper', 'microcrimp'],
    startPool: ['crimp', 'microcrimp'],
    topPool: ['crimp', 'sloper', 'pinch'],
    twoStartsProb: 0.3,
    footBonusProb: 0.08,
    volumeProb: 0.15,
    scaleBase: 0.86,
    cruxBoostDy: 22,
    cruxCount: 2,
  },
  // V10–V11: Expert / Pro World-Cup tier (verified with V11 Climber, grip 154)
  10: {
    wallAngles: [45, 50],
    styles: ['power', 'dyno'],
    numHands: 4,
    minDy: 60,
    maxDy: 82,
    minDx: 56,
    maxDx: 106,
    maxAngle: 78,
    handPool: ['microcrimp', 'sloper', 'microcrimp', 'crimp'],
    startPool: ['microcrimp', 'crimp'],
    topPool: ['sloper', 'crimp', 'microcrimp'],
    twoStartsProb: 0.25,
    footBonusProb: 0.06,
    volumeProb: 0.12,
    scaleBase: 0.84,
    cruxBoostDy: 24,
    cruxCount: 2,
  },
  11: {
    wallAngles: [50, 55],
    styles: ['power', 'dyno'],
    numHands: 4,
    minDy: 62,
    maxDy: 85,
    minDx: 58,
    maxDx: 110,
    maxAngle: 82,
    handPool: ['microcrimp', 'microcrimp', 'sloper'],
    startPool: ['microcrimp', 'sloper'],
    topPool: ['microcrimp', 'sloper', 'crimp'],
    twoStartsProb: 0.22,
    footBonusProb: 0.04,
    volumeProb: 0.1,
    scaleBase: 0.81,
    cruxBoostDy: 25,
    cruxCount: 3,
  },
};

export interface MeasuredDifficulty {
  estimatedGrade: number; // 1.0..11.5 continuous
  staminaSpent: number;
  hardMoves: number;
  dynoMoves: number;
  minGrip: number;
  maxReach: number;
  cruxStrain: number;
  stepCount: number;
}

/**
 * Measures real physical difficulty of a solved route at a specific wall tilt angle.
 * Follows real Hueco V-scale principles:
 * 1) Crux-dominant (hardest move + top-2 crux average)
 * 2) Wall overhang & slab multipliers
 * 3) Hold positivity / microcrimp density
 * 4) Required climber strength tier (gripStrength > 92 elevates grade into V8–V11)
 */
export function measureRouteDifficulty(
  holds: Hold[],
  steps: BetaStep[],
  profile: ClimberProfile = CLIMBER_PRESETS[1],
  wallAngleDeg = 0
): MeasuredDifficulty {
  const init = getInitialAssignment(holds, profile);
  const seq = evaluateBetaSequence(init, steps, holds, profile, emptyFreeMap(), wallAngleDeg);
  const staminaSpent = Math.round(100 - seq.finalStamina);

  let hardMoves = 0;
  let dynoMoves = 0;
  let minGrip = 100;
  let maxReach = 0;
  let maxBarnDoor = 0;
  const handStrains: number[] = [];

  for (const tr of seq.traces) {
    const ev = tr.evaluation;
    if (ev.rating === 'hard') hardMoves += 1;
    if (ev.isDyno || tr.step.target.kind === 'dyno') dynoMoves += 1;
    if (LIMB_META[tr.step.limb].isHand) {
      minGrip = Math.min(minGrip, ev.gripScore);
      maxReach = Math.max(maxReach, ev.reachRatio);
      handStrains.push(ev.staminaCost);
    }
    maxBarnDoor = Math.max(maxBarnDoor, ev.barnDoorRisk);
  }

  handStrains.sort((a, b) => b - a);
  const cruxStrain = handStrains[0] ?? 8;
  const top2Crux =
    handStrains.length >= 2 ? (handStrains[0] + handStrains[1]) / 2 : cruxStrain;

  // Intrinsic hold quality (includes hold scale, microcrimp & dual-tex technical precision!)
  const handHolds = holds.filter((h) => h.type !== 'foothold');
  const microCount = handHolds.filter((h) => h.type === 'microcrimp').length;
  const dualTexCount = handHolds.filter((h) => h.dualTex).length;
  const avgHoldHandGrip =
    handHolds.length > 0
      ? handHolds.reduce(
          (s, h) => s + HOLD_SPECS[h.type].handGrip * clamp(0.65 + (h.scale ?? 1) * 0.35, 0.78, 1.14),
          0
        ) / handHolds.length
      : 0.85;

  // Component scores calibrated cleanly to real Hueco V1–V11 progression (zero V1 inflation!):
  const angleTerm =
    wallAngleDeg >= 0
      ? clamp((wallAngleDeg / 55) * 4.4, 0, 4.4)
      : clamp((Math.abs(wallAngleDeg) / 10) * 1.4, 0, 1.4);
  const holdTerm =
    clamp((0.96 - avgHoldHandGrip) * 5.6, 0, 3.0) +
    Math.min(1.2, microCount * 0.36) +
    Math.min(0.6, dualTexCount * 0.16);
  const cruxTerm = clamp((top2Crux - 10) / 5.5, 0, 1.9);
  const staminaTerm = clamp((staminaSpent - 40) / 34, 0, 1.7);
  const hardDynoTerm = Math.min(1.5, hardMoves * 0.18 + dynoMoves * 0.42);
  const reachTerm = clamp((maxReach - 0.92) * 2.8, 0, 0.7);
  const balanceTerm = clamp((maxBarnDoor - 0.38) * 1.5, 0, 0.5);
  // Strength tier compensation: if measured with a stronger climber (grip > 92), their extra strength masked difficulty
  const strengthBonus = clamp((profile.gripStrength - 92) / 26, 0, 2.5);

  const rawGrade =
    0.9 +
    angleTerm * 0.88 +
    holdTerm * 0.74 +
    cruxTerm * 0.42 +
    staminaTerm * 0.42 +
    hardDynoTerm * 0.38 +
    reachTerm * 0.25 +
    balanceTerm * 0.25 +
    strengthBonus * 0.82;

  return {
    estimatedGrade: clamp(Math.round(rawGrade * 10) / 10, 1.0, 11.5),
    staminaSpent,
    hardMoves,
    dynoMoves,
    minGrip,
    maxReach: Math.round(maxReach * 100) / 100,
    cruxStrain: Math.round(cruxStrain * 10) / 10,
    stepCount: steps.length,
  };
}

export interface LiveGradeEstimate {
  gradeLabel: string; // 'V1'..'V11' or 'V11+'
  numericGrade: number;
  requiredTier: 'standard' | 'advanced' | 'pro' | 'extreme';
  recommendedGrip: number;
}

/**
 * Kilter-Board style live grader: evaluates a route at any wall tilt angle across
 * Standard (92) -> V9 Advanced (132) -> V11 Pro (154) tiers to output its real dynamic V-grade!
 */
export function estimateRouteGrade(
  holds: Hold[],
  wallAngleDeg: number
): LiveGradeEstimate {
  const hasStart = holds.some((h) => h.role === 'start');
  const hasTop = holds.some((h) => h.role === 'top');
  if (!hasStart || !hasTop || holds.length < 3) {
    return { gradeLabel: 'Custom', numericGrade: 1, requiredTier: 'standard', recommendedGrip: 92 };
  }

  const standard = CLIMBER_PRESETS[1];
  const powerV7 = CLIMBER_PRESETS[3];
  const advV9 = CLIMBER_PRESETS[5];
  const proV11 = CLIMBER_PRESETS[6];

  const solStd = suggestBeta(holds, standard, 18, 12, wallAngleDeg);
  if (solStd.solved) {
    const m = measureRouteDifficulty(holds, solStd.steps, standard, wallAngleDeg);
    const g = clamp(Math.round(m.estimatedGrade), 1, 6);
    return {
      gradeLabel: `V${g}`,
      numericGrade: g,
      requiredTier: 'standard',
      recommendedGrip: g >= 6 ? 100 : 92,
    };
  }

  const solPow = suggestBeta(holds, powerV7, 18, 12, wallAngleDeg);
  if (solPow.solved) {
    const m = measureRouteDifficulty(holds, solPow.steps, powerV7, wallAngleDeg);
    const g = clamp(Math.round(Math.max(6.8, m.estimatedGrade)), 7, 8);
    return {
      gradeLabel: `V${g}`,
      numericGrade: g,
      requiredTier: 'standard',
      recommendedGrip: 114,
    };
  }

  const solAdv = suggestBeta(holds, advV9, 18, 12, wallAngleDeg);
  if (solAdv.solved) {
    const m = measureRouteDifficulty(holds, solAdv.steps, advV9, wallAngleDeg);
    const g = clamp(Math.round(Math.max(7.8, m.estimatedGrade)), 8, 9);
    return {
      gradeLabel: `V${g}`,
      numericGrade: g,
      requiredTier: 'advanced',
      recommendedGrip: 132,
    };
  }

  const solPro = suggestBeta(holds, proV11, 18, 12, wallAngleDeg);
  if (solPro.solved) {
    const m = measureRouteDifficulty(holds, solPro.steps, proV11, wallAngleDeg);
    const g = clamp(Math.round(Math.max(9.6, m.estimatedGrade)), 10, 11);
    return {
      gradeLabel: `V${g}`,
      numericGrade: g,
      requiredTier: 'pro',
      recommendedGrip: 154,
    };
  }

  return {
    gradeLabel: 'V11+',
    numericGrade: 12,
    requiredTier: 'extreme',
    recommendedGrip: 160,
  };
}

/**
 * Generates a realistic, physics-calibrated bouldering route for any target V-grade (V1..V11).
 * Incorporates real wall angles, RIC styles, non-overlapping hold placement, and multi-tier verification.
 */
export function generateRoute(
  gradeNum: number,
  referenceProfile?: ClimberProfile,
  forcedStyle?: RouteStyle
): RouteProblem {
  const g = clamp(Math.round(gradeNum), 1, 11);
  const profile = referenceProfile ?? getReferenceClimberForGrade(g);
  const bp = GRADE_BLUEPRINTS[g];
  const style: RouteStyle = forcedStyle ?? pick(bp.styles);
  const holdFamily: HoldStyleFamily =
    style === 'tech' || style === 'dyno'
      ? pick(['comp', 'comp', 'geometric'])
      : style === 'power'
        ? pick(['geometric', 'organic', 'comp'])
        : pick(['organic', 'comp', 'geometric']);
  const colorObj = pick(HOLD_COLORS.slice(0, 5));
  const color = colorObj.hex;

  const pickVariantForFamily = (type: HoldType): number => {
    if (type === 'volume') {
      if (holdFamily === 'comp') return pick([3, 2, 1]);
      if (holdFamily === 'geometric') return pick([0, 1, 2]);
      return pick([0, 1, 3]);
    }
    // Bias silhouette variant toward the route's sculptural family while keeping rich variety
    if (holdFamily === 'organic') return pick([0, 0, 1, 2]);
    if (holdFamily === 'comp') return pick([1, 1, 0, 2]);
    return pick([2, 2, 0, 1]);
  };

  const maybeDualTex = (type: HoldType, isRecovery: boolean): boolean => {
    if (isRecovery || g < 4 || type === 'foothold' || type === 'jug' || type === 'volume') return false;
    const baseProb =
      holdFamily === 'comp'
        ? type === 'sloper'
          ? 0.55
          : 0.34
        : holdFamily === 'geometric'
          ? 0.22
          : 0.1;
    return Math.random() < baseProb;
  };

  const maybeThumbCatch = (type: HoldType): boolean => {
    if (type !== 'pinch' && type !== 'crimp') return false;
    return Math.random() < (type === 'pinch' ? 0.42 : 0.22);
  };

  // Pick a style-appropriate wall angle within the grade's realistic band
  let chosenWallAngle = pick(bp.wallAngles);
  if (style === 'tech' && g >= 3 && g <= 5) {
    chosenWallAngle = Math.random() < 0.35 ? (g >= 5 ? -10 : -5) : bp.wallAngles[0];
  } else if (style === 'power' && g >= 4) {
    chosenWallAngle = bp.wallAngles[bp.wallAngles.length - 1];
  } else if (style === 'dyno' && g >= 4) {
    chosenWallAngle = bp.wallAngles[Math.floor(bp.wallAngles.length / 2)];
  }

  const gradeNames: Record<number, string[]> = {
    1: ['新手阶梯', '大把手热身', '轻松直上'],
    2: ['对角节拍', '中段换手', '侧身过渡'],
    3: ['侧拉韵律', '折返线路', '重心考题'],
    4: ['指力试炼', '交错谜题', '动态衔接'],
    5: ['大跨距难点', '技术抠点', '边角突破'],
    6: ['圆弧危机', '精准压重心', '陡壁入门'],
    7: ['月板前哨', '连续死点', '强张力线'],
    8: ['40° 月板线', '微抠破局', '爆发核心'],
    9: ['专家死线', '陡壁微边', '极限协调'],
    10: ['屋檐微抠', '国家队考题', '零容错线'],
    11: ['8A 绝壁线', '世界杯决赛', '大师极限'],
  };

  let bestHolds: Hold[] = [];
  let bestWallAngle = chosenWallAngle;
  let bestMetrics: MeasuredDifficulty | null = null;
  let bestScoreError = Infinity;
  const anatomy = computeAnatomy(profile);

  const baseAttempts = g >= 7 ? 10 : g >= 4 ? 8 : 6;
  const hardCapAttempts = 26;
  for (let attempt = 0; attempt < hardCapAttempts; attempt++) {
    // Stop once we have finished the normal sampling budget AND found at least one verified solvable route
    if (attempt >= baseAttempts && bestMetrics !== null) break;
    const isRecoveryPass = attempt >= baseAttempts;
    const holds: Hold[] = [];
    const trialAngle =
      attempt === 0
        ? chosenWallAngle
        : isRecoveryPass
          ? bp.wallAngles[0]
          : pick(bp.wallAngles);

    // Style-tuned hold pool (strictly zero jugs on V4+ except explicit V4 dyno catch)
    const styleHandPool: HoldType[] = isRecoveryPass
      ? g >= 8
        ? ['crimp', 'pinch', 'microcrimp', 'crimp']
        : g >= 5
          ? ['pinch', 'crimp', 'pinch', 'sloper']
          : bp.handPool
      : style === 'tech'
        ? g >= 8
          ? ['sloper', 'crimp', 'microcrimp', 'sloper']
          : g >= 5
            ? ['sloper', 'crimp', 'sloper', 'crimp']
            : ['sloper', 'crimp', 'pinch', 'sloper']
        : style === 'dyno'
          ? g >= 8
            ? ['crimp', 'pinch', 'crimp', 'microcrimp']
            : g >= 5
              ? ['pinch', 'crimp', 'sloper', 'crimp']
              : ['pinch', 'crimp', 'pinch', 'sloper']
          : bp.handPool;

    // Start zone
    const startX = rand(110, 290);
    const startY = g >= 6 ? rand(104, 124) : rand(118, 138);
    const twoStarts = Math.random() < bp.twoStartsProb;

    if (twoStarts) {
      const gap = rand(52, 74);
      const startTypeL = pick(bp.startPool);
      placeHoldWithoutOverlap(
        holds,
        {
          id: nextUid('h'),
          label: 0,
          x: clamp(startX - gap / 2, 52, WALL_WIDTH_CM - 52),
          y: startY,
          type: startTypeL,
          role: 'start',
          angle: g <= 1 ? 0 : Math.round(rand(-bp.maxAngle * 0.42, 6)),
          scale: clamp(bp.scaleBase, 0.82, 1.24),
          color,
          styleFamily: holdFamily,
          shapeVariant: pickVariantForFamily(startTypeL),
          thumbCatch: maybeThumbCatch(startTypeL),
        },
        true,
        { minX: 48, maxX: WALL_WIDTH_CM - 48, minY: 102, maxY: 155 }
      );
      const startTypeR = pick(bp.startPool);
      placeHoldWithoutOverlap(
        holds,
        {
          id: nextUid('h'),
          label: 0,
          x: clamp(startX + gap / 2, 52, WALL_WIDTH_CM - 52),
          y: startY + rand(-6, 10),
          type: startTypeR,
          role: 'start',
          angle: g <= 1 ? 0 : Math.round(rand(-6, bp.maxAngle * 0.42)),
          scale: clamp(bp.scaleBase, 0.82, 1.24),
          color,
          styleFamily: holdFamily,
          shapeVariant: pickVariantForFamily(startTypeR),
          thumbCatch: maybeThumbCatch(startTypeR),
        },
        true,
        { minX: 48, maxX: WALL_WIDTH_CM - 48, minY: 102, maxY: 155 }
      );
    } else {
      const startType = pick(bp.startPool);
      placeHoldWithoutOverlap(
        holds,
        {
          id: nextUid('h'),
          label: 0,
          x: startX,
          y: startY,
          type: startType,
          role: 'start',
          angle: g <= 2 ? 0 : Math.round(rand(-15, 15)),
          scale: clamp(bp.scaleBase, 0.84, 1.18),
          color,
          styleFamily: holdFamily,
          shapeVariant: pickVariantForFamily(startType),
          thumbCatch: maybeThumbCatch(startType),
        },
        true,
        { minX: 52, maxX: WALL_WIDTH_CM - 52, minY: 104, maxY: 150 }
      );
    }

    // Starting footholds
    const startFootY = g >= 6 ? rand(30, 44) : rand(40, 58);
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
        scale: clamp(bp.scaleBase * 0.96, 0.8, 1.18),
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
        scale: clamp(bp.scaleBase * 0.96, 0.8, 1.18),
        color,
      },
      true,
      { minX: 38, maxX: WALL_WIDTH_CM - 38, minY: 28, maxY: 82 }
    );

    // Upward progression with grade-appropriate spacing, crux count, and footholds
    let prevX = startX;
    let prevY = startY;
    let dir = startX > WALL_WIDTH_CM / 2 ? -1 : 1;
    const firstCrux = Math.max(1, Math.floor(bp.numHands / 2) - (bp.cruxCount >= 2 ? 1 : 0));

    for (let i = 0; i < bp.numHands; i++) {
      const isCrux = bp.cruxCount > 0 && i >= firstCrux && i < firstCrux + bp.cruxCount;
      const easeFactor = isRecoveryPass ? 0.86 : 1.0;
      const dynoExtra = style === 'dyno' && isCrux && !isRecoveryPass ? 8 : 0;
      const stepDy =
        (rand(bp.minDy, bp.maxDy) + (isCrux ? bp.cruxBoostDy * (i === firstCrux ? 0.9 : 0.55) : 0)) *
          easeFactor +
        dynoExtra;
      const targetY = clamp(prevY + stepDy, prevY + 34, 344);

      if (Math.random() < (g <= 1 ? 0.55 : 0.78)) dir *= -1;
      let targetX = prevX + dir * rand(bp.minDx, bp.maxDx * easeFactor);
      if (targetX < 56 || targetX > WALL_WIDTH_CM - 56) {
        dir *= -1;
        targetX = clamp(prevX + dir * rand(bp.minDx, bp.maxDx * 0.85 * easeFactor), 56, WALL_WIDTH_CM - 56);
      }

      let type: HoldType = pick(styleHandPool);
      // Guarantee at least one iconic microcrimp crux on V8–V11 power/balanced lines!
      if (isCrux && g >= 8 && style !== 'dyno' && i === firstCrux) {
        type = 'microcrimp';
      }

      let angle = 0;
      if (bp.maxAngle > 0) {
        if (isRecoveryPass) {
          angle = Math.round(rand(-22, 22));
        } else if (type === 'sloper' || type === 'microcrimp' || type === 'pocket') {
          const cap = type === 'microcrimp' ? 26 : type === 'pocket' ? 30 : 34;
          angle = Math.round(rand(-Math.min(cap, bp.maxAngle * 0.45), Math.min(cap, bp.maxAngle * 0.45)));
        } else {
          const bias = targetX > prevX ? 1 : -1;
          angle = Math.round(bias * rand(bp.maxAngle * 0.3, bp.maxAngle));
        }
      }

      const allowDualTex = Math.abs(angle) <= 34 && maybeDualTex(type, isRecoveryPass);
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
          scale: clamp(
            bp.scaleBase + (isRecoveryPass ? 0.06 : 0) + rand(-0.05, 0.05),
            0.76,
            1.24
          ),
          color,
          styleFamily: holdFamily,
          shapeVariant: pickVariantForFamily(type),
          dualTex: allowDualTex,
          thumbCatch: maybeThumbCatch(type),
        },
        true,
        { minX: 48, maxX: WALL_WIDTH_CM - 48, minY: prevY + 26, maxY: 350 }
      );
      if (!placedHand) continue;

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
          scale: useVolume ? 1.0 : clamp(bp.scaleBase * 0.94, 0.8, 1.15),
          color: useVolume ? '#3D434C' : color,
          styleFamily: holdFamily,
          shapeVariant: pickVariantForFamily(useVolume ? 'volume' : 'foothold'),
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

      if (isRecoveryPass || Math.random() < bp.footBonusProb) {
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
            scale: clamp(bp.scaleBase * 0.92, 0.82, 1.12),
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
    const topMaxDx = g <= 1 ? 30 : g <= 4 ? 52 : 68;
    const topX = clamp(prevX + rand(-topMaxDx, topMaxDx), 74, WALL_WIDTH_CM - 74);
    const topY = clamp(
      Math.max(prevY + rand(bp.minDy, bp.maxDy + 6), g <= 1 ? 364 : 378),
      362,
      414
    );
    const topType = pick(bp.topPool);
    const placedTop = placeHoldWithoutOverlap(
      holds,
      {
        id: nextUid('h'),
        label: 0,
        x: topX,
        y: topY,
        type: topType,
        role: 'top',
        angle: g >= 7 ? Math.round(rand(-18, 18)) : 0,
        scale: clamp(bp.scaleBase + 0.08, 0.86, 1.26),
        color,
        styleFamily: holdFamily,
        shapeVariant: pickVariantForFamily(topType),
      },
      true,
      { minX: 60, maxX: WALL_WIDTH_CM - 60, minY: 358, maxY: 416 }
    );

    const refTopX = placedTop?.x ?? topX;
    const refTopY = placedTop?.y ?? topY;
    const highFootX = clamp(refTopX + rand(-46, 46), 54, WALL_WIDTH_CM - 54);
    const highFootY = clamp(
      refTopY - rand(g <= 2 ? 98 : 112, g <= 2 ? 124 : 144),
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
        scale: clamp(bp.scaleBase * 0.94, 0.82, 1.12),
        color,
      },
      false,
      { minX: 44, maxX: WALL_WIDTH_CM - 44, minY: 205, maxY: refTopY - 78 }
    );

    const numbered = renumberHolds(holds);
    if (bestHolds.length === 0) {
      bestHolds = numbered;
      bestWallAngle = trialAngle;
    }

    // Verify solvability against the grade's reference climber at trialAngle!
    const sol = suggestBeta(
      numbered,
      profile,
      isRecoveryPass ? 22 : 20,
      isRecoveryPass ? 18 : 14,
      trialAngle
    );
    if (!sol.solved) continue;

    const metrics = measureRouteDifficulty(numbered, sol.steps, profile, trialAngle);
    let err = Math.abs(metrics.estimatedGrade - g);
    if (g <= 2 && (metrics.dynoMoves > 0 || metrics.hardMoves > g)) err += 2.5;
    if (g >= 4 && metrics.staminaSpent < 45 + (g - 4) * 6) err += 1.6;
    if (g >= 5 && metrics.hardMoves + metrics.dynoMoves < 1) err += 2.2;
    // For V8+, prefer routes that truly challenge standard (92) climbers!
    if (g >= 8) {
      const stdTry = suggestBeta(numbered, CLIMBER_PRESETS[1], 16, 10, trialAngle);
      if (stdTry.solved) err += 3.0;
    }

    if (err < bestScoreError) {
      bestScoreError = err;
      bestHolds = numbered;
      bestWallAngle = trialAngle;
      bestMetrics = metrics;
      if (err <= 0.75) break;
    }
  }

  const baseDesc: Record<number, string> = {
    1: '大把手与充裕脚点热身线，练习节奏换脚与重心移动。',
    2: '把手与捏点交替的初阶斜线，培养基础脚法意识。',
    3: '引入侧拉点与轻仰角折返，注意对侧脚 Flag 防开门。',
    4: '进阶分水岭：抠点/圆弧与力量核心开始成为硬门槛。',
    5: '中仰角技术线，圆弧压重心与精准步序缺一不可。',
    6: '告别大把手：陡壁抠点与连续重心控制，考验指力与张力。',
    7: '高阶强张力线：出现微抠点与大跨距死点/飞跃难点。',
    8: '40° 级高阶力量线（推荐指力 ≥ 132）：微抠点 + 陡仰角强核心。',
    9: '专家级陡壁考题（推荐「V9 进阶高手」）：多步高强度 Crux。',
    10: '准职业屋檐线（推荐「V11 世界杯选手」）：极陡仰角 + 6–10mm 微抠点。',
    11: '8A 职业级绝壁（推荐「V11 世界杯选手」）：极限仰角、微抠与零容错连续难点！',
  };

  const angleNote = getWallAngleLabel(bestWallAngle);
  const styleNote = STYLE_LABELS[style];
  const familyNote = HOLD_FAMILY_LABELS[holdFamily];
  const telemetryNote = bestMetrics
    ? ` [${angleNote} · ${styleNote} · ${familyNote} · ${bestMetrics.stepCount}步 · 耗能${bestMetrics.staminaSpent}%${
        bestMetrics.dynoMoves > 0 ? ` · 飞跃${bestMetrics.dynoMoves}次` : ''
      }]`
    : ` [${angleNote} · ${styleNote} · ${familyNote}]`;

  return {
    id: nextUid('route'),
    name: pick(gradeNames[g]),
    grade: `V${g}`,
    wallAngleDeg: bestWallAngle,
    style,
    holdFamily,
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
 * specifically tailored to the current climber's height, ape index, grip, flexibility, and wall tilt!
 */
export function suggestBeta(
  holds: Hold[],
  profile: ClimberProfile,
  maxDepth = 20,
  beamWidth = 24,
  wallAngleDeg = 0
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

    const footFollowBonus = clamp(footAvgY - (handMaxY - 170), -90, 45) * 0.45;
    return -avgHandDist * 1.15 + topBonus + footFollowBonus + stamina * 0.85 - stepCount * 2.4;
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
  let bestSolved: { steps: BetaStep[]; dynoCount: number; stamina: number; depth: number } | null = null;

  for (let depth = 0; depth < maxDepth; depth++) {
    // Once we have a dyno-based solution, search at most 3 more plies to prefer a clean static send
    if (bestSolved && depth > bestSolved.depth + 3) break;
    const nextBeam: SearchNode[] = [];

    for (const node of beam) {
      const lhHold = node.assignment.lh ? holdMap.get(node.assignment.lh) : undefined;
      const rhHold = node.assignment.rh ? holdMap.get(node.assignment.rh) : undefined;
      const maxHandY = Math.max(lhHold?.y ?? 120, rhHold?.y ?? 120);

      for (const limb of ALL_LIMBS) {
        const isHand = LIMB_META[limb].isHand;
        const currentHoldId = node.assignment[limb];
        const currentHold = currentHoldId ? holdMap.get(currentHoldId) : undefined;

        const candidates = holds.filter((h) => {
          if (h.id === currentHoldId) return false;
          if (isHand) {
            if (h.type === 'foothold') return false;
            if (currentHold && h.y < currentHold.y - 35) return false;
            if (currentHold?.role === 'top') return false;
          } else {
            if (h.y > maxHandY - 12) return false;
            if (currentHold && h.y < currentHold.y - 25) return false;
            const otherFootId = limb === 'lf' ? node.assignment.rf : node.assignment.lf;
            if (otherFootId === h.id && HOLD_SPECS[h.type].baseRadiusCm < 12) return false;
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
          const staticTarget = holdTarget(target.id);
          const staticEv = evaluateMove(
            node.assignment,
            freeMap,
            limb,
            staticTarget,
            holds,
            profile,
            wallAngleDeg
          );

          const evaluations: Array<{ limbTarget: LimbTarget; ev: ReturnType<typeof evaluateMove> }> = [];
          if (staticEv.feasible) {
            evaluations.push({ limbTarget: staticTarget, ev: staticEv });
          } else if (isHand && target.y > maxHandY + 14) {
            // Only attempt explicit Dyno when static reach is genuinely impossible (no V1–V3 dyno cheesing!)
            const singleDyno = dynoTarget(target.id, false);
            const singleEv = evaluateMove(
              node.assignment,
              freeMap,
              limb,
              singleDyno,
              holds,
              profile,
              wallAngleDeg
            );
            if (singleEv.feasible) {
              evaluations.push({ limbTarget: singleDyno, ev: singleEv });
            }
            if (limb === 'rh' && target.y > maxHandY + 38) {
              const dblDyno = dynoTarget(target.id, true);
              const dblEv = evaluateMove(
                node.assignment,
                freeMap,
                limb,
                dblDyno,
                holds,
                profile,
                wallAngleDeg
              );
              if (dblEv.feasible) {
                evaluations.push({ limbTarget: dblDyno, ev: dblEv });
              }
            }
          }

          for (const { limbTarget, ev } of evaluations) {
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
              const dynoCount = steps.filter((s) => s.target.kind === 'dyno').length;
              const isStaticSend = dynoCount === 0 && !ev.isDyno;
              if (isStaticSend) {
                return { solved: true, steps, bestProgressY: topTarget.y };
              }
              if (
                !bestSolved ||
                dynoCount < bestSolved.dynoCount ||
                (dynoCount === bestSolved.dynoCount && newStamina > bestSolved.stamina)
              ) {
                bestSolved = { steps, dynoCount, stamina: newStamina, depth };
              }
              continue;
            }

            const altBonus = node.lastLimb !== limb ? 4 : 0;
            const ratingPenalty =
              limbTarget.kind === 'dyno'
                ? limbTarget.bothHands
                  ? -46
                  : -30
                : ev.isDyno || ev.rating === 'dyno'
                  ? -28
                  : ev.rating === 'hard'
                    ? -6
                    : 0;
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

  if (bestSolved) {
    return { solved: true, steps: bestSolved.steps, bestProgressY: topTarget.y };
  }

  const bestLh = bestNode.assignment.lh ? holdMap.get(bestNode.assignment.lh) : undefined;
  const bestRh = bestNode.assignment.rh ? holdMap.get(bestNode.assignment.rh) : undefined;
  return {
    solved: false,
    steps: bestNode.steps,
    bestProgressY: Math.max(bestLh?.y ?? 0, bestRh?.y ?? 0),
  };
}
