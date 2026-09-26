# Repair log (phase by phase)

## Phase 1 — audit
- `AUDIT.md`: responsibility map, the problems with their exact locations, and the repair plan.
- Baseline: `npm test` 33/33 in 27 s. 50 files in one process: no heap growth (6.5–7.3 MB after GC), 2.5 s/file, peak RSS 433 MB.

## Phase 2 — protection of unsupported features
- New `src/capability.js`: support level per element (SUPPORTED / PARTIALLY_SUPPORTED / UNSUPPORTED) with reasons, plus uncertain regions.
- `raster.js` `CAPS`: one table of what the renderer draws exactly. Protection follows it automatically.
- Enforced in:
  - `attempt()` (feature safety check first: a locked element is never changed, and no change may touch an uncertain region)
  - occlusion (unsupported elements never hide anything)
  - transform flattening
  - image restoration
  - semantic ring rebuild
  - export
- Bugs fixed:
  - `filter` was never read, so filtered geometry was editable
  - markers inherited from groups / CSS were missed
  - geometry copied by `<use>` was editable while its copy was rendered stale
  - `currentColor` was always black
  - lenient transform parsing (`translate(30) foo(2)` was partly applied; browsers ignore it)
  - unchanged paths were rewritten at 3 decimals without validation
  - flattening ran on dashed / protected elements
- Tests: 6 regression checks, plus `test/protection.js` over 50 adversarial fixtures (`test/make-fixtures.js`).
- Result: 89/89.

## Phase 3 — rendering model (browser = source of truth)
- `src/browser.js`: headless Chrome / Edge over DevTools, with no npm dependency. It renders the SVG exactly as an `<img>` does.
- `test/conformance.js`: internal renderer vs Chrome on every sample and fixture, uncertain regions excluded.
- Renderer fixes, each verified against Chrome:
  - **Viewport**: the internal view was the viewBox, starting at y=0. Chrome centres it (`xMidYMid meet`) after pixel rounding, so every edge was shifted by up to 0.2 px. Deer-frame went from 1.57 % visible difference to 0.
  - **Gradients** are drawn per pixel (`src/paint.js`), replacing the mean colour. This covers linear, radial with focal point / `fr`, units, `gradientTransform`, pad / reflect / repeat, stop-opacity and `href` inheritance. Unresolvable cases lock the element.
  - **Strokes** are built in local space and then mapped, so they are exact under skew and non-uniform scale (4 solid spots → 0). **Dashes** are drawn, including the offset and a closed-path wrap.
  - **clipPath**: objectBoundingBox units follow the candidate's own box. `transform` on `<clipPath>` and nested clip-path are supported; the union is source-over.
  - **Mask**: the region (maskUnits) is modelled, as are content units, mask-type alpha / luminance (sRGB coefficients confirmed by Chrome), child opacity and gradient content. Everything else inside a mask or clip locks the element.
  - **Group compositing**: groups with opacity or a mask, and an element whose fill and stroke overlap under opacity or a mask, are painted as isolated layers. Group masks use the group's box from its members' current geometry. Proof: the old per-leaf path differs from Chrome by 2.3–6.6 % with thousands of solid spots; the layered path differs by 0.
  - `elementBox`: the stroke reach used the mean scale √|det|; it now uses the largest singular value. The **end point of open paths was missing** from every box (`flatten` returns segment starts only).
- Conformance limit: 0 solid spots, and at most 0.25 % isolated edge pixels. Justification: lines and fractional edges match Chrome exactly (coverage 0.75 → 64, 0.875 → 32). The residual on the two clock samples (≤ 0.18 %) is unchanged by 4x–16x supersampling and grows when curves are flattened *more* exactly, so it is Chrome's own curve approximation.
- Result: **58/58** files agree with Chrome, with gradient, clip, mask and opacity fixtures now at 0 % excluded.
- Still not drawn internally (so protected, and validated only in the browser): text, image, filter, pattern, marker, non-scaling stroke, nested `<svg>` / `<symbol>` viewports, `<switch>`.
- Tests: 8 renderer / viewport regression checks plus 58 conformance checks. Total **157/157**.

## Phase 4 — viewport and transforms (part 1)
- `src/viewport.js`:
  - units (px, in, cm, mm, pt, pc, em)
  - `preserveAspectRatio`: all 9 alignments × meet / slice, plus none
  - the root view is exactly the region the browser shows, so content outside the viewBox (meet) is now rendered and validated instead of being an uncertain strip
