import { CLIMBER_PRESETS, computeAnatomy } from './climber';
import { ALL_LIMBS, HOLD_COLORS, HOLD_SPECS, LIMB_META, renumberHolds } from './holds';
import { clamp, dist } from './ik';
import { buildHoldMap, evaluateMove, getInitialAssignment, isTopReached } from './physics';
import {
  BetaStep,
  ClimberProfile,
  Hold,
  HoldType,
  LimbAssignment,
  LimbId,
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
 * Generates a realistic, climbable bouldering route for a target V-grade (0..7).
 * Uses a forward-constructed climbing skeleton plus verification against the physics solver.
 */
export function generateRoute(gradeNum: number, referenceProfile?: ClimberProfile): RouteProblem {
  const g = clamp(Math.round(gradeNum), 0, 7);
  const profile = referenceProfile ?? CLIMBER_PRESETS[1]; // Standard 172cm reference
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

  // Difficulty parameters
  const numMainHands = g <= 1 ? 5 : g <= 3 ? 5 : g <= 5 ? 5 : 4;
  const maxStepDy = 46 + g * 5.2; // V0 ~46cm, V7 ~82cm
  const minStepDy = 36 + g * 3.0;
  const lateralSpread = 44 + g * 8.5;
  const maxAngle = g <= 1 ? 12 : g <= 3 ? 42 : g <= 5 ? 58 : 72;

  const handPools: Record<number, HoldType[]> = {
    0: ['jug', 'jug', 'jug', 'pinch'],
    1: ['jug', 'jug', 'pinch'],
    2: ['jug', 'pinch', 'pinch', 'crimp'],
    3: ['pinch', 'crimp', 'jug', 'sloper'],
    4: ['crimp', 'pinch', 'sloper'],
    5: ['crimp', 'sloper', 'pinch', 'crimp'],
    6: ['crimp', 'sloper', 'sloper', 'crimp'],
    7: ['crimp', 'sloper', 'crimp'],
  };

  let bestHolds: Hold[] = [];
  const anatomy = computeAnatomy(profile);

  // Try up to 6 candidates and pick the first that our Beta solver confirms is solvable
  for (let attempt = 0; attempt < 6; attempt++) {
    const holds: Hold[] = [];

    // Start zone
    const startX = rand(115, 285);
    const startY = rand(118, 138);
    const twoStarts = g <= 3 || Math.random() < 0.55;

    if (twoStarts) {
      const gap = rand(46, 68);
      holds.push({
        id: nextUid('h'),
        label: 0,
        x: clamp(startX - gap / 2, 52, WALL_WIDTH_CM - 52),
        y: startY,
        type: g <= 2 ? 'jug' : pick(['jug', 'pinch']),
        role: 'start',
        angle: g <= 1 ? 0 : Math.round(rand(-20, 5)),
        scale: g <= 2 ? 1.12 : 1.0,
        color,
      });
      holds.push({
        id: nextUid('h'),
        label: 0,
        x: clamp(startX + gap / 2, 52, WALL_WIDTH_CM - 52),
        y: startY + rand(-8, 12),
        type: g <= 2 ? 'jug' : pick(['jug', 'pinch', 'sloper']),
        role: 'start',
        angle: g <= 1 ? 0 : Math.round(rand(-5, 22)),
        scale: g <= 2 ? 1.12 : 1.0,
        color,
      });
    } else {
      holds.push({
        id: nextUid('h'),
        label: 0,
        x: startX,
        y: startY,
        type: g <= 3 ? 'jug' : 'pinch',
        role: 'start',
        angle: 0,
        scale: 1.1,
        color,
      });
    }

    // Starting footholds
    holds.push({
      id: nextUid('h'),
      label: 0,
      x: clamp(startX - rand(28, 52), 42, WALL_WIDTH_CM - 42),
      y: rand(38, 56),
      type: 'foothold',
      role: 'normal',
      angle: 0,
      scale: g <= 2 ? 1.12 : 0.95,
      color,
    });
    holds.push({
      id: nextUid('h'),
      label: 0,
      x: clamp(startX + rand(28, 52), 42, WALL_WIDTH_CM - 42),
      y: rand(44, 66),
      type: 'foothold',
      role: 'normal',
      angle: 0,
      scale: g <= 2 ? 1.12 : 0.95,
      color,
    });

    // Build upward zigzag hand progression + matching footholds
    let prevX = startX;
    let prevY = startY;
    let dir = startX > WALL_WIDTH_CM / 2 ? -1 : 1;

    for (let i = 0; i < numMainHands; i++) {
      const progress = (i + 1) / (numMainHands + 1);
      const stepDy = rand(minStepDy, maxStepDy);
      const targetY = clamp(prevY + stepDy, prevY + 34, 348);

      // Zigzag or traverse laterally
      if (Math.random() < 0.72) dir *= -1;
      let targetX = prevX + dir * rand(28, lateralSpread);
      if (targetX < 62 || targetX > WALL_WIDTH_CM - 62) {
        dir *= -1;
        targetX = clamp(prevX + dir * rand(32, lateralSpread * 0.85), 62, WALL_WIDTH_CM - 62);
      }

      const type = pick(handPools[g]);
      // Sidepull angles make sense relative to movement direction!
      let angle = 0;
      if (g >= 2) {
        if (type === 'sloper') {
          angle = Math.round(rand(-18, 18));
        } else {
          // Slight inward pull angle toward wall center / previous stance
          const bias = targetX > prevX ? 1 : -1;
          angle = Math.round(bias * rand(8, maxAngle));
        }
      }

      holds.push({
        id: nextUid('h'),
        label: 0,
        x: Math.round(targetX),
        y: Math.round(targetY),
        type,
        role: 'normal',
        angle,
        scale: clamp(1.12 - g * 0.03 + rand(-0.06, 0.06), 0.84, 1.18),
        color,
      });

      // Add a helpful foothold below this move (or a charcoal volume occasionally on V2+)
      const footY = clamp(targetY - rand(anatomy.heightCm * 0.42, anatomy.heightCm * 0.56), 72, targetY - 48);
      const footX = clamp((prevX + targetX) / 2 + rand(-36, 36), 44, WALL_WIDTH_CM - 44);
      const useVolume = g >= 2 && i === 1 && Math.random() < 0.45;
      holds.push({
        id: nextUid('h'),
        label: 0,
        x: Math.round(footX),
        y: Math.round(footY),
        type: useVolume ? 'volume' : 'foothold',
        role: 'normal',
        angle: useVolume ? Math.round(rand(-14, 14)) : 0,
        scale: useVolume ? 1.0 : clamp(1.06 - g * 0.025, 0.85, 1.12),
        color: useVolume ? '#3D434C' : color,
      });

      // For higher grades or intermediate pacing, add a subtle secondary foot on opposite side
      if (progress < 0.85 && (g <= 4 || Math.random() < 0.6)) {
        const oppFootX = clamp(
          targetX - dir * rand(28, 62),
          44,
          WALL_WIDTH_CM - 44
        );
        const oppFootY = clamp(footY + rand(16, 44), 85, targetY - 38);
        if (holds.every((h) => dist(h, { x: oppFootX, y: oppFootY }) > 32)) {
          holds.push({
            id: nextUid('h'),
            label: 0,
            x: Math.round(oppFootX),
            y: Math.round(oppFootY),
            type: 'foothold',
            role: 'normal',
            angle: 0,
            scale: 0.94,
            color,
          });
        }
      }

      prevX = targetX;
      prevY = targetY;
      if (prevY >= 332) break;
    }

    // Top hold
    const topX = clamp(prevX + rand(-56, 56), 76, WALL_WIDTH_CM - 76);
    const topY = clamp(Math.max(prevY + rand(44, 68), 372), 368, 412);
    holds.push({
      id: nextUid('h'),
      label: 0,
      x: Math.round(topX),
      y: Math.round(topY),
      type: g <= 5 ? 'jug' : pick(['jug', 'pinch', 'sloper']),
      role: 'top',
      angle: 0,
      scale: g <= 3 ? 1.2 : 1.08,
      color,
    });

    // High foothold to allow matching Top cleanly
    const highFootX = clamp(topX + rand(-48, 48), 54, WALL_WIDTH_CM - 54);
    const highFootY = clamp(topY - rand(105, 138), 220, 305);
    if (holds.every((h) => dist(h, { x: highFootX, y: highFootY }) > 28)) {
      holds.push({
        id: nextUid('h'),
        label: 0,
        x: Math.round(highFootX),
        y: Math.round(highFootY),
        type: 'foothold',
        role: 'normal',
        angle: 0,
        scale: 0.96,
        color,
      });
    }

    const numbered = renumberHolds(holds);
    bestHolds = numbered;

    // Verify route is actually solvable by our beam-search solver!
    const sol = suggestBeta(numbered, profile, 22);
    if (sol.solved) {
      break;
    }
  }

  const descriptions: Record<number, string> = {
    0: '大把手直上线路，跨距轻松，适合自由发挥多种脚法。',
    1: '基础节奏线，练习“先踩脚再出手”的流畅攀爬。',
    2: '轻度斜线移动，兼顾把手与捏点转换。',
    3: '引入侧拉点与折返路线，规划好对侧脚点防止开门。',
    4: '抠点与捏点交替，考验合理分配体能与换脚时机。',
    5: '中等以上跨距与方向点，不同身高臂展的解法差异明显。',
    6: '高难圆弧与小抠点组合，重心贴壁与拉扯角度要求严苛。',
    7: '极限定线：大跨距 + 方向性小点，可能需要动态死点（Dyno）或精准高脚！',
  };

  return {
    id: nextUid('route'),
    name: `${pick(gradeNames[g])}`,
    grade: `V${g}`,
    description: descriptions[g],
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
  maxDepth = 20
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
  const beamWidth = 24;

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
          const ev = evaluateMove(node.assignment, limb, target.id, holds, profile);
          if (!ev.feasible) continue;

          const newStamina = node.stamina - ev.staminaCost;
          if (newStamina <= 2) continue;

          const nextAssignment: LimbAssignment = { ...node.assignment, [limb]: target.id };
          const key = stateKey(nextAssignment);
          const prevBestStam = visited.get(key);
          if (prevBestStam !== undefined && prevBestStam >= newStamina - 1) continue;
          visited.set(key, newStamina);

          const step: BetaStep = {
            id: nextUid('step'),
            limb,
            targetHoldId: target.id,
          };
          const steps = [...node.steps, step];

          if (isTopReached(nextAssignment, holds)) {
            return { solved: true, steps, bestProgressY: topTarget.y };
          }

          // Small bonus for alternating limbs naturally
          const altBonus = node.lastLimb !== limb ? 4 : 0;
          const ratingPenalty = ev.rating === 'dyno' ? -8 : ev.rating === 'hard' ? -3 : 0;
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
