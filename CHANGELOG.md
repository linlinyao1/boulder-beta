# Changelog

All notable changes to **BETA 抱石台 (`boulder-beta`)** follow [Semantic Versioning](https://semver.org/).

## [v1.5.4] - 2026-11-20
### Added & Fixed
- **4-Point Start (`startFoot` / 脚起步) Support (`src/game/types.ts`, `src/game/renderer.ts`, `src/main.ts`, `src/game/engine.ts`)**:
  - Added dedicated `'startFoot'` hold role alongside `'start'` (手起步) and `'top'` (完攀点) across desktop Setter controls, mobile Setter quick-cycle button, double-click cycling, and wall/photo-preview tape badges (`手S` emerald green vs `脚S` cobalt blue).
  - Marked starting footholds as `'startFoot'` in built-in presets (`src/game/presets.ts`), procedural route generation (`src/game/generator.ts`), and photo-to-route recognition (`src/game/photoVision.ts`).
- **Natural Starting Stance & Matched-Limb IK (`src/game/physics.ts`, `src/game/ik.ts`)**:
  - Upgraded `getInitialAssignment` to prioritize explicit `startFoot` holds, cap automatic start-foot horizontal reach (`<= maxLegReach * 1.02`, eliminating wide-split start poses on asymmetric comp routes), cleanly match both feet on a single under-hand macro, and gracefully separate vertically distant `start` holds (`dy > 95cm`) into hand vs foot starts.
  - Added horizontal contact spread in `solvePose` whenever both hands or both feet match on the same hold so matched start stances render cleanly without overlapping limbs.

## [v1.5.3] - 2026-11-20
### Added & Fixed
- **Lateral & Coordination Run-and-Jump Dyno Physics (`src/game/physics.ts`)**:
  - Expanded lateral Dyno envelope (`maxLatReach`) to model authentic horizontal leg push-off without loosening vertical anti-cheese limits (`maxUpReach`).
  - Added intermediate stepping-stone macro detection (`findCoordinationStepHold`) so horizontal Double Dynos can execute realistic competition-style run-and-jump coordination across low volumes/macros.
  - Fixed `volume` and oversized comp `sloper` double-dyno catch shock multipliers (`0.92` / `0.85` instead of `0.58` / `0.74`).
- **AI Beta Solver Horizontal Dyno Exploration (`src/game/generator.ts`)**:
  - Unlocked Single & Double Dyno search for wide horizontal and diagonal gaps (`lateralGap > 52cm / 82cm`) as well as slightly downward lateral transfers.
- **Animation & Arrow Badges (`src/game/engine.ts`, `src/game/renderer.ts`)**:
  - Added mid-flight lead-foot stepping-stone plant animation during coordination run-and-jumps and dedicated `协调跑跳` / `横向双飞` arrow badges.

## [v1.5.2] - 2026-11-20
### Improved
- **Real-World Gym Photo Vision Engine V2 (`src/game/photoVision.ts`)**:
  - Replaced single global background color with an `8×9` spatial local wall-background grid so multi-tone gyms (e.g. white upper panels + dark charcoal-blue lower panels) never bleed into hold masks.
  - Added CIELCH hue-angle purity gating + Canny-style dual-threshold hysteresis region growing, cleanly separating pastel/mint holds from blue-grey walls, climbers, and competing hold colors.
  - Upgraded fragment merging to actual pixel-boundary proximity (prevents merging diagonally stacked competition rails while still reconnecting chalk-split or hand-occluded hold halves) and preserved real hold color & Start/TOP eligibility on oversized competition macros.
- **Stage 3 Interactive Polish (`src/game/photoModal.ts`)**:
  - Added live translucent segmentation mask tint preview so matched pixels are visually verified in real time.
  - Added `✎ 补点/删点` direct tap-to-add / tap-to-delete mode in Stage 3 for instant recovery of climber-occluded holds.
  - Added automatic top/bottom UI-chrome crop framing for tall mobile app screenshots (e.g. Xiaohongshu / Douyin).

## [v1.5.1] - 2026-11-20
### Added & Fixed
- **Mobile 1-Tap Photo Shortcut**: Added a dedicated camera button (`识图`) right in the mobile top bar so phone users can launch photo/camera route recognition immediately from any mode, plus accented styling on the mobile Setter `拍照识图` button.
- **Deterministic V5 Procedural Generation**: Added deep-recovery pass in `generateRoute` for V4–V6 so procedural routes are reliably solvable across all random seeds and GitHub Pages CI builds pass consistently.

## [v1.5.0] - 2026-11-20
### Added
- **100% Local On-Device Photo-to-Route Setter (`src/game/photoVision.ts`, `src/game/photoModal.ts`)**:
  - Upload or capture real gym wall photos (mobile `capture="environment"` camera + drag-and-drop + built-in realistic gym demo photo).
  - Interactive 4-corner perspective rectification (`computeHomographyDstToSrc` & `warpRgbaPerspective`) mapping tilted gym photos cleanly into `400×450cm` orthographic wall coordinates.
  - Chalk- & shadow-tolerant CIELAB contrastive color segmentation with positive multi-tap expansion, negative sample rejection, automatic wall background subtraction, and achromatic (black/white) route support.
  - On-device geometric + photometric classifier (PCA major/minor axes, solidity, dark cavity pocket detection, specular Dual-Tex detection, luminance/chalk gradient pull orientation) + Physics-in-the-Loop route angle calibration & live V-grade estimate.
- **3D Perspective-Mapped Wall Photo Underlay**: imported rectified gym photo projects onto the 3D tilted trapezoid plywood wall (tilting smoothly with Kilter angles `-10°..+55°`), with show/hide toggle, opacity slider, and clear controls in Setter mode.

## [v1.4.1] - 2026-11-20
### Fixed
- Fixed climber awkwardly flying straight across the wall to the TOP hold after clicking **AI 推演 (`autoSuggestBeta`)**: the climber now stays grounded on the Start holds with full Beta path arrows displayed immediately, ready to step through or play the climb animation.
- Prevented mid-air floating transitions when jumping across multiple steps (`inspectStep`) or clearing a long Beta sequence (`clearBeta`); smooth limb blending now applies only to adjacent single-step transitions.

## [v1.4.0] - 2026-11-20
### Added
- **Real-world climbing hold shaping system** (`src/game/holdShapes.ts`): 25 sculpted hold silhouettes across 8 hold types (`3–4` variants per type) and 3 cohesive design families (`拟岩砂岩` / `比赛流线` / `几何切面`).
- **8th hold type: Pocket (`口袋点`)** with deep recessed crater rendering and strict directional pull physics.
- **Dual-Tex (`双纹理`) & Thumb Catch (`拇指扣`)** surface craftsmanship with live physics coupling (`Dual-Tex` narrows pull tolerance `0.74×` & penalizes off-axis slips; `Thumb Catch` grants `+7%` grip & `+10°` tolerance).
- **4 realistic Volume silhouettes** (asymmetrical 3D pyramid, trapezoidal roof ridge, pentagonal slab, fiberglass Macro dome) with per-facet lighting and perimeter screw hardware.
- **Version management system**: SemVer `package.json` + Vite build-time version/commit injection + clickable in-app version badge (`v1.4.0`) & Changelog modal + `npm run release:<patch|minor|major>` script + Git milestone tags (`v1.0.0`–`v1.4.0`).

## [v1.3.1] - 2026-11-20
### Fixed
- Recalibrated V1–V11 difficulty progression; fixed `suggestBeta` double-dyno cheesing that inflated measured grades by +2–3 grades and caused generated V4/V5 routes to pick soft low-angle jug ladders.
- Tightened Double Dyno impact catch threshold (`0.38 -> 0.52`), shock load penalty on crimps/slopers/microcrimps, barn-door cutoff (`0.82 -> 0.76`), and V4–V6 preset routes.

## [v1.3.0] - 2026-11-20
### Added
- Full Hueco **V1–V11** grading scale, `microcrimp` hold type, and V9/V11 pro climber tiers.
- **Kilter Board adjustable wall tilt** (`-10°` slab to `+55°` roof) with live dynamic V-grade re-estimation.
- **3D perspective trapezoid wall projection**, hydraulic steel struts, side-profile inclinometer widget, cast overhang shadow, and on-stage `− / +` tilt stepper.

## [v1.2.0] - 2026-11-19
### Added
- Mobile thumb-pad workspace, slide-up sheets, pinch-to-zoom, and wall panning.
- Calibrated human ballistic Dyno jump envelope, conditional foothold micro-crimping, youth climber preset (`140cm+`), and zero-overlap procedural hold spacing.
- Automated GitHub Pages CI/CD workflow.

## [v1.1.0] - 2026-11-19
### Added
- 2.5D foreshortened IK with anatomical crossover & leg pass-through guards.
- Wall smear (`踩墙`), dangling counterbalance flag (`悬空`), and explicit Single / Double Dyno with cut-loose swing animation.

## [v1.0.0] - 2026-11-19
### Added
- Initial release of BETA Bouldering Route Setter, Beta Planner, Physics Climb Simulator, and Beam-Search AI Beta Solver.
