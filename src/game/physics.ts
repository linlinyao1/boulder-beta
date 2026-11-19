import { computeAnatomy } from './climber';
import { getHoldOptimalPullDir, HOLD_SPECS, LIMB_META } from './holds';
import { clamp, dist, doLegsIntersect, solvePose } from './ik';
import {
  BetaStep,
  ClimberProfile,
  Hold,
  LimbAssignment,
  LimbId,
  MoveEvaluation,
  MoveRating,
  SolvedPose,
  Vec2,
} from './types';

export function buildHoldMap(holds: Hold[]): Map<string, Hold> {
  return new Map(holds.map((h) => [h.id, h]));
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

  const tol = spec.angleToleranceDeg;
  if (angleDiffDeg <= tol) {
    // Smooth curve from 1.0 down to 0.72 at tolerance boundary
    const t = angleDiffDeg / Math.max(1, tol);
    return { alignment: 1 - 0.28 * t * t, angleDiffDeg };
  } else {
    const over = (angleDiffDeg - tol) / Math.max(15, 180 - tol);
    return { alignment: clamp(0.72 - over * 1.15, 0.05, 0.72), angleDiffDeg };
  }
}

/**
 * Evaluates a single planned climbing move: moving `limb` from its current state to `targetHoldId`.
 */