- Strict transform grammar (from phase 2). Negative scale, reflection, rotation, skew and nested matrices all agree with Chrome (fixtures).

## Phase 5 — final correctness audit (claims checked against the code and the tests)

This log and AUDIT.md were treated as claims, not evidence. Each claim was checked by
running the code; the full report with the measured numbers is `FINAL-AUDIT.md`.

| Claim | What was found |
|---|---|
| "Total 157/157" (phase 3) | Not what the suite reports today. Before this phase: **166/166** with a browser, and **105 passed + 1 SKIP line** without one. That one SKIP line hid 61 conformance checks that were never counted. After this phase: see FINAL-AUDIT.md. |
| "58/58 files agree with Chrome" | Today there are 61 rows. With Chromium 1194 all 61 were reported "ok", but 7 of them had **100 % of the image excluded** as uncertain (css-descendant, css-important, css-media, css-pseudo, filter-css-function, transform-css, transform-invalid). Nothing was compared there. They are now reported as skipped, not as agreement. The other 54 were confirmed within the stated limit (≤ 0.25 %, 0 spots). |
| "Browser = source of truth" | Without Chrome / Edge, `validation.ok` was `true` with `browser: "unavailable"`. In a container running as root, Chrome never started at all: it needs `--no-sandbox` there, and the launch error was swallowed. **Fixed:** explicit STRICT / FALLBACK modes, `browserVerified`, `certified`, and the failure reason is kept. |
| Browser oracle robust | **Bug:** after one failed render, the render queue stayed rejected, so every later file failed as well (a failure that only shows up in sequence). There was also no timeout on DevTools commands, so a hung browser hung the run. **Fixed**, with a regression test. |
| Plan 7: "delete only when certainly hidden" | **Not implemented.** The `visible <= 2 px or <= 1 %` rule was still there. A visible 0.2-unit ring was deleted in professional mode (reproduced). **Fixed:** zero coverage at 1x and 4x, plus a render that must not change at all. |
| Plan 8: evidence-based confidence (`src/evidence.js`) | **Not implemented.** Hand-written `confidence` values (0.99, 0.97, 0.915 …) were the gate against `minConfidence`. **Fixed:** decisions use measured evidence only. |
| Plan 9: evidence-based shape reconstruction | **Not implemented** (`confidence >= shapeSensitivity`). **Fixed**; see FINAL-AUDIT.md. |
| Plan 10: topology signature with pairwise relations | **Not implemented, and still not implemented.** Listed as remaining. |
| Plan 12: crop cache capped in bytes (LRU) | **Not implemented.** It was still a count cap (400 entries, cleared all at once): 122 MB of crops on christmas-clock. **Fixed:** byte LRU capped at 48 MB. |
| Plan 13: `test/adversarial.js` (before / after / topology / geometry per case) | **Not present.** `test/protection.js` covers protection only. The defect fixtures of this phase cover before / after / expected geometry. |
| "Unchanged paths are not rewritten at 3 decimals" | True for unchanged paths. **Changed paths in an earlier history stage** were still written at 3 decimals without validation. **Fixed:** they are written without rounding. |
| Final gate judges the exported text | Yes, but the browser reference was the original **re-serialized by the same writer**, so a writer bug could not show. It did hide one: the space between two `<tspan>`s was dropped. **Fixed:** the reference is the input text, and the writer's copy of the original is compared with it (fidelity). |
| `--no-structure` is safe | **Bug:** unwrapping a `<g>` lost a `g { fill: … }` rule, so a red shape came out black. **Fixed.** |
| Grid Hausdorff distance (`geom.hausdorff`) | **Bug:** it computed neighbour cells in floating point (59.8 / 0.2 = 298.99…) and skipped cells. It returned 1.02 where brute force gives 0.17, which skewed the symmetry measurements. **Fixed**, with a test. |
| "50 files in one process: no heap growth" | Confirmed: heap after GC stays 6.0 → 7.0 MB over 72 files. A sequential run is not slower than isolated processes (ratio ≤ 1.12). |
| README: "christmas-clock 1010 → 317 nodes, 0.148 %"; "bakery: 6 circles rebuilt as real circles" | Not reproducible with the code as delivered: christmas-clock came out at 1010 → 452 nodes without a browser and 1010 → 602 with one. The 6 bakery "circles" were already circles within 0.1 u, so rewriting them is **path normalization, not a repair**. The README now points to the measured numbers. |
