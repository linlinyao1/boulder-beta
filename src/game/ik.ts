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

function getTorsoFrames(
  pelvis: Vec2,
  torsoAngle: number,
  anatomy: ClimberAnatomy
): {
  chest: Vec2;
  head: Vec2;
  shoulders: { lh: Vec2; rh: Vec2 };
  hips: { lf: Vec2; rf: Vec2 };
} {
  // torsoAngle = 0 => spine points straight up (0, 1)
  // positive torsoAngle leans right (+sin, +cos)
  const ux = Math.sin(torsoAngle);
  const uy = Math.cos(torsoAngle);
  // right vector perpendicular to spine
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
    lh: { x: chest.x - rx * anatomy.shoulderHalfW, y: chest.y - ry * anatomy.shoulderHalfW },
    rh: { x: chest.x + rx * anatomy.shoulderHalfW, y: chest.y + ry * anatomy.shoulderHalfW },
  };

  const hips = {
    lf: { x: pelvis.x - rx * anatomy.hipHalfW, y: pelvis.y - ry * anatomy.hipHalfW },
    rf: { x: pelvis.x + rx * anatomy.hipHalfW, y: pelvis.y + ry * anatomy.hipHalfW },
  };

  return { chest, head, shoulders, hips };
}

/**
 * Analytical 2-bone IK choosing the biomechanically natural bend solution
 * (elbows flare outward & slightly down; knees open outward & upward in frog climbing stance).
 */
