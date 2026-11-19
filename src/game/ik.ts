import {
  ClimberAnatomy,
  Hold,
  LimbAssignment,
  LimbId,
  SolvedPose,
  Vec2,
  WALL_HEIGHT_CM,
  WALL_WIDTH_CM,
} from './types';

export interface ReachBias {
  limb: LimbId;
  target: Vec2;
  strength: number; // 0..1
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpVec(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function smoothstep(t: number): number {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}

export function easeOutCubic(t: number): number {
  const c = clamp(t, 0, 1);
  return 1 - Math.pow(1 - c, 3);
}

export function easeInOutCubic(t: number): number {
  const c = clamp(t, 0, 1);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

/**
 * Exact 2D segment intersection test (excluding tiny endpoint tolerance so shared hips don't false-trigger).
 */
export function segmentsIntersect(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2, eps = 0.04): boolean {
  const dxa = a2.x - a1.x;
  const dya = a2.y - a1.y;
  const dxb = b2.x - b1.x;
  const dyb = b2.y - b1.y;
  const denom = dxa * dyb - dya * dxb;
  if (Math.abs(denom) < 1e-6) return false;

  const t = ((b1.x - a1.x) * dyb - (b1.y - a1.y) * dxb) / denom;
  const u = ((b1.x - a1.x) * dya - (b1.y - a1.y) * dxa) / denom;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
}

/**
 * Checks whether the left leg skeleton and right leg skeleton physically pass through each other.
 */
export function doLegsIntersect(pose: SolvedPose): boolean {
  const lThigh: [Vec2, Vec2] = [pose.hips.lf, pose.knees.lf];
  const lShin: [Vec2, Vec2] = [pose.knees.lf, pose.limbs.lf];
  const rThigh: [Vec2, Vec2] = [pose.hips.rf, pose.knees.rf];
  const rShin: [Vec2, Vec2] = [pose.knees.rf, pose.limbs.rf];

  return (
    segmentsIntersect(lThigh[0], lThigh[1], rThigh[0], rThigh[1]) ||
    segmentsIntersect(lThigh[0], lThigh[1], rShin[0], rShin[1]) ||
    segmentsIntersect(lShin[0], lShin[1], rThigh[0], rThigh[1]) ||
    segmentsIntersect(lShin[0], lShin[1], rShin[0], rShin[1])
  );
}

function getTorsoFrames(
  pelvis: Vec2,
  torsoAngle: number,
  hipTurn: number,
  anatomy: ClimberAnatomy
): {
  chest: Vec2;
  head: Vec2;
  shoulders: { lh: Vec2; rh: Vec2 };
  hips: { lf: Vec2; rf: Vec2 };
} {
  // Foreshorten shoulder/hip horizontal width subtly when turning side-on (hipTurn in -1..1)
  const turnCos = Math.cos(hipTurn * 0.62);
  const shW = anatomy.shoulderHalfW * clamp(turnCos, 0.52, 1);
  const hpW = anatomy.hipHalfW * clamp(turnCos, 0.56, 1);

  const ux = Math.sin(torsoAngle);
  const uy = Math.cos(torsoAngle);
  const rx = Math.cos(torsoAngle);
  const ry = -Math.sin(torsoAngle);

  const chest = {
    x: pelvis.x + ux * anatomy.torsoLen,
    y: pelvis.y + uy * anatomy.torsoLen,
  };

  const head = {
    x: chest.x + ux * (anatomy.headRadius * 1.48),
    y: chest.y + uy * (anatomy.headRadius * 1.48),
  };

  const shoulders = {
    lh: { x: chest.x - rx * shW, y: chest.y - ry * shW },
    rh: { x: chest.x + rx * shW, y: chest.y + ry * shW },
  };

  const hips = {
    lf: { x: pelvis.x - rx * hpW, y: pelvis.y - ry * hpW },
    rf: { x: pelvis.x + rx * hpW, y: pelvis.y + ry * hpW },
  };

  return { chest, head, shoulders, hips };
}

/**
 * Analytical 2-bone IK choosing the biomechanically natural bend solution.
 * Strictly preserves bone lengths len1 and len2 (clamps end effector if beyond max reach).
 */
export function solveTwoBoneIK(
  root: Vec2,
  target: Vec2,
  len1: number,
  len2: number,
  limb: LimbId,
  hipTurn = 0
): { joint: Vec2; end: Vec2 } {
  const dx = target.x - root.x;
  const dy = target.y - root.y;
  const rawD = Math.hypot(dx, dy);

  const minD = Math.abs(len1 - len2) + 2.0;
  const maxD = len1 + len2 - 0.15;

  if (rawD < 0.001) {
    const dir = limb === 'lh' || limb === 'lf' ? -1 : 1;
    return {
      joint: { x: root.x + dir * len1 * 0.6, y: root.y - len1 * 0.4 },
      end: { x: target.x, y: target.y },
    };
  }

  const ux = dx / rawD;
  const uy = dy / rawD;
  const d = clamp(rawD, minD, maxD);

  // Rigid end position (never stretches bone past len1 + len2 visually!)
  const end: Vec2 =
    rawD > maxD
      ? { x: root.x + ux * maxD, y: root.y + uy * maxD }
      : { x: target.x, y: target.y };

  const a = (len1 * len1 - len2 * len2 + d * d) / (2 * d);
  const hSq = Math.max(0, len1 * len1 - a * a);
  const h = Math.sqrt(hSq);

  const midX = root.x + ux * a;
  const midY = root.y + uy * a;

  const px = -uy;
  const py = ux;

  const cand1: Vec2 = { x: midX + px * h, y: midY + py * h };
  const cand2: Vec2 = { x: midX - px * h, y: midY - py * h };

  const scoreCandidate = (c: Vec2): number => {
    const isLeft = limb === 'lh' || limb === 'lf';
    const isHand = limb === 'lh' || limb === 'rh';
    const outward = isLeft ? root.x - c.x : c.x - root.x;

    if (isHand) {
      // Elbows always drop below shoulder-hand line and flare gently outward
      return -(c.y - root.y) * 2.1 + outward * 0.78;
    } else {
      // Knees open outward in frog stance, OR subtly turn with hipTurn (drop-knee when turning side-on!)
      const turnBias = hipTurn * (c.x - root.x) * 0.65;
      // Avoid knee dropping below the foot (anatomically impossible unless kneeling upside down)
      const belowFootPenalty = c.y < end.y - 6 ? -80 : 0;
      return outward * 1.35 + (c.y - root.y) * 0.55 + turnBias + belowFootPenalty;
    }
  };

  const joint = scoreCandidate(cand1) >= scoreCandidate(cand2) ? cand1 : cand2;
  return { joint, end };
}

/**
 * Rebuilds an exact, strictly-rigid SolvedPose from explicit pelvis, torsoAngle, hipTurn,
 * and 4 world-space limb positions. Used every animation frame so bones NEVER stretch or morph!
 */
export function buildRigidPoseFromTargets(
  pelvis: Vec2,
  torsoAngle: number,
  hipTurn: number,
  limbTargets: Record<LimbId, Vec2>,
  anchoredFlags: Record<LimbId, boolean>,
  anatomy: ClimberAnatomy,
  flexibility = 90
): SolvedPose {
  const { chest, head, shoulders, hips } = getTorsoFrames(pelvis, torsoAngle, hipTurn, anatomy);

  const lhIK = solveTwoBoneIK(shoulders.lh, limbTargets.lh, anatomy.upperArmLen, anatomy.forearmLen, 'lh', hipTurn);
  const rhIK = solveTwoBoneIK(shoulders.rh, limbTargets.rh, anatomy.upperArmLen, anatomy.forearmLen, 'rh', hipTurn);
  const lfIK = solveTwoBoneIK(hips.lf, limbTargets.lf, anatomy.thighLen, anatomy.shinLen, 'lf', hipTurn);
  const rfIK = solveTwoBoneIK(hips.rf, limbTargets.rf, anatomy.thighLen, anatomy.shinLen, 'rf', hipTurn);

  const limbs: Record<LimbId, Vec2> = {
    lh: lhIK.end,
    rh: rhIK.end,
    lf: lfIK.end,
    rf: rfIK.end,
  };
  const elbows = { lh: lhIK.joint, rh: rhIK.joint };
  const knees = { lf: lfIK.joint, rf: rfIK.joint };

  const com: Vec2 = {
    x:
      pelvis.x * 0.34 +
      chest.x * 0.3 +
      head.x * 0.08 +
      (knees.lf.x + knees.rf.x) * 0.08 +
      (elbows.lh.x + elbows.rh.x) * 0.04 +
      (limbs.lf.x + limbs.rf.x) * 0.02,
    y:
      pelvis.y * 0.34 +
      chest.y * 0.3 +
      head.y * 0.08 +
      (knees.lf.y + knees.rf.y) * 0.08 +
      (elbows.lh.y + elbows.rh.y) * 0.04 +
      (limbs.lf.y + limbs.rf.y) * 0.02,
  };

  const stretchRatios: Record<LimbId, number> = {
    lh: anchoredFlags.lh ? dist(shoulders.lh, limbTargets.lh) / anatomy.maxArmReach : 0,
    rh: anchoredFlags.rh ? dist(shoulders.rh, limbTargets.rh) / anatomy.maxArmReach : 0,
    lf: anchoredFlags.lf ? dist(hips.lf, limbTargets.lf) / anatomy.maxLegReach : 0,
    rf: anchoredFlags.rf ? dist(hips.rf, limbTargets.rf) / anatomy.maxLegReach : 0,
  };

  // Scrunch / High-step hip flexibility penalty
  let scrunchPenalty = 0;
  const flexLimitAboveHip = 12 + (flexibility - 70) * 0.55;
  const handYs: number[] = [];
  if (anchoredFlags.lh) handYs.push(limbTargets.lh.y);
  if (anchoredFlags.rh) handYs.push(limbTargets.rh.y);

  for (const fLimb of ['lf', 'rf'] as const) {
    if (!anchoredFlags[fLimb]) continue;
    const fPos = limbTargets[fLimb];
    const aboveHip = fPos.y - pelvis.y;
    if (aboveHip > flexLimitAboveHip) {
      scrunchPenalty = Math.max(scrunchPenalty, clamp((aboveHip - flexLimitAboveHip) / 36, 0, 1));
    }
    if (handYs.length > 0) {
      const avgHY = handYs.reduce((s, y) => s + y, 0) / handYs.length;
      const boxHeight = avgHY - fPos.y;
      const minComfortBox = anatomy.heightCm * 0.42 - (flexibility - 80) * 0.45;
      if (boxHeight < minComfortBox) {
        scrunchPenalty = Math.max(scrunchPenalty, clamp((minComfortBox - boxHeight) / 45, 0, 1));
      }
    }
  }

  return {
    pelvis,
    chest,
    head,
    torsoAngle,
    hipTurn,
    shoulders,
    hips,
    elbows,
    knees,
    limbs,
    com,
    stretchRatios,
    scrunchPenalty,
  };
}

export function solvePose(
  assignment: LimbAssignment,
  holdMap: Map<string, Hold>,
  anatomy: ClimberAnatomy,
  flexibility = 90,
  reachBias?: ReachBias,
  overrideLimbPos?: Partial<Record<LimbId, Vec2>>
): SolvedPose {
  const anchored: Partial<Record<LimbId, Vec2>> = {};
  for (const limb of ['lh', 'rh', 'lf', 'rf'] as LimbId[]) {
    if (overrideLimbPos && overrideLimbPos[limb]) {
      anchored[limb] = overrideLimbPos[limb];
    } else {
      const hid = assignment[limb];
      if (hid) {
        const h = holdMap.get(hid);
        if (h) anchored[limb] = { x: h.x, y: h.y };
      }
    }
  }

  const hands: Vec2[] = [];
  if (anchored.lh) hands.push(anchored.lh);
  if (anchored.rh) hands.push(anchored.rh);

  const feet: Vec2[] = [];
  if (anchored.lf) feet.push(anchored.lf);
  if (anchored.rf) feet.push(anchored.rf);

  // Initial pelvis guess
  let px = WALL_WIDTH_CM * 0.5;
  let py = anatomy.maxLegReach * 0.88;
  let torsoAngle = 0;

  if (hands.length > 0 && feet.length > 0) {
    const avgHX = hands.reduce((s, p) => s + p.x, 0) / hands.length;
    const avgHY = hands.reduce((s, p) => s + p.y, 0) / hands.length;
    const avgFX = feet.reduce((s, p) => s + p.x, 0) / feet.length;
    const avgFY = feet.reduce((s, p) => s + p.y, 0) / feet.length;
    px = avgHX * 0.46 + avgFX * 0.54;
    const naturalHangPy = avgHY - anatomy.torsoLen * 0.96 - anatomy.maxArmReach * 0.24;
    const naturalStandPy = avgFY + anatomy.maxLegReach * 0.66;
    py = clamp(
      Math.min(naturalStandPy, naturalHangPy),
      Math.max(24, avgHY - anatomy.torsoLen - anatomy.maxArmReach * 0.88),
      Math.max(28, avgHY - anatomy.torsoLen * 0.72)
    );
    torsoAngle = clamp(Math.atan2(avgHX - avgFX, Math.max(35, avgHY - avgFY)) * 0.42, -0.54, 0.54);
  } else if (hands.length > 0) {
    const avgHX = hands.reduce((s, p) => s + p.x, 0) / hands.length;
    const avgHY = hands.reduce((s, p) => s + p.y, 0) / hands.length;
    px = avgHX;
    py = Math.max(24, avgHY - anatomy.torsoLen - anatomy.maxArmReach * 0.72);
  } else if (feet.length > 0) {
    const avgFX = feet.reduce((s, p) => s + p.x, 0) / feet.length;
    const avgFY = feet.reduce((s, p) => s + p.y, 0) / feet.length;
    px = avgFX;
    py = avgFY + anatomy.maxLegReach * 0.82;
  }

  // Estimate natural climbing hip-turn (turn hip into the wall when reaching high/sideways)
  let hipTurn = 0;
  if (reachBias && (reachBias.limb === 'lh' || reachBias.limb === 'rh')) {
    const sideDir = reachBias.limb === 'lh' ? -1 : 1;
    const reachHeight = clamp((reachBias.target.y - (py + anatomy.torsoLen)) / 70, 0, 1);
    hipTurn = clamp(sideDir * reachHeight * 0.58 * reachBias.strength, -0.68, 0.68);
  } else if (anchored.lh && anchored.rh) {
    const dy = anchored.rh.y - anchored.lh.y;
    hipTurn = clamp(dy / 95, -0.55, 0.55);
  } else if (anchored.lh && !anchored.rh) {
    hipTurn = -0.35;
  } else if (anchored.rh && !anchored.lh) {
    hipTurn = 0.35;
  }

  // Iterative weighted constraint projection
  const iterations = 28;
  for (let iter = 0; iter < iterations; iter++) {
    const { shoulders, hips } = getTorsoFrames({ x: px, y: py }, torsoAngle, hipTurn, anatomy);

    // 1. Natural hanging balance between hands and standing feet
    if (feet.length > 0 && hands.length > 0) {
      const avgFY = feet.reduce((s, p) => s + p.y, 0) / feet.length;
      const avgHY = hands.reduce((s, p) => s + p.y, 0) / hands.length;
      const hangTarget = avgHY - anatomy.torsoLen * 0.98 - anatomy.maxArmReach * 0.26;
      const standTarget = avgFY + anatomy.maxLegReach * 0.66;
      const desiredPy = Math.min(standTarget, hangTarget);
      py += (desiredPy - py) * 0.1;
    } else if (feet.length > 0) {
      const avgFY = feet.reduce((s, p) => s + p.y, 0) / feet.length;
      const desiredPy = avgFY + anatomy.maxLegReach * 0.74;
      py += (desiredPy - py) * 0.08;
    } else {
      py -= 1.2;
    }

    // 2. Reach bias (climber shifts hips & leans toward next target hold)
    if (reachBias) {
      const isHand = reachBias.limb === 'lh' || reachBias.limb === 'rh';
      const root = isHand
        ? shoulders[reachBias.limb as 'lh' | 'rh']
        : hips[reachBias.limb as 'lf' | 'rf'];
      const dx = reachBias.target.x - root.x;
      const dy = reachBias.target.y - root.y;
      const d = Math.hypot(dx, dy);
      const maxR = isHand ? anatomy.maxArmReach : anatomy.maxLegReach;
      if (d > maxR * 0.55) {
        const pull = Math.min(18, (d - maxR * 0.55) * 0.25) * reachBias.strength;
        px += (dx / d) * pull;
        py += (dy / d) * pull;
        if (isHand) {
          const desiredLean = clamp((reachBias.target.x - px) / 145, -0.56, 0.56);
          torsoAngle = lerp(torsoAngle, desiredLean, 0.14 * reachBias.strength);
        }
      }
    }

    // 3. Enforce anchored hands within arm reach
    for (const hLimb of ['lh', 'rh'] as const) {
      const target = anchored[hLimb];
      if (!target) continue;
      const sh = shoulders[hLimb];
      const dx = target.x - sh.x;
      const dy = target.y - sh.y;
      const d = Math.hypot(dx, dy);
      const comfortLimit = anatomy.maxArmReach * 0.96;
      if (d > comfortLimit && d > 0.001) {
        const excess = d - comfortLimit;
        const ux = dx / d;
        const uy = dy / d;
        px += ux * excess * 0.58;
        py += uy * excess * 0.58;
        const leverX = sh.x - px;
        const leverY = sh.y - py;
        const torque = (leverX * uy - leverY * ux) / (anatomy.torsoLen * anatomy.torsoLen);
        torsoAngle = clamp(torsoAngle - torque * excess * 0.26, -0.62, 0.62);
      } else if (d < anatomy.maxArmReach * 0.24 && d > 0.001) {
        const push = (anatomy.maxArmReach * 0.24 - d) * 0.25;
        px -= (dx / d) * push;
        py -= (dy / d) * push;
      }
    }

    // 4. Enforce anchored feet within leg reach
    for (const fLimb of ['lf', 'rf'] as const) {
      const target = anchored[fLimb];
      if (!target) continue;
      const hp = hips[fLimb];
      const dx = target.x - hp.x;
      const dy = target.y - hp.y;
      const d = Math.hypot(dx, dy);
      const legLimit = anatomy.maxLegReach * 0.96;
      if (d > legLimit && d > 0.001) {
        const excess = d - legLimit;
        px += (dx / d) * excess * 0.55;
        py += (dy / d) * excess * 0.55;
      }
      const minPelvisOverFoot = -16 - (flexibility - 80) * 0.35;
      if (py < target.y + minPelvisOverFoot) {
        py = lerp(py, target.y + minPelvisOverFoot, 0.3);
      }
    }

    // 5. Gently align torso toward hands
    if (hands.length > 0) {
      const avgHX = hands.reduce((s, p) => s + p.x, 0) / hands.length;
      const avgHY = hands.reduce((s, p) => s + p.y, 0) / hands.length;
      const desiredTilt = clamp(Math.atan2(avgHX - px, Math.max(30, avgHY - py)) * 0.42, -0.58, 0.58);
      torsoAngle = lerp(torsoAngle, desiredTilt, 0.08);
    }

    px = clamp(px, 24, WALL_WIDTH_CM - 24);
    py = clamp(py, 22, WALL_HEIGHT_CM - anatomy.torsoLen - 18);
  }

  const pelvis: Vec2 = { x: px, y: py };
  const { shoulders, hips } = getTorsoFrames(pelvis, torsoAngle, hipTurn, anatomy);

  // Determine free limb positions (natural counter-flagging, never crossing into the other leg!)
  const anchorXs = Object.values(anchored).map((p) => p!.x);
  const avgAnchorX = anchorXs.length > 0 ? anchorXs.reduce((a, b) => a + b, 0) / anchorXs.length : px;

  const limbTargets: Record<LimbId, Vec2> = {
    lh:
      anchored.lh ??
      {
        x: clamp(shoulders.lh.x - anatomy.maxArmReach * 0.26, 12, WALL_WIDTH_CM - 12),
        y: Math.max(12, shoulders.lh.y - anatomy.maxArmReach * 0.56),
      },
    rh:
      anchored.rh ??
      {
        x: clamp(shoulders.rh.x + anatomy.maxArmReach * 0.26, 12, WALL_WIDTH_CM - 12),
        y: Math.max(12, shoulders.rh.y - anatomy.maxArmReach * 0.56),
      },
    lf:
      anchored.lf ??
      {
        x: clamp(
          Math.min(
            hips.lf.x - (avgAnchorX > px + 6 ? 24 : 14),
            anchored.rf ? anchored.rf.x - 18 : WALL_WIDTH_CM
          ),
          14,
          WALL_WIDTH_CM - 14
        ),
        y: Math.max(6, hips.lf.y - anatomy.maxLegReach * 0.74),
      },
    rf:
      anchored.rf ??
      {
        x: clamp(
          Math.max(
            hips.rf.x + (avgAnchorX < px - 6 ? 24 : 14),
            anchored.lf ? anchored.lf.x + 18 : 0
          ),
          14,
          WALL_WIDTH_CM - 14
        ),
        y: Math.max(6, hips.rf.y - anatomy.maxLegReach * 0.74),
      },
  };

  const anchoredFlags: Record<LimbId, boolean> = {
    lh: Boolean(anchored.lh),
    rh: Boolean(anchored.rh),
    lf: Boolean(anchored.lf),
    rf: Boolean(anchored.rf),
  };

  return buildRigidPoseFromTargets(
    pelvis,
    torsoAngle,
    hipTurn,
    limbTargets,
    anchoredFlags,
    anatomy,
    flexibility
  );
}

/**
 * Smoothly blends two poses by interpolating pelvis/torso/hipTurn and the 4 limb targets,
 * then re-solving exact 2-bone IK so bone lengths NEVER distort during transitions!
 */
export function blendPosesRigid(
  a: SolvedPose,
  b: SolvedPose,
  t: number,
  anatomy: ClimberAnatomy,
  flexibility = 90,
  overrideLimbPos?: Partial<Record<LimbId, Vec2>>
): SolvedPose {
  const ease = easeInOutCubic(t);
  const pelvis = lerpVec(a.pelvis, b.pelvis, ease);
  const torsoAngle = lerp(a.torsoAngle, b.torsoAngle, ease);
  const hipTurn = lerp(a.hipTurn, b.hipTurn, ease);

  const limbTargets: Record<LimbId, Vec2> = {
    lh: overrideLimbPos?.lh ?? lerpVec(a.limbs.lh, b.limbs.lh, ease),
    rh: overrideLimbPos?.rh ?? lerpVec(a.limbs.rh, b.limbs.rh, ease),
    lf: overrideLimbPos?.lf ?? lerpVec(a.limbs.lf, b.limbs.lf, ease),
    rf: overrideLimbPos?.rf ?? lerpVec(a.limbs.rf, b.limbs.rf, ease),
  };

  return buildRigidPoseFromTargets(
    pelvis,
    torsoAngle,
    hipTurn,
    limbTargets,
    { lh: true, rh: true, lf: true, rf: true },
    anatomy,
    flexibility
  );
}
