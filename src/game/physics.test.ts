import { describe, expect, it } from 'vitest';
import { CLIMBER_PRESETS, computeAnatomy } from './climber';
import { generateRoute, suggestBeta } from './generator';
import { blendPosesRigid, dist, doLegsIntersect } from './ik';
import { evaluateBetaSequence, evaluateMove, getInitialAssignment } from './physics';
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

      // Verify every single step has anatomically legal non-intersecting legs
      for (const tr of evalSeq.traces) {
        expect(doLegsIntersect(tr.evaluation.resultingPose)).toBe(false);
      }
    }
  });

  it('rejects inhuman leg crossing (left foot stepping to the right of right foot)', () => {
    const v1 = PRESET_ROUTES[0];
    const standard = CLIMBER_PRESETS[1];
    const init = getInitialAssignment(v1.holds, standard);
    // Try moving left foot onto hold v1-h2 (x=238, right side) while right foot is on v1-f2 (x=235) or v1-f4 (x=220)
    const crossEv = evaluateMove(
      { ...init, lf: 'v1-f1', rf: 'v1-f3' }, // rf at x=180
      'lf',
      'v1-f4', // x=220 (far right of rf!)
      v1.holds,
      standard
    );
    expect(crossEv.feasible).toBe(false);
    expect(crossEv.failReason).toContain('交叉');
  });

  it('keeps bone lengths strictly rigid during pose blending', () => {
    const v1 = PRESET_ROUTES[0];
    const standard = CLIMBER_PRESETS[1];
    const anat = computeAnatomy(standard);
    const init = getInitialAssignment(v1.holds, standard);
    const ev = evaluateMove(init, 'lh', 'v1-h1', v1.holds, standard);
    const mid = blendPosesRigid(
      evaluateMove(init, 'lf', 'v1-f3', v1.holds, standard).resultingPose,
      ev.resultingPose,
      0.5,
      anat,
      standard.flexibility
    );

    expect(Math.abs(dist(mid.shoulders.lh, mid.elbows.lh) - anat.upperArmLen)).toBeLessThan(0.5);
    expect(Math.abs(dist(mid.elbows.lh, mid.limbs.lh) - anat.forearmLen)).toBeLessThan(0.5);
    expect(Math.abs(dist(mid.hips.lf, mid.knees.lf) - anat.thighLen)).toBeLessThan(0.5);
    expect(Math.abs(dist(mid.knees.lf, mid.limbs.lf) - anat.shinLen)).toBeLessThan(0.5);
  });

  it('shows real anthropometric difference between short and long-wingspan climbers on V5 Morpho', () => {
    const morpho = PRESET_ROUTES.find((r) => r.id === 'preset-v5-morpho')!;
    const shortClimber = CLIMBER_PRESETS[0]; // 156cm, ape 0
    const tallClimber = CLIMBER_PRESETS[2]; // 188cm, ape +10

    // From start stance, try reaching straight for v5-big1 (252, 244) with right hand
    const shortInit = getInitialAssignment(morpho.holds, shortClimber);
    const tallInit = getInitialAssignment(morpho.holds, tallClimber);

    const shortDirect = evaluateMove(shortInit, 'rh', 'v5-big1', morpho.holds, shortClimber);
    const tallDirect = evaluateMove(tallInit, 'rh', 'v5-big1', morpho.holds, tallClimber);

    expect(tallDirect.reachRatio).toBeLessThan(shortDirect.reachRatio);
    // And short climber can still solve V5 using intermediate holds!
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
