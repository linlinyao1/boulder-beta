import './style.css';
import { CLIMBER_PRESETS, computeAnatomy } from './game/climber';
import { targetLabel } from './game/contact';
import { BoulderEngine, EngineSnapshot } from './game/engine';
import { ALL_LIMBS, HOLD_COLORS, HOLD_SPECS, LIMB_META } from './game/holds';
import { PRESET_ROUTES } from './game/presets';
import { HoldRole, HoldType, PlanContactMode } from './game/types';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand-group">
        <div class="brand-mark">
          <span class="brand-dot"></span>
          <span>BETA 抱石台</span>
        </div>
        <div class="route-meta">
          <span id="ui-grade-pill" class="grade-pill">V1</span>
          <span id="ui-route-title" class="route-title">阶梯热身线</span>
        </div>
      </div>

      <nav class="mode-tabs" aria-label="工作模式">
        <button class="mode-tab" data-mode="setter">1. 定线设置</button>
        <button class="mode-tab active" data-mode="plan">2. 规划 Beta</button>
        <button class="mode-tab" data-mode="climb">3. 攀爬演练</button>
      </nav>

      <div class="route-actions">
        <select id="ui-preset-select" class="select-input" title="选择预设经典线路">
          <option value="" disabled>经典线路…</option>
          ${PRESET_ROUTES.map(
            (r, idx) => `<option value="${idx}">${r.grade} · ${r.name}</option>`
          ).join('')}
        </select>

        <div class="gen-inline">
          <select id="ui-gen-grade" class="select-input" title="选择随机生成难度">
            <option value="0">V0 入门</option>
            <option value="1">V1 简单</option>
            <option value="2">V2 初阶</option>
            <option value="3" selected>V3 中阶</option>
            <option value="4">V4 进阶</option>
            <option value="5">V5 困难</option>
            <option value="6">V6 高难</option>
            <option value="7">V7 极限</option>
          </select>
          <button id="ui-gen-btn" class="btn btn-sm btn-primary">随机生成</button>
        </div>

        <button id="ui-clear-wall" class="btn btn-sm" title="清空岩墙自行定线">清空岩壁</button>
      </div>
    </header>

    <main class="workspace">
      <section class="stage-wrap">
        <div id="ui-stage-top-dock" class="stage-top-dock"></div>
        <div class="canvas-container">
          <canvas id="wall-canvas"></canvas>
        </div>
        <div id="ui-stage-bottom-pill" class="stage-bottom-pill hidden"></div>
        <div id="ui-result-overlay" class="result-overlay" style="display:none;"></div>
      </section>

      <aside class="sidebar">
        <!-- Persistent Climber Body Section -->
        <section class="sidebar-section" id="ui-body-section">
          <div class="section-head">
            <div>
              <div class="section-title">攀岩者体型与能力</div>
              <div id="ui-body-summary" class="section-sub mono">172cm · 臂展 174cm (+2)</div>
            </div>
            <button id="ui-body-collapse" class="collapse-toggle">收起</button>
          </div>
          <div id="ui-body-controls">
            <div class="body-presets" id="ui-body-presets">
              ${CLIMBER_PRESETS.map(
                (p, i) => `
                <button class="preset-chip" data-preset="${i}">
                  <span class="preset-chip-name">${p.name}</span>
                  <span class="preset-chip-meta">${p.heightCm}cm / 猿猴${p.apeIndexCm >= 0 ? '+' : ''}${p.apeIndexCm}</span>
                </button>`
              ).join('')}
            </div>

            <div class="slider-grid">
              <label class="slider-row">
                <div class="slider-label-row">
                  <span>身高 (Height)</span>
                  <span id="val-height" class="slider-val">172 cm</span>
                </div>
                <input id="sl-height" type="range" min="145" max="205" step="1" value="172" />
              </label>

              <label class="slider-row">
                <div class="slider-label-row">
                  <span>臂展差 / 猿猴指数 (Ape Index)</span>
                  <span id="val-ape" class="slider-val">+2 cm</span>
                </div>
                <input id="sl-ape" type="range" min="-10" max="16" step="1" value="2" />
              </label>

              <label class="slider-row">
                <div class="slider-label-row">
                  <span>指力与握力 (Grip)</span>
                  <span id="val-grip" class="slider-val">92</span>
                </div>
                <input id="sl-grip" type="range" min="65" max="120" step="1" value="92" />
              </label>

              <label class="slider-row">
                <div class="slider-label-row">
                  <span>髋部柔韧度 (Flexibility)</span>
                  <span id="val-flex" class="slider-val">92</span>
                </div>
                <input id="sl-flex" type="range" min="65" max="120" step="1" value="92" />
              </label>
            </div>

            <div class="anatomy-readout" id="ui-anatomy-readout"></div>
          </div>
        </section>

        <!-- Dynamic Mode Inspector -->
        <section class="sidebar-section" id="ui-mode-panel" style="flex:1;"></section>
      </aside>
    </main>
  </div>
