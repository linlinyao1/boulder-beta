import { computeAnatomy } from './climber';
import {
  applyLimbTarget,
  detachLimb,
  emptyFreeMap,
  freeOverrides,
  getLimbWorldPos,
  isSupportingLimb,
  supportingLimbs,
} from './contact';
import { getHoldOptimalPullDir, getHoldScaleGripFactor, HOLD_SPECS, LIMB_META } from './holds';
import { clamp, dist, doLegsIntersect, solvePose } from './ik';
import {
  BetaStep,
  ClimberProfile,
  FreeLimbMap,
  Hold,
  LimbAssignment,
  LimbId,
  LimbTarget,
  MoveEvaluation,
  MoveRating,
  SolvedPose,
  Vec2,
  WALL_HEIGHT_CM,
  WALL_WIDTH_CM,
} from './types';

export function buildHoldMap(holds: Hold[]): Map<string, Hold> {
  return new Map(holds.map((h) => [h.id, h]));
}

export interface WallAnglePhysics {
  angleDeg: number;
  sinOverhang: number;
  sinSlab: number;
  handGripMult: number;
  handStaminaMult: number;
  footStaminaMult: number;
  slabBalanceMult: number;
  smearWallMult: number;
  dynoRiseMult: number;
  minHandGripThreshold: number;
}

/**
 * Computes physical force modifiers from wall tilt angle:
 * - Positive angles (+5°..+55°): Overhang pulls climber away from wall (mg*sinθ),
 *   raising finger load, stamina drain, cut-loose likelihood, and grip threshold.
 * - Negative angles (-10°..-5°): Slab eases finger load & helps smears,
 *   but sharply amplifies balance/CoM sensitivity.
 */
export function computeWallAnglePhysics(wallAngleDeg = 0): WallAnglePhysics {
  const angleDeg = clamp(wallAngleDeg, -10, 55);
  const rad = (angleDeg * Math.PI) / 180;
  const sinOverhang = Math.max(0, Math.sin(rad));
  const sinSlab = Math.max(0, -Math.sin(rad));

  return {
    angleDeg,
    sinOverhang,
    sinSlab,
    handGripMult: 1 - 0.44 * sinOverhang + 0.14 * sinSlab,
    handStaminaMult: 1 + 0.92 * sinOverhang - 0.16 * sinSlab,
    footStaminaMult: 1 + 0.44 * sinOverhang,
    slabBalanceMult: 1 + 1.15 * sinSlab,
    smearWallMult: clamp(1 - 0.52 * sinOverhang + 0.25 * sinSlab, 0.48, 1.18),
    dynoRiseMult: clamp(Math.cos(Math.max(0, rad)) * 0.48 + 0.52, 0.76, 1.0),
    minHandGripThreshold: Math.round(25 + sinOverhang * 18),
  };
}

/**
 * Computes the default starting limb placement on a route:
 * - Hands go on the Start hold(s)
 * - Feet go on the best low footholds / holds beneath the start hands
 */
export function getInitialAssignment(holds: Hold[], profile: ClimberProfile): LimbAssignment {
  const anatomy = computeAnatomy(profile);
  const startHolds = holds.filter((h) => h.role === 'start').sort((a, b) => a.x - b.x);

  const assignment: LimbAssignment = { lh: null, rh: null, lf: null, rf: null };

  if (startHolds.length >= 2) {
    assignment.lh = startHolds[0].id;
    assignment.rh = startHolds[startHolds.length - 1].id;
  } else if (startHolds.length === 1) {
    assignment.lh = startHolds[0].id;
    assignment.rh = startHolds[0].id;
  } else if (holds.length > 0) {
    // Fallback to lowest non-foothold
    const handCandidates = holds
      .filter((h) => h.type !== 'foothold')
      .sort((a, b) => a.y - b.y);
    const chosen = handCandidates[0] ?? holds[0];
    assignment.lh = chosen.id;
    assignment.rh = chosen.id;
  }

  const holdMap = buildHoldMap(holds);
  const lhHold = assignment.lh ? holdMap.get(assignment.lh) : undefined;
  const rhHold = assignment.rh ? holdMap.get(assignment.rh) : undefined;
  const handCenterX =
    lhHold && rhHold ? (lhHold.x + rhHold.x) / 2 : lhHold?.x ?? rhHold?.x ?? 200;
  const handMinY = Math.min(lhHold?.y ?? 140, rhHold?.y ?? 140);

  // Pick suitable starting footholds below the start hands
  const footCandidates = holds
    .filter((h) => h.id !== assignment.lh && h.id !== assignment.rh && h.y < handMinY - 22)
    .filter((h) => handMinY - h.y <= anatomy.heightCm * 0.96)
    .sort((a, b) => {
      const scoreA =
        Math.abs(a.x - handCenterX) * 0.7 + Math.abs(handMinY - a.y - anatomy.heightCm * 0.62);
      const scoreB =
        Math.abs(b.x - handCenterX) * 0.7 + Math.abs(handMinY - b.y - anatomy.heightCm * 0.62);
      return scoreA - scoreB;
    });

  const leftFeet = footCandidates.filter((h) => h.x <= handCenterX + 12);
  const rightFeet = footCandidates.filter((h) => h.x >= handCenterX - 12);

  if (leftFeet.length > 0) assignment.lf = leftFeet[0].id;
  if (rightFeet.length > 0) {
    const lfHold = assignment.lf ? holdMap.get(assignment.lf) : undefined;
    const validRight = rightFeet.filter((h) => !lfHold || h.x >= lfHold.x - 4);
    const rfChoice =
      validRight.find((h) => h.id !== assignment.lf) ?? validRight[0] ?? null;
    assignment.rf = rfChoice?.id ?? null;
  }
  if (!assignment.lf && footCandidates.length > 0) {
    const rfHold = assignment.rf ? holdMap.get(assignment.rf) : undefined;
    const validLeft = footCandidates.find((h) => !rfHold || h.x <= rfHold.x + 4);
    assignment.lf = validLeft?.id ?? null;
  }
  if (!assignment.rf && footCandidates.length > 1) {
    const lfHold = assignment.lf ? holdMap.get(assignment.lf) : undefined;
    assignment.rf =
      footCandidates.find((h) => h.id !== assignment.lf && (!lfHold || h.x >= lfHold.x - 4))?.id ??
      null;
  }

  return assignment;
}

