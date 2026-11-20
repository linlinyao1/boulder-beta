import { describe, expect, it } from 'vitest';
import { CLIMBER_PRESETS, computeAnatomy, getReferenceClimberForGrade } from './climber';
import { emptyFreeMap } from './contact';
import {
  estimateRouteGrade,
  generateRoute,
  measureRouteDifficulty,
  suggestBeta,
} from './generator';
import { getHoldHitRadius } from './holds';
import { blendPosesRigid, dist, doLegsIntersect } from './ik';
import {
  evaluateBetaSequence,
  evaluateHoldMove,
  evaluateMove,
  getInitialAssignment,
} from './physics';
import { PRESET_ROUTES } from './presets';

describe('Bouldering physics, V1–V11 grades & Kilter wall angle', () => {
  it('solves all preset routes for their grade-appropriate climber tier with zero leg pass-throughs', () => {
    for (const route of PRESET_ROUTES) {
      const gradeNum = Number(route.grade.replace(/[^0-9]/g, '')) || 1;
      const climber = getReferenceClimberForGrade(gradeNum);
      const result = suggestBeta(route.holds, climber, 24, 24, route.wallAngleDeg);
      expect(
        result.solved,
        `Expected preset "${route.name}" (${route.grade} @ ${route.wallAngleDeg}°) to be solvable by ${climber.name}`
      ).toBe(true);
      expect(result.steps.length).toBeGreaterThan(2);

      const init = getInitialAssignment(route.holds, climber);
      const evalSeq = evaluateBetaSequence(
        init,
        result.steps,
        route.holds,
        climber,
        emptyFreeMap(),
        route.wallAngleDeg
      );
      expect(evalSeq.reachesTop).toBe(true);
      expect(evalSeq.firstFailureIndex).toBeNull();

      for (const tr of evalSeq.traces) {
        expect(doLegsIntersect(tr.evaluation.resultingPose)).toBe(false);
      }
    }
  });

  it('enforces real finger-strength gating on steep V8–V10 presets (standard 92 fails, V9/V11 pros solve)', () => {
    const standard = CLIMBER_PRESETS[1]; // grip 92
    const v9Adv = CLIMBER_PRESETS[5]; // grip 132
    const v11Pro = CLIMBER_PRESETS[6]; // grip 154

    const v8 = PRESET_ROUTES.find((r) => r.id === 'preset-v8-moonboard')!;
    const v10 = PRESET_ROUTES.find((r) => r.id === 'preset-v10-roof-micro')!;

    expect(suggestBeta(v8.holds, standard, 20, 16, v8.wallAngleDeg).solved).toBe(false);
    expect(suggestBeta(v8.holds, v9Adv, 24, 24, v8.wallAngleDeg).solved).toBe(true);

    expect(suggestBeta(v10.holds, standard, 20, 16, v10.wallAngleDeg).solved).toBe(false);
    expect(suggestBeta(v10.holds, v11Pro, 24, 24, v10.wallAngleDeg).solved).toBe(true);
  });

  it('increases real physical difficulty & dynamic V-grade when tilting wall steeper (Kilter Board effect)', () => {
    const v3 = PRESET_ROUTES.find((r) => r.id === 'preset-v3-sidepull')!;
    const standard = CLIMBER_PRESETS[1];
    const init = getInitialAssignment(v3.holds, standard);

    const flatMove = evaluateHoldMove(init, 'rh', 'v3-h1', v3.holds, standard, emptyFreeMap(), 0);
    const steepMove = evaluateHoldMove(init, 'rh', 'v3-h1', v3.holds, standard, emptyFreeMap(), 45);

    expect(steepMove.gripScore).toBeLessThan(flatMove.gripScore);
    expect(steepMove.staminaCost).toBeGreaterThan(flatMove.staminaCost);

    const grade0 = estimateRouteGrade(v3.holds, 0);
    const grade45 = estimateRouteGrade(v3.holds, 45);
    expect(grade45.numericGrade).toBeGreaterThan(grade0.numericGrade + 2);
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

  it('supports Single & Double Dyno with foot push-off, cut-loose, and solves V4 Dyno Canyon', () => {
    const dynoRoute = PRESET_ROUTES.find((r) => r.id === 'preset-v4-dyno')!;
    const standard = CLIMBER_PRESETS[1];
    const init = getInitialAssignment(dynoRoute.holds, standard);

    const staticTry = evaluateHoldMove(
      init,
      'rh',
      'vd-catch',
      dynoRoute.holds,
      standard,
      emptyFreeMap(),
      dynoRoute.wallAngleDeg
    );
    expect(staticTry.feasible).toBe(false);

    const doubleDyno = evaluateMove(
      init,
      emptyFreeMap(),
      'rh',
      { kind: 'dyno', holdId: 'vd-catch', bothHands: true },
      dynoRoute.holds,
      standard,
      dynoRoute.wallAngleDeg
    );
    expect(doubleDyno.feasible, doubleDyno.failReason ?? 'double dyno should succeed').toBe(true);
    expect(doubleDyno.isDyno).toBe(true);
    expect(doubleDyno.cutsFeet).toBe(true);

    const noFeetDyno = evaluateMove(
      { ...init, lf: null, rf: null },
      emptyFreeMap(),
      'rh',
      { kind: 'dyno', holdId: 'vd-catch', bothHands: true },
      dynoRoute.holds,
      standard,
      dynoRoute.wallAngleDeg
    );
    expect(noFeetDyno.feasible).toBe(false);

    const tall = CLIMBER_PRESETS[2];
    const tallInit = getInitialAssignment(dynoRoute.holds, tall);
    for (const skipId of ['vd-vol', 'vd-top']) {
      const skipTry = evaluateMove(
        tallInit,
        emptyFreeMap(),
        'rh',
        { kind: 'dyno', holdId: skipId, bothHands: true },
        dynoRoute.holds,
        tall,
        dynoRoute.wallAngleDeg
      );
      expect(skipTry.feasible, `Tall climber should not dyno straight from start to ${skipId}`).toBe(false);
    }

    const sol = suggestBeta(dynoRoute.holds, standard, 24, 24, dynoRoute.wallAngleDeg);
    expect(sol.solved).toBe(true);
    expect(sol.steps.some((s) => s.target.kind === 'dyno')).toBe(true);
  });

  it('allows micro-crimping a foothold with feet supported, while failing without feet or low strength-to-weight', () => {
    const v1 = PRESET_ROUTES[0];
    const standard = CLIMBER_PRESETS[1];
    const init = getInitialAssignment(v1.holds, standard);

    const microCrimp = evaluateHoldMove(init, 'rh', 'v1-f4', v1.holds, standard);
    expect(microCrimp.feasible, microCrimp.failReason ?? 'supported micro-crimp should work').toBe(true);
    expect(microCrimp.rating).toBe('hard');

    const noFeetCrimp = evaluateHoldMove({ ...init, lf: null, rf: null }, 'rh', 'v1-f4', v1.holds, standard);
    expect(noFeetCrimp.feasible).toBe(false);

    const heavyWeak = { name: '重低握', heightCm: 198, apeIndexCm: 0, gripStrength: 66, flexibility: 80 };
    const heavyTry = evaluateHoldMove(init, 'rh', 'v1-f4', v1.holds, heavyWeak);
    expect(heavyTry.feasible).toBe(false);
  });

  it('shows real anthropometric difference between short and long-wingspan climbers on V5 Morpho', () => {
    const morpho = PRESET_ROUTES.find((r) => r.id === 'preset-v5-morpho')!;
    const shortClimber = CLIMBER_PRESETS[0];
    const tallClimber = CLIMBER_PRESETS[2];

    const shortInit = getInitialAssignment(morpho.holds, shortClimber);
    const tallInit = getInitialAssignment(morpho.holds, tallClimber);

    const shortDirect = evaluateHoldMove(
      shortInit,
      'rh',
      'v5-big1',
      morpho.holds,
      shortClimber,
      emptyFreeMap(),
      morpho.wallAngleDeg
    );
    const tallDirect = evaluateHoldMove(
      tallInit,
      'rh',
      'v5-big1',
      morpho.holds,
      tallClimber,
      emptyFreeMap(),
      morpho.wallAngleDeg
    );

    expect(tallDirect.reachRatio).toBeLessThan(shortDirect.reachRatio);
    const shortBeta = suggestBeta(morpho.holds, shortClimber, 24, 24, morpho.wallAngleDeg);
    expect(shortBeta.solved).toBe(true);
  });

  it('calibrates procedural V1 vs V6 vs V10 routes so higher V-grades are measurably harder', () => {
    let v1Sum = 0;
    let v6Sum = 0;
    let v10Sum = 0;
    for (let i = 0; i < 2; i++) {
      const r1 = generateRoute(1);
      const p1 = getReferenceClimberForGrade(1);
      const s1 = suggestBeta(r1.holds, p1, 24, 20, r1.wallAngleDeg);
      expect(s1.solved).toBe(true);
      v1Sum += measureRouteDifficulty(r1.holds, s1.steps, p1, r1.wallAngleDeg).estimatedGrade;

      const r6 = generateRoute(6);
      const p6 = getReferenceClimberForGrade(6);
      const s6 = suggestBeta(r6.holds, p6, 24, 20, r6.wallAngleDeg);
      expect(s6.solved).toBe(true);
      v6Sum += measureRouteDifficulty(r6.holds, s6.steps, p6, r6.wallAngleDeg).estimatedGrade;

      const r10 = generateRoute(10);
      const p10 = getReferenceClimberForGrade(10);
      const s10 = suggestBeta(r10.holds, p10, 24, 20, r10.wallAngleDeg);
      expect(s10.solved).toBe(true);
      v10Sum += measureRouteDifficulty(r10.holds, s10.steps, p10, r10.wallAngleDeg).estimatedGrade;
    }
    expect(v6Sum / 2).toBeGreaterThan(v1Sum / 2 + 2.5);
    expect(v10Sum / 2).toBeGreaterThan(v6Sum / 2 + 2.5);
  });

  it('generates climbable procedural routes across V1..V11 with zero overlapping holds', () => {
    for (const grade of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      const route = generateRoute(grade);
      expect(route.grade).toBe(`V${grade}`);
      expect(route.holds.some((h) => h.role === 'start')).toBe(true);
      expect(route.holds.some((h) => h.role === 'top')).toBe(true);

      for (let i = 0; i < route.holds.length; i++) {
        for (let j = i + 1; j < route.holds.length; j++) {
          const a = route.holds[i];
          const b = route.holds[j];
          const minGap = getHoldHitRadius(a) * 1.15 + getHoldHitRadius(b) * 1.15 + 10;
          expect(
            dist(a, b),
            `Overlap on V${grade} between #${a.label} (${a.type}) and #${b.label} (${b.type})`
          ).toBeGreaterThanOrEqual(minGap);
        }
      }

      const refClimber = getReferenceClimberForGrade(grade);
      const sol = suggestBeta(route.holds, refClimber, 24, 20, route.wallAngleDeg);
      expect(
        sol.solved,
        `Generated V${grade} (${route.wallAngleDeg}°) should be solvable by ${refClimber.name}`
      ).toBe(true);
    }
  });
});
