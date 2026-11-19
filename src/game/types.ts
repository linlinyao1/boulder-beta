export const WALL_WIDTH_CM = 400;
export const WALL_HEIGHT_CM = 450;

export type GameMode = 'setter' | 'plan' | 'climb';

export type HoldType = 'jug' | 'crimp' | 'pinch' | 'sloper' | 'foothold' | 'volume';

export type HoldRole = 'start' | 'normal' | 'top';

export type LimbId = 'lh' | 'rh' | 'lf' | 'rf';

export interface Vec2 {
  x: number;
  y: number;
}

export interface Hold {
  id: string;
  label: number; // 1-based display index on wall
  x: number; // cm from left edge [0..400]
  y: number; // cm from crash pad [0..450]
  type: HoldType;
  role: HoldRole;
  angle: number; // degrees: 0 = flat top edge (pull down), 90 = right-edge sidepull, 180 = undercling
  scale: number; // 0.75..1.4
  color: string;
}

export interface ClimberProfile {
  name: string;
  heightCm: number; // 145..205
  apeIndexCm: number; // -10..+16 (wingspan = height + apeIndex)
  gripStrength: number; // 60..120
  flexibility: number; // 60..120
}

export interface ClimberAnatomy {
  heightCm: number;
  wingspanCm: number;
  torsoLen: number;
  shoulderHalfW: number;
  hipHalfW: number;
  headRadius: number;
  upperArmLen: number;
  forearmLen: number;
  thighLen: number;
  shinLen: number;
  maxArmReach: number;
  maxLegReach: number;
  weightFactor: number; // relative to 172cm reference climber
}

/**
 * Which hold each limb currently occupies (null = free / smearing / dangling)
 */
export interface LimbAssignment {
  lh: string | null;
  rh: string | null;
  lf: string | null;
  rf: string | null;
}

export interface SolvedPose {
  pelvis: Vec2;
  chest: Vec2;
  head: Vec2;
  torsoAngle: number; // radians, 0 = vertical upright, + = leaning right
  shoulders: { lh: Vec2; rh: Vec2 };
  hips: { lf: Vec2; rf: Vec2 };
  elbows: { lh: Vec2; rh: Vec2 };
  knees: { lf: Vec2; rf: Vec2 };
  limbs: Record<LimbId, Vec2>;
  com: Vec2; // Center of Mass
  stretchRatios: Record<LimbId, number>; // distance / maxReach
  scrunchPenalty: number; // 0..1 when feet are cramped above hip flexibility
}

export interface BetaStep {
  id: string;
  limb: LimbId;
  targetHoldId: string;
}

export type MoveRating = 'solid' | 'hard' | 'dyno' | 'fail';

export interface MoveEvaluation {
  feasible: boolean;
  rating: MoveRating;
  reachRatio: number; // moving limb reach ratio at catch
  reachExcessCm: number; // >0 if beyond static reach
  isDyno: boolean;
  gripScore: number; // 0..100
  balanceScore: number; // 0..100
  barnDoorRisk: number; // 0..1 (higher = worse)
  directionAlignment: number; // 0..1 (1 = ideal pull direction)
  staminaCost: number; // 0..100
  failReason: string | null;
  warnings: string[];
  resultingPose: SolvedPose;
}

export interface RouteProblem {
  id: string;
  name: string;
  grade: string; // e.g. 'V1', 'V5'
  description: string;
  holdColor: string;
  holds: Hold[];
}

export interface ClimbResult {
  status: 'success' | 'failed';
  failedAtStep?: number;
  reason: string;
  movesCompleted: number;
  totalMoves: number;
  staminaRemaining: number;
  cruxStepIndex: number | null;
  cruxStrain: number;
  elapsedSec: number;
}