/**
 * Evaluates directional alignment (0..1) of a limb pulling/stepping on a hold.
 */
function computeHoldAlignment(
  hold: Hold,
  limb: LimbId,
  pose: SolvedPose
): { alignment: number; angleDiffDeg: number } {
  const spec = HOLD_SPECS[hold.type];
  const isHand = LIMB_META[limb].isHand;

  if (!isHand) {
    // Feet mostly push down; flat/up-facing holds are best, inverted underclings are poor footholds
    const ideal = getHoldOptimalPullDir(hold.angle);
    // ideal.y = -1 means flat top edge (great for feet!)
    const footUpScore = clamp((-ideal.y + 0.35) / 1.35, 0.15, 1);
    return { alignment: footUpScore, angleDiffDeg: Math.abs(hold.angle) };
  }

  const shoulder = pose.shoulders[limb as 'lh' | 'rh'];
  // Slopers rely heavily on CoM being directly along pull vector; jugs rely mostly on shoulder pull vector
  const pullOrigin: Vec2 = {
    x: shoulder.x * (1 - spec.comDependency) + pose.com.x * spec.comDependency,
    y: shoulder.y * (1 - spec.comDependency) + pose.com.y * spec.comDependency,
  };

  const vx = pullOrigin.x - hold.x;
  const vy = pullOrigin.y - hold.y;
  const len = Math.hypot(vx, vy);
  if (len < 0.01) return { alignment: 0.8, angleDiffDeg: 0 };

  const actualDir = { x: vx / len, y: vy / len };
  const idealDir = getHoldOptimalPullDir(hold.angle);
  const dot = clamp(actualDir.x * idealDir.x + actualDir.y * idealDir.y, -1, 1);
  const angleDiffDeg = (Math.acos(dot) * 180) / Math.PI;

  // Dual-Tex narrows usable pull sector (glossy no-tex zone slips); thumb catch widens ergonomic pull sector!
  const tol = clamp(
    spec.angleToleranceDeg * (hold.dualTex ? 0.74 : 1.0) + (hold.thumbCatch ? 10 : 0),
    28,
    150
  );
  if (angleDiffDeg <= tol) {
    // Smooth curve from 1.0 down to 0.72 at tolerance boundary
    const t = angleDiffDeg / Math.max(1, tol);
    return { alignment: 1 - 0.28 * t * t, angleDiffDeg };
  } else {
    const over = (angleDiffDeg - tol) / Math.max(15, 180 - tol);
    return { alignment: clamp(0.72 - over * 1.15, 0.05, 0.72), angleDiffDeg };
  }
}

function failEval(
  pose: SolvedPose,
  reason: string,
  extras: Partial<MoveEvaluation> = {}
): MoveEvaluation {
  return {
    feasible: false,
    rating: 'fail',
    reachRatio: extras.reachRatio ?? 1.5,
    reachExcessCm: extras.reachExcessCm ?? 20,
    isDyno: extras.isDyno ?? false,
    gripScore: extras.gripScore ?? 0,
    balanceScore: extras.balanceScore ?? 20,
    barnDoorRisk: extras.barnDoorRisk ?? 0.5,
    directionAlignment: extras.directionAlignment ?? 0.4,
    staminaCost: extras.staminaCost ?? 12,
    failReason: reason,
    warnings: extras.warnings ?? [],
    resultingPose: pose,
  };
}

function supportPointPos(
  limb: LimbId,
  assignment: LimbAssignment,
  free: FreeLimbMap,
  holdMap: Map<string, Hold>
): Vec2 | null {
  return getLimbWorldPos(limb, assignment, free, holdMap);
}

export interface DynoEnvelope {
  canLaunch: boolean;
  launchOrigin: Vec2;
  maxUpReach: number;
  maxLatReach: number;
  maxJumpRiseCm: number;
  footImpulse: number;
  pushFeetCount: number;
}

/**
 * Computes the physically grounded human Dyno jump envelope from the current stance.
 * Shared by both physics evaluation and wall reach-arc visualization so visuals match physics 1:1.
 */
