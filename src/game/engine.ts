import { CLIMBER_PRESETS, computeAnatomy } from './climber';
import {
  applyLimbTarget,
  detachLimb,
  dynoTarget,
  emptyFreeMap,
  flagTarget,
  freeOverrides,
  holdTarget,
  smearTarget,
  targetLabel,
} from './contact';
import { estimateRouteGrade, generateRoute, LiveGradeEstimate, nextUid, suggestBeta } from './generator';
import { getHoldHitRadius, HOLD_COLORS, HOLD_SPECS, LIMB_META, renumberHolds } from './holds';
import {
  blendPosesRigid,
  buildRigidPoseFromTargets,
  clamp,
  dist,
  easeInOutCubic,
  easeOutCubic,
  lerp,
  lerpVec,
  solvePose,
} from './ik';
import {
  BetaTraceStep,
  buildHoldMap,
  evaluateBetaSequence,
  evaluateMove,
  getInitialAssignment,
  isTopReached,
} from './physics';
import { PRESET_ROUTES } from './presets';
import {
  computeWallTransform,
  Particle,
  renderScene,
  screenToWorld,
  WallTransform,
} from './renderer';
import {
  BetaStep,
  ClimberProfile,
  ClimbResult,
  FreeLimbMap,
  GameMode,
  Hold,
  HoldRole,
  HoldStyleFamily,
  HoldType,
  LimbAssignment,
  LimbId,
  LimbTarget,
  MoveEvaluation,
  PlanContactMode,
  RouteProblem,
  RouteStyle,
  SolvedPose,
  Vec2,
  WALL_HEIGHT_CM,
  WALL_WIDTH_CM,
} from './types';

export interface SetterBrush {
  type: HoldType;
  role: HoldRole;
  angle: number;
  scale: number;
  color: string;
  styleFamily: HoldStyleFamily;
  shapeVariant: number;
  dualTex: boolean;
  thumbCatch: boolean;
}

export interface EngineSnapshot {
  mode: GameMode;
  routeName: string;
  routeGrade: string;
  baseRouteGrade: string;
  wallAngleDeg: number;
  baseWallAngleDeg: number;
  liveGradeEstimate: LiveGradeEstimate;
  routeStyle: RouteStyle;
  routeDescription: string;
  holds: Hold[];
  selectedHoldId: string | null;
  hoveredHoldId: string | null;
  brush: SetterBrush;
  profile: ClimberProfile;
  activeLimb: LimbId;
  planContactMode: PlanContactMode;
  betaSteps: BetaStep[];
  betaTraces: BetaTraceStep[];
  inspectedStepIndex: number;
  betaReachesTop: boolean;
  betaFirstFailure: number | null;
  betaFinalStamina: number;
  hoveredEval: MoveEvaluation | null;
  wallHoverEval: MoveEvaluation | null;
  inspectedFree: FreeLimbMap;
  showReachArc: boolean;
  showComLine: boolean;
  showBetaArrows: boolean;
  // Climb live telemetry
  climbStatus: 'idle' | 'running' | 'paused' | 'success' | 'failed' | 'incomplete';
  climbStepIndex: number;
  climbStatusText: string;
  climbStamina: number;
  climbBalance: number;
  playbackSpeed: number;
  climbResult: ClimbResult | null;
  cameraZoom: number;
}

interface ClimbAnimState {
  phase: 'shift' | 'reach' | 'settle' | 'holdTop' | 'fall';
  phaseTime: number;
  phaseDuration: number;
  stepIdx: number;
  startPose: SolvedPose;
  supportPose: SolvedPose;
  targetPose: SolvedPose;
  currentAssignment: LimbAssignment;
  currentFree: FreeLimbMap;
  currentEval: MoveEvaluation | null;
  willFail: boolean;
  failReason: string;
  staminaBeforeStep: number;
  staminaAfterStep: number;
  elapsedTotal: number;
  cruxStepIndex: number | null;
  cruxStrain: number;
  // Fall physics
  fallOffsetX: number;
  fallOffsetY: number;
  fallVx: number;
  fallVy: number;
  fallRot: number;
  fallOmega: number;
  fallBounced: boolean;
  fallPose: SolvedPose | null;
}

