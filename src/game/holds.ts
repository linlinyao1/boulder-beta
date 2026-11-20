import { Hold, HoldType, LimbId, Vec2 } from './types';

export interface HoldSpec {
  type: HoldType;
  nameZh: string;
  shortZh: string;
  description: string;
  handGrip: number; // 0..1 base grip quality for hands
  footGrip: number; // 0..1 base grip quality for feet
  angleToleranceDeg: number; // how forgiving the pull direction is
  staminaMultiplier: number; // relative forearm drain
  baseRadiusCm: number; // visual & hit-test radius in cm
  comDependency: number; // 0..1: slopers depend heavily on CoM alignment
}

export const HOLD_SPECS: Record<HoldType, HoldSpec> = {
  jug: {
    type: 'jug',
    nameZh: '大把手 (Jug)',
    shortZh: '大把手',
    description: '深槽好抓，容错率高，省体能，适合起步与恢复。',
    handGrip: 1.0,
    footGrip: 0.96,
    angleToleranceDeg: 135,
    staminaMultiplier: 0.65,
    baseRadiusCm: 13,
    comDependency: 0.12,
  },
  pinch: {
    type: 'pinch',
    nameZh: '捏点 (Pinch)',
    shortZh: '捏点',
    description: '拇指对捏发力，适合中段过渡与侧向控制。',
    handGrip: 0.78,
    footGrip: 0.85,
    angleToleranceDeg: 95,
    staminaMultiplier: 1.05,
    baseRadiusCm: 11.5,
    comDependency: 0.25,
  },
  crimp: {
    type: 'crimp',
    nameZh: '抠点 (Crimp)',
    shortZh: '抠点',
    description: '15–20mm 窄边指力点，方向敏感，中高难度核心点，耗费握力。',
    handGrip: 0.64,
    footGrip: 0.82,
    angleToleranceDeg: 68,
    staminaMultiplier: 1.42,
    baseRadiusCm: 9.5,
    comDependency: 0.35,
  },
  microcrimp: {
    type: 'microcrimp',
    nameZh: '微抠点 (Micro-crimp)',
    shortZh: '微抠点',
    description: '6–10mm 极窄指力边，角度容错极低，V8–V11 标志性难点岩点。',
    handGrip: 0.48,
    footGrip: 0.78,
    angleToleranceDeg: 48,
    staminaMultiplier: 1.72,
    baseRadiusCm: 7.5,
    comDependency: 0.42,
  },
  sloper: {
    type: 'sloper',
    nameZh: '圆弧点 (Sloper)',
    shortZh: '圆弧点',
    description: '靠手掌摩擦与重心正下方压住，方向不对极易打滑。',
    handGrip: 0.58,
    footGrip: 0.72,
    angleToleranceDeg: 58,
    staminaMultiplier: 1.32,
    baseRadiusCm: 14,
    comDependency: 0.68,
  },
  foothold: {
    type: 'foothold',
    nameZh: '小脚点 (Foothold)',
    shortZh: '脚点',
    description: '专为踩脚设计的微小岩点；脚下有支撑且指力/体重比足够时可勉强微抠过渡，但体能消耗极大。',
    handGrip: 0.36,
    footGrip: 0.92,
    angleToleranceDeg: 75,
    staminaMultiplier: 1.9,
    baseRadiusCm: 7.2,
    comDependency: 0.25,
  },
  volume: {
    type: 'volume',
    nameZh: '大造型 (Volume)',
    shortZh: '大造型',
    description: '大型几何立体岩板，可踩踏、摩擦撑手或借力过渡。',
    handGrip: 0.72,
    footGrip: 0.94,
    angleToleranceDeg: 115,
    staminaMultiplier: 0.95,
    baseRadiusCm: 21,
    comDependency: 0.38,
  },
};

export const HOLD_COLORS = [
  { name: '珊瑚红', hex: '#D6453A' },
  { name: '钴蓝', hex: '#2B6CB0' },
  { name: '姜黄', hex: '#D99B26' },
  { name: '松石绿', hex: '#238C6B' },
  { name: '绛紫', hex: '#6B4E9B' },
  { name: '炭灰', hex: '#3D434C' },
];

export const LIMB_META: Record<
  LimbId,
  { nameZh: string; shortZh: string; color: string; isHand: boolean; side: 'left' | 'right'; hotkey: string }
> = {
  lh: { nameZh: '左手', shortZh: '左手', color: '#2563EB', isHand: true, side: 'left', hotkey: '1' },
  rh: { nameZh: '右手', shortZh: '右手', color: '#E11D48', isHand: true, side: 'right', hotkey: '2' },
  lf: { nameZh: '左脚', shortZh: '左脚', color: '#0D9488', isHand: false, side: 'left', hotkey: '3' },
  rf: { nameZh: '右脚', shortZh: '右脚', color: '#D97706', isHand: false, side: 'right', hotkey: '4' },
};

export const ALL_LIMBS: LimbId[] = ['lh', 'rh', 'lf', 'rf'];

/**
 * Returns the unit vector representing the optimal pull direction FROM the hold
 * toward the climber's pulling shoulder/CoM (in world coordinates where +y is UP).
 * angle = 0 => (0, -1) (pulling straight down)
 * angle = 90 => (-1, 0) (right-edge sidepull, pull left)
 * angle = -90 => (1, 0) (left-edge sidepull, pull right)
 * angle = 180 => (0, 1) (undercling, pull up)
 */
export function getHoldOptimalPullDir(angleDeg: number): Vec2 {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: -Math.sin(rad),
    y: -Math.cos(rad),
  };
}

export function getHoldHitRadius(hold: Hold): number {
  return HOLD_SPECS[hold.type].baseRadiusCm * hold.scale;
}

/**
 * Physical grip positivity modifier from hold size (scale 0.75..1.35).
 * Anchored at scale=1.0 -> 1.00 so smaller edges (0.75x) are noticeably harder to hold.
 */
export function getHoldScaleGripFactor(scale: number): number {
  return Math.max(0.8, Math.min(1.15, 1 + (scale - 1.0) * 0.52));
}

export function getWallAngleLabel(angleDeg: number): string {
  if (angleDeg <= -5) return `${angleDeg}° 平衡板`;
  if (angleDeg < 5) return `${angleDeg}° 直壁`;
  if (angleDeg <= 20) return `${angleDeg}° 轻仰角`;
  if (angleDeg <= 35) return `${angleDeg}° 中仰角`;
  if (angleDeg <= 45) return `${angleDeg}° 陡仰角`;
  return `${angleDeg}° 极陡屋檐`;
}

export function getGradeTierColor(gradeStr: string): string {
  const m = gradeStr.match(/V(\d+)/i);
  if (!m) return '#181D22';
  const g = Number(m[1]);
  if (g <= 2) return '#15803D'; // Beginner: green
  if (g <= 5) return '#1D4ED8'; // Intermediate: cobalt
  if (g <= 8) return '#C2410C'; // Advanced: burnt orange
  return '#991B1B'; // Expert / Pro V9–V11: crimson
}

export function renumberHolds(holds: Hold[]): Hold[] {
  // Sort visually from bottom-left to top-right for intuitive numbering
  const sortedIds = [...holds]
    .sort((a, b) => {
      const yDiff = a.y - b.y;
      if (Math.abs(yDiff) > 22) return yDiff;
      return a.x - b.x;
    })
    .map((h) => h.id);
  const indexMap = new Map(sortedIds.map((id, i) => [id, i + 1]));
  return holds.map((h) => ({ ...h, label: indexMap.get(h.id) ?? h.label }));
}
