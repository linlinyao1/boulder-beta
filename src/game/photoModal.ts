import { HOLD_SPECS, renumberHolds } from './holds';
import { clamp } from './ik';
import { nextUid } from './generator';
import {
  ColorSample,
  QuadCorners,
  RecognitionResult,
  recognizeHoldsFromRectifiedRgba,
  RgbaBuffer,
  samplePatchColor,
  warpRgbaPerspective,
} from './photoVision';
import { Hold, Vec2, WALL_HEIGHT_CM, WALL_WIDTH_CM } from './types';

export interface PhotoImportPayload {
  holds: Hold[];
  wallAngleDeg: number;
  estimatedGrade: string;
  dominantHex: string;
  overlayCanvas: HTMLCanvasElement;
  description: string;
}

type ModalStage = 'upload' | 'crop' | 'detect';

const DEFAULT_QUAD: QuadCorners = [
  { x: 0.08, y: 0.06 },
  { x: 0.92, y: 0.06 },
  { x: 0.96, y: 0.95 },
  { x: 0.04, y: 0.95 },
];

/**
 * Generates a realistic synthetic tilted gym-wall photo (plywood facets, T-nuts,
 * chalk-dusted red target route + competing blue holds + shadows) so users can test
 * the entire 4-corner homography + CIELAB recognition flow in 1 click without a photo!
 */
function createSampleGymWallCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 720;
  c.height = 840;
  const ctx = c.getContext('2d')!;

  // Gym studio background
  ctx.fillStyle = '#2B3036';
  ctx.fillRect(0, 0, c.width, c.height);

  // Perspective-angled plywood wall quad (simulating upward phone camera angle!)
  const quad = [
    { x: 105, y: 55 },
    { x: 615, y: 55 },
    { x: 665, y: 760 },
    { x: 55, y: 760 },
  ];

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(quad[0].x, quad[0].y);
  ctx.lineTo(quad[1].x, quad[1].y);
  ctx.lineTo(quad[2].x, quad[2].y);
  ctx.lineTo(quad[3].x, quad[3].y);
  ctx.closePath();
  const wallGrad = ctx.createLinearGradient(0, 55, 0, 760);
  wallGrad.addColorStop(0, '#B9A07C');
  wallGrad.addColorStop(0.55, '#CEB793');
  wallGrad.addColorStop(1, '#DFCBA8');
  ctx.fillStyle = wallGrad;
  ctx.fill();
  ctx.clip();

  // Subtle plywood seam lines & gym spotlight gradient
  ctx.strokeStyle = 'rgba(72, 56, 38, 0.22)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(60, 310);
  ctx.lineTo(660, 290);
  ctx.moveTo(50, 540);
  ctx.lineTo(670, 555);
  ctx.stroke();

  const mapWall = (nx: number, ny: number): Vec2 => {
    const topX = quad[0].x + (quad[1].x - quad[0].x) * nx;
    const botX = quad[3].x + (quad[2].x - quad[3].x) * nx;
    const x = topX + (botX - topX) * ny;
    const y = quad[0].y + (quad[3].y - quad[0].y) * ny;
    return { x, y };
  };

  // Helper to paint realistic chalky/shadowed holds on the sample photo
  const paintHold = (
    nx: number,
    ny: number,
    rx: number,
    ry: number,
    rotDeg: number,
    baseColor: string,
    chalk: boolean,
    pocketHole = false
  ) => {
    const p = mapWall(nx, ny);
    const persp = 0.86 + ny * 0.22;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate((rotDeg * Math.PI) / 180);
    ctx.shadowColor = 'rgba(20, 14, 8, 0.42)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 6;

    ctx.beginPath();
    ctx.ellipse(0, 0, rx * persp, ry * persp, 0, 0, Math.PI * 2);
    ctx.fillStyle = baseColor;
    ctx.fill();
    ctx.shadowColor = 'transparent';

    if (chalk) {
      // Simulate real chalk dust on top lip!
      const cg = ctx.createRadialGradient(0, -ry * persp * 0.45, 2, 0, -ry * persp * 0.3, rx * persp * 0.9);
      cg.addColorStop(0, 'rgba(255, 252, 248, 0.62)');
      cg.addColorStop(1, 'rgba(255, 252, 248, 0)');
      ctx.fillStyle = cg;
      ctx.fill();
    }
    if (pocketHole) {
      ctx.beginPath();
      ctx.ellipse(0, -2, rx * persp * 0.42, ry * persp * 0.35, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(42, 12, 10, 0.72)';
      ctx.fill();
    }
    ctx.restore();
  };

  // Competing blue route (tests color separation!)
  const blueHolds: Array<[number, number, number, number, number]> = [
    [0.24, 0.72, 20, 15, -10],
    [0.72, 0.65, 18, 22, 18],
    [0.26, 0.44, 24, 12, -20],
    [0.74, 0.34, 22, 18, 12],
    [0.34, 0.18, 25, 16, 0],
  ];
  for (const [nx, ny, rx, ry, rot] of blueHolds) {
    paintHold(nx, ny, rx, ry, rot, '#2563A8', true);
  }

  // Target Coral-Red V4/V5 route (mix of start pinches, crimps, pocket, sloper, footholds & top!)
  // Footholds
  paintHold(0.36, 0.9, 10, 7, 0, '#C93B32', false);
  paintHold(0.58, 0.88, 10, 7, 0, '#C93B32', false);
  paintHold(0.35, 0.66, 10, 7, 0, '#C93B32', false);
  paintHold(0.6, 0.56, 10, 7, 0, '#C93B32', false);
  paintHold(0.42, 0.4, 10, 7, 0, '#C93B32', false);
  // Start holds
  paintHold(0.38, 0.73, 16, 22, -14, '#D64238', true);
  paintHold(0.55, 0.71, 16, 22, 14, '#D64238', true);
  // Mid holds (crimp, 2-finger pocket, flat crimp, sloper, top!)
  paintHold(0.4, 0.56, 24, 10, -22, '#CF3D33', true);
  paintHold(0.61, 0.46, 21, 17, 15, '#D44137', true, true);
  paintHold(0.42, 0.32, 23, 10, -18, '#CC3A30', true);
  paintHold(0.57, 0.24, 24, 20, 12, '#D8453B', true);
  paintHold(0.49, 0.11, 26, 17, 0, '#D9463C', true);

  ctx.restore();

  // Crash pad at bottom
  ctx.fillStyle = '#1E2329';
  ctx.fillRect(0, 762, c.width, 78);
  return c;
}

