import { computeAnatomy } from './climber';
import {
  applyLimbTarget,
  detachLimb,
  emptyFreeMap,
  freeOverrides,
  getLimbWorldPos,
  supportingLimbs,
} from './contact';
import { getHoldOptimalPullDir, HOLD_SPECS, LIMB_META } from './holds';
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

/**
 * Evaluates a planned climbing move onto a hold, wall smear, or dangling flag.
 */
export function evaluateMove(
  prevAssignment: LimbAssignment,
  prevFree: FreeLimbMap,
  limb: LimbId,
  target: LimbTarget,
  holds: Hold[],
  profile: ClimberProfile
): MoveEvaluation {
  const holdMap = buildHoldMap(holds);
  const anatomy = computeAnatomy(profile);
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
  const dynoLimit = isHand && target.kind === 'hold' ? 1.21 : target.kind === 'hold' ? 1.045 : 1.02;

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

  // 2.5 Anatomical legality for feet (holds + smears)
  const lfPos = getLimbWorldPos('lf', next.assignment, next.free, holdMap);
  const rfPos = getLimbWorldPos('rf', next.assignment, next.free, holdMap);
  if (lfPos && rfPos) {
    if (lfPos.x > rfPos.x + 8) {
      return failEval(nextPose, '双脚反向交叉穿越（左脚不可跨到右脚右侧）', {
        reachRatio: effectiveReach,
        reachExcessCm,
      });
    }
    if (doLegsIntersect(nextPose)) {
      return failEval(nextPose, '双腿骨骼发生交叉碰撞，人体无法完成此脚法', {
        reachRatio: effectiveReach,
        reachExcessCm,
      });
    }
  }

  if (!isHand && (target.kind === 'hold' || target.kind === 'smear')) {
    const crossOffset =
      limb === 'lf' ? targetPos.x - nextPose.pelvis.x : nextPose.pelvis.x - targetPos.x;
    const isHighFoot = targetPos.y > nextPose.pelvis.y - 34;
    if (crossOffset > (isHighFoot ? 22 : 36)) {
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

  // 3. Contact quality
  const strengthToWeight = (profile.gripStrength / 92) / Math.pow(anatomy.weightFactor, 0.52);
  let alignment = 0.85;
  let gripScore = 70;
  let baseGrip = 0.7;
  let staminaMult = 1;

  if (target.kind === 'hold' && targetHold) {
    const spec = HOLD_SPECS[targetHold.type];
    const alignInfo = computeHoldAlignment(targetHold, limb, nextPose);
    alignment = alignInfo.alignment;
    baseGrip = isHand ? spec.handGrip : spec.footGrip;
    gripScore = clamp(Math.round(baseGrip * alignment * clamp(strengthToWeight, 0.72, 1.32) * 100), 0, 100);
    staminaMult = spec.staminaMultiplier;

    if (isHand && targetHold.type === 'foothold') {
      return failEval(nextPose, `#${targetHold.label} 是小脚点，手指无法抓稳`, {
        reachRatio: effectiveReach,
        reachExcessCm,
        isDyno,
        gripScore,
        directionAlignment: alignment,
      });
    }
    if (isHand && alignment < 0.28) {
      return failEval(
        nextPose,
        `#${targetHold.label} ${spec.shortZh}发力方向偏离 ${Math.round(alignInfo.angleDiffDeg)}°，手掌打滑脱落`,
        { reachRatio: effectiveReach, reachExcessCm, isDyno, gripScore, directionAlignment: alignment }
      );
    }
    if (isDyno && baseGrip * alignment < 0.44) {
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
    // Friction smear: better for feet, weak for hands; needs CoM pressing into wall
    // Feet: weight pressing down onto smear; Hands: CoM close to contact in X
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
      Math.round(baseGrip * alignment * clamp(strengthToWeight, 0.7, 1.25) * 100),
      0,
      100
    );
    staminaMult = isHand ? 1.55 : 1.15;
    warnings.push(isHand ? '蹭墙摩擦手，仅作短暂过渡' : '踩墙（Smear），靠鞋底摩擦与重心压墙');
    if (gripScore < 16) {
      return failEval(nextPose, '踩墙/蹭墙摩擦力不足，请把重心更靠近接触点', {
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
      outsideDist / 48 + (sameSide ? 0.32 : 0) + narrowBaseFactor - flagRelief,
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

  if (barnDoorRisk > 0.82 && !isLowStartStanding) {
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

  // 6. Stamina
  const footSupportFactor =
    remainingFeet.length >= 2 ? 0.78 : remainingFeet.length === 1 ? 1.0 : 1.75;
  const reachFactor = isDyno ? 1.65 : effectiveReach > 0.9 ? 1.32 : 1.0;
  const alignFactor = 1 + (1 - alignment) * 0.9;
  const scrunchFactor = 1 + nextPose.scrunchPenalty * 0.45;
  const barnDoorFactor = 1 + barnDoorRisk * 0.5;
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
        baseCost * footSupportFactor * reachFactor * alignFactor * scrunchFactor * barnDoorFactor * weightVsGrip,
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
  prevFree: FreeLimbMap = emptyFreeMap()
): MoveEvaluation {
  return evaluateMove(prevAssignment, prevFree, limb, { kind: 'hold', holdId: targetHoldId }, holds, profile);
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
  initialFree: FreeLimbMap = emptyFreeMap()
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
    const evaluation = evaluateMove(current, free, step.limb, step.target, holds, profile);
    const applied = applyLimbTarget(current, free, step.limb, step.target);
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