export function getDynoEnvelope(
  assignment: LimbAssignment,
  free: FreeLimbMap,
  holds: Hold[],
  profile: ClimberProfile,
  bothHands: boolean,
  stayingHand?: LimbId,
  wallAngleDeg = 0
): DynoEnvelope {
  const holdMap = buildHoldMap(holds);
  const anatomy = computeAnatomy(profile);
  const wallPhys = computeWallAnglePhysics(wallAngleDeg);
  const startPose = solvePose(
    assignment,
    holdMap,
    anatomy,
    profile.flexibility,
    undefined,
    freeOverrides(free)
  );

  const pushFeet = supportingLimbs(assignment, free, ['lf', 'rf']).filter((fl) => {
    const p = supportPointPos(fl, assignment, free, holdMap);
    return p && p.y < startPose.pelvis.y + 24;
  });

  if (pushFeet.length === 0) {
    return {
      canLaunch: false,
      launchOrigin: { x: startPose.chest.x, y: startPose.chest.y },
      maxUpReach: 0,
      maxLatReach: 0,
      maxJumpRiseCm: 0,
      footImpulse: 0,
      pushFeetCount: 0,
    };
  }

  // Impulse quality: two real footholds >> one foothold >> wall smears
  const holdFeetCount = pushFeet.filter((fl) => assignment[fl] !== null).length;
  const smearFeetCount = pushFeet.length - holdFeetCount;
  const footImpulse =
    holdFeetCount >= 2
      ? 1.0
      : holdFeetCount === 1 && smearFeetCount >= 1
        ? 0.82
        : holdFeetCount === 1
          ? 0.68
          : smearFeetCount >= 2
            ? 0.56
            : 0.46;

  const footPts = pushFeet
    .map((fl) => supportPointPos(fl, assignment, free, holdMap)!)
    .filter(Boolean);
  const avgFootX = footPts.reduce((s, p) => s + p.x, 0) / footPts.length;
  const avgFootY = footPts.reduce((s, p) => s + p.y, 0) / footPts.length;

  // Standing shoulder height at full leg extension (toe-off moment)
  let toeOffShoulderY = avgFootY + anatomy.maxLegReach * 0.9 + anatomy.torsoLen;

  // CRITICAL real-world constraint: when launching off handholds, your shoulders at the moment
  // of hand release cannot magically be far above the handholds you are pulling/pushing off!
  const activeHands = supportingLimbs(assignment, free, ['lh', 'rh']);
  const handPts = activeHands
    .map((hl) => getLimbWorldPos(hl, assignment, free, holdMap))
    .filter((p): p is Vec2 => Boolean(p));

  if (handPts.length > 0) {
    const maxHandY = Math.max(...handPts.map((p) => p.y));
    // Pulling/pressing past the start holds before releasing lets shoulders reach ~20cm above holds at most
    const releaseShoulderCap = maxHandY + (bothHands ? 20 : 12);
    toeOffShoulderY = Math.min(toeOffShoulderY, releaseShoulderCap);
  }

  // For single-hand Dyno, the staying hand physically caps how high the shoulder can rise!
  if (!bothHands && stayingHand) {
    const stayPos = getLimbWorldPos(stayingHand, assignment, free, holdMap);
    if (stayPos) {
      toeOffShoulderY = Math.min(toeOffShoulderY, stayPos.y + anatomy.maxArmReach * 0.72);
    }
  }

  // Realistic human vertical CoM jump rise off climbing holds after release (no running start!):
  // Baseline 172cm adult on 2 solid footholds: ~24cm Double Dyno, ~16cm Single Dyno.
  const legStrokeScale = clamp(anatomy.maxLegReach / 85, 0.74, 1.14);
  const powerFactor = clamp(
    ((profile.gripStrength * 0.45 + profile.flexibility * 0.55) / 92) /
      Math.pow(anatomy.weightFactor, 0.22),
    0.84,
    1.12
  );

  const baseJumpRise = bothHands ? 24 : 16;
  const maxJumpRiseCm =
    baseJumpRise * legStrokeScale * footImpulse * powerFactor * wallPhys.dynoRiseMult;

  const launchOrigin: Vec2 = {
    x: startPose.chest.x * 0.55 + avgFootX * 0.45,
    y: toeOffShoulderY,
  };

  // Fingertip reach envelope relative to release shoulder:
  // Upward = arm length + airborne CoM rise
  // Lateral = arm length + realistic lateral push-off (limited by foot friction angle)
  const maxUpReach = anatomy.maxArmReach + maxJumpRiseCm;
  const maxLatReach = anatomy.maxArmReach + maxJumpRiseCm * 0.85 + (bothHands ? 8 : 4);

  return {
    canLaunch: true,
    launchOrigin,
    maxUpReach,
    maxLatReach,
    maxJumpRiseCm,
    footImpulse,
    pushFeetCount: pushFeet.length,
  };
}

/**
 * Evaluates an explicit Single-Hand or Double-Hand Dyno (dynamic launch + possible cut-loose).
 */