export class PhotoRouteModal {
  private backdrop: HTMLDivElement;
  private onImport: (payload: PhotoImportPayload) => void;

  private stage: ModalStage = 'upload';
  private sourceCanvas: HTMLCanvasElement | null = null;
  private quad: QuadCorners = DEFAULT_QUAD.map((p) => ({ ...p })) as QuadCorners;
  private draggingCorner = -1;

  private rectifiedCanvas: HTMLCanvasElement | null = null;
  private rectifiedRgba: RgbaBuffer | null = null;

  private samples: ColorSample[] = [];
  private sampleMode: 'include' | 'exclude' | 'edit' = 'include';
  private tolerance = 26;
  private minHoldAreaPx = 34;
  private wallAngleDeg = 15;
  private enablePhysicsCalibration = true;
  private lastResult: RecognitionResult | null = null;
  private maskOverlayCanvas: HTMLCanvasElement | null = null;

  private cropCanvas: HTMLCanvasElement | null = null;
  private detectCanvas: HTMLCanvasElement | null = null;

  constructor(container: HTMLElement, onImport: (payload: PhotoImportPayload) => void) {
    this.onImport = onImport;
    this.backdrop = document.createElement('div');
    this.backdrop.id = 'ui-photo-modal';
    this.backdrop.className = 'photo-modal-backdrop hidden';
    this.backdrop.setAttribute('role', 'dialog');
    this.backdrop.setAttribute('aria-modal', 'true');
    this.backdrop.setAttribute('aria-label', '拍照识图定线');
    container.appendChild(this.backdrop);

    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) this.close();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.backdrop.classList.contains('hidden')) {
        this.close();
      }
    });
  }

  public open(initialWallAngle = 15): void {
    this.wallAngleDeg = clamp(Math.round(initialWallAngle / 5) * 5, -10, 55);
    this.stage = 'upload';
    this.sourceCanvas = null;
    this.rectifiedCanvas = null;
    this.rectifiedRgba = null;
    this.samples = [];
    this.sampleMode = 'include';
    this.lastResult = null;
    this.quad = DEFAULT_QUAD.map((p) => ({ ...p })) as QuadCorners;
    this.backdrop.classList.remove('hidden');
    this.renderUI();
  }

  public close(): void {
    this.backdrop.classList.add('hidden');
    this.draggingCorner = -1;
  }

  private loadImageFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1080;
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(120, Math.round(img.width * scale));
        c.height = Math.max(120, Math.round(img.height * scale));
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        this.sourceCanvas = c;
        // Auto-trim top status/search bar & bottom caption bar on tall mobile app screenshots (e.g. Xiaohongshu/Douyin)!
        const aspect = c.height / Math.max(1, c.width);
        this.quad =
          aspect > 1.72
            ? [
                { x: 0.02, y: 0.1 },
                { x: 0.98, y: 0.1 },
                { x: 0.98, y: 0.82 },
                { x: 0.02, y: 0.82 },
              ]
            : (DEFAULT_QUAD.map((p) => ({ ...p })) as QuadCorners);
        this.stage = 'crop';
        this.renderUI();
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  }

  private loadDemoPhoto(): void {
    this.sourceCanvas = createSampleGymWallCanvas();
    this.quad = [
      { x: 105 / 720, y: 55 / 840 },
      { x: 615 / 720, y: 55 / 840 },
      { x: 665 / 720, y: 760 / 840 },
      { x: 55 / 720, y: 760 / 840 },
    ];
    this.wallAngleDeg = 15;
    this.stage = 'crop';
    this.renderUI();
  }

  private enterDetectStage(): void {
    if (!this.sourceCanvas) return;
    const sCtx = this.sourceCanvas.getContext('2d')!;
    const sImg = sCtx.getImageData(0, 0, this.sourceCanvas.width, this.sourceCanvas.height);

    const warped = warpRgbaPerspective(
      { data: sImg.data, width: sImg.width, height: sImg.height },
      this.quad,
      WALL_WIDTH_CM,
      WALL_HEIGHT_CM
    );
    this.rectifiedRgba = warped;

    const rCanvas = document.createElement('canvas');
    rCanvas.width = WALL_WIDTH_CM;
    rCanvas.height = WALL_HEIGHT_CM;
    const rCtx = rCanvas.getContext('2d')!;
    const outImgData = new ImageData(new Uint8ClampedArray(warped.data), warped.width, warped.height);
    rCtx.putImageData(outImgData, 0, 0);
    this.rectifiedCanvas = rCanvas;

    this.samples = [];
    this.sampleMode = 'include';
    this.lastResult = null;
    this.stage = 'detect';
    this.renderUI();
  }

  private runRecognition(): void {
    if (!this.rectifiedRgba) return;
    this.lastResult = recognizeHoldsFromRectifiedRgba(this.rectifiedRgba, this.samples, {
      tolerance: this.tolerance,
      minHoldAreaPx: this.minHoldAreaPx,
      wallAngleDeg: this.wallAngleDeg,
      enablePhysicsCalibration: this.enablePhysicsCalibration,
    });
    this.buildMaskOverlayCanvas(this.lastResult);
    this.drawDetectCanvas();
    this.updateDetectTelemetryUI();
  }

  private buildMaskOverlayCanvas(res: RecognitionResult | null): void {
    if (!res?.mask) {
      this.maskOverlayCanvas = null;
      return;
    }
    const mc = document.createElement('canvas');
    mc.width = res.maskWidth;
    mc.height = res.maskHeight;
    const mctx = mc.getContext('2d')!;
    const img = mctx.createImageData(res.maskWidth, res.maskHeight);
    const d = img.data;
    const m = res.mask;
    for (let i = 0, p4 = 0; i < m.length; i++, p4 += 4) {
      if (m[i]) {
        d[p4] = 34;
        d[p4 + 1] = 211;
        d[p4 + 2] = 166;
        d[p4 + 3] = 105;
      }
    }
    mctx.putImageData(img, 0, 0);
    this.maskOverlayCanvas = mc;
  }

  private handleManualHoldEdit(px: number, py: number): void {
    const worldX = Math.round(clamp(px, 22, WALL_WIDTH_CM - 22));
    const worldY = Math.round(clamp(WALL_HEIGHT_CM - py, 22, WALL_HEIGHT_CM - 22));

    if (!this.lastResult) {
      this.lastResult = {
        holds: [],
        details: [],
        dominantHex: '#4E8975',
        estimatedGrade: 'Custom',
        solved: false,
        calibrationNotes: ['已进入手动补点模式'],
        elapsedMs: 1,
        maskWidth: WALL_WIDTH_CM,
        maskHeight: WALL_HEIGHT_CM,
      };
    }

    // Check if tapping an existing hold -> remove it!
    const existing = this.lastResult.holds;
    let hitIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < existing.length; i++) {
      const h = existing[i];
      const hitR = Math.max(16, HOLD_SPECS[h.type].baseRadiusCm * h.scale * 1.2);
      const d = Math.hypot(h.x - worldX, h.y - worldY);
      if (d <= hitR && d < bestDist) {
        bestDist = d;
        hitIdx = i;
      }
    }

    let nextHolds = [...existing];
    if (hitIdx >= 0) {
      nextHolds.splice(hitIdx, 1);
      this.lastResult.calibrationNotes = ['已删除误识别岩点（可继续点击补点或删点）'];
    } else {
      nextHolds.push({
        id: nextUid('phm'),
        label: 0,
        x: worldX,
        y: worldY,
        type: 'crimp',
        role: 'normal',
        angle: 0,
        scale: 1.05,
        color: this.lastResult.dominantHex,
        styleFamily: 'comp',
        shapeVariant: 1,
      });
      this.lastResult.calibrationNotes = ['已手动补加 1 颗岩点（导入定线台后可调点型/角度）'];
    }

    // Ensure Start & TOP exist when >= 2 holds
    if (nextHolds.length >= 2) {
      if (!nextHolds.some((h) => h.role === 'top')) {
        const highest = [...nextHolds].sort((a, b) => b.y - a.y)[0];
        highest.role = 'top';
      }
      if (!nextHolds.some((h) => h.role === 'start')) {
        const lowest = [...nextHolds].filter((h) => h.role !== 'top').sort((a, b) => a.y - b.y)[0];
        if (lowest) lowest.role = 'start';
      }
    }

    this.lastResult.holds = renumberHolds(nextHolds);
    this.drawDetectCanvas();
    this.updateDetectTelemetryUI();
  }

  private renderUI(): void {
    const stepBadge = (s: ModalStage, num: string, label: string) =>
      `<span class="pm-step ${this.stage === s ? 'active' : ''}">${num}. ${label}</span>`;

    this.backdrop.innerHTML = `
      <div class="photo-modal">
        <div class="photo-modal-head">
          <div>
            <div class="section-title">实景拍照 / 识图定线（端侧本地引擎）</div>
            <div class="pm-steps">
              ${stepBadge('upload', '1', '拍照或选图')}
              ${stepBadge('crop', '2', '四角透视矫正')}
              ${stepBadge('detect', '3', '点选色块自动扣点')}
            </div>
          </div>
          <button id="pm-close" class="btn btn-sm">关闭</button>
        </div>

        <div class="photo-modal-body" id="pm-body">
          ${this.renderStageHtml()}
        </div>
      </div>
    `;

    this.backdrop.querySelector('#pm-close')?.addEventListener('click', () => this.close());
    this.bindStageEvents();
  }

  private renderStageHtml(): string {
    if (this.stage === 'upload') {
      return `
        <div class="pm-dropzone" id="pm-dropzone">
          <div class="pm-drop-icon">◫</div>
          <div class="pm-drop-title">上传或拍摄真实岩馆抱石线路照片</div>
          <div class="pm-drop-sub">
            100% 浏览器本地端智能运行（CIELAB 抗镁粉取色 + 透视矫正 + 物理闭环校准），照片不上传任何服务器。
          </div>
          <div class="pm-upload-actions">
            <label class="btn btn-primary" style="cursor:pointer;">
              现场拍照（调用相机）
              <input id="pm-camera-input" type="file" accept="image/*" capture="environment" style="display:none;" />
            </label>
            <label class="btn" style="cursor:pointer;">
              从相册 / 本地选图
              <input id="pm-file-input" type="file" accept="image/*" style="display:none;" />
            </label>
          </div>
          <div class="pm-demo-row">
            <button id="pm-demo-btn" class="btn btn-sm">使用内置岩馆样张体验识别流程 →</button>
          </div>
        </div>
      `;
    }

    if (this.stage === 'crop') {
      return `
        <div class="pm-workspace">
          <div class="pm-canvas-box">
            <canvas id="pm-crop-canvas" class="pm-stage-canvas"></canvas>
            <div class="pm-canvas-tip">拖动 4 个蓝色角点对齐岩壁四边，消除仰拍透视畸变</div>
          </div>
          <div class="pm-controls">
            <div class="section-sub" style="margin-bottom:6px;">拍摄岩壁大概倾角</div>
            <div class="angle-chip-row" style="margin-bottom:12px;">
              ${[-5, 0, 10, 15, 25, 35, 45]
                .map(
                  (deg) =>
                    `<button class="angle-chip ${this.wallAngleDeg === deg ? 'active' : ''}" data-pm-angle="${deg}">${deg}°</button>`
                )
                .join('')}
            </div>

            <div class="pm-info-card">
              <strong>拍摄框选小技巧</strong>
              <ul>
                <li>上边对齐墙顶（约 4.5m），下边对齐海绵垫上方墙脚。</li>
                <li>对齐越精准，还原出的点距和身高臂展物理模拟越真实。</li>
              </ul>
            </div>

            <div class="pm-footer-btns">
              <button id="pm-back-upload" class="btn btn-sm">重选照片</button>
              <button id="pm-reset-quad" class="btn btn-sm">重置四角</button>
              <button id="pm-next-detect" class="btn btn-primary" style="flex:1;">透视矫正并取色 →</button>
            </div>
          </div>
        </div>
      `;
    }

    // Stage 3: detect
    return `
      <div class="pm-workspace">
        <div class="pm-canvas-box">
          <canvas id="pm-detect-canvas" class="pm-stage-canvas"></canvas>
          <div class="pm-canvas-tip" id="pm-detect-tip">
            点击图片上目标线路的任意 1 颗岩点，立即自动提取全墙同色岩点（可点多颗沾粉/背光点增强识别）
          </div>
        </div>
        <div class="pm-controls">
          <div class="section-sub" style="margin-bottom:6px;">交互模式（取色 / 手动增删岩点）</div>
          <div class="role-row" style="margin-bottom:10px;">
            <button id="pm-mode-inc" class="btn btn-sm ${this.sampleMode === 'include' ? 'btn-primary' : ''}">+ 选岩点色</button>
            <button id="pm-mode-exc" class="btn btn-sm ${this.sampleMode === 'exclude' ? 'btn-danger' : ''}">− 排除杂色</button>
            <button id="pm-mode-edit" class="btn btn-sm ${this.sampleMode === 'edit' ? 'btn-primary' : ''}">✎ 补点/删点</button>
            <button id="pm-clear-samples" class="btn btn-sm">清空</button>
          </div>

          <div id="pm-sample-chips" class="pm-sample-chips"></div>

          <div class="slider-grid" style="margin-top:8px;">
            <label class="slider-row">
              <div class="slider-label-row">
                <span>色差容忍度（沾粉多可调高）</span>
                <span id="pm-tol-val" class="slider-val">${this.tolerance}</span>
              </div>
              <input id="pm-tol-slider" type="range" min="12" max="54" step="1" value="${this.tolerance}" />
            </label>

            <label class="slider-row">
              <div class="slider-label-row">
                <span>最小噪点面积过滤</span>
                <span id="pm-area-val" class="slider-val">${this.minHoldAreaPx} px²</span>
              </div>
              <input id="pm-area-slider" type="range" min="16" max="110" step="2" value="${this.minHoldAreaPx}" />
            </label>
          </div>

          <label class="pm-check-row">
            <input id="pm-cal-toggle" type="checkbox" ${this.enablePhysicsCalibration ? 'checked' : ''} />
            <span>开启端侧物理闭环校准（自动优化发力角度并估算 V 级）</span>
          </label>

          <div id="pm-telemetry" class="pm-telemetry">
            等待点选目标线路岩点…
          </div>

          <div class="pm-footer-btns">
            <button id="pm-back-crop" class="btn btn-sm">← 调四角</button>
            <button id="pm-import-btn" class="btn btn-primary" style="flex:1;" disabled>导入到定线台（带半透明底图）</button>
          </div>
        </div>
      </div>
    `;
  }

  private bindStageEvents(): void {
    if (this.stage === 'upload') {
      const camIn = this.backdrop.querySelector<HTMLInputElement>('#pm-camera-input');
      const fileIn = this.backdrop.querySelector<HTMLInputElement>('#pm-file-input');
      const dropzone = this.backdrop.querySelector<HTMLDivElement>('#pm-dropzone');
      const demoBtn = this.backdrop.querySelector<HTMLButtonElement>('#pm-demo-btn');

      const onFile = (input: HTMLInputElement | null) => {
        const f = input?.files?.[0];
        if (f) this.loadImageFile(f);
      };
      camIn?.addEventListener('change', () => onFile(camIn));
      fileIn?.addEventListener('change', () => onFile(fileIn));
      demoBtn?.addEventListener('click', () => this.loadDemoPhoto());

      dropzone?.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
      dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
      dropzone?.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        const f = e.dataTransfer?.files?.[0];
        if (f && f.type.startsWith('image/')) this.loadImageFile(f);
      });
      return;
    }

    if (this.stage === 'crop') {
      this.cropCanvas = this.backdrop.querySelector<HTMLCanvasElement>('#pm-crop-canvas');
      if (this.cropCanvas && this.sourceCanvas) {
        this.cropCanvas.width = this.sourceCanvas.width;
        this.cropCanvas.height = this.sourceCanvas.height;
        this.bindCropPointerEvents(this.cropCanvas);
        this.drawCropCanvas();
      }

      this.backdrop.querySelectorAll<HTMLButtonElement>('[data-pm-angle]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.wallAngleDeg = Number(btn.dataset.pmAngle);
          this.backdrop.querySelectorAll('[data-pm-angle]').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });

      this.backdrop.querySelector('#pm-back-upload')?.addEventListener('click', () => {
        this.stage = 'upload';
        this.renderUI();
      });
      this.backdrop.querySelector('#pm-reset-quad')?.addEventListener('click', () => {
        this.quad = DEFAULT_QUAD.map((p) => ({ ...p })) as QuadCorners;
        this.drawCropCanvas();
      });
      this.backdrop.querySelector('#pm-next-detect')?.addEventListener('click', () => {
        this.enterDetectStage();
      });
      return;
    }

    // Stage 3: detect
    this.detectCanvas = this.backdrop.querySelector<HTMLCanvasElement>('#pm-detect-canvas');
    if (this.detectCanvas) {
      this.detectCanvas.width = WALL_WIDTH_CM;
      this.detectCanvas.height = WALL_HEIGHT_CM;
      this.drawDetectCanvas();

      this.detectCanvas.addEventListener('pointerdown', (e) => {
        if (!this.rectifiedRgba || !this.detectCanvas) return;
        const rect = this.detectCanvas.getBoundingClientRect();
        const px = clamp(((e.clientX - rect.left) / rect.width) * WALL_WIDTH_CM, 2, WALL_WIDTH_CM - 3);
        const py = clamp(((e.clientY - rect.top) / rect.height) * WALL_HEIGHT_CM, 2, WALL_HEIGHT_CM - 3);

        if (this.sampleMode === 'edit' && e.button !== 2) {
          this.handleManualHoldEdit(px, py);
          return;
        }

        const sampled = samplePatchColor(this.rectifiedRgba, px, py, 4);
        const kind: 'include' | 'exclude' = e.button === 2 ? 'exclude' : this.sampleMode === 'exclude' ? 'exclude' : 'include';
        this.samples.push({
          x: px,
          y: py,
          rgb: sampled.rgb,
          lab: sampled.lab,
          kind,
        });
        this.runRecognition();
      });
      this.detectCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    const syncModeButtons = () => {
      this.backdrop.querySelector('#pm-mode-inc')?.classList.toggle('btn-primary', this.sampleMode === 'include');
      this.backdrop.querySelector('#pm-mode-exc')?.classList.toggle('btn-danger', this.sampleMode === 'exclude');
      this.backdrop.querySelector('#pm-mode-edit')?.classList.toggle('btn-primary', this.sampleMode === 'edit');
      const tip = this.backdrop.querySelector('#pm-detect-tip');
      if (tip) {
        tip.textContent =
          this.sampleMode === 'edit'
            ? '手动微调模式：点击已识别岩点直接删除，点击空白处手动补一颗岩点（适合被攀爬者挡住的点）'
            : this.sampleMode === 'exclude'
              ? '排除杂色模式：点击误识别的背景墙/其他色点，立即将其从识别结果中剔除'
              : '点击图片上目标线路的任意 1 颗岩点，立即自动提取全墙同色岩点（支持双色墙/沾粉/阴影）';
      }
    };

    this.backdrop.querySelector('#pm-mode-inc')?.addEventListener('click', () => {
      this.sampleMode = 'include';
      syncModeButtons();
    });
    this.backdrop.querySelector('#pm-mode-exc')?.addEventListener('click', () => {
      this.sampleMode = 'exclude';
      syncModeButtons();
    });
    this.backdrop.querySelector('#pm-mode-edit')?.addEventListener('click', () => {
      this.sampleMode = 'edit';
      syncModeButtons();
    });
    this.backdrop.querySelector('#pm-clear-samples')?.addEventListener('click', () => {
      this.samples = [];
      this.lastResult = null;
      this.maskOverlayCanvas = null;
      this.drawDetectCanvas();
      this.updateDetectTelemetryUI();
    });

    const tolSlider = this.backdrop.querySelector<HTMLInputElement>('#pm-tol-slider');
    const areaSlider = this.backdrop.querySelector<HTMLInputElement>('#pm-area-slider');
    const calToggle = this.backdrop.querySelector<HTMLInputElement>('#pm-cal-toggle');

    tolSlider?.addEventListener('input', () => {
      this.tolerance = Number(tolSlider.value);
      const lbl = this.backdrop.querySelector('#pm-tol-val');
      if (lbl) lbl.textContent = String(this.tolerance);
      if (this.samples.some((s) => s.kind === 'include')) this.runRecognition();
    });

    areaSlider?.addEventListener('input', () => {
      this.minHoldAreaPx = Number(areaSlider.value);
      const lbl = this.backdrop.querySelector('#pm-area-val');
      if (lbl) lbl.textContent = `${this.minHoldAreaPx} px²`;
      if (this.samples.some((s) => s.kind === 'include')) this.runRecognition();
    });

    calToggle?.addEventListener('change', () => {
      this.enablePhysicsCalibration = calToggle.checked;
      if (this.samples.some((s) => s.kind === 'include')) this.runRecognition();
    });

    this.backdrop.querySelector('#pm-back-crop')?.addEventListener('click', () => {
      this.stage = 'crop';
      this.renderUI();
    });

    this.backdrop.querySelector('#pm-import-btn')?.addEventListener('click', () => {
      if (!this.lastResult || !this.rectifiedCanvas || this.lastResult.holds.length === 0) return;
      const overlayCopy = document.createElement('canvas');
      overlayCopy.width = this.rectifiedCanvas.width;
      overlayCopy.height = this.rectifiedCanvas.height;
      overlayCopy.getContext('2d')!.drawImage(this.rectifiedCanvas, 0, 0);

      const noteStr = this.lastResult.calibrationNotes[0] ?? '已从实景岩壁照片自动提取岩点';
      this.onImport({
        holds: this.lastResult.holds,
        wallAngleDeg: this.wallAngleDeg,
        estimatedGrade: this.lastResult.estimatedGrade,
        dominantHex: this.lastResult.dominantHex,
        overlayCanvas: overlayCopy,
        description: `实景照片识图生成（${this.lastResult.holds.length}点 · ${this.wallAngleDeg}°）：${noteStr}。可在定线台对照半透明原图微调。`,
      });
      this.close();
    });

    this.updateDetectTelemetryUI();
  }

  private bindCropPointerEvents(canvas: HTMLCanvasElement): void {
    const getNorm = (e: PointerEvent): Vec2 => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: clamp((e.clientX - rect.left) / rect.width, 0.01, 0.99),
        y: clamp((e.clientY - rect.top) / rect.height, 0.01, 0.99),
      };
    };

    canvas.addEventListener('pointerdown', (e) => {
      const pt = getNorm(e);
      let bestIdx = -1;
      let bestD = 0.09; // generous touch hit radius
      this.quad.forEach((c, idx) => {
        const d = Math.hypot(c.x - pt.x, c.y - pt.y);
        if (d < bestD) {
          bestD = d;
          bestIdx = idx;
        }
      });
      if (bestIdx >= 0) {
        this.draggingCorner = bestIdx;
        canvas.setPointerCapture(e.pointerId);
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (this.draggingCorner < 0) return;
      this.quad[this.draggingCorner] = getNorm(e);
      this.drawCropCanvas();
    });

    const endDrag = () => {
      this.draggingCorner = -1;
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
  }

  private drawCropCanvas(): void {
    if (!this.cropCanvas || !this.sourceCanvas) return;
    const ctx = this.cropCanvas.getContext('2d')!;
    const w = this.cropCanvas.width;
    const h = this.cropCanvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.sourceCanvas, 0, 0, w, h);

    // Dim area outside the selected wall quadrilateral
    const pts = this.quad.map((p) => ({ x: p.x * w, y: p.y * h }));
    ctx.save();
    ctx.fillStyle = 'rgba(15, 20, 26, 0.48)';
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[3].x, pts[3].y);
    ctx.lineTo(pts[2].x, pts[2].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.closePath();
    ctx.fill('evenodd');

    // Subtle 3x3 perspective alignment grid inside quad
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = Math.max(1, w / 480);
    for (let t = 1; t <= 2; t++) {
      const f = t / 3;
      const topX = pts[0].x + (pts[1].x - pts[0].x) * f;
      const topY = pts[0].y + (pts[1].y - pts[0].y) * f;
      const botX = pts[3].x + (pts[2].x - pts[3].x) * f;
      const botY = pts[3].y + (pts[2].y - pts[3].y) * f;
      ctx.beginPath();
      ctx.moveTo(topX, topY);
      ctx.lineTo(botX, botY);
      ctx.stroke();

      const leftX = pts[0].x + (pts[3].x - pts[0].x) * f;
      const leftY = pts[0].y + (pts[3].y - pts[0].y) * f;
      const rightX = pts[1].x + (pts[2].x - pts[1].x) * f;
      const rightY = pts[1].y + (pts[2].y - pts[1].y) * f;
      ctx.beginPath();
      ctx.moveTo(leftX, leftY);
      ctx.lineTo(rightX, rightY);
      ctx.stroke();
    }

    // Crisp wall boundary outline
    ctx.strokeStyle = '#38BDF8';
    ctx.lineWidth = Math.max(2.2, w / 240);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.lineTo(pts[2].x, pts[2].y);
    ctx.lineTo(pts[3].x, pts[3].y);
    ctx.closePath();
    ctx.stroke();

    // 4 draggable corner handles
    const handleR = Math.max(11, w * 0.022);
    const labels = ['左上', '右上', '右下', '左下'];
    pts.forEach((p, idx) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, handleR, 0, Math.PI * 2);
      ctx.fillStyle = '#0284C7';
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = Math.max(2.5, w / 260);
      ctx.stroke();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = `700 ${Math.round(handleR * 0.72)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(labels[idx], p.x, p.y);
    });
    ctx.restore();
  }

  private drawDetectCanvas(): void {
    if (!this.detectCanvas || !this.rectifiedCanvas) return;
    const ctx = this.detectCanvas.getContext('2d')!;
    const w = this.detectCanvas.width;
    const h = this.detectCanvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.rectifiedCanvas, 0, 0, w, h);

    // Translucent live pixel-mask preview so the user sees exact segmented hold pixels
    if (this.maskOverlayCanvas) {
      ctx.drawImage(this.maskOverlayCanvas, 0, 0, w, h);
    }

    // Draw recognized hold overlays
    if (this.lastResult) {
      for (const hld of this.lastResult.holds) {
        const px = (hld.x / WALL_WIDTH_CM) * w;
        const py = (1 - hld.y / WALL_HEIGHT_CM) * h;
        const r = Math.max(11, HOLD_SPECS[hld.type].baseRadiusCm * hld.scale * 1.15);

        ctx.save();
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fillStyle =
          hld.role === 'top'
            ? 'rgba(220, 38, 38, 0.22)'
            : hld.role === 'start'
              ? 'rgba(22, 163, 74, 0.24)'
              : hld.role === 'startFoot'
                ? 'rgba(2, 132, 199, 0.24)'
                : 'rgba(100, 116, 139, 0.18)';
        ctx.fill();
        ctx.strokeStyle =
          hld.role === 'top'
            ? '#EF4444'
            : hld.role === 'start'
              ? '#22C55E'
              : hld.role === 'startFoot'
                ? '#0EA5E9'
                : '#94A3B8';
        ctx.lineWidth = 2.2;
        ctx.stroke();

        // Compact label pill
        const tag =
          hld.role === 'top'
            ? `TOP`
            : hld.role === 'start'
              ? `手S·${HOLD_SPECS[hld.type].shortZh}`
              : hld.role === 'startFoot'
                ? `脚S·${HOLD_SPECS[hld.type].shortZh}`
                : `${hld.label}·${HOLD_SPECS[hld.type].shortZh}`;
        ctx.font = '700 10px "Inter", "PingFang SC", sans-serif';
        const tw = ctx.measureText(tag).width + 8;
        ctx.fillStyle =
          hld.role === 'top'
            ? '#DC2626'
            : hld.role === 'start'
              ? '#15803D'
              : hld.role === 'startFoot'
                ? '#0284C7'
                : 'rgba(24, 29, 34, 0.85)';
        ctx.beginPath();
        ctx.roundRect(px - tw / 2, py - r - 15, tw, 14, 4);
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tag, px, py - r - 8);
        ctx.restore();
      }
    }

    // Draw sampled color pins (+ include / - exclude)
    for (const s of this.samples) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]})`;
      ctx.fill();
      ctx.strokeStyle = s.kind === 'include' ? '#22C55E' : '#EF4444';
      ctx.lineWidth = 2.4;
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 10px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.kind === 'include' ? '+' : '−', s.x, s.y + 0.5);
      ctx.restore();
    }
  }

  private updateDetectTelemetryUI(): void {
    const chips = this.backdrop.querySelector('#pm-sample-chips');
    const tele = this.backdrop.querySelector('#pm-telemetry');
    const importBtn = this.backdrop.querySelector<HTMLButtonElement>('#pm-import-btn');

    if (chips) {
      chips.innerHTML =
        this.samples.length === 0
          ? `<span class="section-sub">尚未取色：请直接点击左侧照片里的目标岩点</span>`
          : this.samples
              .map(
                (s, idx) => `
              <button class="pm-swatch-chip ${s.kind}" data-rm-sample="${idx}" title="点击移除该色样">
                <span class="pm-swatch-dot" style="background:rgb(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]});"></span>
                <span>${s.kind === 'include' ? '正' : '排'}</span>
              </button>`
              )
              .join('');

      chips.querySelectorAll<HTMLButtonElement>('[data-rm-sample]').forEach((b) => {
        b.addEventListener('click', () => {
          const idx = Number(b.dataset.rmSample);
          this.samples.splice(idx, 1);
          if (this.samples.some((s) => s.kind === 'include')) this.runRecognition();
          else {
            this.lastResult = null;
            this.drawDetectCanvas();
            this.updateDetectTelemetryUI();
          }
        });
      });
    }

    if (tele) {
      if (!this.lastResult || this.lastResult.holds.length === 0) {
        tele.innerHTML = `<span class="section-sub">点击目标线路任意岩点后，端侧引擎将在 &lt;150ms 内完成分割与定级。</span>`;
      } else {
        const res = this.lastResult;
        const dualCount = res.holds.filter((h) => h.dualTex).length;
        const pocketCount = res.holds.filter((h) => h.type === 'pocket').length;
        const statusCls = res.solved ? 'ok' : 'warn';
        tele.innerHTML = `
          <div class="pm-tele-row">
            <span class="pm-badge ${statusCls}">${res.solved ? '物理验通' : '待微调'}</span>
            <strong>${res.holds.length} 颗岩点</strong>
            <span class="mono">估测 ${res.estimatedGrade}</span>
            <span class="mono" style="margin-left:auto;opacity:0.65;">${res.elapsedMs}ms</span>
          </div>
          <div class="pm-tele-note">
            ${res.calibrationNotes[0] ?? ''}${
              pocketCount > 0 || dualCount > 0
                ? `（含 ${pocketCount > 0 ? `口袋点×${pocketCount} ` : ''}${dualCount > 0 ? `双纹理×${dualCount}` : ''}）`
                : ''
            }
          </div>
        `;
      }
    }

    if (importBtn) {
      const ok = Boolean(this.lastResult && this.lastResult.holds.length >= 2);
      importBtn.disabled = !ok;
      importBtn.textContent = ok
        ? `导入 ${this.lastResult!.holds.length} 颗岩点到定线台（带底图）`
        : '请先点击岩点完成识别';
    }
  }
}
