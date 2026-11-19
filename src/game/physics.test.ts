import { describe, expect, it } from 'vitest';
import { CLIMBER_PRESETS } from './climber';
import { generateRoute, suggestBeta } from './generator';
import { evaluateBetaSequence, evaluateMove, getInitialAssignment } from './physics';
import { PRESET_ROUTES } from './presets';

describe('Bouldering physics & Beta solver', () => {
  it('solves all preset routes for the standard climber', () => {
    const standard = CLIMBER_PRESETS[1];
    for (const route of PRESET_ROUTES) {
      const result = suggestBeta(route.holds, standard, 24);
      expect(result.solved, `Expected preset "${route.name}" (${route.grade}) to be solvable`).toBe(true);
      expect(result.steps.length).toBeGreaterThan(2);

      const init = getInitialAssignment(route.holds, standard);
      const evalSeq = evaluateBetaSequence(init, result.steps, route.holds, standard);
      expect(evalSeq.reachesTop).toBe(true);
      expect(evalSeq.firstFailureIndex).toBeNull();
    }
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
