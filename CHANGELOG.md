# Changelog

All notable changes to **BETA 抱石台 (`boulder-beta`)** follow [Semantic Versioning](https://semver.org/).

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