`;

const canvas = document.querySelector<HTMLCanvasElement>('#wall-canvas')!;
const gradePill = document.querySelector<HTMLSpanElement>('#ui-grade-pill')!;
const routeTitle = document.querySelector<HTMLSpanElement>('#ui-route-title')!;
const presetSelect = document.querySelector<HTMLSelectElement>('#ui-preset-select')!;
const genGradeSelect = document.querySelector<HTMLSelectElement>('#ui-gen-grade')!;
const genBtn = document.querySelector<HTMLButtonElement>('#ui-gen-btn')!;
const clearWallBtn = document.querySelector<HTMLButtonElement>('#ui-clear-wall')!;
const stageTopDock = document.querySelector<HTMLDivElement>('#ui-stage-top-dock')!;
const stageBottomPill = document.querySelector<HTMLDivElement>('#ui-stage-bottom-pill')!;
const resultOverlay = document.querySelector<HTMLDivElement>('#ui-result-overlay')!;
const modePanel = document.querySelector<HTMLElement>('#ui-mode-panel')!;

// Body controls
const bodySummary = document.querySelector<HTMLDivElement>('#ui-body-summary')!;
const bodyCollapseBtn = document.querySelector<HTMLButtonElement>('#ui-body-collapse')!;
const bodyControls = document.querySelector<HTMLDivElement>('#ui-body-controls')!;
const bodyPresetsWrap = document.querySelector<HTMLDivElement>('#ui-body-presets')!;
const anatomyReadout = document.querySelector<HTMLDivElement>('#ui-anatomy-readout')!;
const slHeight = document.querySelector<HTMLInputElement>('#sl-height')!;
const slApe = document.querySelector<HTMLInputElement>('#sl-ape')!;
const slGrip = document.querySelector<HTMLInputElement>('#sl-grip')!;
const slFlex = document.querySelector<HTMLInputElement>('#sl-flex')!;
const valHeight = document.querySelector<HTMLSpanElement>('#val-height')!;
const valApe = document.querySelector<HTMLSpanElement>('#val-ape')!;
const valGrip = document.querySelector<HTMLSpanElement>('#val-grip')!;
const valFlex = document.querySelector<HTMLSpanElement>('#val-flex')!;

let bodyCollapsed = false;
let latestSnap: EngineSnapshot | null = null;

const engine = new BoulderEngine(canvas, (snap) => {
  latestSnap = snap;
  syncUI(snap);
});

window.addEventListener('resize', () => engine.resize());

// Top bar events
document.querySelectorAll<HTMLButtonElement>('.mode-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode as EngineSnapshot['mode'];
    engine.setMode(mode);
  });
});

presetSelect.addEventListener('change', () => {
  const idx = Number(presetSelect.value);
  if (!Number.isNaN(idx) && PRESET_ROUTES[idx]) {
    engine.loadRoute(PRESET_ROUTES[idx]);
  }
});

genBtn.addEventListener('click', () => {
  const g = Number(genGradeSelect.value);
  presetSelect.value = '';
  engine.generateNewRoute(g);
});

clearWallBtn.addEventListener('click', () => {
  presetSelect.value = '';
  engine.clearWall();
});

// Body controls events
bodyCollapseBtn.addEventListener('click', () => {
  bodyCollapsed = !bodyCollapsed;
  bodyControls.style.display = bodyCollapsed ? 'none' : 'block';
  bodyCollapseBtn.textContent = bodyCollapsed ? '展开' : '收起';
});

bodyPresetsWrap.addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLButtonElement>('.preset-chip');
  if (!chip) return;
  const idx = Number(chip.dataset.preset);
  engine.applyProfilePreset(idx);
});

slHeight.addEventListener('input', () => {
  engine.setProfile({ name: '自定义体型', heightCm: Number(slHeight.value) });
});
slApe.addEventListener('input', () => {
  engine.setProfile({ name: '自定义体型', apeIndexCm: Number(slApe.value) });
});
slGrip.addEventListener('input', () => {
  engine.setProfile({ name: '自定义体型', gripStrength: Number(slGrip.value) });
});
slFlex.addEventListener('input', () => {
  engine.setProfile({ name: '自定义体型', flexibility: Number(slFlex.value) });
});

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (!latestSnap) return;

  if (latestSnap.mode === 'plan') {
    if (e.key === '1') engine.setActiveLimb('lh');
    else if (e.key === '2') engine.setActiveLimb('rh');
    else if (e.key === '3') engine.setActiveLimb('lf');
    else if (e.key === '4') engine.setActiveLimb('rf');
    else if (e.key.toLowerCase() === 'h') engine.setPlanContactMode('hold');
    else if (e.key.toLowerCase() === 's') engine.setPlanContactMode('smear');
    else if (e.key.toLowerCase() === 'f') engine.setPlanContactMode('flag');
    else if (e.key.toLowerCase() === 'd') engine.setPlanContactMode('dyno');
    else if (e.key.toLowerCase() === 'g') engine.setPlanContactMode('doubleDyno');
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      engine.undoBetaStep();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      engine.undoBetaStep();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (latestSnap.betaSteps.length > 0) engine.startClimb();
    }
  } else if (latestSnap.mode === 'setter') {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      engine.deleteSelectedHold();
    } else if (e.key.toLowerCase() === 'r') {
      e.preventDefault();
      engine.rotateSelectedHold(e.shiftKey ? -15 : 15);
    }
  } else if (latestSnap.mode === 'climb') {
    if (e.key === ' ') {
      e.preventDefault();
      engine.togglePauseClimb();
    }
  }
});

// ==================== UI RENDERING ====================

function syncUI(snap: EngineSnapshot): void {
  // Top bar
  gradePill.textContent = snap.routeGrade;
  routeTitle.textContent = snap.routeName;
  document.querySelectorAll<HTMLButtonElement>('.mode-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === snap.mode);
  });

  // Body controls sync (preserve focus while dragging range inputs)
  const p = snap.profile;
  const anat = computeAnatomy(p);
  const apeSign = p.apeIndexCm >= 0 ? '+' : '';
  bodySummary.textContent = `${p.heightCm}cm · 臂展 ${anat.wingspanCm}cm (${apeSign}${p.apeIndexCm})`;

  if (document.activeElement !== slHeight) slHeight.value = String(p.heightCm);
  if (document.activeElement !== slApe) slApe.value = String(p.apeIndexCm);
  if (document.activeElement !== slGrip) slGrip.value = String(p.gripStrength);
  if (document.activeElement !== slFlex) slFlex.value = String(p.flexibility);

  valHeight.textContent = `${p.heightCm} cm`;
  valApe.textContent = `${apeSign}${p.apeIndexCm} cm`;
  valGrip.textContent = `${p.gripStrength}`;
  valFlex.textContent = `${p.flexibility}`;

  bodyPresetsWrap.querySelectorAll<HTMLButtonElement>('.preset-chip').forEach((chip, i) => {
    const pr = CLIMBER_PRESETS[i];
    const isMatch =
      pr.heightCm === p.heightCm &&
      pr.apeIndexCm === p.apeIndexCm &&
      pr.gripStrength === p.gripStrength &&
      pr.flexibility === p.flexibility;
    chip.classList.toggle('active', isMatch);
  });

  anatomyReadout.innerHTML = `
    <div class="anatomy-cell"><span>单臂可达</span><strong>${Math.round(anat.maxArmReach)}cm</strong></div>
    <div class="anatomy-cell"><span>单腿跨距</span><strong>${Math.round(anat.maxLegReach)}cm</strong></div>
    <div class="anatomy-cell"><span>体重系数</span><strong>${anat.weightFactor.toFixed(2)}×</strong></div>
  `;

  renderStageTopDock(snap);
  renderStageBottomPill(snap);
  renderResultOverlay(snap);
  const activeId = document.activeElement?.id;
  if (activeId !== 'st-angle' && activeId !== 'st-scale') {
    renderModePanel(snap);
  }
}

function renderStageTopDock(snap: EngineSnapshot): void {
  if (snap.mode === 'plan') {
    stageTopDock.innerHTML = `
      <div class="limb-dock">
        ${ALL_LIMBS.map((limb) => {
          const m = LIMB_META[limb];
          const active = snap.activeLimb === limb;
          return `
            <button class="limb-btn ${active ? 'active' : ''}" data-limb="${limb}" style="${
              active ? `border-color:${m.color};` : ''
            }">
              <span class="limb-dot" style="background:${m.color}"></span>
              <span>${m.nameZh}</span>
              <span class="kbd-hint">${m.hotkey}</span>
            </button>
          `;
        }).join('')}
      </div>
      <div class="dock-divider"></div>
      <div class="limb-dock" title="动作方式：抓点 / 踩墙 / 悬空 / 单手飞跃 / 双手齐飞">
        ${(
          [
            ['hold', '抓点', 'H'],
            ['smear', '踩墙', 'S'],
            ['flag', '悬空', 'F'],
            ['dyno', '飞跃', 'D'],
            ['doubleDyno', '双飞', 'G'],
          ] as [PlanContactMode, string, string][]
        )
          .map(
            ([mode, label, key]) => `
          <button class="limb-btn ${snap.planContactMode === mode ? 'active' : ''}" data-cmode="${mode}" style="${
              snap.planContactMode === mode
                ? mode === 'dyno' || mode === 'doubleDyno'
                  ? 'border-color:#d97706;color:#b45309;'
                  : 'border-color:#181d22;'
                : ''
            }">
            <span>${label}</span>
            <span class="kbd-hint">${key}</span>
          </button>`
          )
          .join('')}
      </div>
      <div class="dock-divider"></div>
      <label class="toggle-chip">
        <input type="checkbox" id="tg-reach" ${snap.showReachArc ? 'checked' : ''}/> 可达圈
      </label>
      <label class="toggle-chip">
        <input type="checkbox" id="tg-com" ${snap.showComLine ? 'checked' : ''}/> 重心线
      </label>
      <label class="toggle-chip">
        <input type="checkbox" id="tg-arrows" ${snap.showBetaArrows ? 'checked' : ''}/> 路径
      </label>
    `;

    stageTopDock.querySelectorAll<HTMLButtonElement>('.limb-btn').forEach((btn) => {
      if (btn.dataset.limb) {
        btn.addEventListener('click', () => engine.setActiveLimb(btn.dataset.limb as EngineSnapshot['activeLimb']));
      }
      if (btn.dataset.cmode) {
        btn.addEventListener('click', () =>
          engine.setPlanContactMode(btn.dataset.cmode as PlanContactMode)
        );
      }
    });
    stageTopDock.querySelector<HTMLInputElement>('#tg-reach')?.addEventListener('change', (e) => {
      engine.setDisplayToggle('showReachArc', (e.target as HTMLInputElement).checked);
    });
    stageTopDock.querySelector<HTMLInputElement>('#tg-com')?.addEventListener('change', (e) => {
      engine.setDisplayToggle('showComLine', (e.target as HTMLInputElement).checked);
    });
    stageTopDock.querySelector<HTMLInputElement>('#tg-arrows')?.addEventListener('change', (e) => {
      engine.setDisplayToggle('showBetaArrows', (e.target as HTMLInputElement).checked);
    });
  } else if (snap.mode === 'setter') {
    stageTopDock.innerHTML = `
      <span class="stage-hint-pill">
        单击空墙放置岩点 · 拖拽调整位置 · 双击切换 <strong>起/完攀点</strong> · 按 <span class="kbd-hint">R</span> 旋转 · <span class="kbd-hint">Del</span> 删除
      </span>
    `;
  } else {
    const stam = Math.round(snap.climbStamina);
    const stamColor = stam > 50 ? '#16A34A' : stam > 25 ? '#D97706' : '#DC2626';
    stageTopDock.innerHTML = `
      <div class="climb-hud">
        <div class="hud-metric">
          <span>体能</span>
          <div class="stamina-bar-track">
            <div class="stamina-bar-fill" style="width:${stam}%;background:${stamColor};"></div>
          </div>
          <span class="mono">${stam}%</span>
        </div>
        <div class="dock-divider"></div>
        <div class="hud-metric">
          <span>稳定度</span>
          <span class="mono">${Math.round(snap.climbBalance)}%</span>
        </div>
        <div class="dock-divider"></div>
        <div class="speed-group">
          ${[0.6, 1.0, 1.5]
            .map(
              (spd) =>
                `<button class="speed-btn ${snap.playbackSpeed === spd ? 'active' : ''}" data-spd="${spd}">${spd}x</button>`
            )
            .join('')}
        </div>
        <button id="hud-play-btn" class="btn btn-sm btn-primary">
          ${snap.climbStatus === 'running' ? '暂停' : snap.climbStatus === 'paused' ? '继续' : '重播'}
        </button>
      </div>
    `;

    stageTopDock.querySelectorAll<HTMLButtonElement>('.speed-btn').forEach((btn) => {
      btn.addEventListener('click', () => engine.setPlaybackSpeed(Number(btn.dataset.spd)));
    });
    stageTopDock.querySelector<HTMLButtonElement>('#hud-play-btn')?.addEventListener('click', () => {
      engine.togglePauseClimb();
    });
  }
}

function renderStageBottomPill(snap: EngineSnapshot): void {
  const tagMap: Record<'solid' | 'hard' | 'dyno' | 'fail', string> = {
    solid: '稳妥可达',
    hard: '吃力伸展',
    dyno: '动态飞跃',
    fail: '无法完成',
  };

  if (snap.mode === 'plan' && snap.hoveredHoldId && snap.hoveredEval) {
    const hold = snap.holds.find((h) => h.id === snap.hoveredHoldId);
    const ev = snap.hoveredEval;
    if (!hold) {
      stageBottomPill.classList.add('hidden');
      return;
    }
    const limbName =
      snap.planContactMode === 'doubleDyno'
        ? '双手齐飞'
        : snap.planContactMode === 'dyno'
          ? `${LIMB_META[snap.activeLimb].nameZh}飞跃`
          : LIMB_META[snap.activeLimb].nameZh;
    const detail = ev.feasible
      ? `体能 -${ev.staminaCost}% · 抓握 ${ev.gripScore} · 稳定 ${ev.balanceScore}${
          ev.warnings[0] ? ` · ${ev.warnings[0]}` : ''
        }`
      : ev.failReason ?? '动作不可行';

    stageBottomPill.classList.remove('hidden');
    stageBottomPill.innerHTML = `
      <span class="eval-tag ${ev.rating}">${tagMap[ev.rating]}</span>
      <span>${limbName} → #${hold.label} ${HOLD_SPECS[hold.type].shortZh}：${detail}</span>
    `;
  } else if (snap.mode === 'plan' && snap.wallHoverEval && snap.planContactMode !== 'hold') {
    const ev = snap.wallHoverEval;
    const limbName = LIMB_META[snap.activeLimb].nameZh;
    const modeLabel = snap.planContactMode === 'smear' ? '踩墙/蹭墙' : '悬空配重';
    const detail = ev.feasible
      ? `体能 -${ev.staminaCost}% · 摩擦/配重 ${ev.gripScore} · 稳定 ${ev.balanceScore}${
          ev.warnings[0] ? ` · ${ev.warnings[0]}` : ''
        }`
      : ev.failReason ?? '动作不可行';
    stageBottomPill.classList.remove('hidden');
    stageBottomPill.innerHTML = `
      <span class="eval-tag ${ev.rating}">${tagMap[ev.rating]}</span>
      <span>${limbName} → ${modeLabel}：${detail}</span>
    `;
  } else if (snap.mode === 'climb' && snap.climbStatus !== 'success' && snap.climbStatus !== 'failed') {
    stageBottomPill.classList.remove('hidden');
    stageBottomPill.innerHTML = `<span>${snap.climbStatusText}</span>`;
  } else {
    stageBottomPill.classList.add('hidden');
  }
}

function renderResultOverlay(snap: EngineSnapshot): void {
  if (snap.mode !== 'climb' || !snap.climbResult) {
    resultOverlay.style.display = 'none';
    return;
  }

  const r = snap.climbResult;
  const isOk = r.status === 'success';
  resultOverlay.style.display = 'block';
  resultOverlay.className = `result-overlay ${r.status}`;

  resultOverlay.innerHTML = `
    <div class="result-header">
      <div class="result-title">${isOk ? '完攀成功 · SEND!' : `第 ${r.failedAtStep} 步脱落 · FALL`}</div>
      <span class="grade-pill">${snap.routeGrade}</span>
    </div>
    <p class="result-reason">${r.reason}</p>
    <div class="result-stats">
      <div class="stat-box">
        <div class="stat-label">完成步数</div>
        <div class="stat-val">${r.movesCompleted} / ${r.totalMoves}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">剩余体能</div>
        <div class="stat-val">${r.staminaRemaining}%</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">难点步</div>
        <div class="stat-val">${r.cruxStepIndex !== null ? `#${r.cruxStepIndex + 1}` : '-'}</div>
      </div>
    </div>
    <div class="result-actions">
      <button id="res-retry" class="btn btn-primary" style="flex:1;">再爬一次</button>
      <button id="res-edit-beta" class="btn" style="flex:1;">返回调整 Beta</button>
    </div>
  `;

  resultOverlay.querySelector('#res-retry')?.addEventListener('click', () => engine.startClimb());
  resultOverlay.querySelector('#res-edit-beta')?.addEventListener('click', () => engine.setMode('plan'));
}

function renderModePanel(snap: EngineSnapshot): void {
  if (snap.mode === 'setter') {
    renderSetterPanel(snap);
  } else if (snap.mode === 'plan') {
    renderPlanPanel(snap);
  } else {
    renderClimbPanel(snap);
  }
}

function renderSetterPanel(snap: EngineSnapshot): void {
  const selected = snap.selectedHoldId
    ? snap.holds.find((h) => h.id === snap.selectedHoldId) ?? null
    : null;

  const startCount = snap.holds.filter((h) => h.role === 'start').length;
  const topCount = snap.holds.filter((h) => h.role === 'top').length;

  const activeType = selected ? selected.type : snap.brush.type;
  const activeRole = selected ? selected.role : snap.brush.role;
  const activeColor = selected ? selected.color : snap.brush.color;
  const activeAngle = selected ? selected.angle : snap.brush.angle;
  const activeScale = selected ? selected.scale : snap.brush.scale;

  modePanel.innerHTML = `
    <div class="section-head">
      <div>
        <div class="section-title">${selected ? `编辑岩点 #${selected.label}` : '放置新岩点画笔'}</div>
        <div class="section-sub">共 ${snap.holds.length} 点 · 起步 ${startCount} · 完攀 ${topCount}</div>
      </div>
      ${selected ? `<button id="st-deselect" class="btn btn-sm">切回画笔</button>` : ''}
    </div>

    <div class="hold-type-grid">
      ${(Object.keys(HOLD_SPECS) as HoldType[])
        .map((t) => {
          const sp = HOLD_SPECS[t];
          return `
            <button class="hold-type-btn ${activeType === t ? 'active' : ''}" data-htype="${t}">
              <strong>${sp.shortZh}</strong>
              <span>抓力 ${Math.round(sp.handGrip * 100)} · 脚感 ${Math.round(sp.footGrip * 100)}</span>
            </button>
          `;
        })
        .join('')}
    </div>

    <div class="section-sub" style="margin-bottom:6px;">岩点属性</div>
    <div class="role-row">
      ${(
        [
          ['normal', '普通点'],
          ['start', '起步点 (Start)'],
          ['top', '完攀点 (TOP)'],
        ] as [HoldRole, string][]
      )
        .map(
          ([role, label]) =>
            `<button class="btn btn-sm ${activeRole === role ? 'btn-primary' : ''}" data-hrole="${role}">${label}</button>`
        )
        .join('')}
    </div>

    <div class="section-sub" style="margin-bottom:6px;">色系</div>
    <div class="color-row">
      ${HOLD_COLORS.map(
        (c) =>
          `<button class="color-swatch ${activeColor === c.hex ? 'active' : ''}" data-hcolor="${c.hex}" title="${c.name}" style="background:${c.hex};"></button>`
      ).join('')}
    </div>

    <div class="selected-hold-box">
      <div class="slider-grid">
        <label class="slider-row">
          <div class="slider-label-row">
            <span>发力朝向角度 (0°正拉 / ±90°侧拉 / 180°反提)</span>
            <span id="st-angle-val" class="slider-val">${activeAngle}°</span>
          </div>
          <input id="st-angle" type="range" min="-180" max="180" step="5" value="${activeAngle}" />
        </label>

        <label class="slider-row">
          <div class="slider-label-row">
            <span>岩点尺寸</span>
            <span id="st-scale-val" class="slider-val">${Math.round(activeScale * 100)}%</span>
          </div>
          <input id="st-scale" type="range" min="0.75" max="1.35" step="0.05" value="${activeScale}" />
        </label>
      </div>

      ${
        selected
          ? `<div style="display:flex;gap:8px;margin-top:10px;">
              <button id="st-rot-l" class="btn btn-sm" style="flex:1;">左旋 15°</button>
              <button id="st-rot-r" class="btn btn-sm" style="flex:1;">右旋 15°</button>
              <button id="st-del" class="btn btn-sm btn-danger">删除</button>
            </div>`
          : ''
      }
    </div>

    <div style="margin-top:14px;">
      <button id="st-go-plan" class="btn btn-block btn-primary" ${
        startCount === 0 || topCount === 0 ? 'disabled' : ''
      }>
        ${
          startCount === 0 || topCount === 0
            ? '请先至少放置 1 个起步点与 1 个完攀点'
            : '定线完成，前往规划 Beta →'
        }
      </button>
    </div>
  `;

  modePanel.querySelector('#st-deselect')?.addEventListener('click', () => {
    engine.deselectHold();
  });

  modePanel.querySelectorAll<HTMLButtonElement>('[data-htype]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.htype as HoldType;
      if (selected) engine.updateSelectedHold({ type });
      else engine.setBrush({ type });
    });
  });

  modePanel.querySelectorAll<HTMLButtonElement>('[data-hrole]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const role = btn.dataset.hrole as HoldRole;
      if (selected) engine.updateSelectedHold({ role });
      else engine.setBrush({ role });
    });
  });

  modePanel.querySelectorAll<HTMLButtonElement>('[data-hcolor]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.hcolor!;
      if (selected) engine.updateSelectedHold({ color });
      else engine.setBrush({ color });
    });
  });

  const angleInput = modePanel.querySelector<HTMLInputElement>('#st-angle');
  const scaleInput = modePanel.querySelector<HTMLInputElement>('#st-scale');

  angleInput?.addEventListener('input', () => {
    const val = Number(angleInput.value);
    const lbl = modePanel.querySelector('#st-angle-val');
    if (lbl) lbl.textContent = `${val}°`;
    if (selected) engine.updateSelectedHold({ angle: val });
    else engine.setBrush({ angle: val });
  });

  scaleInput?.addEventListener('input', () => {
    const val = Number(scaleInput.value);
    const lbl = modePanel.querySelector('#st-scale-val');
    if (lbl) lbl.textContent = `${Math.round(val * 100)}%`;
    if (selected) engine.updateSelectedHold({ scale: val });
    else engine.setBrush({ scale: val });
  });

  modePanel.querySelector('#st-rot-l')?.addEventListener('click', () => engine.rotateSelectedHold(-15));
  modePanel.querySelector('#st-rot-r')?.addEventListener('click', () => engine.rotateSelectedHold(15));
  modePanel.querySelector('#st-del')?.addEventListener('click', () => engine.deleteSelectedHold());
  modePanel.querySelector('#st-go-plan')?.addEventListener('click', () => engine.setMode('plan'));
}

function renderPlanPanel(snap: EngineSnapshot): void {
  const holdMap = new Map(snap.holds.map((h) => [h.id, h]));

  let summaryClass = 'empty';
  let summaryText = '选择上方四肢后，点击岩点逐步编排你的解题 Beta';
  if (snap.betaSteps.length > 0) {
    if (snap.betaFirstFailure !== null) {
      summaryClass = 'error';
      summaryText = `第 ${snap.betaFirstFailure + 1} 步存在失手风险 · 仍可点击攀爬观察实测结果`;
    } else if (snap.betaReachesTop) {
      summaryClass = 'ready';
      summaryText = `Beta 完整可行！共 ${snap.betaSteps.length} 步 · 预计剩余体能 ${Math.round(
        snap.betaFinalStamina
      )}%`;
    } else {
      summaryClass = 'warn';
      summaryText = `已规划 ${snap.betaSteps.length} 步 · 还需将双手同时匹配到完攀点 (TOP)`;
    }
  }

  modePanel.innerHTML = `
    <div class="section-head">
      <div class="section-title">Beta 解题规划</div>
      <div class="section-sub mono">${snap.betaSteps.length} 步</div>
    </div>

    <div class="route-desc-box">
      ${snap.routeDescription}
      <div style="margin-top:6px;color:var(--ink-muted);">
        动作模式：抓点(H) · 踩墙(S) · 悬空(F) · <strong>单手飞跃(D)</strong> · <strong>双手齐飞(G)</strong>。飞跃需踩稳脚下支点蓄力起跳！
      </div>
    </div>

    <div class="beta-summary-bar ${summaryClass}">${summaryText}</div>

    <div class="beta-toolbar">
      <button id="bp-suggest" class="btn btn-sm" style="flex:1;" title="根据当前身高臂展自动推演一条可行解法">
        AI 推演参考 Beta
      </button>
      <button id="bp-undo" class="btn btn-sm" ${snap.betaSteps.length === 0 ? 'disabled' : ''}>撤销</button>
      <button id="bp-clear" class="btn btn-sm" ${snap.betaSteps.length === 0 ? 'disabled' : ''}>清空</button>
    </div>

    <div class="beta-list" id="bp-list">
      <div class="beta-item ${snap.inspectedStepIndex === -1 ? 'active' : ''}" data-step-idx="-1">
        <span class="beta-step-num" style="background:#535D68;">起</span>
        <div class="beta-item-main">
          <div class="beta-item-title">起步姿态 (Start)</div>
          <div class="beta-item-sub">双手就位起步点 · 体能 100%</div>
        </div>
        <span></span>
      </div>

      ${snap.betaTraces
        .map((tr, i) => {
          const t = tr.step.target;
          const h = t.kind === 'hold' || t.kind === 'dyno' ? holdMap.get(t.holdId) : undefined;
          const m = LIMB_META[tr.step.limb];
          const ev = tr.evaluation;
          const isFail = !ev.feasible || tr.pumpedOut;
          const isActive = snap.inspectedStepIndex === i;
          const isDoubleDyno = t.kind === 'dyno' && t.bothHands;
          const actorLabel = isDoubleDyno ? '双手' : m.nameZh;
          const dest =
            t.kind === 'hold' || t.kind === 'dyno'
              ? `#${h?.label ?? '?'} ${h ? HOLD_SPECS[h.type].shortZh : ''}`
              : targetLabel(t);
          const subText = isFail
            ? tr.pumpedOut && ev.feasible
              ? '体能耗尽 (0%)'
              : ev.failReason ?? '动作失败'
            : `${
                isDoubleDyno
                  ? '双手飞跃 · 切脚悬空 · '
                  : t.kind === 'dyno' || ev.isDyno
                    ? ev.cutsFeet
                      ? '动态飞跃 · 切脚 · '
                      : '动态死点 · '
                    : t.kind === 'smear'
                      ? '踩墙 · '
                      : t.kind === 'flag'
                        ? '悬空 · '
                        : ev.rating === 'hard'
                          ? '吃力 · '
                          : '稳妥 · '
              }体能剩 ${Math.round(tr.staminaAfter)}%`;

          return `
            <div class="beta-item ${isActive ? 'active' : ''} ${isFail ? 'fail' : ''}" data-step-idx="${i}">
              <span class="beta-step-num" style="background:${
                isFail ? '#DC2626' : t.kind === 'dyno' ? '#D97706' : m.color
              };">${i + 1}</span>
              <div class="beta-item-main">
                <div class="beta-item-title">
                  <span>${actorLabel} → ${dest}</span>
                  ${h?.role === 'top' ? '<span class="grade-pill" style="font-size:9px;padding:1px 4px;">TOP</span>' : ''}
                  ${t.kind === 'dyno' ? `<span class="grade-pill" style="font-size:9px;padding:1px 4px;background:#d97706;">${t.bothHands ? '双飞' : 'DYNO'}</span>` : ''}
                  ${t.kind === 'smear' ? '<span class="grade-pill" style="font-size:9px;padding:1px 4px;background:#0d9488;">踩墙</span>' : ''}
                  ${t.kind === 'flag' ? '<span class="grade-pill" style="font-size:9px;padding:1px 4px;background:#6b7280;">悬空</span>' : ''}
                </div>
                <div class="beta-item-sub">${subText}</div>
              </div>
              <button class="beta-del-btn" data-del-step="${i}" title="删除此步">×</button>
            </div>
          `;
        })
        .join('')}
    </div>

    <button id="bp-climb" class="btn btn-block ${
      snap.betaReachesTop ? 'btn-accent' : 'btn-primary'
    }" ${snap.betaSteps.length === 0 ? 'disabled' : ''}>
      ${snap.betaSteps.length === 0 ? '请先规划步骤' : '按此 Beta 开始攀爬演练'}
    </button>
  `;

  modePanel.querySelector('#bp-suggest')?.addEventListener('click', () => {
    const res = engine.autoSuggestBeta();
    if (!res.solved) {
      stageBottomPill.classList.remove('hidden');
      stageBottomPill.innerHTML = `<span class="eval-tag fail">未找到完整解法</span><span>当前体型在此线路可能超出极限，可尝试调整身高/臂展或补充过渡岩点。</span>`;
    }
  });
  modePanel.querySelector('#bp-undo')?.addEventListener('click', () => engine.undoBetaStep());
  modePanel.querySelector('#bp-clear')?.addEventListener('click', () => engine.clearBeta());
  modePanel.querySelector('#bp-climb')?.addEventListener('click', () => engine.startClimb());

  modePanel.querySelectorAll<HTMLElement>('.beta-item').forEach((row) => {
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.beta-del-btn')) return;
      engine.inspectStep(Number(row.dataset.stepIdx));
    });
  });

  modePanel.querySelectorAll<HTMLButtonElement>('[data-del-step]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      engine.removeBetaStep(Number(btn.dataset.delStep));
    });
  });
}

function renderClimbPanel(snap: EngineSnapshot): void {
  const holdMap = new Map(snap.holds.map((h) => [h.id, h]));

  modePanel.innerHTML = `
    <div class="section-head">
      <div class="section-title">攀爬实况追踪</div>
      <div class="section-sub mono">步数 ${Math.max(0, snap.climbStepIndex + 1)} / ${snap.betaSteps.length}</div>
    </div>

    <div class="route-desc-box" style="margin-bottom:10px;">
      <strong>当前状态：</strong>${snap.climbStatusText}
    </div>

    <div class="beta-list">
      ${snap.betaTraces
        .map((tr, i) => {
          const t = tr.step.target;
          const h = t.kind === 'hold' || t.kind === 'dyno' ? holdMap.get(t.holdId) : undefined;
          const isDoubleDyno = t.kind === 'dyno' && t.bothHands;
          const dest =
            t.kind === 'hold' || t.kind === 'dyno'
              ? `#${h?.label ?? '?'} ${h ? HOLD_SPECS[h.type].shortZh : ''}`
              : targetLabel(t);
          const m = LIMB_META[tr.step.limb];
          const isCurrent = snap.climbStepIndex === i && snap.climbStatus === 'running';
          const isDone =
            snap.climbStatus === 'success' ||
            (snap.climbStepIndex > i) ||
            (snap.climbStatus === 'incomplete');
          const isFailedStep =
            snap.climbResult?.status === 'failed' && snap.climbResult.failedAtStep === i + 1;

          return `
            <div class="beta-item ${isCurrent ? 'active' : ''} ${isFailedStep ? 'fail' : ''}" style="cursor:default;opacity:${
              isDone || isCurrent || isFailedStep ? 1 : 0.65
            }">
              <span class="beta-step-num" style="background:${
                isFailedStep ? '#DC2626' : isDone ? '#15803D' : t.kind === 'dyno' ? '#D97706' : m.color
              };">${isDone && !isFailedStep ? '✓' : i + 1}</span>
              <div class="beta-item-main">
                <div class="beta-item-title">${isDoubleDyno ? '双手齐飞' : m.nameZh} → ${dest}</div>
                <div class="beta-item-sub">
                  抓握 ${tr.evaluation.gripScore} · 稳定 ${tr.evaluation.balanceScore} · 消耗 ${
            tr.evaluation.staminaCost
          }%
                </div>
              </div>
              <span class="mono" style="font-size:11px;color:var(--ink-muted);">${
                isCurrent ? '执行中' : isFailedStep ? '脱落' : isDone ? '完成' : ''
              }</span>
            </div>
          `;
        })
        .join('')}
    </div>

    <div style="display:flex;gap:8px;">
      <button id="cl-replay" class="btn btn-primary" style="flex:1;">重新攀爬</button>
      <button id="cl-back-plan" class="btn" style="flex:1;">修改 Beta</button>
    </div>
  `;

  modePanel.querySelector('#cl-replay')?.addEventListener('click', () => engine.startClimb());
  modePanel.querySelector('#cl-back-plan')?.addEventListener('click', () => engine.setMode('plan'));
}