export function solveTwoBoneIK(
  root: Vec2,
  target: Vec2,
  len1: number,
  len2: number,
  limb: LimbId
): Vec2 {
  const dx = target.x - root.x;
  const dy = target.y - root.y;
  const rawD = Math.hypot(dx, dy);

  if (rawD < 0.001) {
    return { x: root.x + (limb === 'lh' || limb === 'lf' ? -len1 * 0.5 : len1 * 0.5), y: root.y };
  }

  const minD = Math.abs(len1 - len2) + 0.5;
  const maxD = len1 + len2 - 0.1;
  const d = clamp(rawD, minD, maxD);

  const ux = dx / rawD;
  const uy = dy / rawD;

  // Distance along root->target to the projection of the joint
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
    // Outward lateral preference
    const outward = isLeft ? root.x - c.x : c.x - root.x;
    if (isHand) {
      // Elbows naturally hang downward and flare slightly outward — never chicken-winging above shoulders
      return -(c.y - root.y) * 1.9 + outward * 0.72;
    } else {
      // Knees flare outward (open frog hips) and slightly upward
      return outward * 1.45 + (c.y - root.y) * 0.45;
    }
  };

  return scoreCandidate(cand1) >= scoreCandidate(cand2) ? cand1 : cand2;
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
    // Climbers hang slightly beneath their handholds rather than pushing shoulders above them
    const naturalHangPy = avgHY - anatomy.torsoLen * 0.96 - anatomy.maxArmReach * 0.24;
    const naturalStandPy = avgFY + anatomy.maxLegReach * 0.66;
    py = clamp(
      Math.min(naturalStandPy, naturalHangPy),
      Math.max(24, avgHY - anatomy.torsoLen - anatomy.maxArmReach * 0.88),
      Math.max(28, avgHY - anatomy.torsoLen * 0.72)
    );
    torsoAngle = clamp(Math.atan2(avgHX - avgFX, Math.max(35, avgHY - avgFY)) * 0.45, -0.58, 0.58);
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

  // Iterative weighted constraint projection for natural climbing body mechanics
  const iterations = 28;
  for (let iter = 0; iter < iterations; iter++) {
    const { shoulders, hips } = getTorsoFrames({ x: px, y: py }, torsoAngle, anatomy);

    // 1. Subtle gravity sag vs standing leg support (prefer hanging comfortably beneath hands)
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

    // 2. Reach bias (climber shifts hips & leans toward next target hold!)
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
          const desiredLean = clamp((reachBias.target.x - px) / 140, -0.6, 0.6);
          torsoAngle = lerp(torsoAngle, desiredLean, 0.14 * reachBias.strength);
        }
      }
    }

    // 3. Enforce anchored hands within arm reach (strong constraint)
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
        // Torque on torso angle
        const leverX = sh.x - px;
        const leverY = sh.y - py;
        const torque = (leverX * uy - leverY * ux) / (anatomy.torsoLen * anatomy.torsoLen);
        torsoAngle = clamp(torsoAngle - torque * excess * 0.28, -0.68, 0.68);
      } else if (d < anatomy.maxArmReach * 0.22 && d > 0.001) {
        // Avoid crushing chest directly onto hand hold
        const push = (anatomy.maxArmReach * 0.22 - d) * 0.25;
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
      // Prevent pelvis dropping way below a foot unless high-stepping
      const minPelvisOverFoot = -16 - (flexibility - 80) * 0.35;
      if (py < target.y + minPelvisOverFoot) {
        py = lerp(py, target.y + minPelvisOverFoot, 0.3);
      }
    }

    // 5. Gently keep torso aligned between hands & feet
    if (hands.length > 0) {
      const avgHX = hands.reduce((s, p) => s + p.x, 0) / hands.length;
      const avgHY = hands.reduce((s, p) => s + p.y, 0) / hands.length;
      const desiredTilt = clamp(Math.atan2(avgHX - px, Math.max(30, avgHY - py)) * 0.45, -0.62, 0.62);
      torsoAngle = lerp(torsoAngle, desiredTilt, 0.08);
    }

    px = clamp(px, 24, WALL_WIDTH_CM - 24);
    py = clamp(py, 22, WALL_HEIGHT_CM - anatomy.torsoLen - 18);
  }

  const pelvis: Vec2 = { x: px, y: py };
  const { chest, head, shoulders, hips } = getTorsoFrames(pelvis, torsoAngle, anatomy);

  // Determine free limb positions (natural climbing flag / counterbalance!)
  const anchorXs = Object.values(anchored).map((p) => p!.x);
  const avgAnchorX = anchorXs.length > 0 ? anchorXs.reduce((a, b) => a + b, 0) / anchorXs.length : px;

  const limbs: Record<LimbId, Vec2> = {
    lh:
      anchored.lh ??
      {
        x: clamp(shoulders.lh.x - anatomy.maxArmReach * 0.28, 12, WALL_WIDTH_CM - 12),
        y: Math.max(12, shoulders.lh.y - anatomy.maxArmReach * 0.58),
      },
    rh:
      anchored.rh ??
      {
        x: clamp(shoulders.rh.x + anatomy.maxArmReach * 0.28, 12, WALL_WIDTH_CM - 12),
        y: Math.max(12, shoulders.rh.y - anatomy.maxArmReach * 0.58),
      },
    lf:
      anchored.lf ??
      {
        // Counter-flag left foot if anchors are right of pelvis
        x: clamp(
          hips.lf.x - (avgAnchorX > px + 6 ? 26 : 14),
          14,
          WALL_WIDTH_CM - 14
        ),
        y: Math.max(6, hips.lf.y - anatomy.maxLegReach * 0.74),
      },
    rf:
      anchored.rf ??
      {
        x: clamp(
          hips.rf.x + (avgAnchorX < px - 6 ? 26 : 14),
          14,
          WALL_WIDTH_CM - 14
        ),
        y: Math.max(6, hips.rf.y - anatomy.maxLegReach * 0.74),
      },
  };

  const elbows = {
    lh: solveTwoBoneIK(shoulders.lh, limbs.lh, anatomy.upperArmLen, anatomy.forearmLen, 'lh'),
    rh: solveTwoBoneIK(shoulders.rh, limbs.rh, anatomy.upperArmLen, anatomy.forearmLen, 'rh'),
  };

  const knees = {
    lf: solveTwoBoneIK(hips.lf, limbs.lf, anatomy.thighLen, anatomy.shinLen, 'lf'),
    rf: solveTwoBoneIK(hips.rf, limbs.rf, anatomy.thighLen, anatomy.shinLen, 'rf'),
  };

  // Weighted anatomical Center of Mass
  const com: Vec2 = {
    x:
      pelvis.x * 0.34 +
      chest.x * 0.30 +
      head.x * 0.08 +
      (knees.lf.x + knees.rf.x) * 0.08 +
      (elbows.lh.x + elbows.rh.x) * 0.04 +
      (limbs.lf.x + limbs.rf.x) * 0.02,
    y:
      pelvis.y * 0.34 +
      chest.y * 0.30 +
      head.y * 0.08 +
      (knees.lf.y + knees.rf.y) * 0.08 +
      (elbows.lh.y + elbows.rh.y) * 0.04 +
      (limbs.lf.y + limbs.rf.y) * 0.02,
  };

  const stretchRatios: Record<LimbId, number> = {
    lh: anchored.lh ? dist(shoulders.lh, limbs.lh) / anatomy.maxArmReach : 0,
    rh: anchored.rh ? dist(shoulders.rh, limbs.rh) / anatomy.maxArmReach : 0,
    lf: anchored.lf ? dist(hips.lf, limbs.lf) / anatomy.maxLegReach : 0,
    rf: anchored.rf ? dist(hips.rf, limbs.rf) / anatomy.maxLegReach : 0,
  };

  // Scrunch / High-step hip flexibility penalty
  let scrunchPenalty = 0;
  const flexLimitAboveHip = 12 + (flexibility - 70) * 0.55; // flexible climbers can step much higher!
  for (const fLimb of ['lf', 'rf'] as const) {
    const fPos = anchored[fLimb];
    if (!fPos) continue;
    const aboveHip = fPos.y - pelvis.y;
    if (aboveHip > flexLimitAboveHip) {
      scrunchPenalty = Math.max(scrunchPenalty, clamp((aboveHip - flexLimitAboveHip) / 36, 0, 1));
    }
    // Also check cramped box (tall climber with hands very close to feet)
    if (hands.length > 0) {
      const avgHY = hands.reduce((s, p) => s + p.y, 0) / hands.length;
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

export function interpolatePose(a: SolvedPose, b: SolvedPose, t: number): SolvedPose {
  const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  return {
    pelvis: lerpVec(a.pelvis, b.pelvis, ease),
    chest: lerpVec(a.chest, b.chest, ease),
    head: lerpVec(a.head, b.head, ease),
    torsoAngle: lerp(a.torsoAngle, b.torsoAngle, ease),
    shoulders: {
      lh: lerpVec(a.shoulders.lh, b.shoulders.lh, ease),
      rh: lerpVec(a.shoulders.rh, b.shoulders.rh, ease),
    },
    hips: {
      lf: lerpVec(a.hips.lf, b.hips.lf, ease),
      rf: lerpVec(a.hips.rf, b.hips.rf, ease),
    },
    elbows: {
      lh: lerpVec(a.elbows.lh, b.elbows.lh, ease),
      rh: lerpVec(a.elbows.rh, b.elbows.rh, ease),
    },
    knees: {
      lf: lerpVec(a.knees.lf, b.knees.lf, ease),
      rf: lerpVec(a.knees.rf, b.knees.rf, ease),
    },
    limbs: {
      lh: lerpVec(a.limbs.lh, b.limbs.lh, ease),
      rh: lerpVec(a.limbs.rh, b.limbs.rh, ease),
      lf: lerpVec(a.limbs.lf, b.limbs.lf, ease),
      rf: lerpVec(a.limbs.rf, b.limbs.rf, ease),
    },
    com: lerpVec(a.com, b.com, ease),
    stretchRatios: {
      lh: lerp(a.stretchRatios.lh, b.stretchRatios.lh, ease),
      rh: lerp(a.stretchRatios.rh, b.stretchRatios.rh, ease),
      lf: lerp(a.stretchRatios.lf, b.stretchRatios.lf, ease),
      rf: lerp(a.stretchRatios.rf, b.stretchRatios.rf, ease),
    },
    scrunchPenalty: lerp(a.scrunchPenalty, b.scrunchPenalty, ease),
  };
}
