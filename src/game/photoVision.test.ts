import { describe, expect, it } from 'vitest';
import {
  calibrateRecognizedRoute,
  ColorSample,
  recognizeHoldsFromRectifiedRgba,
  RgbaBuffer,
  samplePatchColor,
  warpRgbaPerspective,
} from './photoVision';
import { Hold, WALL_HEIGHT_CM, WALL_WIDTH_CM } from './types';

function createBuffer(w: number, h: number, bg: [number, number, number]): RgbaBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg[0];
    data[i * 4 + 1] = bg[1];
    data[i * 4 + 2] = bg[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}

function paintEllipse(
  buf: RgbaBuffer,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rgb: [number, number, number],
  opts: { chalkTop?: boolean; shadowBottom?: boolean; darkHole?: boolean } = {}
): void {
  const x0 = Math.max(0, Math.floor(cx - rx - 1));
  const x1 = Math.min(buf.width - 1, Math.ceil(cx + rx + 1));
  const y0 = Math.max(0, Math.floor(cy - ry - 1));
  const y1 = Math.min(buf.height - 1, Math.ceil(cy + ry + 1));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const r2 = nx * nx + ny * ny;
      if (r2 > 1) continue;

      let r = rgb[0];
      let g = rgb[1];
      let b = rgb[2];

      if (opts.chalkTop && ny < -0.3) {
        // Blend chalk white onto upper gripping lip
        const k = Math.min(0.45, (-ny - 0.3) * 0.65);
        r = Math.round(r * (1 - k) + 245 * k);
        g = Math.round(g * (1 - k) + 245 * k);
        b = Math.round(b * (1 - k) + 245 * k);
      }
      if (opts.shadowBottom && ny > 0.35) {
        const k = Math.min(0.35, (ny - 0.35) * 0.55);
        r = Math.round(r * (1 - k));
        g = Math.round(g * (1 - k));
        b = Math.round(b * (1 - k));
      }
      if (opts.darkHole && r2 < 0.22) {
        r = Math.round(r * 0.38);
        g = Math.round(g * 0.38);
        b = Math.round(b * 0.38);
      }

      const i = (y * buf.width + x) * 4;
      buf.data[i] = r;
      buf.data[i + 1] = g;
      buf.data[i + 2] = b;
      buf.data[i + 3] = 255;
    }
  }
}