export function evaluateMove(
  prevAssignment: LimbAssignment,
  limb: LimbId,
  targetHoldId: string,
  holds: Hold[],
  profile: ClimberProfile
): MoveEvaluation {
  const holdMap = buildHoldMap(holds);
  const targetHold = holdMap.get(targetHoldId);
  const anatomy = computeAnatomy(profile);
  const isHand = LIMB_META[limb].isHand;

  const fallbackPose = solvePose(prevAssignment, holdMap, anatomy, profile.flexibility);

  if (!targetHold) {
    return {
      feasible: false,
      rating: 'fail',
      reachRatio: 2,
      reachExcessCm: 99,
      isDyno: false,
      gripScore: 0,
      balanceScore: 0,
      barnDoorRisk: 1,
      directionAlignment: 0,
      staminaCost: 0,
      failReason: '目标岩点不存在',
      warnings: [],
      resultingPose: fallbackPose,
    };
  }

  // Support pose while moving limb lets go and shifts toward target
  const supportAssignment: LimbAssignment = { ...prevAssignment, [limb]: null };
  const supportPose = solvePose(
    supportAssignment,
    holdMap,
    anatomy,
    profile.flexibility,
    { limb, target: { x: targetHold.x, y: targetHold.y }, strength: 0.92 }
  );

  // Target landing pose
  const nextAssignment: LimbAssignment = { ...prevAssignment, [limb]: targetHoldId };
  const nextPose = solvePose(nextAssignment, holdMap, anatomy, profile.flexibility);

  const warnings: string[] = [];

  // 1. Check remaining anchor support during transition
  const remainingHands = (['lh', 'rh'] as LimbId[]).filter((l) => supportAssignment[l] !== null);
  const remainingFeet = (['lf', 'rf'] as LimbId[]).filter((l) => supportAssignment[l] !== null);
  const remainingAll = [...remainingHands, ...remainingFeet];

  const isLowStartStanding =
    remainingHands.length === 0 &&
    remainingFeet.length >= 1 &&
    targetHold.y < anatomy.heightCm * 1.12;

  if (remainingHands.length === 0 && !isLowStartStanding) {
    return {
      feasible: false,
      rating: 'fail',
      reachRatio: 1.5,
      reachExcessCm: 30,
      isDyno: false,
      gripScore: 0,
      balanceScore: 0,
      barnDoorRisk: 1,
      directionAlignment: 0,
      staminaCost: 25,
      failReason: '双手同时离墙且重心过高，无法抓稳岩壁',
      warnings,
      resultingPose: nextPose,
    };
  }

  // 2. Reachability check (both during reach AND at landing span)
  const limbRoot = isHand
    ? supportPose.shoulders[limb as 'lh' | 'rh']
    : supportPose.hips[limb as 'lf' | 'rf'];
  const maxLimbReach = isHand ? anatomy.maxArmReach : anatomy.maxLegReach;
  const distToTarget = dist(limbRoot, { x: targetHold.x, y: targetHold.y });
  const reachFromSupport = distToTarget / maxLimbReach;

  // Also check if landing pose forces any anchored limb beyond physical limit
  const maxAnchorStretch = Math.max(
    nextPose.stretchRatios.lh,
    nextPose.stretchRatios.rh,
    nextPose.stretchRatios.lf,
    nextPose.stretchRatios.rf
  );

  const effectiveReach = Math.max(reachFromSupport, maxAnchorStretch);
  const staticLimit = isHand ? 1.035 : 1.045;
  const dynoLimit = isHand ? 1.21 : 1.045; // feet don't dyno

  const hasPushFoot = remainingFeet.some((fl) => {
    const fh = holdMap.get(supportAssignment[fl]!);
    return fh && fh.y < supportPose.pelvis.y + 18;
  });

  let isDyno = false;
  const reachExcessCm = Math.max(0, (effectiveReach - staticLimit) * maxLimbReach);

  if (effectiveReach > dynoLimit || (!hasPushFoot && effectiveReach > staticLimit)) {
    const gapCm = Math.max(1, Math.round((effectiveReach - staticLimit) * maxLimbReach));
    const reason = isHand
      ? hasPushFoot
        ? `${LIMB_META[limb].nameZh}够不到 #${targetHold.label}（差约 ${gapCm}cm），建议先垫高脚点或增大臂展`
        : `${LIMB_META[limb].nameZh}够不到 #${targetHold.label}（差约 ${gapCm}cm），且缺少踩脚点无法发力起跳`
      : `${LIMB_META[limb].nameZh}跨距过大，够不到 #${targetHold.label} 脚点（差约 ${gapCm}cm）`;

    return {
      feasible: false,
      rating: 'fail',
      reachRatio: effectiveReach,
      reachExcessCm: gapCm,
      isDyno: false,
      gripScore: 0,
      balanceScore: 20,
      barnDoorRisk: 0.3,
      directionAlignment: 0.5,
      staminaCost: 14,
      failReason: reason,
      warnings,
      resultingPose: nextPose,
    };
  }

  if (isHand && effectiveReach > staticLimit && effectiveReach <= dynoLimit && hasPushFoot) {
    isDyno = true;
    warnings.push(`动态飞跃 (Dyno / 死点出手)，需稳稳接住 #${targetHold.label}`);
  } else if (effectiveReach > 0.92) {
    warnings.push(`${LIMB_META[limb].nameZh}接近极限伸展，体能消耗增大`);
  }

  // 2.5 Anatomical legality: prevent inhuman leg pass-throughs, bone intersections & tangled crosses
  const nextLfHold = nextAssignment.lf ? holdMap.get(nextAssignment.lf) : undefined;
  const nextRfHold = nextAssignment.rf ? holdMap.get(nextAssignment.rf) : undefined;
  if (nextLfHold && nextRfHold) {
    if (nextLfHold.x > nextRfHold.x + 6) {
      return {
        feasible: false,
        rating: 'fail',
        reachRatio: effectiveReach,
        reachExcessCm,
        isDyno: false,
        gripScore: 0,
        balanceScore: 15,
        barnDoorRisk: 0.6,
        directionAlignment: 0.5,
        staminaCost: 12,
        failReason: '双脚反向交叉穿越（左脚不可跨到右脚右侧），请先移走对侧脚或做换脚',
        warnings,
        resultingPose: nextPose,
      };
    }
    if (doLegsIntersect(nextPose)) {
      return {
        feasible: false,
        rating: 'fail',
        reachRatio: effectiveReach,
        reachExcessCm,
        isDyno: false,
        gripScore: 0,
        balanceScore: 15,
        barnDoorRisk: 0.6,
        directionAlignment: 0.5,
        staminaCost: 12,
        failReason: '双腿骨骼发生交叉碰撞，人体无法完成此脚法',
        warnings,
        resultingPose: nextPose,
      };
    }
  }

  // Prevent high single-leg hip twist past opposite side of pelvis
  if (!isHand) {
    const crossOffset =
      limb === 'lf' ? targetHold.x - nextPose.pelvis.x : nextPose.pelvis.x - targetHold.x;
    const isHighFoot = targetHold.y > nextPose.pelvis.y - 34;
    if (crossOffset > (isHighFoot ? 20 : 34)) {
      return {
        feasible: false,
        rating: 'fail',
        reachRatio: effectiveReach,
        reachExcessCm,
        isDyno: false,
        gripScore: 0,
        balanceScore: 20,
        barnDoorRisk: 0.55,
        directionAlignment: 0.4,
        staminaCost: 12,
        failReason: `${LIMB_META[limb].nameZh}跨过身体中线过深，髋关节无法扭转到位`,
        warnings,
        resultingPose: nextPose,
      };
    }
  }

  // Prevent extreme tangled flat hand-cross (allow clean vertical cross-throughs!)
  const nextLhHold = nextAssignment.lh ? holdMap.get(nextAssignment.lh) : undefined;
  const nextRhHold = nextAssignment.rh ? holdMap.get(nextAssignment.rh) : undefined;
  if (nextLhHold && nextRhHold && nextLhHold.id !== nextRhHold.id) {
    const handCrossX = nextLhHold.x - nextRhHold.x;
    const handDiffY = Math.abs(nextLhHold.y - nextRhHold.y);
    if (handCrossX > 34 || (handCrossX > 18 && handDiffY < 26)) {
      return {
        feasible: false,
        rating: 'fail',
        reachRatio: effectiveReach,
        reachExcessCm,
        isDyno: false,
        gripScore: 0,
        balanceScore: 25,
        barnDoorRisk: 0.5,
        directionAlignment: 0.4,
        staminaCost: 14,
        failReason: '双臂过度交叉缠绕，请调整左右手顺序',
        warnings,
        resultingPose: nextPose,
      };
    }
    if (handCrossX > 10) {
      warnings.push('交叉手动作（Cross），注意转髋贴壁');
    }
  }

  // 3. Hold quality & directional pull alignment
  const spec = HOLD_SPECS[targetHold.type];
  const { alignment, angleDiffDeg } = computeHoldAlignment(targetHold, limb, nextPose);

  // Strength-to-weight modifier: lighter & stronger climbers get better grip security
  const strengthToWeight = (profile.gripStrength / 92) / Math.pow(anatomy.weightFactor, 0.52);

  const baseGrip = isHand ? spec.handGrip : spec.footGrip;
  const gripRaw = baseGrip * alignment * clamp(strengthToWeight, 0.72, 1.32);
  const gripScore = clamp(Math.round(gripRaw * 100), 0, 100);

  if (isHand && targetHold.type === 'foothold') {
    return {
      feasible: false,
      rating: 'fail',
      reachRatio: effectiveReach,
      reachExcessCm,
      isDyno,
      gripScore,
      balanceScore: 40,
      barnDoorRisk: 0.4,
      directionAlignment: alignment,
      staminaCost: 16,
      failReason: `#${targetHold.label} 是小脚点，手指无法抓稳`,
      warnings,
      resultingPose: nextPose,
    };
  }

  if (isHand && alignment < 0.28) {
    return {
      feasible: false,
      rating: 'fail',
      reachRatio: effectiveReach,
      reachExcessCm,
      isDyno,
      gripScore,
      balanceScore: 35,
      barnDoorRisk: 0.5,
      directionAlignment: alignment,
      staminaCost: 18,
      failReason: `#${targetHold.label} ${spec.shortZh}发力方向偏离 ${Math.round(angleDiffDeg)}°，手掌打滑脱落`,
      warnings,
      resultingPose: nextPose,
    };
  }

  if (isDyno && baseGrip * alignment < 0.44) {
    return {
      feasible: false,
      rating: 'fail',
      reachRatio: effectiveReach,
      reachExcessCm,
      isDyno: true,
      gripScore,
      balanceScore: 28,
      barnDoorRisk: 0.55,
      directionAlignment: alignment,
      staminaCost: 22,
      failReason: `动态飞跃未能抓稳 #${targetHold.label}（${spec.shortZh}抓握面不足）`,
      warnings,
      resultingPose: nextPose,
    };
  }

  if (isHand && alignment < 0.58) {
    warnings.push(`#${targetHold.label} 抓握角度偏斜 (${Math.round(angleDiffDeg)}°)，握力消耗加剧`);
  }

  // 4. Barn-door & Center of Mass stability check during the 3-point support phase
  let barnDoorRisk = 0;
  if (remainingAll.length >= 2 && remainingHands.length >= 1) {
    const supPts = remainingAll.map((l) => holdMap.get(supportAssignment[l]!)!).filter(Boolean);
    const minX = Math.min(...supPts.map((p) => p.x));
    const maxX = Math.max(...supPts.map((p) => p.x));
    const spanX = maxX - minX;
    const comX = supportPose.com.x;

    // Distance of CoM outside support horizontal span
    const outsideDist = comX < minX ? minX - comX : comX > maxX ? comX - maxX : 0;

    // Check same-side alignment (e.g., only right hand + right foot when moving left hand)
    const onlyOneHand = remainingHands.length === 1;
    const onlyOneFoot = remainingFeet.length === 1;
    const sameSide =
      onlyOneHand &&
      onlyOneFoot &&
      LIMB_META[remainingHands[0]].side === LIMB_META[remainingFeet[0]].side;

    // Also check if all support points are almost collinear vertically (narrow base)
    const narrowBaseFactor = spanX < 18 ? 0.25 : 0;
    const freeFootFlagRelief = remainingFeet.length < 2 ? 0.16 : 0;

    barnDoorRisk = clamp(
      outsideDist / 48 + (sameSide ? 0.32 : 0) + narrowBaseFactor - freeFootFlagRelief,
      0,
      1
    );

    // Extra torque if remaining hand is a bad hold during a single-hand lock-off
    if (onlyOneHand) {
      const holdHand = holdMap.get(supportAssignment[remainingHands[0]]!);
      if (holdHand) {
        const { alignment: supAlign } = computeHoldAlignment(
          holdHand,
          remainingHands[0],
          supportPose
        );
        const supGrip = HOLD_SPECS[holdHand.type].handGrip * supAlign;
        if (supGrip < 0.36 && remainingFeet.length === 0) {
          barnDoorRisk = clamp(barnDoorRisk + 0.35, 0, 1);
        }
      }
    }
  } else if (remainingAll.length === 1 && !isLowStartStanding) {
    // Hanging by a single limb only!
    barnDoorRisk = 0.85;
  }

  if (barnDoorRisk > 0.82 && !isLowStartStanding) {
    return {
      feasible: false,
      rating: 'fail',
      reachRatio: effectiveReach,
      reachExcessCm,
      isDyno,
      gripScore,
      balanceScore: Math.round((1 - barnDoorRisk) * 100),
      barnDoorRisk,
      directionAlignment: alignment,
      staminaCost: 20,
      failReason: '支点集中在同侧导致开门失衡 (Barn-door)，先调整对侧脚点稳住重心',
      warnings,
      resultingPose: nextPose,
    };
  }

  if (barnDoorRisk > 0.5) {
    warnings.push('重心偏离支点轴线，有开门摆荡趋势');
  }

  // 5. Flexibility / high-step scrunch check
  if (nextPose.scrunchPenalty > 0.82) {
    return {
      feasible: false,
      rating: 'fail',
      reachRatio: effectiveReach,
      reachExcessCm,
      isDyno,
      gripScore,
      balanceScore: 30,
      barnDoorRisk,
      directionAlignment: alignment,
      staminaCost: 16,
      failReason: `高脚/折叠姿态超出当前柔韧度上限，无法踩稳 #${targetHold.label}`,
      warnings,
      resultingPose: nextPose,
    };
  }

  if (nextPose.scrunchPenalty > 0.42) {
    warnings.push('高脚折叠幅度较大，发力较吃力');
  }

  // 6. Stamina cost calculation
  const footSupportFactor =
    remainingFeet.length >= 2 ? 0.78 : remainingFeet.length === 1 ? 1.0 : 1.75; // campusing hurts!
  const reachFactor = isDyno ? 1.65 : effectiveReach > 0.9 ? 1.32 : 1.0;
  const alignFactor = 1 + (1 - alignment) * 0.9;
  const scrunchFactor = 1 + nextPose.scrunchPenalty * 0.45;
  const barnDoorFactor = 1 + barnDoorRisk * 0.5;
  const weightVsGrip = anatomy.weightFactor / (profile.gripStrength / 92);

  const baseCost = isHand ? 7.8 * spec.staminaMultiplier : 3.6;
  const staminaCost = Math.round(
    clamp(
      baseCost *
        footSupportFactor *
        reachFactor *
        alignFactor *
        scrunchFactor *
        barnDoorFactor *
        weightVsGrip,
      2,
      36
    ) * 10
  ) / 10;

  const balanceScore = clamp(
    Math.round((1 - barnDoorRisk * 0.75 - nextPose.scrunchPenalty * 0.25) * 100),
    0,
    100
  );

  let rating: MoveRating = 'solid';
  if (isDyno) {
    rating = 'dyno';
  } else if (effectiveReach > 0.92 || gripScore < 58 || barnDoorRisk > 0.48 || staminaCost > 16) {
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
  profile: ClimberProfile
): {
  traces: BetaTraceStep[];
  finalAssignment: LimbAssignment;
  finalStamina: number;
  reachesTop: boolean;
  firstFailureIndex: number | null;
} {
  let current = { ...initialAssignment };
  let stamina = 100;
  let firstFailureIndex: number | null = null;
  const traces: BetaTraceStep[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const evaluation = evaluateMove(current, step.limb, step.targetHoldId, holds, profile);
    const next = { ...current, [step.limb]: step.targetHoldId };
    stamina = Math.max(0, Math.round((stamina - evaluation.staminaCost) * 10) / 10);
    const pumpedOut = stamina <= 0;

    if ((!evaluation.feasible || pumpedOut) && firstFailureIndex === null) {
      firstFailureIndex = i;
    }

    traces.push({
      step,
      assignmentBefore: { ...current },
      assignmentAfter: { ...next },
      evaluation,
      staminaAfter: stamina,
      pumpedOut,
    });

    current = next;
  }

  const reachesTop = firstFailureIndex === null && isTopReached(current, holds);

  return {
    traces,
    finalAssignment: current,
    finalStamina: stamina,
    reachesTop,
    firstFailureIndex,
  };
}