function evaluateDynoMove(
  prevAssignment: LimbAssignment,
  prevFree: FreeLimbMap,
  limb: LimbId,
  target: Extract<LimbTarget, { kind: 'dyno' }>,
  holds: Hold[],
  profile: ClimberProfile,
  wallAngleDeg = 0
): MoveEvaluation {
  const holdMap = buildHoldMap(holds);
  const anatomy = computeAnatomy(profile);
  const wallPhys = computeWallAnglePhysics(wallAngleDeg);
  const targetHold = holdMap.get(target.holdId) ?? null;
  const warnings: string[] = [];

  const startPose = solvePose(
    prevAssignment,
    holdMap,
    anatomy,
    profile.flexibility,
    undefined,
    freeOverrides(prevFree)
  );

  if (!targetHold) {
    return failEval(startPose, '飞跃目标岩点不存在', { isDyno: true, isDoubleDyno: target.bothHands });
  }

  if (!target.bothHands && !LIMB_META[limb].isHand) {
    return failEval(startPose, '单手飞跃需先选择左手或右手，或直接切换「双飞」', {
      isDyno: true,
    });
  }

  if (targetHold.type === 'foothold') {
    return failEval(startPose, `#${targetHold.label} 是小脚点，动态飞跃无法抓停`, {
      isDyno: true,
      isDoubleDyno: target.bothHands,
      staminaCost: 18,
    });
  }

  const otherHand: LimbId = limb === 'lh' ? 'rh' : 'lh';
  const env = getDynoEnvelope(
    prevAssignment,
    prevFree,
    holds,
    profile,
    target.bothHands,
    target.bothHands ? undefined : otherHand,
    wallAngleDeg
  );

  if (!env.canLaunch) {
    return failEval(startPose, '双脚处于悬空状态，缺少蹬伸支点，无法起跳飞跃（请先踩稳至少一只脚）', {
      isDyno: true,
      isDoubleDyno: target.bothHands,
      staminaCost: 14,
    });
  }

  const dx = Math.abs(targetHold.x - env.launchOrigin.x);
  const dy = targetHold.y - env.launchOrigin.y;
  const upNeed = Math.max(0, dy);
  const downNeed = Math.max(0, -dy);

  // Check if single-hand dyno would rip the other staying hand off its hold
  if (!target.bothHands) {
    const otherHandPos = getLimbWorldPos(otherHand, prevAssignment, prevFree, holdMap);
    if (otherHandPos) {
      const spanBetweenHands = dist(otherHandPos, targetHold);
      const maxSpan = anatomy.wingspanCm * 1.04;
      if (spanBetweenHands > maxSpan) {
        return failEval(
          startPose,
          `目标点跨距 (${Math.round(spanBetweenHands)}cm) 超出单手滞留臂展 (${Math.round(maxSpan)}cm)，请改用「双飞 (G)」双手同时起跳`,
          {
            isDyno: true,
            reachRatio: spanBetweenHands / anatomy.maxArmReach,
            reachExcessCm: Math.round(spanBetweenHands - maxSpan),
            staminaCost: 16,
          }
        );
      }
    }
  }

  // Elliptical ballistic reach check (gravity & lateral friction couple vertical and horizontal jump!)
  const verticalNorm = upNeed > 0 ? upNeed / env.maxUpReach : (downNeed * 0.65) / env.maxUpReach;
  const lateralNorm = dx / env.maxLatReach;
  const dynoEffort = Math.hypot(lateralNorm, verticalNorm);
  const reachRatio = dist(env.launchOrigin, targetHold) / Math.max(1, anatomy.maxArmReach);

  if (dynoEffort > 1.0) {
    const excessRatio = dynoEffort - 1.0;
    const gapCm = Math.max(1, Math.round(excessRatio * Math.min(env.maxUpReach, env.maxLatReach)));
    return failEval(
      startPose,
      `${target.bothHands ? '双手飞跃' : '动态飞跃'}超出真人起跳极限（差约 ${gapCm}cm，当前滞空约 +${Math.round(env.maxJumpRiseCm)}cm），请先踩高脚点再起跳`,
      {
        isDyno: true,
        isDoubleDyno: target.bothHands,
        reachRatio,
        reachExcessCm: gapCm,
        staminaCost: 20,
      }
    );
  }

  // Decide whether feet cut loose on landing
  let cutsFeet = target.bothHands;
  if (!cutsFeet) {
    const testKeepFeet = applyLimbTarget(prevAssignment, prevFree, limb, target, false);
    const keepPose = solvePose(
      testKeepFeet.assignment,
      holdMap,
      anatomy,
      profile.flexibility,
      undefined,
      freeOverrides(testKeepFeet.free)
    );
    const maxLegStretch = Math.max(keepPose.stretchRatios.lf, keepPose.stretchRatios.rf);
    const cutThreshold = 0.82 - wallPhys.sinOverhang * 0.22;
    if (maxLegStretch > 1.01 || dynoEffort > cutThreshold) {
      cutsFeet = true;
    }
  }

  const next = applyLimbTarget(prevAssignment, prevFree, limb, target, cutsFeet);
  const nextPose = solvePose(
    next.assignment,
    holdMap,
    anatomy,
    profile.flexibility,
    undefined,
    freeOverrides(next.free)
  );

  // Catch grip quality on impact (scales with hold size, wall overhang, and climber strength-to-weight)
  const spec = HOLD_SPECS[targetHold.type];
  const scaleGrip = getHoldScaleGripFactor(targetHold.scale);
  const alignLimb: LimbId = target.bothHands ? 'rh' : limb;
  const { alignment, angleDiffDeg } = computeHoldAlignment(targetHold, alignLimb, nextPose);
  const strengthToWeight = (profile.gripStrength / 92) / Math.pow(anatomy.weightFactor, 0.5);
  // Full-body airborne double-dyno shock load makes catching small/slopey/pocket/dual-tex holds much harder than jugs
  const shockMult =
    (target.bothHands
      ? targetHold.type === 'jug'
        ? 1.0
        : targetHold.type === 'pinch'
          ? 0.9
          : targetHold.type === 'crimp'
            ? 0.78
            : targetHold.type === 'sloper'
              ? 0.74
              : targetHold.type === 'pocket'
                ? 0.72
                : 0.58
      : targetHold.type === 'microcrimp'
        ? 0.84
        : targetHold.type === 'pocket'
          ? 0.88
          : 1.0) *
    (targetHold.dualTex ? 0.88 : 1.0) *
    (targetHold.thumbCatch ? 1.06 : 1.0);
  const catchFactor =
    spec.handGrip *
    scaleGrip *
    wallPhys.handGripMult *
    alignment *
    shockMult *
    clamp(strengthToWeight, 0.74, 1.78);
  const gripScore = clamp(Math.round(catchFactor * 100), 0, 100);

  const minCatch = target.bothHands ? 0.52 : 0.45;
  const minDynoAlign = targetHold.dualTex ? 0.44 : 0.36;
  if (alignment < minDynoAlign) {
    return failEval(
      nextPose,
      targetHold.dualTex
        ? `飞跃抓点角度偏离 ${Math.round(angleDiffDeg)}°，滑入双纹理光滑禁区脱落`
        : `飞跃抓点角度偏离 ${Math.round(angleDiffDeg)}°，滞空冲击下打滑脱落`,
      {
        isDyno: true,
        isDoubleDyno: target.bothHands,
        cutsFeet,
        reachRatio,
        reachExcessCm: 0,
        gripScore,
        directionAlignment: alignment,
        staminaCost: 22,
      }
    );
  }

  if (catchFactor < minCatch) {
    const angleTip =
      wallPhys.angleDeg >= 25 ? `（${wallPhys.angleDeg}° 仰角冲击负荷极高，需更高指力或调缓倾角）` : '';
    return failEval(
      nextPose,
      `飞跃冲击力过大，未能抓停 #${targetHold.label} ${spec.shortZh}${angleTip}`,
      {
        isDyno: true,
        isDoubleDyno: target.bothHands,
        cutsFeet,
        reachRatio,
        reachExcessCm: 0,
        gripScore,
        directionAlignment: alignment,
        staminaCost: 22,
      }
    );
  }

  if (target.bothHands) {
    warnings.push(`双手大飞跃 (质心滞空 +${Math.round(env.maxJumpRiseCm * dynoEffort)}cm)！落地切脚悬空，请找脚点稳住摆荡`);
  } else if (cutsFeet) {
    warnings.push('大跨距动态飞跃并切脚悬空 (Cut-loose)，注意控制摆荡');
  } else {
    warnings.push('动态死点出手 (Deadpoint)，保留脚点快速抓稳');
  }

  const intensity = clamp(dynoEffort, 0.35, 1);
  const staminaCost =
    Math.round(
      clamp(
        (target.bothHands ? 17 : 14) *
          (0.75 + intensity * 0.55) *
          (0.8 + spec.staminaMultiplier * 0.35) *
          wallPhys.handStaminaMult *
          (anatomy.weightFactor / (profile.gripStrength / 92)),
        9,
        34
      ) * 10
    ) / 10;

  const balanceScore = clamp(Math.round((cutsFeet ? 62 : 76) + alignment * 20 - intensity * 18), 26, 96);

  return {
    feasible: true,
    rating: 'dyno',
    reachRatio,
    reachExcessCm: 0,
    isDyno: true,
    isDoubleDyno: target.bothHands,
    cutsFeet,
    gripScore,
    balanceScore,
    barnDoorRisk: cutsFeet ? 0.32 : 0.2,
    directionAlignment: alignment,
    staminaCost,
    failReason: null,
    warnings,
    resultingPose: nextPose,
  };
}

/**
 * Evaluates a planned climbing move onto a hold, wall smear, dangling flag, or dynamic Dyno.
 */
