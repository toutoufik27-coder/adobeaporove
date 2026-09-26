# Audit and repair plan: SVG → SVG repair engine (`refine/`)

Baseline (before any change): `npm test` passes 33/33 in 27 s. A copy of the untouched
code is kept outside the project for diffing.

## 1. Where every responsibility lives

| Responsibility | File(s) |
|---|---|
| XML parsing, serialization | `src/xml.js` |
| Security sanitizer | `src/security.js` |
| CSS (sheets, cascade, colours) | `src/css.js` |
| Transforms | `src/matrix.js` (parse / multiply), applied in `src/model.js` `visit()` |
| Scene model (elements, paints, clip/mask refs, `use`) | `src/model.js` |
| Viewport (`viewBox`, width/height, nested `<svg>`) | `src/model.js` `buildModel()` + `src/raster.js` `makeView()` |
| Rendering (fills, strokes, clip, mask, opacity, gradients) | `src/raster.js` |
| Gradients | `src/model.js` `paintOf()` / `gradientMean()` → mean colour |
| Patterns | `src/model.js` `paintOf()` → fallback colour or grey |
| Masks / clipPaths | `src/model.js` (collection), `src/raster.js` `clipCoverage()` / `maskCoverage()` |
| Filters | **nowhere**: the `filter` property is not read at all |
| Text / image | `src/model.js:82`: recorded with `render:false`, never drawn |
| Markers | `src/model.js:170`: own attribute only (locks editing), never drawn |
| Path geometry | `src/pathdata.js`, `src/geom.js`, `src/fit.js` |
| Features / topology / recognition | `src/features.js` |
| Hidden geometry | `src/engine.js` `subpathVisibility()` / `refreshOcclusion()`, `src/passes.js` pass 1 |
| Candidate generation | `src/passes.js` (passes 1–4, 6, 7, 10) |
| Validation | `src/engine.js` `attempt()` / `geometryCheck()` / `regionCheck()` / `globalCheck()`, `src/passes.js` passes 8–9, `src/integrity.js` |
| Visual metrics | `src/metrics.js` |
| Export | `src/output.js`, `src/process.js` `stateOutput()` |
| Tests | `test/run.js` (33 checks), `test/mock-model.js` |
| Performance | caches in `src/engine.js` (`ctx.crops`), full-view buffers in `src/raster.js` |

## 2. Findings (problem → exact location)

### 2.1 Approximate renderer (`src/raster.js`, `src/model.js`)
- Gradients are drawn as the **mean of their stops** (`model.js:98`, `gradientMean`). `gradientUnits`, `gradientTransform`, `spreadMethod`, `fx/fy/fr` and stop positions are ignored.
- Patterns are drawn as their fallback colour, or opaque grey (`model.js:100`).
- Filters are not modelled at all: `filter` is not in `PROPS` (`css.js:215`).
- Text and image are never drawn (`model.js:82`), so validation sees empty space there.
- Markers are never drawn.
- Dashes are drawn as solid strokes (`raster.js` `strokePolys`).
- Strokes are offset in **pixel space** with the width scaled by `sqrt(|det|)` (`raster.js:94-95`). That is wrong under non-uniform scale and skew, where the pen should be an ellipse.
- `vector-effect: non-scaling-stroke` is ignored.
- Opacity is multiplied into every leaf (`model.js:77`) instead of being composited per group. Overlapping children of a semi-transparent group, or the fill and stroke of a semi-transparent element, are blended twice.
- A partial mask on a group is applied per child, which gives the wrong result where children overlap.
- `currentColor` is hard-coded to black (`model.js:94`); the `color` property is not resolved.
- Unknown colours (`hsl()`, most CSS named colours, `var()`) silently become black (`model.js:103`).
- `<switch>` draws every child (`model.js:80`); browsers draw only the first match.
- `use → use` chains are marked `render:false` (`model.js:144`), so they are invisible to validation.