describe('On-device photo-to-route computer vision & physics calibration', () => {
  it('rectifies a perspective-tilted wall quad accurately to 400x450 coordinates', () => {
    const src = createBuffer(400, 400, [210, 190, 156]);
    // Place a bright red marker at the exact center of a trapezoid quad [ (80,40), (320,40), (360,360), (40,360) ]
    // Wait: projective center (intersection of diagonals) for symmetric trapezoid sits slightly above midpoint y:
    // Diagonal 1: (80,40)->(360,360); Diagonal 2: (320,40)->(40,360) => intersection x=200, y = 40 + 320 * (240 / (240+320)) = 177.14
    paintEllipse(src, 200, 177, 14, 14, [220, 40, 40]);

    const warped = warpRgbaPerspective(
      src,
      [
        { x: 80 / 399, y: 40 / 399 },
        { x: 320 / 399, y: 40 / 399 },
        { x: 360 / 399, y: 360 / 399 },
        { x: 40 / 399, y: 360 / 399 },
      ],
      WALL_WIDTH_CM,
      WALL_HEIGHT_CM
    );

    // Center of warped image (200, 225) should now be red!
    const centerSample = samplePatchColor(warped, 200, 225, 3);
    expect(centerSample.rgb[0]).toBeGreaterThan(190);
    expect(centerSample.rgb[1]).toBeLessThan(80);
  });

  it('segments chalky/shadowed red holds cleanly while ignoring plywood and competing blue route', () => {
    const buf = createBuffer(WALL_WIDTH_CM, WALL_HEIGHT_CM, [212, 192, 158]);

    // Competing blue holds
    paintEllipse(buf, 90, 260, 18, 14, [40, 105, 185], { chalkTop: true });
    paintEllipse(buf, 310, 180, 20, 15, [40, 105, 185], { chalkTop: true });

    // Target coral-red route: 2 footholds, start pinch, crimp, pocket, sloper, top jug
    paintEllipse(buf, 150, 405, 6, 5, [210, 62, 54]); // small foothold
    paintEllipse(buf, 230, 400, 6, 5, [210, 62, 54]); // small foothold
    paintEllipse(buf, 185, 320, 11, 20, [214, 65, 56], { chalkTop: true, shadowBottom: true }); // vertical pinch (Start)
    paintEllipse(buf, 145, 240, 20, 7, [208, 60, 52], { chalkTop: true, shadowBottom: true }); // flat crimp
    paintEllipse(buf, 235, 175, 16, 15, [214, 66, 58], { darkHole: true }); // pocket
    paintEllipse(buf, 190, 70, 20, 14, [216, 68, 58], { chalkTop: true }); // top jug

    const sampled = samplePatchColor(buf, 185, 320, 4);
    const samples: ColorSample[] = [{ x: 185, y: 320, ...sampled, kind: 'include' }];

    const res = recognizeHoldsFromRectifiedRgba(buf, samples, {
      tolerance: 26,
      minHoldAreaPx: 34,
      wallAngleDeg: 10,
      enablePhysicsCalibration: true,
    });

    expect(res.holds.length).toBe(6);
    expect(res.holds.some((h) => h.role === 'start')).toBe(true);
    expect(res.holds.some((h) => h.role === 'top')).toBe(true);
    // Verify distinct hold types were inferred from shape/cavity features
    expect(res.holds.some((h) => h.type === 'foothold')).toBe(true);
    expect(res.holds.some((h) => h.type === 'crimp' || h.type === 'microcrimp')).toBe(true);
    expect(res.holds.some((h) => h.type === 'pocket')).toBe(true);
    expect(res.holds.some((h) => h.type === 'pinch')).toBe(true);
  });

  it('supports achromatic black holds and contrastive negative-sample rejection', () => {
    const buf = createBuffer(WALL_WIDTH_CM, WALL_HEIGHT_CM, [215, 198, 168]);

    // Black route holds
    paintEllipse(buf, 160, 340, 14, 14, [34, 38, 44]);
    paintEllipse(buf, 220, 220, 16, 12, [38, 42, 48]);
    paintEllipse(buf, 190, 90, 18, 14, [32, 36, 42]);
    // Slightly lighter dark-grey distractor to reject via negative sample
    paintEllipse(buf, 310, 240, 15, 15, [88, 92, 96]);

    const inc = samplePatchColor(buf, 160, 340, 4);
    const exc = samplePatchColor(buf, 310, 240, 4);

    const res = recognizeHoldsFromRectifiedRgba(
      buf,
      [
        { x: 160, y: 340, ...inc, kind: 'include' },
        { x: 310, y: 240, ...exc, kind: 'exclude' },
      ],
      {
        tolerance: 28,
        minHoldAreaPx: 30,
        wallAngleDeg: 0,
        enablePhysicsCalibration: false,
      }
    );

    expect(res.holds.length).toBe(3);
    expect(res.holds.every((h) => h.x < 260)).toBe(true);
  });

  it('calibrates noisy CV hold angles via on-device physics solver', () => {
    // Route with intentionally terrible upside-down/off-axis angles on crimps
    const noisyHolds: Hold[] = [
      { id: 'n1', label: 1, x: 155, y: 45, type: 'foothold', role: 'normal', angle: 0, scale: 1.0, color: '#D6453A' },
      { id: 'n2', label: 2, x: 225, y: 48, type: 'foothold', role: 'normal', angle: 0, scale: 1.0, color: '#D6453A' },
      { id: 'n3', label: 3, x: 162, y: 132, type: 'pinch', role: 'start', angle: 120, scale: 1.05, color: '#D6453A' },
      { id: 'n4', label: 4, x: 224, y: 138, type: 'pinch', role: 'start', angle: -120, scale: 1.05, color: '#D6453A' },
      { id: 'n5', label: 5, x: 158, y: 205, type: 'crimp', role: 'normal', angle: 145, scale: 1.0, color: '#D6453A', dualTex: true },
      { id: 'n6', label: 6, x: 220, y: 170, type: 'foothold', role: 'normal', angle: 0, scale: 1.0, color: '#D6453A' },
      { id: 'n7', label: 7, x: 228, y: 268, type: 'crimp', role: 'normal', angle: -140, scale: 1.0, color: '#D6453A', dualTex: true },
      { id: 'n8', label: 8, x: 170, y: 235, type: 'foothold', role: 'normal', angle: 0, scale: 1.0, color: '#D6453A' },
      { id: 'n9', label: 9, x: 196, y: 348, type: 'jug', role: 'top', angle: 0, scale: 1.15, color: '#D6453A' },
    ];

    const cal = calibrateRecognizedRoute(noisyHolds, 10);
    expect(cal.solved).toBe(true);
    expect(cal.estimatedGrade).toMatch(/^V\d+/);
    // Noisy 145° angle on n5 should have been corrected toward natural pull angle
    const fixed5 = cal.holds.find((h) => h.id === 'n5')!;
    expect(Math.abs(fixed5.angle)).toBeLessThan(60);
  });
});