export function evaluateMove(
  prevAssignment: LimbAssignment,
  prevFree: FreeLimbMap,
  limb: LimbId,
  target: LimbTarget,
  holds: Hold[],
  profile: ClimberProfile,
  wallAngleDeg = 0
): MoveEvaluation {
  if (target.kind === 'dyno') {
    return evaluateDynoMove(prevAssignment, prevFree, limb, target, holds, profile, wallAngleDeg);
  }
  const holdMap = buildHoldMap(holds);
  const anatomy = computeAnatomy(profile);
  const wallPhys = computeWallAnglePhysics(wallAngleDeg);
  const isHand = LIMB_META[limb].isHand;
  const warnings: string[] = [];

  const fallbackPose = solvePose(
    prevAssignment,
    holdMap,
    anatomy,
    profile.flexibility,
    undefined,
    freeOverrides(prevFree)
  );

  let targetPos: Vec2;
  let targetHold: Hold | null = null;
  if (target.kind === 'hold') {
    targetHold = holdMap.get(target.holdId) ?? null;
    if (!targetHold) {
      return failEval(fallbackPose, '目标岩点不存在', { reachRatio: 2, reachExcessCm: 99 });
    }
    targetPos = { x: targetHold.x, y: targetHold.y };
  } else {
    targetPos = { x: target.x, y: target.y };
    if (
      targetPos.x < 8 ||
      targetPos.x > WALL_WIDTH_CM - 8 ||
      targetPos.y < 10 ||
      targetPos.y > WALL_HEIGHT_CM - 10
    ) {
      return failEval(fallbackPose, '目标位置超出岩墙范围');
    }
  }

  const support = detachLimb(prevAssignment, prevFree, limb);
  const supportPose = solvePose(
    support.assignment,
    holdMap,
    anatomy,
    profile.flexibility,
    { limb, target: targetPos, strength: 0.92 },
    freeOverrides(support.free)
  );

  const next = applyLimbTarget(prevAssignment, prevFree, limb, target);
  const nextPose = solvePose(
    next.assignment,
    holdMap,
    anatomy,
    profile.flexibility,
    undefined,
    freeOverrides(next.free)
  );

  // 1. Remaining support during transition (holds + smears count; flags do not)
  const remainingHands = supportingLimbs(support.assignment, support.free, ['lh', 'rh']);
  const remainingFeet = supportingLimbs(support.assignment, support.free, ['lf', 'rf']);
  const remainingAll = [...remainingHands, ...remainingFeet];
  const flagFeet = (['lf', 'rf'] as LimbId[]).filter((l) => support.free[l]?.mode === 'flag');

  const isLowStartStanding =
    remainingHands.length === 0 &&
    remainingFeet.length >= 1 &&
    targetPos.y < anatomy.heightCm * 1.12;

  if (remainingHands.length === 0 && !isLowStartStanding && target.kind !== 'flag') {
    // Flagging a hand while already without hands is always bad; smear/hold needs hand support
    if (!(target.kind === 'smear' && !isHand && remainingFeet.length >= 1)) {
      return failEval(nextPose, '双手同时离墙且无可靠支点，无法稳住', {
        staminaCost: 22,
        barnDoorRisk: 1,
      });
    }
  }

  // 2. Reachability
  const limbRoot = isHand
    ? supportPose.shoulders[limb as 'lh' | 'rh']
    : supportPose.hips[limb as 'lf' | 'rf'];
  const maxLimbReach = isHand ? anatomy.maxArmReach : anatomy.maxLegReach;
  const reachFromSupport = dist(limbRoot, targetPos) / maxLimbReach;
  const maxAnchorStretch = Math.max(
    nextPose.stretchRatios.lh,
    nextPose.stretchRatios.rh,
    nextPose.stretchRatios.lf,
    nextPose.stretchRatios.rf
  );
  const effectiveReach = Math.max(reachFromSupport, maxAnchorStretch);
  const staticLimit = isHand ? 1.035 : 1.045;
  // Hold mode is static (only tiny deadpoint lunge up to 1.09); larger jumps use explicit Dyno (D / G)!
  const dynoLimit = isHand && target.kind === 'hold' ? 1.09 : target.kind === 'hold' ? 1.045 : 1.02;

  const hasPushFoot = remainingFeet.some((fl) => {
    const p = supportPointPos(fl, support.assignment, support.free, holdMap);
    return p && p.y < supportPose.pelvis.y + 18;
  });

  let isDyno = false;
  const reachExcessCm = Math.max(0, (effectiveReach - staticLimit) * maxLimbReach);

  if (effectiveReach > dynoLimit || (!hasPushFoot && effectiveReach > staticLimit && target.kind === 'hold')) {
    const gapCm = Math.max(1, Math.round((effectiveReach - staticLimit) * maxLimbReach));
    const label =
      target.kind === 'hold' && targetHold
        ? `#${targetHold.label}`
        : target.kind === 'smear'
          ? '踩墙位置'
          : '悬空位置';
    return failEval(
      nextPose,
      `${LIMB_META[limb].nameZh}够不到${label}（差约 ${gapCm}cm）`,
      { reachRatio: effectiveReach, reachExcessCm: gapCm, staminaCost: 14 }
    );
  }

  if (isHand && target.kind === 'hold' && effectiveReach > staticLimit && effectiveReach <= dynoLimit && hasPushFoot) {
    isDyno = true;
    warnings.push(`动态飞跃 (Dyno)，需稳稳接住 #${targetHold!.label}`);
  } else if (effectiveReach > 0.92) {
    warnings.push(`${LIMB_META[limb].nameZh}接近极限伸展`);
  }

  // 2.5 Anatomical legality for weighted feet (holds + smears); free flags can pass behind in 3D!
  const lfWeighted = isSupportingLimb(next.assignment, next.free, 'lf');
  const rfWeighted = isSupportingLimb(next.assignment, next.free, 'rf');
  const lfPos = lfWeighted ? getLimbWorldPos('lf', next.assignment, next.free, holdMap) : null;
  const rfPos = rfWeighted ? getLimbWorldPos('rf', next.assignment, next.free, holdMap) : null;

  if (lfPos && rfPos) {
    const reverseCrossX = lfPos.x - rfPos.x;
    const footHeightGap = Math.abs(lfPos.y - rfPos.y);

    if (reverseCrossX > 12) {
      return failEval(nextPose, '双脚反向交叉穿越（左脚不可直接踩到右脚外侧），请先移走对侧脚或做换脚', {
        reachRatio: effectiveReach,
        reachExcessCm,
      });
    }

    // Only hard-block true 3D leg collision when moving a foot and feet aren't widely staggered vertically
    if (!isHand && footHeightGap < 26 && doLegsIntersect(nextPose)) {
      return failEval(nextPose, '双腿在同一平面内发生交叉碰撞，可改用悬空后挂（Flag）或先调整对侧脚', {
        reachRatio: effectiveReach,
        reachExcessCm,
      });
    } else if (doLegsIntersect(nextPose)) {
      warnings.push('双腿姿态较为紧凑，注意转髋让开膝盖空间');
    }
  }

  if (!isHand && (target.kind === 'hold' || target.kind === 'smear')) {
    const crossOffset =
      limb === 'lf' ? targetPos.x - nextPose.pelvis.x : nextPose.pelvis.x - targetPos.x;
    const isHighFoot = targetPos.y > nextPose.pelvis.y - 34;
    if (crossOffset > (isHighFoot ? 28 : 42)) {
      return failEval(nextPose, `${LIMB_META[limb].nameZh}跨过身体中线过深，髋关节无法扭转到位`, {
        reachRatio: effectiveReach,
        reachExcessCm,
      });
    }
  }

  const nextLh = getLimbWorldPos('lh', next.assignment, next.free, holdMap);
  const nextRh = getLimbWorldPos('rh', next.assignment, next.free, holdMap);
  if (
    next.assignment.lh &&
    next.assignment.rh &&
    next.assignment.lh !== next.assignment.rh &&
    nextLh &&
    nextRh
  ) {
    const handCrossX = nextLh.x - nextRh.x;
    const handDiffY = Math.abs(nextLh.y - nextRh.y);
    if (handCrossX > 34 || (handCrossX > 18 && handDiffY < 26)) {
      return failEval(nextPose, '双臂过度交叉缠绕，请调整左右手顺序', {
        reachRatio: effectiveReach,
        reachExcessCm,
      });
    }
    if (handCrossX > 10) warnings.push('交叉手动作（Cross），注意转髋贴壁');
  }

  // 3. Contact quality (incorporates hold scale, wall tilt overhang/slab, and real finger strength)
  const strengthToWeight = (profile.gripStrength / 92) / Math.pow(anatomy.weightFactor, 0.52);
  let alignment = 0.85;
  let gripScore = 70;
  let baseGrip = 0.7;
  let staminaMult = 1;

  if (target.kind === 'hold' && targetHold) {
    const spec = HOLD_SPECS[targetHold.type];
    const scaleGrip = getHoldScaleGripFactor(targetHold.scale);
    const alignInfo = computeHoldAlignment(targetHold, limb, nextPose);
    alignment = alignInfo.alignment;
    const featureGripMult = isHand
      ? targetHold.thumbCatch
        ? 1.07
        : 1.0
      : targetHold.dualTex
        ? 0.88
        : 1.0;
    baseGrip = (isHand ? spec.handGrip : spec.footGrip) * scaleGrip * featureGripMult;
    const wallGripFactor = isHand
      ? wallPhys.handGripMult
      : clamp(1 - wallPhys.sinOverhang * 0.14 + wallPhys.sinSlab * 0.08, 0.84, 1.06);
    gripScore = clamp(
      Math.round(baseGrip * wallGripFactor * alignment * clamp(strengthToWeight, 0.72, 1.78) * 100),
      0,
      100
    );
    staminaMult = spec.staminaMultiplier;

    if (isHand && targetHold.type === 'foothold') {
      if (isDyno) {
        return failEval(nextPose, `#${targetHold.label} 是微小脚点，动态冲击下手指无法抓停`, {
          reachRatio: effectiveReach,
          reachExcessCm,
          isDyno: true,
          gripScore,
          directionAlignment: alignment,
          staminaCost: 20,
        });
      }
      if (remainingFeet.length === 0) {
        return failEval(nextPose, `脚下缺少支撑，无法仅靠手抠 #${targetHold.label} 小脚点承受全身重量`, {
          reachRatio: effectiveReach,
          reachExcessCm,
          gripScore,
          directionAlignment: alignment,
          staminaCost: 18,
        });
      }
      if (alignment < 0.55) {
        return failEval(
          nextPose,
          `#${targetHold.label} 小脚点边缘极浅，发力角度偏离 ${Math.round(alignInfo.angleDiffDeg)}° 会直接打滑`,
          { reachRatio: effectiveReach, reachExcessCm, gripScore, directionAlignment: alignment, staminaCost: 16 }
        );
      }
      if (gripScore < Math.max(28, wallPhys.minHandGripThreshold)) {
        return failEval(
          nextPose,
          `#${targetHold.label} 小脚点抓握面过小，当前指力/体重比难以抠稳（可减轻体重或提高指力）`,
          { reachRatio: effectiveReach, reachExcessCm, gripScore, directionAlignment: alignment, staminaCost: 16 }
        );
      }
      warnings.push(`微抠 #${targetHold.label} 小脚点过渡，指力消耗极大`);
    }
    const baseMinAlign =
      targetHold.type === 'microcrimp'
        ? 0.42
        : targetHold.type === 'sloper'
          ? 0.38
          : targetHold.type === 'pocket'
            ? 0.36
            : targetHold.type === 'crimp'
              ? 0.34
              : 0.28;
    const minAlign = clamp(baseMinAlign + (targetHold.dualTex ? 0.07 : 0), 0.28, 0.56);
    if (isHand && alignment < minAlign) {
      return failEval(
        nextPose,
        targetHold.dualTex
          ? `#${targetHold.label} 双纹理${spec.shortZh}发力偏离 ${Math.round(alignInfo.angleDiffDeg)}°，滑入光滑禁区脱落`
          : `#${targetHold.label} ${spec.shortZh}发力方向偏离 ${Math.round(alignInfo.angleDiffDeg)}°，手掌打滑脱落`,
        { reachRatio: effectiveReach, reachExcessCm, isDyno, gripScore, directionAlignment: alignment }
      );
    }
    // Realistic steep-overhang & small-hold finger-strength gate!
    if (
      isHand &&
      targetHold.type !== 'foothold' &&
      (wallPhys.angleDeg >= 10 || targetHold.type === 'microcrimp') &&
      gripScore < wallPhys.minHandGripThreshold
    ) {
      const tiltHint =
        wallPhys.angleDeg >= 20 ? `在 ${wallPhys.angleDeg}° 仰角下` : '';
      return failEval(
        nextPose,
        `${tiltHint}指力不足以抓稳 #${targetHold.label} ${spec.shortZh}（抓握 ${gripScore} < 需求 ${wallPhys.minHandGripThreshold}，可切换高阶体型/提高指力或调缓墙角）`,
        {
          reachRatio: effectiveReach,
          reachExcessCm,
          isDyno,
          gripScore,
          directionAlignment: alignment,
          staminaCost: 18,
        }
      );
    }
    if (isDyno && (baseGrip * wallGripFactor * alignment * clamp(strengthToWeight, 0.72, 1.78)) < 0.44) {
      return failEval(nextPose, `动态飞跃未能抓稳 #${targetHold.label}`, {
        reachRatio: effectiveReach,
        reachExcessCm,
        isDyno: true,
        gripScore,
        directionAlignment: alignment,
        staminaCost: 22,
      });
    }
    if (isHand && alignment < 0.58) {
      warnings.push(`#${targetHold.label} 抓握角度偏斜，握力消耗加剧`);
    }
  } else if (target.kind === 'smear') {
    // Friction smear: great on slab, progressively harder on steep overhang
    const lateral = clamp(1 - Math.abs(nextPose.com.x - targetPos.x) / (isHand ? 55 : 75), 0.25, 1);
    const verticalPress = isHand
      ? 0.85
      : clamp(0.45 + (nextPose.pelvis.y - targetPos.y) / 90, 0.4, 1);
    const pressIntoWall = lateral * verticalPress;
    const heightOk = isHand
      ? targetPos.y < nextPose.chest.y + 8 && targetPos.y > nextPose.pelvis.y - 40
      : targetPos.y < nextPose.pelvis.y + 12 && targetPos.y > nextPose.pelvis.y - anatomy.maxLegReach * 0.95;
    if (!heightOk) {
      return failEval(
        nextPose,
        isHand ? '蹭墙手位过高或过低，无法产生有效摩擦力' : '踩墙位置过高或过低，无法有效顶墙',
        { reachRatio: effectiveReach, reachExcessCm }
      );
    }
    baseGrip = isHand ? 0.28 : 0.58;
    alignment = pressIntoWall * (isHand ? 0.75 : 0.95);
    gripScore = clamp(
      Math.round(baseGrip * wallPhys.smearWallMult * alignment * clamp(strengthToWeight, 0.7, 1.45) * 100),
      0,
      100
    );
    staminaMult = isHand ? 1.55 : 1.15;
    warnings.push(isHand ? '蹭墙摩擦手，仅作短暂过渡' : '踩墙（Smear），靠鞋底摩擦与重心压墙');
    if (gripScore < 16) {
      return failEval(nextPose, '踩墙/蹭墙摩擦力不足，请把重心更靠近接触点或调缓仰角', {
        reachRatio: effectiveReach,
        reachExcessCm,
        gripScore,
        directionAlignment: alignment,
      });
    }
  } else {
    // Flag: dangling counterbalance — not a support, but can stabilize barn-door
    baseGrip = 0;
    alignment = 0.9;
    gripScore = 0;
    staminaMult = isHand ? 0.55 : 0.4;
    const sideOk =
      (LIMB_META[limb].side === 'left' && targetPos.x <= nextPose.pelvis.x + 8) ||
      (LIMB_META[limb].side === 'right' && targetPos.x >= nextPose.pelvis.x - 8);
    if (!sideOk && Math.abs(targetPos.x - nextPose.pelvis.x) > 28) {
      warnings.push('悬空配重越过身体中线较深，控制难度上升');
    }
    warnings.push(isHand ? '手部悬空配重（Flag）' : '脚部悬空配重（Flag），利用摆腿稳定重心');
  }

  // 4. Barn-door using holds + smear support points
  let barnDoorRisk = 0;
  const getSupPts = (): Vec2[] =>
    remainingAll
      .map((l) => supportPointPos(l, support.assignment, support.free, holdMap))
      .filter((p): p is Vec2 => Boolean(p));

  if (remainingAll.length >= 2 && remainingHands.length >= 1) {
    const supPts = getSupPts();
    const minX = Math.min(...supPts.map((p) => p.x));
    const maxX = Math.max(...supPts.map((p) => p.x));
    const spanX = maxX - minX;
    const comX = supportPose.com.x;
    const outsideDist = comX < minX ? minX - comX : comX > maxX ? comX - maxX : 0;
    const onlyOneHand = remainingHands.length === 1;
    const onlyOneFoot = remainingFeet.length === 1;
    const sameSide =
      onlyOneHand &&
      onlyOneFoot &&
      LIMB_META[remainingHands[0]].side === LIMB_META[remainingFeet[0]].side;
    const narrowBaseFactor = spanX < 18 ? 0.25 : 0;
    // Flagging the free foot/hand opposite the support side reduces barn-door
    const flagRelief = flagFeet.length > 0 || (target.kind === 'flag' && !isHand) ? 0.22 : remainingFeet.length < 2 ? 0.08 : 0;

    barnDoorRisk = clamp(
      (outsideDist / 48) * wallPhys.slabBalanceMult +
        (sameSide ? 0.32 : 0) +
        narrowBaseFactor -
        flagRelief,
      0,
      1
    );
  } else if (remainingAll.length === 1 && !isLowStartStanding) {
    barnDoorRisk = target.kind === 'flag' ? 0.72 : 0.85;
  } else if (remainingAll.length === 0 && !isLowStartStanding) {
    barnDoorRisk = 1;
  }

  // After landing a smear, weak friction increases risk
  if (target.kind === 'smear' && gripScore < 40) {
    barnDoorRisk = clamp(barnDoorRisk + 0.12, 0, 1);
  }

  if (barnDoorRisk > 0.76 && !isLowStartStanding) {
    return failEval(nextPose, '支点集中在同侧导致开门失衡，可对侧踩墙/悬空配重或换脚稳住', {
      reachRatio: effectiveReach,
      reachExcessCm,
      isDyno,
      gripScore,
      barnDoorRisk,
      balanceScore: Math.round((1 - barnDoorRisk) * 100),
      directionAlignment: alignment,
      staminaCost: 20,
      warnings,
    });
  }
  if (barnDoorRisk > 0.5) warnings.push('重心偏离支点轴线，有开门摆荡趋势');

  // 5. Scrunch
  if (nextPose.scrunchPenalty > 0.82 && target.kind !== 'flag') {
    return failEval(nextPose, '高脚/折叠姿态超出当前柔韧度上限', {
      reachRatio: effectiveReach,
      reachExcessCm,
      isDyno,
      gripScore,
      barnDoorRisk,
      directionAlignment: alignment,
      warnings,
    });
  }
  if (nextPose.scrunchPenalty > 0.42) warnings.push('高脚折叠幅度较大，发力较吃力');

  // 6. Stamina (overhang multiplies forearm & core tension drain!)
  const footSupportFactor =
    remainingFeet.length >= 2 ? 0.76 : remainingFeet.length === 1 ? 1.08 : 1.85;
  const reachFactor = isDyno ? 1.65 : effectiveReach > 0.9 ? 1.32 : 1.0;
  const alignFactor = 1 + (1 - alignment) * 0.9;
  const scrunchFactor = 1 + nextPose.scrunchPenalty * 0.45;
  const barnDoorFactor = 1 + barnDoorRisk * 0.5;
  const wallDrainFactor = isHand ? wallPhys.handStaminaMult : wallPhys.footStaminaMult;
  const weightVsGrip = anatomy.weightFactor / (profile.gripStrength / 92);
  const baseCost =
    target.kind === 'flag'
      ? isHand
        ? 3.2
        : 2.4
      : target.kind === 'smear'
        ? isHand
          ? 9.5
          : 4.8
        : isHand
          ? 7.8 * staminaMult
          : 3.6;

  const staminaCost =
    Math.round(
      clamp(
        baseCost *
          footSupportFactor *
          reachFactor *
          alignFactor *
          scrunchFactor *
          barnDoorFactor *
          wallDrainFactor *
          weightVsGrip,
        1.8,
        38
      ) * 10
    ) / 10;

  const balanceScore = clamp(
    Math.round((1 - barnDoorRisk * 0.75 - nextPose.scrunchPenalty * 0.25) * 100),
    0,
    100
  );

  let rating: MoveRating = 'solid';
  if (isDyno) rating = 'dyno';
  else if (
    effectiveReach > 0.92 ||
    (target.kind !== 'flag' && gripScore < 58) ||
    barnDoorRisk > 0.48 ||
    staminaCost > 16 ||
    target.kind === 'smear'
  ) {
    rating = 'hard';
  }

  return {
    feasible: true,
    rating,
    reachRatio: effectiveReach,
    reachExcessCm,
    isDyno,
    gripScore,
    balanceScore,
    barnDoorRisk,
    directionAlignment: alignment,
    staminaCost,
    failReason: null,
    warnings,
    resultingPose: nextPose,
  };
}

