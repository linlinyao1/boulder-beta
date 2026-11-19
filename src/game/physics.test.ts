import { describe, expect, it } from 'vitest';
import { CLIMBER_PRESETS, computeAnatomy } from './climber';
import { emptyFreeMap } from './contact';
import { generateRoute, suggestBeta } from './generator';
import { blendPosesRigid, dist, doLegsIntersect } from './ik';
import {
  evaluateBetaSequence,
  evaluateHoldMove,
  evaluateMove,
  getInitialAssignment,
} from './physics';
import { PRESET_ROUTES } from './presets';

describe('Bouldering physics & Beta solver', () => {
  it('solves all preset routes for the standard climber with zero leg pass-throughs', () => {
    const standard = CLIMBER_PRESETS[1];
    for (const route of PRESET_ROUTES) {
      const result = suggestBeta(route.holds, standard, 24);
      expect(result.solved, `Expected preset "${route.name}" (${route.grade}) to be solvable`).toBe(true);
      expect(result.steps.length).toBeGreaterThan(2);

      const init = getInitialAssignment(route.holds, standard);
      const evalSeq = evaluateBetaSequence(init, result.steps, route.holds, standard);
      expect(evalSeq.reachesTop).toBe(true);
      expect(evalSeq.firstFailureIndex).toBeNull();

      for (const tr of evalSeq.traces) {
        expect(doLegsIntersect(tr.evaluation.resultingPose)).toBe(false);
      }
    }
  });

  it('rejects inhuman leg crossing (left foot stepping to the right of right foot)', () => {
    const v1 = PRESET_ROUTES[0];
    const standard = CLIMBER_PRESETS[1];
    const init = getInitialAssignment(v1.holds, standard);
    const crossEv = evaluateHoldMove(
      { ...init, lf: 'v1-f1', rf: 'v1-f3' },
      'lf',
      'v1-f4',
      v1.holds,
      standard
    );
    expect(crossEv.feasible).toBe(false);
    expect(crossEv.failReason).toContain('交叉');
  });

  it('keeps 3D bone lengths consistent and avoids excessive sideways knee splay during 2.5D IK', () => {
    const v1 = PRESET_ROUTES[0];
    const standard = CLIMBER_PRESETS[1];
    const anat = computeAnatomy(standard);
    const init = getInitialAssignment(v1.holds, standard);
    const ev = evaluateHoldMove(init, 'lh', 'v1-h1', v1.holds, standard);
    const mid = blendPosesRigid(
      evaluateHoldMove(init, 'lf', 'v1-f3', v1.holds, standard).resultingPose,
      ev.resultingPose,
      0.5,
      anat,
      standard.flexibility
    );

    expect(dist(mid.shoulders.lh, mid.elbows.lh)).toBeLessThanOrEqual(anat.upperArmLen + 0.5);
    expect(dist(mid.elbows.lh, mid.limbs.lh)).toBeLessThanOrEqual(anat.forearmLen + 0.5);
    expect(dist(mid.hips.lf, mid.knees.lf)).toBeLessThanOrEqual(anat.thighLen + 0.5);
    expect(dist(mid.knees.lf, mid.limbs.lf)).toBeLessThanOrEqual(anat.shinLen + 0.5);

    const lf2d = dist(mid.hips.lf, mid.knees.lf);
    const lfZ = mid.jointDepth.lf * anat.thighLen;
    expect(Math.abs(Math.hypot(lf2d, lfZ) - anat.thighLen)).toBeLessThan(1.0);
  });

  it('allows foot smear and dangling flag contacts without requiring a hold', () => {
    const v1 = PRESET_ROUTES[0];
    const standard = CLIMBER_PRESETS[1];
    const init = getInitialAssignment(v1.holds, standard);

    // First free the right foot onto a nearby wall smear under the stance
    const smear = evaluateMove(
      { ...init, rf: null },
      emptyFreeMap(),
      'rf',
      { kind: 'smear', x: 210, y: 70 },
      v1.holds,
      standard
    );
    expect(smear.feasible, smear.failReason ?? 'smear should be feasible').toBe(true);
    expect(smear.warnings.some((w) => w.includes('踩墙') || w.includes('Smear'))).toBe(true);

    // Flag the free left foot for counterbalance while right stays on a hold
    const flag = evaluateMove(
      { ...init, lf: null },
      emptyFreeMap(),
      'lf',
      { kind: 'flag', x: 130, y: 55 },
      v1.holds,
      standard
    );
    expect(flag.feasible, flag.failReason ?? 'flag should be feasible').toBe(true);
    expect(flag.gripScore).toBe(0);

    // Back-flagging right foot behind left standing leg should be allowed (3D depth clearance!)
    const backFlag = evaluateMove(
      { ...init, lf: 'v1-f1', rf: null },
      emptyFreeMap(),
      'rf',
      { kind: 'flag', x: 135, y: 40 },
      v1.holds,
      standard
    );
    expect(backFlag.feasible, backFlag.failReason ?? 'back-flag should be allowed').toBe(true);
  });

  it('shows real anthropometric difference between short and long-wingspan climbers on V5 Morpho', () => {
    const morpho = PRESET_ROUTES.find((r) => r.id === 'preset-v5-morpho')!;
    const shortClimber = CLIMBER_PRESETS[0];
    const tallClimber = CLIMBER_PRESETS[2];

    const shortInit = getInitialAssignment(morpho.holds, shortClimber);
    const tallInit = getInitialAssignment(morpho.holds, tallClimber);

    const shortDirect = evaluateHoldMove(shortInit, 'rh', 'v5-big1', morpho.holds, shortClimber);
    const tallDirect = evaluateHoldMove(tallInit, 'rh', 'v5-big1', morpho.holds, tallClimber);

    expect(tallDirect.reachRatio).toBeLessThan(shortDirect.reachRatio);
    const shortBeta = suggestBeta(morpho.holds, shortClimber, 24);
    expect(shortBeta.solved).toBe(true);
  });

  it('generates climbable procedural routes across V0..V6', () => {
    const standard = CLIMBER_PRESETS[1];
    for (const grade of [0, 2, 4, 6]) {
      const route = generateRoute(grade, standard);
      expect(route.holds.some((h) => h.role === 'start')).toBe(true);
      expect(route.holds.some((h) => h.role === 'top')).toBe(true);
      const sol = suggestBeta(route.holds, standard, 24);
      expect(sol.solved, `Generated V${grade} should be solvable`).toBe(true);
    }
  });
});