### 2.2 Unsupported features and protection
- `doc.unsupported` is only a counter, used by the analysis report (`analyze.js:368`). It has **no effect** on candidates or validation.
- Elements with `filter` (own or inherited from a `<g>`), pattern paint, masks with unsupported units, `vector-effect`, CSS `transform`, `@media`, complex selectors or animations stay **editable**.
- Markers are detected only as the element's own attribute (`model.js:170`). A `marker-*` inherited from a group, the `marker` shorthand and markers set by sheet rules are missed.
- A path referenced by `<use>` elsewhere can be edited. Its `<use>` copy is rendered from a separate, stale snapshot (`model.js:150-154`), so validation never sees the copy change.

### 2.3 CSS cascade (`src/css.js`)
- `!important` is **stripped** (`css.js:223`), so an important sheet rule loses to inline style.
- Complex selectors (descendant, child, attribute, pseudo-class) are **silently ignored** (`css.js:242`).
- `@media` / `@supports` blocks are dropped (`css.js:236`).
- Presentation attributes are read only for a fixed list (`css.js:215`). `color`, `filter`, `marker-*`, `stop-color`, `stroke-dashoffset`, `mask-type`, `transform` and `font-*` are missing.
- `initial`, `unset`, `var()` and `calc()` are not handled.

### 2.4 Transforms (`src/matrix.js`)
- Parsing is lenient. `translate(10) foo(3)` or `rotate(30 5)` are partly applied. Browsers reject the whole list and apply **no** transform.
- A `matrix()` with the wrong number of arguments silently becomes identity.
- Unreadable transforms only raise a warning; the element stays editable.
- The CSS `transform` property, `transform-origin` and `transform-box` are ignored.

### 2.5 Viewport (`src/model.js:28-30, 71-76`, `src/raster.js:10`)
- The root `preserveAspectRatio` and `width`/`height` are ignored. The renderer shows exactly the viewBox, so content that a browser shows outside the viewBox (`meet` with a different aspect) is never validated, and `slice` crops are not modelled.
- Units in width/height (`cm`, `mm`, `in`, `pt`, `em`) are dropped (`len()` only handles `%`).
- Nested `<svg>`: `preserveAspectRatio` is ignored (always top-left `meet`), there is no viewport clipping (browsers clip by default), and percentages resolve against the wrong box.
- A `<use>` of a `<symbol>` ignores the symbol's `viewBox` and the use's `width`/`height`.

### 2.6 Text and image
- Both are `render:false` (`model.js:82`).
- They do not take part in regional or global validation.
- A shape moved over or away from a text or image passes validation unseen.

### 2.7 Hidden geometry (`src/passes.js:57-80`, `src/engine.js:62-80`)
- A contour counts as hidden when `visible <= 2 px` **or** `visible <= 1 %` of its area (`passes.js:64`). That is "probably hidden → delete": a visible 1 % sliver, such as a thin outline ring, is deleted and then passes the 1.5 % region tolerance.
- Pattern paint counts as a fully **opaque occluder** (fallback alpha 1). An element under a pattern with transparent gaps is deleted.
- Occluders with a filter (offset or transparency) are treated as opaque. A hidden element that has a filter (a drop shadow extends past its geometry) can be deleted.
- Text and image are ignored as part of the scene.
- Removing an element that has fill `none` and stroke `none` (`passes.js:30`) ignores markers and filters, which can paint even then.
- Visibility is measured at the 700 px view, so sub-pixel details are unmeasured.

### 2.8 Memory and performance
- There is **no cross-file leak**. 50 files in one process: heap after GC stays flat at 6.5–7.3 MB, and time per file is stable (`test/bench.js`).
- Peak memory per file is high: `ctx.crops` (`engine.js:118-124`) caches up to **400** reference crops of up to 360 k px each, stored as Float32 RGB plus Float32 Lab (about 8.6 MB per entry). That is 98 MB for `christmas-clock.svg` (34 entries) and **up to about 3.4 GB** in the worst case. The cache is capped by entry count, not bytes, and is cleared all at once.
- `clipCoverage()` / `maskCoverage()` allocate a full-view Float32 buffer per clip per render call.
- `compare()` allocates two full buffers per call and converts to Lab twice per changed pixel.