/** Convenience wrapper for hold-only moves (tests / AI solver). */
export function evaluateHoldMove(
  prevAssignment: LimbAssignment,
  limb: LimbId,
  targetHoldId: string,
  holds: Hold[],
  profile: ClimberProfile,
  prevFree: FreeLimbMap = emptyFreeMap(),
  wallAngleDeg = 0
): MoveEvaluation {
  return evaluateMove(
    prevAssignment,
    prevFree,
    limb,
    { kind: 'hold', holdId: targetHoldId },
    holds,
    profile,
    wallAngleDeg
  );
}

export function isTopReached(assignment: LimbAssignment, holds: Hold[]): boolean {
  const topIds = new Set(holds.filter((h) => h.role === 'top').map((h) => h.id));
  if (topIds.size === 0) return false;
  return (
    assignment.lh !== null &&
    assignment.rh !== null &&
    topIds.has(assignment.lh) &&
    topIds.has(assignment.rh)
  );
}

export interface BetaTraceStep {
  step: BetaStep;
  assignmentBefore: LimbAssignment;
  assignmentAfter: LimbAssignment;
  freeBefore: FreeLimbMap;
  freeAfter: FreeLimbMap;
  evaluation: MoveEvaluation;
  staminaAfter: number;
  pumpedOut: boolean;
}

