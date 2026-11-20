# Photo-to-Route On-Device Recognition Design (`v1.5.0`)

## Goal
Allow climbers in Setter mode (`定线设置`) to upload or photograph a real climbing gym wall and generate a playable, physics-calibrated simulated route **100% locally in the browser** (zero server, zero API keys, zero heavy model downloads, `< 150ms` inference).

## Architecture

### 1. On-Device Vision & Physics Calibration Engine (`src/game/photoVision.ts`)
- **Perspective Rectification (8-DOF Homography)**:
  - User aligns 4 corner handles over the wall in the photo.
  - Exact 3×3 projective transform (Gaussian elimination with partial pivoting) warps the selected wall quadrilateral into a clean `400 × 450` orthographic RGBA plane (`1px = 1cm`).
- **Chalk- & Shadow-Tolerant Contrastive Color Segmentation (CIELAB)**:
  - Converts warped RGBA pixels into CIELAB (`L*, a*, b*`).
  - For colorful routes (`C* >= 14`), weights chromaticity `(a*, b*)` strongly and lightness `L*` lightly (`0.30×`) with chalk-highlight forgiveness so chalked lips and shadowed undersides stay grouped as one hold.
  - For low-chroma black/white/grey routes (`C* < 14`), shifts weight to `L*` luminance contrast against automatically estimated wall-border background.
  - Supports multi-tap **positive samples** (`include`, expanding the local color cluster) and **negative samples** (`exclude`, contrastive rejection of similar walls or neighboring routes).
  - Applies 3×3 morphological closing (dilation → erosion), 8-connected component labeling, and proximity fragment merging.
- **Multi-Feature Hold Classifier (PCA + Luminance/Chalk Gradient)**:
  - Computes 2nd central moments (PCA major/minor axes, elongation, principal axis angle), fill solidity, interior dark-cavity contrast (`pocket` detection), specular highlight peak (`dualTex` detection), and luminance/chalk centroid offset (pull direction `angle`).
  - Maps each component to `HoldType` (`jug`, `pinch`, `crimp`, `microcrimp`, `pocket`, `sloper`, `foothold`, `volume`), `scale`, `angle`, `dualTex`, and auto-assigns `start` and `top` roles.
- **Physics-in-the-Loop Route Calibration**:
  - Runs local `suggestBeta` + `estimateRouteGrade` at the user's chosen `wallAngleDeg`.
  - When noisy CV pull angles block solvability, refines ambiguous handhold angles toward natural climbing flow and outputs live V-grade estimate and actionable status notes.

### 2. Photo Import Studio Modal (`src/game/photoModal.ts`)
- Triggered from Setter mode (`拍照 / 识图定线`), supporting mobile rear camera capture (`capture="environment"`), file picker, and drag-and-drop.
- Two-step workflow:
  1. **Wall Framing**: drag 4 corner handles + pick approximate wall angle (`-10°..+55°`).
  2. **Interactive Color Extraction & Preview**: click any hold on the rectified wall to segment the route immediately; add positive/negative samples; tune tolerance, minimum hold size, and physics calibration toggle; click **导入到定线台**.

### 3. 3D Perspective Wall Photo Underlay (`src/game/engine.ts`, `src/game/renderer.ts`)
- Stores the rectified `400×450` wall canvas as an optional `wallPhotoOverlay` (`visible`, `opacity`).
- Renders the underlay directly onto the 3D tilted trapezoid plywood wall using horizontal scanline perspective slices so it tilts smoothly with the Kilter wall angle (`-10°..+55°`).
- Exposes show/hide toggle, opacity slider, and clear button inside the Setter sidebar.

## Testing & Versioning
- Dedicated unit tests in `src/game/photoVision.test.ts` covering homography accuracy, chalk/shadow tolerance, black/white hold detection, negative sample rejection, hold type classification, and physics calibration.
- Shipped as **`v1.5.0`** following `.cursor/rules/versioning.mdc`.