### 2.9 False-positive acceptance
- **Hand-written confidence** (`0.99`, `0.97`, `0.96`, `0.94` …) is the gate against `minConfidence` (`engine.js:194`). It is not evidence.
- The shift-tolerant metric (`metrics.js:260-277`) counts a changed pixel as invisible when its new colour exists nearby in the original. When a 1–2 px line disappears, the background colour is nearby, so the change is **invisible to the metric**. Only `solid` (full 3×3 blocks) can catch it, and `maxSolid` allows 2–4.
- The region tolerance is relative to the object's area (`engine.js:131-136`), so a small detail lost on a large object is diluted.
- `ctx.final` is computed in pass 9, **before** pass 10 (merge, precision, flatten) changes the geometry again. The exported file is never re-validated visually.
- The export is never re-parsed or re-rendered. `integrity()` checks only XML, references and path syntax.
- `flattenTransforms` (`passes.js:551`) runs on **non-editable** elements too: dashed, markers, filter. It writes an inline `stroke-width` that an `!important` sheet rule overrides, and dash lengths are not scaled.
- `mergePaths` (`passes.js:503`) ignores filter and markers.
- `exportSVG` (`output.js:151`) rewrites **unchanged** paths at 3 decimals (`digits ?? 3`) whenever that is shorter, with no validation. On small viewBoxes this destroys geometry. It also affects every history stage exported before Final.
- Stale `use` copies: see 2.2.

## 3. Repair plan (order = the required priority: rendering accuracy → validation safety → geometry → optimization)

1. **Capability / protection system** (`src/capability.js`, new). For every element: `SUPPORTED`, `PARTIAL` or `UNSUPPORTED`, with reasons.
   - `UNSUPPORTED` locks the geometry.
   - Uncertain **regions** (filter regions, pattern, text, image, unknown paint, …) reject any candidate whose change touches them.
   - It is enforced in `attempt()`, hidden removal, merge, flatten and export.
2. **Renderer fixes** (`src/raster.js`, `src/model.js`):
   - real linear and radial gradients (units, transform, spread, stops, stop-opacity)
   - strokes built in local space (exact under any affine), plus dashes
   - clip and mask units, mask-type, `use` inside a clip
   - group compositing for opacity and masks
   - `currentColor`
   - `<switch>`
   - `use` chains and symbol viewports
3. **Browser oracle** (`src/browser.js`, new). Headless Chrome/Edge over the DevTools protocol with no npm dependency (Node's built-in `WebSocket`). It renders the SVG exactly as a page `<img>` does. It serves as:
   - the source of truth for the final validation,
   - a conformance test of the internal renderer.
4. **Viewport and transforms**:
   - strict transform grammar (invalid means identity plus a lock)
   - `preserveAspectRatio` (9 alignments × meet/slice) for the root, nested `<svg>` and `<symbol>`
   - viewport clipping
   - units
5. **Stroke**: non-scaling-stroke is protected; flattening is refused when it would change the stroke (non-uniform scale, dashes, markers, filter, `!important`).
6. **CSS**:
   - a selector engine (compound, descendant, child, sibling, attribute, `*`, `:first-child`, …)
   - specificity, source order, `!important` tiers, inheritance, `inherit` / `initial` / `unset`
   - any selector or at-rule it cannot evaluate protects every element it might match
7. **Hidden geometry**: delete only when **certainly** hidden:
   - 0 visible coverage at a higher resolution
   - every occluder fully supported and solid
   - no uncertain region
   - a strict zero-difference render
8. **Evidence-based confidence** (`src/evidence.js`, new): Hausdorff, area, perimeter, centroid, bbox, curvature, topology, local and global raster. Any unsupported feature means reject.
9. **Shape reconstruction**: the same evidence, with tight area / perimeter / curvature limits; organic shapes stay protected.
10. **Topology**: the signature is extended with pairwise relations between contours (disjoint / contains / overlaps), winding and self-intersections.
11. **Final pipeline**: export → re-parse → internal re-render → browser re-render → final validation. On failure, the offending elements are rolled back; if the result still fails, the **original** is returned.
12. **Performance**: crop cache capped in bytes (LRU), fewer full-view allocations, and measurements for 1/10/50/100 files.
13. **Adversarial fixtures** (`test/fixtures/`) and runner (`test/adversarial.js`): before / after / difference / topology / geometry / validity for every case.
14. Every bug fixed gets a regression check in `test/run.js`. Existing checks are kept.