export class BoulderEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private onChange: (snapshot: EngineSnapshot) => void;

  private rafId = 0;
  private lastFrameMs = 0;
  private timeSec = 0;
  private transform: WallTransform = computeWallTransform(800, 700);
  private resizeObserver: ResizeObserver | null = null;
  private cameraZoom = 1.0;
  private cameraPanX = 0;
  private cameraPanY = 0;

  // Multi-touch pinch & pan gesture state
  private activePointers = new Map<number, Vec2>();
  private isPinching = false;
  private pinchPrevDist = 0;
  private pinchPrevMid: Vec2 = { x: 0, y: 0 };
  private pinchJustEnded = false;
  private dragStartPos: Vec2 | null = null;
  private dragOrigHoldPos: Vec2 | null = null;
  private isPanning = false;
  private panLastScreen: Vec2 = { x: 0, y: 0 };
  private pendingTap: {
    pointerId: number;
    screen: Vec2;
    isTouch: boolean;
  } | null = null;

  // Core game state
  private mode: GameMode = 'plan';
  private routeName = '';
  private routeGrade = '';
  private baseRouteGrade = '';
  private wallAngleDeg = 0;
  private renderedWallAngle = 0;
  private baseWallAngleDeg = 0;
  private routeStyle: RouteStyle = 'balanced';
  private liveGradeEstimate: LiveGradeEstimate = {
    gradeLabel: 'V1',
    numericGrade: 1,
    requiredTier: 'standard',
    recommendedGrip: 92,
  };
  private routeDescription = '';
  private holds: Hold[] = [];
  private profile: ClimberProfile = { ...CLIMBER_PRESETS[1] };

  // Setter state
  private selectedHoldId: string | null = null;
  private hoveredHoldId: string | null = null;
  private draggingHoldId: string | null = null;
  private dragOffset: Vec2 = { x: 0, y: 0 };
  private dragMoved = false;
  private brush: SetterBrush = {
    type: 'jug',
    role: 'normal',
    angle: 0,
    scale: 1.05,
    color: HOLD_COLORS[0].hex,
    styleFamily: 'comp',
    shapeVariant: 0,
    dualTex: false,
    thumbCatch: false,
  };

  // Plan state
  private activeLimb: LimbId = 'rh';
  private planContactMode: PlanContactMode = 'hold';
  private betaSteps: BetaStep[] = [];
  private betaTraces: BetaTraceStep[] = [];
  private betaReachesTop = false;
  private betaFirstFailure: number | null = null;
  private betaFinalStamina = 100;
  private inspectedStepIndex = -1; // -1 = start stance
  private previewEvaluations = new Map<string, MoveEvaluation>();
  private wallHoverEval: MoveEvaluation | null = null;
  private wallHoverPos: Vec2 | null = null;
  private showReachArc = true;
  private showComLine = true;
  private showBetaArrows = true;

  // Smooth pose display for Plan mode
  private displayPose: SolvedPose;
  private targetDisplayPose: SolvedPose;

  // Climb simulation state
  private climbStatus: EngineSnapshot['climbStatus'] = 'idle';
  private climbStatusText = '准备就绪';
  private climbStamina = 100;
  private climbBalance = 100;
  private playbackSpeed = 1.0;
  private climbResult: ClimbResult | null = null;
  private anim: ClimbAnimState | null = null;
  private particles: Particle[] = [];

  constructor(canvas: HTMLCanvasElement, onChange: (snapshot: EngineSnapshot) => void) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
    this.onChange = onChange;

    // Initialize with first preset route
    const initRoute = PRESET_ROUTES[0];
    this.loadRoute(initRoute, false);

    // Initialize display pose
    const holdMap = buildHoldMap(this.holds);
    const initAssign = getInitialAssignment(this.holds, this.profile);
    this.displayPose = solvePose(initAssign, holdMap, computeAnatomy(this.profile), this.profile.flexibility);
    this.targetDisplayPose = this.displayPose;

    this.bindEvents();
    this.resize();
    if (this.canvas.parentElement && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas.parentElement);
    }
    this.emit();
    this.lastFrameMs = performance.now();
    this.loop(this.lastFrameMs);
  }

  public destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.resizeObserver?.disconnect();
  }

  public resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(240, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(240, Math.floor(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.clampCamera(rect.width, rect.height);
    this.transform = computeWallTransform(
      rect.width,
      rect.height,
      {
        zoom: this.cameraZoom,
        panX: this.cameraPanX,
        panY: this.cameraPanY,
      },
      this.renderedWallAngle
    );
  }

  public resetCamera(): void {
    this.cameraZoom = 1.0;
    this.cameraPanX = 0;
    this.cameraPanY = 0;
    this.resize();
    this.emit();
  }

  private clampCamera(canvasW: number, canvasH: number): void {
    this.cameraZoom = clamp(this.cameraZoom, 1.0, 3.2);
    if (this.cameraZoom <= 1.01) {
      this.cameraZoom = 1.0;
      this.cameraPanX = 0;
      this.cameraPanY = 0;
      return;
    }
    const base = computeWallTransform(canvasW, canvasH);
    const maxPanX = Math.max(40, (base.wallPixelW * (this.cameraZoom - 1)) / 2 + 48);
    const maxPanY = Math.max(40, ((base.wallPixelH + base.padPixelH) * (this.cameraZoom - 1)) / 2 + 56);
    this.cameraPanX = clamp(this.cameraPanX, -maxPanX, maxPanX);
    this.cameraPanY = clamp(this.cameraPanY, -maxPanY, maxPanY);
  }

  private zoomAroundScreenPoint(screenPt: Vec2, nextZoomRaw: number, panDeltaX = 0, panDeltaY = 0): void {
    const rect = this.canvas.getBoundingClientRect();
    const oldZoom = this.cameraZoom;
    const nextZoom = clamp(nextZoomRaw, 1.0, 3.2);

    // Keep the world point under `screenPt` anchored while zooming + applying optional midpoint pan!
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const ratio = nextZoom / oldZoom;

    this.cameraPanX =
      (screenPt.x - cx) * (1 - ratio) + this.cameraPanX * ratio + panDeltaX;
    this.cameraPanY =
      (screenPt.y - cy) * (1 - ratio) + this.cameraPanY * ratio + panDeltaY;
    this.cameraZoom = nextZoom;

    this.clampCamera(rect.width, rect.height);
    this.transform = computeWallTransform(
      rect.width,
      rect.height,
      {
        zoom: this.cameraZoom,
        panX: this.cameraPanX,
        panY: this.cameraPanY,
      },
      this.renderedWallAngle
    );
  }

  // ==================== PUBLIC ACTIONS ====================

  public setMode(mode: GameMode): void {
    if (this.mode === mode) return;
    this.stopClimbInternal();
    this.mode = mode;
    this.draggingHoldId = null;

    if (mode === 'plan') {
      if (this.baseRouteGrade === 'Custom') this.refreshLiveGrade();
      this.recomputeBeta();
      this.syncPlanPose(true);
    } else if (mode === 'climb') {
      this.recomputeBeta();
      this.resetClimbToStart();
      if (this.betaSteps.length > 0) {
        this.startClimb();
      }
    }
    this.emit();
  }

  public loadRoute(route: RouteProblem, emitChange = true): void {
    this.stopClimbInternal();
    this.cameraZoom = 1.0;
    this.cameraPanX = 0;
    this.cameraPanY = 0;
    this.routeName = route.name;
    this.routeGrade = route.grade;
    this.baseRouteGrade = route.grade;
    this.wallAngleDeg = route.wallAngleDeg ?? 0;
    this.renderedWallAngle = this.wallAngleDeg;
    this.baseWallAngleDeg = this.wallAngleDeg;
    this.routeStyle = route.style ?? 'balanced';
    this.routeDescription = route.description;
    this.holds = renumberHolds(route.holds.map((h) => ({ ...h })));
    this.brush.color = route.holdColor;
    this.selectedHoldId = null;
    this.betaSteps = [];
    this.inspectedStepIndex = -1;
    this.refreshLiveGrade();
    this.recomputeBeta();
    this.syncPlanPose(true);
    if (emitChange) this.emit();
  }

  public setWallAngle(angleDeg: number): void {
    const clamped = clamp(Math.round(angleDeg / 5) * 5, -10, 55);
    if (clamped === this.wallAngleDeg) return;
    this.wallAngleDeg = clamped;
    this.refreshLiveGrade();
    if (this.wallAngleDeg === this.baseWallAngleDeg && this.baseRouteGrade !== 'Custom') {
      this.routeGrade = this.baseRouteGrade;
    } else {
      this.routeGrade = this.liveGradeEstimate.gradeLabel;
    }
    this.recomputeBeta();
    this.syncPlanPose(false);
    this.emit();
  }

  private refreshLiveGrade(): void {
    this.liveGradeEstimate = estimateRouteGrade(this.holds, this.wallAngleDeg);
    if (this.baseRouteGrade === 'Custom') {
      this.routeGrade = this.liveGradeEstimate.gradeLabel;
    }
  }

  public generateNewRoute(gradeNum: number, style?: RouteStyle): void {
    const route = generateRoute(gradeNum, undefined, style);
    this.loadRoute(route, false);
    this.mode = 'plan';
    this.recomputeBeta();
    this.syncPlanPose(true);
    this.emit();
  }

  public clearWall(): void {
    this.stopClimbInternal();
    this.routeName = '自定义抱石线';
    this.routeGrade = 'Custom';
    this.baseRouteGrade = 'Custom';
    this.wallAngleDeg = 0;
    this.baseWallAngleDeg = 0;
    this.routeStyle = 'balanced';
    this.routeDescription = '点击岩墙放置岩点，拖拽移动位置，可自由调整墙面倾角（-10° ~ 55°）。';
    this.holds = [];
    this.selectedHoldId = null;
    this.betaSteps = [];
    this.inspectedStepIndex = -1;
    this.mode = 'setter';
    this.refreshLiveGrade();
    this.recomputeBeta();
    this.emit();
  }

  public setBrush(partial: Partial<SetterBrush>): void {
    this.brush = { ...this.brush, ...partial };
    this.emit();
  }

  public deselectHold(): void {
    this.selectedHoldId = null;
    this.emit();
  }

  public updateSelectedHold(partial: Partial<Hold>): void {
    if (!this.selectedHoldId) return;
    this.holds = this.holds.map((h) =>
      h.id === this.selectedHoldId ? { ...h, ...partial } : h
    );
    this.recomputeBeta();
    this.syncPlanPose(false);
    this.emit();
  }

  public rotateSelectedHold(deltaDeg: number): void {
    if (!this.selectedHoldId) return;
    const h = this.holds.find((x) => x.id === this.selectedHoldId);
    if (!h) return;
    let next = ((h.angle + deltaDeg + 180) % 360 + 360) % 360 - 180;
    if (next === -180) next = 180;
    this.updateSelectedHold({ angle: Math.round(next) });
  }

  public deleteSelectedHold(): void {
    if (!this.selectedHoldId) return;
    const targetId = this.selectedHoldId;
    this.holds = renumberHolds(this.holds.filter((h) => h.id !== targetId));
    this.betaSteps = this.betaSteps.filter(
      (s) => !((s.target.kind === 'hold' || s.target.kind === 'dyno') && s.target.holdId === targetId)
    );
    this.selectedHoldId = null;
    this.inspectedStepIndex = Math.min(this.inspectedStepIndex, this.betaSteps.length - 1);
    this.recomputeBeta();
    this.syncPlanPose(false);
    this.emit();
  }

  public setProfile(partial: Partial<ClimberProfile>): void {
    this.profile = { ...this.profile, ...partial };
    if (this.mode === 'climb' && this.climbStatus !== 'running') {
      this.resetClimbToStart();
    }
    this.recomputeBeta();
    this.syncPlanPose(false);
    this.emit();
  }

  public applyProfilePreset(presetIndex: number): void {
    const preset = CLIMBER_PRESETS[presetIndex];
    if (!preset) return;
    this.profile = { ...preset };
    if (this.mode === 'climb' && this.climbStatus !== 'running') {
      this.resetClimbToStart();
    }
    this.recomputeBeta();
    this.syncPlanPose(false);
    this.emit();
  }

  public setActiveLimb(limb: LimbId): void {
    this.activeLimb = limb;
    this.recomputePreviewEvaluations();
    this.emit();
  }

  public setPlanContactMode(mode: PlanContactMode): void {
    this.planContactMode = mode;
    if (mode === 'dyno' && !LIMB_META[this.activeLimb].isHand) {
      this.activeLimb = 'rh';
    }
    this.wallHoverEval = null;
    this.wallHoverPos = null;
    this.recomputePreviewEvaluations();
    this.emit();
  }

  public addBetaTarget(target: LimbTarget): void {
    const contacts = this.getInspectedContacts();
    if (target.kind === 'hold' && contacts.assignment[this.activeLimb] === target.holdId) {
      return;
    }
    if (
      target.kind === 'dyno' &&
      target.bothHands &&
      contacts.assignment.lh === target.holdId &&
      contacts.assignment.rh === target.holdId
    ) {
      return;
    }

    const prefix =
      this.inspectedStepIndex < this.betaSteps.length - 1
        ? this.betaSteps.slice(0, this.inspectedStepIndex + 1)
        : this.betaSteps;

    const stepLimb: LimbId =
      target.kind === 'dyno' && target.bothHands ? 'rh' : this.activeLimb;

    const newStep: BetaStep = {
      id: nextUid('step'),
      limb: stepLimb,
      target,
    };
    this.betaSteps = [...prefix, newStep];
    this.inspectedStepIndex = this.betaSteps.length - 1;
    this.recomputeBeta();
    this.syncPlanPose(false);

    const puff =
      target.kind === 'hold' || target.kind === 'dyno'
        ? this.holds.find((h) => h.id === target.holdId)
        : { x: target.x, y: target.y };
    if (puff) this.spawnChalkPuff({ x: puff.x, y: puff.y }, target.kind === 'dyno' ? 12 : 7);
    this.emit();
  }

  public setDisplayToggle(key: 'showReachArc' | 'showComLine' | 'showBetaArrows', value: boolean): void {
    this[key] = value;
    this.emit();
  }

  public inspectStep(index: number): void {
    this.inspectedStepIndex = clamp(index, -1, this.betaSteps.length - 1);
    this.recomputePreviewEvaluations();
    this.syncPlanPose(false);
    this.emit();
  }

  public undoBetaStep(): void {
    if (this.betaSteps.length === 0) return;
    this.betaSteps = this.betaSteps.slice(0, -1);
    this.inspectedStepIndex = this.betaSteps.length - 1;
    this.recomputeBeta();
    this.syncPlanPose(false);
    this.emit();
  }

  public removeBetaStep(index: number): void {
    if (index < 0 || index >= this.betaSteps.length) return;
    this.betaSteps = this.betaSteps.filter((_, i) => i !== index);
    this.inspectedStepIndex = Math.min(this.inspectedStepIndex, this.betaSteps.length - 1);
    this.recomputeBeta();
    this.syncPlanPose(false);
    this.emit();
  }

  public clearBeta(): void {
    this.betaSteps = [];
    this.inspectedStepIndex = -1;
    this.recomputeBeta();
    this.syncPlanPose(false);
    this.emit();
  }

  public autoSuggestBeta(): { solved: boolean; stepsCount: number } {
    const sol = suggestBeta(this.holds, this.profile, 24, 24, this.wallAngleDeg);
    this.betaSteps = sol.steps;
    this.inspectedStepIndex = sol.steps.length - 1;
    this.recomputeBeta();
    this.syncPlanPose(false);
    this.emit();
    return { solved: sol.solved, stepsCount: sol.steps.length };
  }

  public setPlaybackSpeed(speed: number): void {
    this.playbackSpeed = speed;
    this.emit();
  }

  public startClimb(): void {
    if (this.holds.length === 0) return;
    this.mode = 'climb';
    this.recomputeBeta();

    if (this.betaSteps.length === 0) {
      this.climbStatus = 'incomplete';
      this.climbStatusText = '请先在「规划 Beta」中规划至少 1 步动作，或点击 AI 推演参考 Beta。';
      this.resetClimbToStart();
      this.emit();
      return;
    }

    const holdMap = buildHoldMap(this.holds);
    const anatomy = computeAnatomy(this.profile);
    const initAssign = getInitialAssignment(this.holds, this.profile);
    const initFree = emptyFreeMap();
    const startPose = solvePose(
      initAssign,
      holdMap,
      anatomy,
      this.profile.flexibility,
      undefined,
      freeOverrides(initFree)
    );

    this.displayPose = startPose;
    this.climbStamina = 100;
    this.climbBalance = 100;
    this.climbResult = null;
    this.climbStatus = 'running';
    this.particles = [];

    this.beginClimbStep(0, initAssign, initFree, startPose, 100, 0, null, 0);
    this.emit();
  }

  public togglePauseClimb(): void {
    if (this.climbStatus === 'running') {
      this.climbStatus = 'paused';
      this.climbStatusText = '已暂停';
      this.emit();
    } else if (this.climbStatus === 'paused') {
      this.climbStatus = 'running';
      this.emit();
    } else {
      this.startClimb();
    }
  }

  public resetClimbToStart(): void {
    this.anim = null;
    this.climbStatus = 'idle';
    this.climbStatusText = '等待开始攀爬';
    this.climbStamina = 100;
    this.climbBalance = 100;
    this.climbResult = null;
    const holdMap = buildHoldMap(this.holds);
    const initAssign = getInitialAssignment(this.holds, this.profile);
    this.displayPose = solvePose(
      initAssign,
      holdMap,
      computeAnatomy(this.profile),
      this.profile.flexibility,
      undefined,
      freeOverrides(emptyFreeMap())
    );
    this.targetDisplayPose = this.displayPose;
  }

  // ==================== INTERNAL LOGIC ====================

  private stopClimbInternal(): void {
    this.anim = null;
    this.climbStatus = 'idle';
    this.climbResult = null;
  }

  private getInspectedContacts(): { assignment: LimbAssignment; free: FreeLimbMap } {
    const initial = getInitialAssignment(this.holds, this.profile);
    if (this.inspectedStepIndex < 0 || this.betaTraces.length === 0) {
      return { assignment: initial, free: emptyFreeMap() };
    }
    const idx = clamp(this.inspectedStepIndex, 0, this.betaTraces.length - 1);
    return {
      assignment: this.betaTraces[idx].assignmentAfter,
      free: this.betaTraces[idx].freeAfter,
    };
  }

  private recomputeBeta(): void {
    const initial = getInitialAssignment(this.holds, this.profile);
    const res = evaluateBetaSequence(
      initial,
      this.betaSteps,
      this.holds,
      this.profile,
      emptyFreeMap(),
      this.wallAngleDeg
    );
    this.betaTraces = res.traces;
    this.betaReachesTop = res.reachesTop;
    this.betaFirstFailure = res.firstFailureIndex;
    this.betaFinalStamina = res.finalStamina;
    this.inspectedStepIndex = clamp(this.inspectedStepIndex, -1, this.betaSteps.length - 1);
    this.recomputePreviewEvaluations();
  }

  private recomputePreviewEvaluations(): void {
    this.previewEvaluations.clear();
    if (this.mode !== 'plan') return;
    const { assignment, free } = this.getInspectedContacts();
    for (const h of this.holds) {
      if (this.planContactMode === 'doubleDyno') {
        if (assignment.lh === h.id && assignment.rh === h.id) continue;
        const ev = evaluateMove(
          assignment,
          free,
          'rh',
          dynoTarget(h.id, true),
          this.holds,
          this.profile,
          this.wallAngleDeg
        );
        this.previewEvaluations.set(h.id, ev);
      } else if (this.planContactMode === 'dyno') {
        if (assignment[this.activeLimb] === h.id) continue;
        const ev = evaluateMove(
          assignment,
          free,
          this.activeLimb,
          dynoTarget(h.id, false),
          this.holds,
          this.profile,
          this.wallAngleDeg
        );
        this.previewEvaluations.set(h.id, ev);
      } else {
        if (assignment[this.activeLimb] === h.id) continue;
        const ev = evaluateMove(
          assignment,
          free,
          this.activeLimb,
          holdTarget(h.id),
          this.holds,
          this.profile,
          this.wallAngleDeg
        );
        this.previewEvaluations.set(h.id, ev);
      }
    }
  }

  private syncPlanPose(snapImmediately: boolean): void {
    const holdMap = buildHoldMap(this.holds);
    const { assignment, free } = this.getInspectedContacts();
    const solved = solvePose(
      assignment,
      holdMap,
      computeAnatomy(this.profile),
      this.profile.flexibility,
      undefined,
      freeOverrides(free)
    );
    this.targetDisplayPose = solved;
    if (snapImmediately) {
      this.displayPose = solved;
    }
  }

  private resolveStepTargetPos(step: BetaStep): Vec2 | null {
    const t = step.target;
    if (t.kind === 'hold' || t.kind === 'dyno') {
      const hold = this.holds.find((x) => x.id === t.holdId);
      return hold ? { x: hold.x, y: hold.y } : null;
    }
    return { x: t.x, y: t.y };
  }

  private beginClimbStep(
    stepIdx: number,
    currentAssignment: LimbAssignment,
    currentFree: FreeLimbMap,
    startPose: SolvedPose,
    staminaBefore: number,
    elapsedTotal: number,
    cruxStepIndex: number | null,
    cruxStrain: number
  ): void {
    const step = this.betaSteps[stepIdx];
    const holdMap = buildHoldMap(this.holds);
    const anatomy = computeAnatomy(this.profile);
    const targetPos = this.resolveStepTargetPos(step);
    const targetHold =
      step.target.kind === 'hold' || step.target.kind === 'dyno'
        ? holdMap.get(step.target.holdId)
        : undefined;
    const ev = evaluateMove(
      currentAssignment,
      currentFree,
      step.limb,
      step.target,
      this.holds,
      this.profile,
      this.wallAngleDeg
    );

    const support = detachLimb(currentAssignment, currentFree, step.limb);
    const supportPose = solvePose(
      support.assignment,
      holdMap,
      anatomy,
      this.profile.flexibility,
      targetPos ? { limb: step.limb, target: targetPos, strength: 0.9 } : undefined,
      freeOverrides(support.free)
    );

    const staminaAfter = Math.max(0, Math.round((staminaBefore - ev.staminaCost) * 10) / 10);
    const pumpedOut = ev.feasible && staminaAfter <= 0;
    const willFail = !ev.feasible || pumpedOut;
    const failReason = !ev.feasible
      ? ev.failReason ?? '动作失败，抓握脱落'
      : pumpedOut
      ? '前臂泵感拉满，体能耗尽失手掉落！'
      : '';

    const limbName = LIMB_META[step.limb].nameZh;
    const destLabel =
      targetHold
        ? `#${targetHold.label} ${HOLD_SPECS[targetHold.type].shortZh}`
        : targetLabel(step.target);
    const isDoubleDyno = step.target.kind === 'dyno' && step.target.bothHands;
    this.climbStatusText = isDoubleDyno
      ? `第 ${stepIdx + 1} 步：深蹲蓄力，双手齐飞 (Double Dyno) -> ${destLabel}！`
      : ev.isDyno
        ? `第 ${stepIdx + 1} 步：蹬脚发力，${limbName}动态飞跃 -> ${destLabel}！`
        : `第 ${stepIdx + 1} 步：重心调整，${limbName}移动 -> ${destLabel}`;

    const nextCruxStrain = ev.staminaCost > cruxStrain ? ev.staminaCost : cruxStrain;
    const nextCruxIdx = ev.staminaCost > cruxStrain ? stepIdx : cruxStepIndex;

    this.anim = {
      phase: 'shift',
      phaseTime: 0,
      phaseDuration: isDoubleDyno ? 0.44 : ev.isDyno ? 0.38 : 0.28,
      stepIdx,
      startPose,
      supportPose,
      targetPose: ev.resultingPose,
      currentAssignment,
      currentFree,
      currentEval: ev,
      willFail,
      failReason,
      staminaBeforeStep: staminaBefore,
      staminaAfterStep: staminaAfter,
      elapsedTotal,
      cruxStepIndex: nextCruxIdx,
      cruxStrain: nextCruxStrain,
      fallOffsetX: 0,
      fallOffsetY: 0,
      fallVx: 0,
      fallVy: 0,
      fallRot: 0,
      fallOmega: 0,
      fallBounced: false,
      fallPose: null,
    };
  }

  private spawnChalkPuff(pos: Vec2, count = 10, color = '#FAFBF8'): void {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 16 + Math.random() * 44;
      this.particles.push({
        x: pos.x + (Math.random() - 0.5) * 6,
        y: pos.y + (Math.random() - 0.5) * 6,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd + 10,
        size: 1.8 + Math.random() * 3.4,
        alpha: 0.75,
        life: 0,
        maxLife: 0.45 + Math.random() * 0.4,
        color,
        gravity: -45,
      });
    }
  }

  private spawnSendConfetti(pos: Vec2): void {
    const colors = ['#2563EB', '#E11D48', '#16A34A', '#D97706', '#FAFBF8'];
    for (let i = 0; i < 36; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 40 + Math.random() * 110;
      this.particles.push({
        x: pos.x,
        y: pos.y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd + 70,
        size: 2.6 + Math.random() * 2.8,
        alpha: 1,
        life: 0,
        maxLife: 1.2 + Math.random() * 0.7,
        color: colors[i % colors.length],
        gravity: -220,
      });
    }
  }

  // ==================== LOOP & ANIMATION ====================

  private loop = (nowMs: number): void => {
    const rawDt = Math.min(0.05, Math.max(0.001, (nowMs - this.lastFrameMs) / 1000));
    this.lastFrameMs = nowMs;
    this.timeSec += rawDt;

    // Smooth motorized hydraulic Kilter wall-tilt transition!
    if (Math.abs(this.renderedWallAngle - this.wallAngleDeg) > 0.05) {
      this.renderedWallAngle = lerp(this.renderedWallAngle, this.wallAngleDeg, Math.min(1, rawDt * 11));
    } else {
      this.renderedWallAngle = this.wallAngleDeg;
    }

    this.updateParticles(rawDt);

    if (this.mode === 'plan') {
      const anatomy = computeAnatomy(this.profile);
      this.displayPose = blendPosesRigid(
        this.displayPose,
        this.targetDisplayPose,
        Math.min(1, rawDt * 12),
        anatomy,
        this.profile.flexibility
      );
    } else if (this.mode === 'climb' && this.climbStatus === 'running' && this.anim) {
      this.updateClimbAnimation(rawDt * this.playbackSpeed);
    }

    this.render();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private updateParticles(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.96;
      p.alpha = (1 - p.life / p.maxLife) * 0.85;
    }
  }

  private updateClimbAnimation(dt: number): void {
    const a = this.anim;
    if (!a) return;

    a.elapsedTotal += dt;
    a.phaseTime += dt;
    const t = clamp(a.phaseTime / Math.max(0.01, a.phaseDuration), 0, 1);
    const step = this.betaSteps[a.stepIdx];
    const holdMap = buildHoldMap(this.holds);
    const anatomy = computeAnatomy(this.profile);
    const targetPos = step ? this.resolveStepTargetPos(step) : null;
    const targetHold =
      step && (step.target.kind === 'hold' || step.target.kind === 'dyno')
        ? holdMap.get(step.target.holdId)
        : undefined;
    const isDoubleDyno = step?.target.kind === 'dyno' && step.target.bothHands;
    const isExplicitDyno = step?.target.kind === 'dyno';
    const cutsFeet = Boolean(a.currentEval?.cutsFeet);
    const anchoredAll: Record<LimbId, boolean> = {
      lh: a.currentAssignment.lh !== null || a.currentFree.lh !== null,
      rh: a.currentAssignment.rh !== null || a.currentFree.rh !== null,
      lf: a.currentAssignment.lf !== null || a.currentFree.lf !== null,
      rf: a.currentAssignment.rf !== null || a.currentFree.rf !== null,
    };

    if (a.phase === 'shift') {
      // Phase 1: Weight transfer / deep squat coil before explosive Dyno launch
      const e = easeInOutCubic(t);
      const pelvis = lerpVec(a.startPose.pelvis, a.supportPose.pelvis, e * (isExplicitDyno ? 0.38 : 0.62));
      if (isExplicitDyno || a.currentEval?.isDyno) {
        // Deep athletic coil downward before exploding upward!
        const coilDepth = isDoubleDyno ? 22 : isExplicitDyno ? 18 : 14;
        pelvis.y = Math.max(22, pelvis.y - Math.sin(t * Math.PI * 0.85) * coilDepth);
      } else {
        pelvis.y -= Math.sin(t * Math.PI) * 2.5;
      }
      const torsoAngle = lerp(a.startPose.torsoAngle, a.supportPose.torsoAngle, e * 0.55);
      const hipTurn = lerp(a.startPose.hipTurn, a.supportPose.hipTurn, e * 0.65);

      this.displayPose = buildRigidPoseFromTargets(
        pelvis,
        torsoAngle,
        hipTurn,
        { ...a.startPose.limbs },
        anchoredAll,
        anatomy,
        this.profile.flexibility
      );

      if (t >= 1) {
        if (isDoubleDyno) {
          this.spawnChalkPuff(a.startPose.limbs.lh, 9);
          this.spawnChalkPuff(a.startPose.limbs.rh, 9);
        } else {
          this.spawnChalkPuff(a.startPose.limbs[step.limb], 7);
        }
        if (cutsFeet) {
          // Explosive foot push-off chalk burst!
          if (a.currentAssignment.lf || a.currentFree.lf) this.spawnChalkPuff(a.startPose.limbs.lf, 10, '#E2E8F0');
          if (a.currentAssignment.rf || a.currentFree.rf) this.spawnChalkPuff(a.startPose.limbs.rf, 10, '#E2E8F0');
        }
        a.phase = 'reach';
        a.phaseTime = 0;
        const moveDist = targetHold ? dist(a.startPose.limbs[step.limb], targetHold) : 50;
        a.phaseDuration = isDoubleDyno
          ? 0.42
          : isExplicitDyno
            ? 0.38
            : a.currentEval?.isDyno
              ? 0.34
              : clamp(0.32 + moveDist / 340, 0.36, 0.56);
      }
    } else if (a.phase === 'reach') {
      // Phase 2: Curved limb swing OR full airborne parabolic Dyno flight!
      const isShortFail = a.willFail && (a.currentEval?.reachExcessCm ?? 0) > 0;
      const isHand = LIMB_META[step.limb].isHand;
      const isLeft = LIMB_META[step.limb].side === 'left';
      const reachFactor = isShortFail ? 0.78 : 1.0;

      const moveEase = a.currentEval?.isDyno ? easeOutCubic(t) : easeInOutCubic(t);
      const bodyEase = isExplicitDyno ? easeOutCubic(t) : easeInOutCubic(t);

      const coilDrop = isDoubleDyno ? 22 : isExplicitDyno ? 18 : 0;
      const shiftStartPelvis = lerpVec(a.startPose.pelvis, a.supportPose.pelvis, isExplicitDyno ? 0.38 : 0.62);
      shiftStartPelvis.y = Math.max(22, shiftStartPelvis.y - coilDrop * Math.sin(Math.PI * 0.85));
      const shiftStartTorso = lerp(a.startPose.torsoAngle, a.supportPose.torsoAngle, 0.55);
      const shiftStartTurn = lerp(a.startPose.hipTurn, a.supportPose.hipTurn, 0.65);

      const pelvis = lerpVec(shiftStartPelvis, a.targetPose.pelvis, bodyEase * reachFactor);
      if (isDoubleDyno) {
        // Big parabolic jump apex!
        pelvis.y += Math.sin(t * Math.PI) * 28;
      } else if (isExplicitDyno) {
        pelvis.y += Math.sin(t * Math.PI) * 21;
      } else if (a.currentEval?.isDyno) {
        pelvis.y += Math.sin(t * Math.PI) * 14;
      }

      const torsoAngle = lerp(shiftStartTorso, a.targetPose.torsoAngle, bodyEase * reachFactor);
      const hipTurn = lerp(shiftStartTurn, a.targetPose.hipTurn, bodyEase * reachFactor);

      const toPt = targetPos ?? a.targetPose.limbs[step.limb];

      const limbPinned = (l: LimbId) => {
        if (cutsFeet && (l === 'lf' || l === 'rf')) return false;
        if (isDoubleDyno && (l === 'lh' || l === 'rh')) return false;
        return a.currentAssignment[l] !== null || a.currentFree[l] !== null;
      };

      const limbTargets: Record<LimbId, Vec2> = {
        lh: limbPinned('lh') ? a.startPose.limbs.lh : lerpVec(a.startPose.limbs.lh, a.targetPose.limbs.lh, bodyEase),
        rh: limbPinned('rh') ? a.startPose.limbs.rh : lerpVec(a.startPose.limbs.rh, a.targetPose.limbs.rh, bodyEase),
        lf: limbPinned('lf') ? a.startPose.limbs.lf : lerpVec(a.startPose.limbs.lf, a.targetPose.limbs.lf, bodyEase),
        rf: limbPinned('rf') ? a.startPose.limbs.rf : lerpVec(a.startPose.limbs.rf, a.targetPose.limbs.rf, bodyEase),
      };

      // Airborne trailing feet during a cut-loose Dyno!
      if (cutsFeet) {
        const flightDragY = Math.sin(t * Math.PI) * 16;
        const flightDragX = -(a.targetPose.pelvis.x - a.startPose.pelvis.x) * Math.sin(t * Math.PI) * 0.22;
        limbTargets.lf = {
          x: lerp(a.startPose.limbs.lf.x, a.targetPose.limbs.lf.x, bodyEase) + flightDragX - 4 * Math.sin(t * Math.PI),
          y: Math.max(8, lerp(a.startPose.limbs.lf.y, a.targetPose.limbs.lf.y, bodyEase) - flightDragY),
        };
        limbTargets.rf = {
          x: lerp(a.startPose.limbs.rf.x, a.targetPose.limbs.rf.x, bodyEase) + flightDragX + 4 * Math.sin(t * Math.PI),
          y: Math.max(8, lerp(a.startPose.limbs.rf.y, a.targetPose.limbs.rf.y, bodyEase) - flightDragY),
        };
      }

      // Compute sweeping arc for reaching hand(s) or foot
      let movingPos: Vec2 = toPt;
      if (isDoubleDyno) {
        const destL = lerpVec(a.startPose.limbs.lh, { x: toPt.x - 5, y: toPt.y }, reachFactor);
        const destR = lerpVec(a.startPose.limbs.rh, { x: toPt.x + 5, y: toPt.y }, reachFactor);
        const arcLift = Math.sin(t * Math.PI) * 24;
        limbTargets.lh = {
          x: lerp(a.startPose.limbs.lh.x, destL.x, moveEase) - Math.sin(t * Math.PI) * 12,
          y: lerp(a.startPose.limbs.lh.y, destL.y, moveEase) + arcLift,
        };
        limbTargets.rh = {
          x: lerp(a.startPose.limbs.rh.x, destR.x, moveEase) + Math.sin(t * Math.PI) * 12,
          y: lerp(a.startPose.limbs.rh.y, destR.y, moveEase) + arcLift,
        };
        movingPos = toPt;
      } else {
        const fromPt = a.startPose.limbs[step.limb];
        const destPt = lerpVec(fromPt, toPt, reachFactor);
        const sideSign = isLeft ? -1 : 1;
        const isSteppingUp = destPt.y > fromPt.y + 8;
        const ctrlPt: Vec2 = {
          x: (fromPt.x + destPt.x) / 2 + sideSign * (isHand ? 12 : 9),
          y:
            (fromPt.y + destPt.y) / 2 +
            (a.currentEval?.isDyno ? 22 : isHand ? 9 : isSteppingUp ? 7 : 3),
        };
        const inv = 1 - moveEase;
        movingPos = {
          x: inv * inv * fromPt.x + 2 * inv * moveEase * ctrlPt.x + moveEase * moveEase * destPt.x,
          y: inv * inv * fromPt.y + 2 * inv * moveEase * ctrlPt.y + moveEase * moveEase * destPt.y,
        };
        limbTargets[step.limb] = movingPos;
      }

      const activeFlags: Record<LimbId, boolean> = {
        lh: limbPinned('lh') && step.limb !== 'lh',
        rh: limbPinned('rh') && step.limb !== 'rh',
        lf: limbPinned('lf') && step.limb !== 'lf',
        rf: limbPinned('rf') && step.limb !== 'rf',
      };

      this.displayPose = buildRigidPoseFromTargets(
        pelvis,
        torsoAngle,
        hipTurn,
        limbTargets,
        activeFlags,
        anatomy,
        this.profile.flexibility
      );

      this.climbStamina = lerp(a.staminaBeforeStep, a.staminaAfterStep, t);
      this.climbBalance = a.currentEval?.balanceScore ?? 80;

      if (t >= 1) {
        if (a.willFail) {
          this.spawnChalkPuff(movingPos, 16, '#FFFFFF');
          a.phase = 'fall';
          a.phaseTime = 0;
          a.phaseDuration = 1.6;
          a.fallPose = this.displayPose;
          a.fallOffsetX = 0;
          a.fallOffsetY = 0;
          const jumpDirX = a.targetPose.pelvis.x - a.startPose.pelvis.x;
          const barnPush =
            isExplicitDyno
              ? clamp(jumpDirX * 0.65, -70, 70)
              : (a.currentEval?.barnDoorRisk ?? 0) > 0.5
                ? this.displayPose.com.x > 200
                  ? 48
                  : -48
                : (Math.random() - 0.5) * 28;
          a.fallVx = barnPush;
          a.fallVy = a.currentEval?.isDyno ? 55 : -10;
          a.fallRot = 0;
          a.fallOmega = barnPush >= 0 ? 2.1 : -2.1;
          this.climbStatusText = `脱落！${a.failReason}`;
          this.emit();
        } else {
          if (targetPos) this.spawnChalkPuff(targetPos, isExplicitDyno ? 18 : 11);
          const applied = applyLimbTarget(
            a.currentAssignment,
            a.currentFree,
            step.limb,
            step.target,
            cutsFeet
          );
          a.currentAssignment = applied.assignment;
          a.currentFree = applied.free;
          this.climbStamina = a.staminaAfterStep;
          a.phase = 'settle';
          a.phaseTime = 0;
          a.phaseDuration = cutsFeet ? 0.52 : a.currentEval?.isDyno ? 0.34 : 0.24;
          this.emit();
        }
      }
    } else if (a.phase === 'settle') {
      // Phase 3: Elastic catch + realistic cut-loose pendulum leg swing after Dyno!
      const dipAmp = cutsFeet ? 12 : a.currentEval?.isDyno ? 8.5 : 3.2;
      const dampedBounce = Math.sin(t * Math.PI) * Math.exp(-t * 1.4) * dipAmp;
      const jumpMomentumSign = a.targetPose.pelvis.x >= a.startPose.pelvis.x ? 1 : -1;
      const swingPelvisX = cutsFeet
        ? Math.sin(t * Math.PI * 2.2) * Math.exp(-t * 2.4) * 14 * jumpMomentumSign
        : 0;

      const settlePelvis: Vec2 = {
        x: clamp(a.targetPose.pelvis.x + swingPelvisX, 24, WALL_WIDTH_CM - 24),
        y: Math.max(20, a.targetPose.pelvis.y - dampedBounce),
      };

      const settleLimbs = { ...a.targetPose.limbs };
      if (cutsFeet) {
        // Secondary-motion phase-lagged pendulum swing on dangling legs!
        const legSwingX =
          Math.sin(Math.max(0, t - 0.1) * Math.PI * 2.2) * Math.exp(-t * 1.9) * 26 * jumpMomentumSign;
        const legLiftY = Math.abs(legSwingX) * 0.28;
        settleLimbs.lf = {
          x: clamp(a.targetPose.limbs.lf.x + legSwingX, 14, WALL_WIDTH_CM - 14),
          y: Math.max(8, a.targetPose.limbs.lf.y + legLiftY),
        };
        settleLimbs.rf = {
          x: clamp(a.targetPose.limbs.rf.x + legSwingX, 14, WALL_WIDTH_CM - 14),
          y: Math.max(8, a.targetPose.limbs.rf.y + legLiftY),
        };
      }

      this.displayPose = buildRigidPoseFromTargets(
        settlePelvis,
        a.targetPose.torsoAngle + (cutsFeet ? swingPelvisX * 0.012 : 0),
        a.targetPose.hipTurn,
        settleLimbs,
        {
          lh: a.currentAssignment.lh !== null || a.currentFree.lh !== null,
          rh: a.currentAssignment.rh !== null || a.currentFree.rh !== null,
          lf: a.currentAssignment.lf !== null || a.currentFree.lf !== null,
          rf: a.currentAssignment.rf !== null || a.currentFree.rf !== null,
        },
        anatomy,
        this.profile.flexibility
      );

      if (t >= 1) {
        this.displayPose = a.targetPose;
        if (isTopReached(a.currentAssignment, this.holds)) {
          a.phase = 'holdTop';
          a.phaseTime = 0;
          a.phaseDuration = 0.7;
          this.climbStatusText = '双手匹配完攀点 (TOP)，稳住 1 秒…';
          this.emit();
        } else if (a.stepIdx + 1 < this.betaSteps.length) {
          this.beginClimbStep(
            a.stepIdx + 1,
            a.currentAssignment,
            a.currentFree,
            a.targetPose,
            a.staminaAfterStep,
            a.elapsedTotal,
            a.cruxStepIndex,
            a.cruxStrain
          );
          this.emit();
        } else {
          this.climbStatus = 'incomplete';
          this.climbStatusText = '已完成当前规划动作，但双手尚未同时抓稳完攀点 (TOP)';
          this.anim = null;
          this.emit();
        }
      }
    } else if (a.phase === 'holdTop') {
      if (t >= 1) {
        const topHold = this.holds.find((h) => h.role === 'top');
        if (topHold) this.spawnSendConfetti({ x: topHold.x, y: topHold.y });
        this.climbStatus = 'success';
        this.climbStatusText = '完攀成功 (SEND)!';
        this.climbResult = {
          status: 'success',
          reason: '动作连贯、重心稳定，成功双手匹配完攀点！',
          movesCompleted: a.stepIdx + 1,
          totalMoves: this.betaSteps.length,
          staminaRemaining: Math.round(this.climbStamina),
          cruxStepIndex: a.cruxStepIndex,
          cruxStrain: Math.round(a.cruxStrain),
          elapsedSec: Math.round(a.elapsedTotal * 10) / 10,
        };
        this.anim = null;
        this.emit();
      }
    } else if (a.phase === 'fall') {
      // Gravity fall onto crash pad (y = 0)
      const gravity = -560; // cm/s^2
      a.fallVy += gravity * dt;
      a.fallOffsetX += a.fallVx * dt;
      a.fallOffsetY += a.fallVy * dt;
      a.fallRot += a.fallOmega * dt;

      const comY = (a.fallPose?.com.y ?? 100) + a.fallOffsetY;
      if (comY <= 18) {
        a.fallOffsetY = 18 - (a.fallPose?.com.y ?? 100);
        if (!a.fallBounced) {
          a.fallBounced = true;
          a.fallVy = Math.abs(a.fallVy) * 0.22;
          a.fallVx *= 0.35;
          a.fallOmega *= 0.25;
          const comX = (a.fallPose?.com.x ?? 200) + a.fallOffsetX;
          this.spawnChalkPuff({ x: clamp(comX, 20, WALL_WIDTH_CM - 20), y: 4 }, 16, '#CBD5E1');
        } else {
          a.fallVy = 0;
          a.fallVx *= 0.8;
          a.fallOmega *= 0.7;
        }
      }

      if (a.phaseTime >= 1.25 && a.fallBounced) {
        this.climbStatus = 'failed';
        this.climbResult = {
          status: 'failed',
          failedAtStep: a.stepIdx + 1,
          reason: a.failReason,
          movesCompleted: a.stepIdx,
          totalMoves: this.betaSteps.length,
          staminaRemaining: Math.round(this.climbStamina),
          cruxStepIndex: a.cruxStepIndex,
          cruxStrain: Math.round(a.cruxStrain),
          elapsedSec: Math.round(a.elapsedTotal * 10) / 10,
        };
        this.emit();
      }
    }
  }

  private render(): void {
    const rect = this.canvas.getBoundingClientRect();
    const inspected = this.getInspectedContacts();
    const activeAssign =
      this.mode === 'climb' && this.anim
        ? this.anim.currentAssignment
        : inspected.assignment;
    const activeFree =
      this.mode === 'climb' && this.anim ? this.anim.currentFree : inspected.free;

    const strain =
      this.mode === 'climb'
        ? clamp((100 - this.climbStamina) / 110 + (this.anim?.currentEval?.rating === 'hard' ? 0.35 : 0), 0, 1)
        : 0;

    let lookTarget: Vec2 | null = null;
    if (this.mode === 'climb' && this.anim) {
      lookTarget = this.resolveStepTargetPos(this.betaSteps[this.anim.stepIdx]);
    } else if (this.mode === 'plan' && this.hoveredHoldId) {
      const h = this.holds.find((x) => x.id === this.hoveredHoldId);
      if (h) lookTarget = { x: h.x, y: h.y };
    } else if (this.mode === 'plan' && this.wallHoverPos) {
      lookTarget = this.wallHoverPos;
    }

    const limbPinned = (l: LimbId) => activeAssign[l] !== null || activeFree[l] !== null;

    // Subtle organic breathing motion on torso/pelvis while keeping anchored hands/feet pinned!
    let renderPose = this.displayPose;
    if (this.mode !== 'setter' && this.anim?.phase !== 'fall') {
      const breathAmp = this.climbStatus === 'running' ? 0.55 : 0.9;
      const breathY = Math.sin(this.timeSec * 2.3) * breathAmp;
      const breathX = Math.cos(this.timeSec * 1.15) * (breathAmp * 0.45);
      renderPose = buildRigidPoseFromTargets(
        { x: this.displayPose.pelvis.x + breathX, y: this.displayPose.pelvis.y + breathY },
        this.displayPose.torsoAngle,
        this.displayPose.hipTurn,
        { ...this.displayPose.limbs },
        {
          lh: limbPinned('lh'),
          rh: limbPinned('rh'),
          lf: limbPinned('lf'),
          rf: limbPinned('rf'),
        },
        computeAnatomy(this.profile),
        this.profile.flexibility
      );
    }

    this.transform = renderScene(this.ctx, rect.width, rect.height, {
      camera: {
        zoom: this.cameraZoom,
        panX: this.cameraPanX,
        panY: this.cameraPanY,
      },
      wallAngleDeg: this.renderedWallAngle,
      mode: this.mode,
      holds: this.holds,
      profile: this.profile,
      pose: renderPose,
      assignment: activeAssign,
      freeLimbs: activeFree,
      selectedHoldId: this.selectedHoldId,
      hoveredHoldId: this.hoveredHoldId,
      activeLimb: this.activeLimb,
      planContactMode: this.planContactMode,
      wallHoverPos: this.wallHoverPos,
      betaSteps: this.betaSteps,
      betaTraces: this.betaTraces,
      inspectedStepIndex: this.inspectedStepIndex,
      previewEvaluations: this.previewEvaluations,
      showReachArc: this.showReachArc,
      showComLine: this.showComLine,
      showBetaArrows: this.showBetaArrows,
      isClimbing: this.climbStatus === 'running',
      activeClimbStep: this.anim?.stepIdx ?? -1,
      stamina: this.climbStamina,
      strainLevel: strain,
      lookTarget,
      fallingState:
        this.anim?.phase === 'fall' && this.anim.fallPose
          ? {
              active: true,
              offsetX: this.anim.fallOffsetX,
              offsetY: this.anim.fallOffsetY,
              rotation: this.anim.fallRot,
              pose: this.anim.fallPose,
            }
          : null,
      particles: this.particles,
      timeSec: this.timeSec,
    });
  }

  // ==================== POINTER INTERACTIONS ====================

  private getPointerScreen(e: MouseEvent): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private getPointerWorld(e: MouseEvent): Vec2 {
    return screenToWorld(this.getPointerScreen(e), this.transform);
  }

  private hitTestHold(worldPt: Vec2, isTouch = false): Hold | null {
    let best: Hold | null = null;
    let bestDist = Infinity;
    const touchBase = Math.max(13, 22 / Math.sqrt(this.cameraZoom));
    const touchPad = Math.max(5, 12 / Math.sqrt(this.cameraZoom));
    for (let i = this.holds.length - 1; i >= 0; i--) {
      const h = this.holds[i];
      const hitR = isTouch
        ? Math.max(touchBase, getHoldHitRadius(h) + touchPad)
        : Math.max(13, getHoldHitRadius(h) + 5);
      const d = dist(worldPt, h);
      if (d <= hitR && d < bestDist) {
        best = h;
        bestDist = d;
      }
    }
    return best;
  }

  private commitTapAt(screenPt: Vec2, isTouch: boolean): void {
    const wp = screenToWorld(screenPt, this.transform);
    const hit = this.hitTestHold(wp, isTouch);

    if (this.mode === 'setter') {
      if (hit) {
        this.selectedHoldId = hit.id;
        this.emit();
      } else if (wp.x >= 12 && wp.x <= WALL_WIDTH_CM - 12 && wp.y >= 16 && wp.y <= WALL_HEIGHT_CM - 16) {
        const newHold: Hold = {
          id: nextUid('h'),
          label: this.holds.length + 1,
          x: Math.round(wp.x),
          y: Math.round(wp.y),
          type: this.brush.type,
          role: this.brush.role,
          angle: this.brush.angle,
          scale: this.brush.scale,
          color: this.brush.type === 'volume' ? '#3D434C' : this.brush.color,
          styleFamily: this.brush.styleFamily,
          shapeVariant: this.brush.shapeVariant,
          dualTex: this.brush.type !== 'foothold' && this.brush.type !== 'volume' ? this.brush.dualTex : false,
          thumbCatch: this.brush.type !== 'foothold' && this.brush.type !== 'volume' ? this.brush.thumbCatch : false,
        };
        this.holds = renumberHolds([...this.holds, newHold]);
        this.selectedHoldId = newHold.id;
        this.recomputeBeta();
        this.emit();
      } else {
        this.selectedHoldId = null;
        this.emit();
      }
    } else if (this.mode === 'plan') {
      if (hit) {
        if (this.planContactMode === 'dyno') {
          this.addBetaTarget(dynoTarget(hit.id, false));
        } else if (this.planContactMode === 'doubleDyno') {
          this.addBetaTarget(dynoTarget(hit.id, true));
        } else {
          this.addBetaTarget(holdTarget(hit.id));
        }
      } else if (
        (this.planContactMode === 'smear' || this.planContactMode === 'flag') &&
        wp.x >= 12 &&
        wp.x <= WALL_WIDTH_CM - 12 &&
        wp.y >= 16 &&
        wp.y <= WALL_HEIGHT_CM - 16
      ) {
        const x = Math.round(wp.x);
        const y = Math.round(wp.y);
        this.addBetaTarget(
          this.planContactMode === 'smear' ? smearTarget(x, y) : flagTarget(x, y)
        );
      }
    }
  }

  private bindEvents(): void {
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType !== 'touch') return;
      const sp = this.getPointerScreen(e);
      this.activePointers.set(e.pointerId, sp);

      // 2 fingers -> begin pinch-to-zoom & pan immediately, canceling any pending tap or hold drag!
      if (this.activePointers.size === 2) {
        const pts = [...this.activePointers.values()];
        this.isPinching = true;
        this.pinchJustEnded = false;
        this.pendingTap = null;
        this.isPanning = false;
        if (this.draggingHoldId && this.dragOrigHoldPos) {
          const orig = this.dragOrigHoldPos;
          const hid = this.draggingHoldId;
          this.holds = this.holds.map((h) => (h.id === hid ? { ...h, x: orig.x, y: orig.y } : h));
          this.draggingHoldId = null;
          this.dragOrigHoldPos = null;
        }
        this.pinchPrevDist = Math.max(10, dist(pts[0], pts[1]));
        this.pinchPrevMid = {
          x: (pts[0].x + pts[1].x) / 2,
          y: (pts[0].y + pts[1].y) / 2,
        };
        return;
      }

      if (this.activePointers.size > 2) return;

      const isTouch = e.pointerType === 'touch';
      const wp = screenToWorld(sp, this.transform);
      const hit = this.hitTestHold(wp, isTouch);

      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture isn't supported
      }

      if (this.mode === 'setter' && hit) {
        this.selectedHoldId = hit.id;
        this.draggingHoldId = hit.id;
        this.dragOffset = { x: hit.x - wp.x, y: hit.y - wp.y };
        this.dragStartPos = sp;
        this.dragOrigHoldPos = { x: hit.x, y: hit.y };
        this.dragMoved = false;
        this.pendingTap = null;
        this.emit();
        return;
      }

      // Defer tap until pointerup so pinch or zoomed-pan never fires accidental holds/steps
      this.pendingTap = { pointerId: e.pointerId, screen: sp, isTouch };
      this.panLastScreen = sp;
      this.isPanning = false;
    });

    this.canvas.addEventListener('pointermove', (e) => {
      const sp = this.getPointerScreen(e);
      if (this.activePointers.has(e.pointerId)) {
        this.activePointers.set(e.pointerId, sp);
      }

      // Pinch-to-zoom + 2-finger pan
      if (this.isPinching && this.activePointers.size >= 2) {
        const pts = [...this.activePointers.values()];
        const curDist = Math.max(10, dist(pts[0], pts[1]));
        const curMid: Vec2 = {
          x: (pts[0].x + pts[1].x) / 2,
          y: (pts[0].y + pts[1].y) / 2,
        };
        const scaleRatio = curDist / Math.max(10, this.pinchPrevDist);
        const dx = curMid.x - this.pinchPrevMid.x;
        const dy = curMid.y - this.pinchPrevMid.y;

        this.zoomAroundScreenPoint(curMid, this.cameraZoom * scaleRatio, dx, dy);
        this.pinchPrevDist = curDist;
        this.pinchPrevMid = curMid;
        this.emit();
        return;
      }

      // Single-finger drag on a hold in Setter mode
      if (this.mode === 'setter' && this.draggingHoldId) {
        if (!this.dragStartPos || dist(sp, this.dragStartPos) > 4) {
          const wp = screenToWorld(sp, this.transform);
          const nx = clamp(Math.round(wp.x + this.dragOffset.x), 18, WALL_WIDTH_CM - 18);
          const ny = clamp(Math.round(wp.y + this.dragOffset.y), 18, WALL_HEIGHT_CM - 18);
          this.holds = this.holds.map((h) =>
            h.id === this.draggingHoldId ? { ...h, x: nx, y: ny } : h
          );
          this.dragMoved = true;
          this.canvas.style.cursor = 'grabbing';
        }
        return;
      }

      // Single-finger pan when zoomed in
      if (this.pendingTap && this.pendingTap.pointerId === e.pointerId && this.cameraZoom > 1.03) {
        if (!this.isPanning && dist(sp, this.pendingTap.screen) >= 9) {
          this.isPanning = true;
          this.panLastScreen = sp;
        }
        if (this.isPanning) {
          const rect = this.canvas.getBoundingClientRect();
          this.cameraPanX += sp.x - this.panLastScreen.x;
          this.cameraPanY += sp.y - this.panLastScreen.y;
          this.panLastScreen = sp;
          this.clampCamera(rect.width, rect.height);
          this.transform = computeWallTransform(
            rect.width,
            rect.height,
            {
              zoom: this.cameraZoom,
              panX: this.cameraPanX,
              panY: this.cameraPanY,
            },
            this.renderedWallAngle
          );
          this.canvas.style.cursor = 'grabbing';
          return;
        }
      }

      // Hover feedback for mouse pointers
      if (e.pointerType === 'touch') return;
      const wp = screenToWorld(sp, this.transform);
      const hit = this.hitTestHold(wp, false);
      const nextHover = hit ? hit.id : null;
      let changed = false;
      if (nextHover !== this.hoveredHoldId) {
        this.hoveredHoldId = nextHover;
        changed = true;
      }

      if (this.mode === 'plan' && !hit && (this.planContactMode === 'smear' || this.planContactMode === 'flag')) {
        const onWall =
          wp.x >= 12 && wp.x <= WALL_WIDTH_CM - 12 && wp.y >= 16 && wp.y <= WALL_HEIGHT_CM - 16;
        if (onWall) {
          const pos = { x: Math.round(wp.x), y: Math.round(wp.y) };
          this.wallHoverPos = pos;
          const { assignment, free } = this.getInspectedContacts();
          const target =
            this.planContactMode === 'smear' ? smearTarget(pos.x, pos.y) : flagTarget(pos.x, pos.y);
          this.wallHoverEval = evaluateMove(
            assignment,
            free,
            this.activeLimb,
            target,
            this.holds,
            this.profile,
            this.wallAngleDeg
          );
          changed = true;
        } else if (this.wallHoverPos) {
          this.wallHoverPos = null;
          this.wallHoverEval = null;
          changed = true;
        }
      } else if (this.wallHoverPos) {
        this.wallHoverPos = null;
        this.wallHoverEval = null;
        changed = true;
      }

      if (changed) this.emit();

      if (this.mode === 'setter') {
        this.canvas.style.cursor = hit ? 'grab' : 'crosshair';
      } else if (this.mode === 'plan') {
        this.canvas.style.cursor =
          hit || this.planContactMode !== 'hold' ? 'pointer' : this.cameraZoom > 1.03 ? 'grab' : 'default';
      } else {
        this.canvas.style.cursor = this.cameraZoom > 1.03 ? 'grab' : 'default';
      }
    });

    const endPointer = (e: PointerEvent) => {
      const sp = this.getPointerScreen(e);
      this.activePointers.delete(e.pointerId);

      if (this.isPinching) {
        if (this.activePointers.size < 2) {
          this.isPinching = false;
          this.pinchJustEnded = true;
          this.emit();
        }
        if (this.activePointers.size === 0) {
          this.pinchJustEnded = false;
        }
        return;
      }

      if (this.pinchJustEnded) {
        if (this.activePointers.size === 0) this.pinchJustEnded = false;
        return;
      }

      if (this.draggingHoldId) {
        if (this.dragMoved) {
          this.holds = renumberHolds(this.holds);
          this.recomputeBeta();
          this.syncPlanPose(false);
        }
        this.draggingHoldId = null;
        this.dragStartPos = null;
        this.dragOrigHoldPos = null;
        try {
          this.canvas.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        this.emit();
        return;
      }

      if (this.pendingTap && this.pendingTap.pointerId === e.pointerId) {
        const tap = this.pendingTap;
        this.pendingTap = null;
        const wasPanning = this.isPanning;
        this.isPanning = false;
        try {
          this.canvas.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        if (!wasPanning && dist(sp, tap.screen) < 12) {
          this.commitTapAt(sp, tap.isTouch);
        }
      }
    };

    this.canvas.addEventListener('pointerup', endPointer);
    this.canvas.addEventListener('pointercancel', endPointer);

    // Wheel & trackpad pinch-to-zoom support
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const sp = this.getPointerScreen(e);
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022));
        this.zoomAroundScreenPoint(sp, this.cameraZoom * factor);
        this.emit();
      },
      { passive: false }
    );

    this.canvas.addEventListener('dblclick', (e) => {
      if (this.mode !== 'setter') return;
      const wp = this.getPointerWorld(e);
      const hit = this.hitTestHold(wp);
      if (!hit) return;
      const nextRole: HoldRole =
        hit.role === 'normal' ? 'start' : hit.role === 'start' ? 'top' : 'normal';
      this.selectedHoldId = hit.id;
      this.updateSelectedHold({ role: nextRole });
    });

    this.canvas.addEventListener('pointerleave', () => {
      if (this.hoveredHoldId !== null) {
        this.hoveredHoldId = null;
        this.emit();
      }
    });
  }

  private emit(): void {
    const hoveredEval =
      this.mode === 'plan' && this.hoveredHoldId
        ? this.previewEvaluations.get(this.hoveredHoldId) ?? null
        : null;
    const inspected = this.getInspectedContacts();

    this.onChange({
      mode: this.mode,
      routeName: this.routeName,
      routeGrade: this.routeGrade,
      baseRouteGrade: this.baseRouteGrade,
      wallAngleDeg: this.wallAngleDeg,
      baseWallAngleDeg: this.baseWallAngleDeg,
      liveGradeEstimate: this.liveGradeEstimate,
      routeStyle: this.routeStyle,
      routeDescription: this.routeDescription,
      holds: this.holds,
      selectedHoldId: this.selectedHoldId,
      hoveredHoldId: this.hoveredHoldId,
      brush: this.brush,
      profile: this.profile,
      activeLimb: this.activeLimb,
      planContactMode: this.planContactMode,
      betaSteps: this.betaSteps,
      betaTraces: this.betaTraces,
      inspectedStepIndex: this.inspectedStepIndex,
      betaReachesTop: this.betaReachesTop,
      betaFirstFailure: this.betaFirstFailure,
      betaFinalStamina: this.betaFinalStamina,
      hoveredEval,
      wallHoverEval: this.wallHoverEval,
      inspectedFree: inspected.free,
      showReachArc: this.showReachArc,
      showComLine: this.showComLine,
      showBetaArrows: this.showBetaArrows,
      climbStatus: this.climbStatus,
      climbStepIndex: this.anim?.stepIdx ?? -1,
      climbStatusText: this.climbStatusText,
      climbStamina: this.climbStamina,
      climbBalance: this.climbBalance,
      playbackSpeed: this.playbackSpeed,
      climbResult: this.climbResult,
      cameraZoom: this.cameraZoom,
    });
  }
}