/**
 * Evaluates an entire planned Beta sequence step by step for the given climber profile.
 */
export function evaluateBetaSequence(
  initialAssignment: LimbAssignment,
  steps: BetaStep[],
  holds: Hold[],
  profile: ClimberProfile,
  initialFree: FreeLimbMap = emptyFreeMap(),
  wallAngleDeg = 0
): {
  traces: BetaTraceStep[];
  finalAssignment: LimbAssignment;
  finalFree: FreeLimbMap;
  finalStamina: number;
  reachesTop: boolean;
  firstFailureIndex: number | null;
} {
  let current = { ...initialAssignment };
  let free = emptyFreeMap();
  // copy initial free
  free = {
    lh: initialFree.lh ? { ...initialFree.lh } : null,
    rh: initialFree.rh ? { ...initialFree.rh } : null,
    lf: initialFree.lf ? { ...initialFree.lf } : null,
    rf: initialFree.rf ? { ...initialFree.rf } : null,
  };
  let stamina = 100;
  let firstFailureIndex: number | null = null;
  const traces: BetaTraceStep[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const evaluation = evaluateMove(current, free, step.limb, step.target, holds, profile, wallAngleDeg);
    const applied = applyLimbTarget(current, free, step.limb, step.target, Boolean(evaluation.cutsFeet));
    stamina = Math.max(0, Math.round((stamina - evaluation.staminaCost) * 10) / 10);
    const pumpedOut = stamina <= 0;

    if ((!evaluation.feasible || pumpedOut) && firstFailureIndex === null) {
      firstFailureIndex = i;
    }

    traces.push({
      step,
      assignmentBefore: { ...current },
      assignmentAfter: { ...applied.assignment },
      freeBefore: {
        lh: free.lh ? { ...free.lh } : null,
        rh: free.rh ? { ...free.rh } : null,
        lf: free.lf ? { ...free.lf } : null,
        rf: free.rf ? { ...free.rf } : null,
      },
      freeAfter: applied.free,
      evaluation,
      staminaAfter: stamina,
      pumpedOut,
    });

    current = applied.assignment;
    free = applied.free;
  }

  const reachesTop = firstFailureIndex === null && isTopReached(current, holds);

  return {
    traces,
    finalAssignment: current,
    finalFree: free,
    finalStamina: stamina,
    reachesTop,
    firstFailureIndex,
  };
}
