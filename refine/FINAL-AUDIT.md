# Final correctness audit (`refine/`)

Every number below was measured in this audit, by running the code. None is copied from
AUDIT.md or REPAIR-LOG.md; those were treated as claims to check (results: REPAIR-LOG.md,
phase 5). To reproduce: `npm test`, `node test/audit.js`,
`node --expose-gc test/bench.js --isolated`.

**Environment:** Node v22.22.2, Linux container (4 cores, 16 GB), running as root.
Browser: Chromium 1194 (Playwright build, headless), started with `SVG_REFINE_BROWSER=/opt/pw-browsers/chromium`.
Chrome needs `--no-sandbox` when it runs as root; the oracle now adds it only in that case.

## 1. Tests (`npm test`, run to the end, default timeouts)

| Run | Passed | Failed | Skipped | Time | Peak RSS (VmHWM) |
|---|---|---|---|---|---|
| Before this audit, no browser | 105 | 0 | 1 line (hid 61 checks) | 82.5 s | not measured |
| Before this audit, Chromium | 166 | 0 | 0 | 95.2 s | 563 MB |
| **After, no browser** | **136** | **0** | **65** | 144.3 s | 499 MB |
| **After, Chromium** | **194** | **0** | **7** | 172.2 s | 504 MB |

- The "before" run with Chromium used the original engine with one change: the oracle
  launch fix (`--no-sandbox` as root). Without that fix, Chromium does not start in
  this container.
- A skipped check is never counted as passed. Without a browser, every check that needs
  one is skipped: 61 conformance checks plus 4 oracle and STRICT checks.
- With Chromium, the 7 skips are conformance rows where the whole image is an uncertain
  region, so nothing is compared. The old suite reported these as "agrees".
- The suite now takes longer mainly because it has more checks and processes more
  geometry. It no longer deletes "probably hidden" contours (section 11), so more
  contours go through every pass.

## 2. Browser validation: STRICT / FALLBACK

- `finalize(ctx, opts, { validation: 'strict' | 'fallback', browser })`. The CLI flag is
  `--validation strict|fallback` (default `strict`), plus `--no-browser`.
- **STRICT:** without the browser oracle, nothing is accepted. The result is
  `ok: false`, `level: 'original-kept'`, `browserVerified: false`, with the reason.
- **FALLBACK:** the internal renderer alone may accept the output. The result then says
  `browserVerified: false` and `level: 'internal-only'`.
- `certified` is true only for STRICT with a browser pass.
- The web worker runs FALLBACK. The page then draws both files in the browser itself
  before download. Intermediate stages are marked as not validated.
- Tests cover STRICT without a browser, FALLBACK without a browser, STRICT with the
  browser, and recovery after a failed render.

## 3. Browser conformance: internal renderer vs Chromium

72 files (samples, fixtures, defect fixtures): **65 measured, 65 agree, 0 differ, 7 not
measured** (100 % of the image is uncertain: CSS selectors / `!important` / `@media`,
CSS filter, CSS transform, invalid transform). The agreement limit is unchanged:
visible ≤ 0.25 %, mean ΔE ≤ 0.6, 0 solid spots.

Largest differences: christmas-clock 0.178 % (mean ΔE 0.214), clock-14-marks 0.177 %,
stroke-dash 0.135 %, bakery-icon 0.107 %, winter-clothing-icon 0.050 %,
deer-frame-icon 0.038 %. All have 0 solid spots. The full table is in section 16.

## 4. Why a run can slow down or stop (findings)

Individual and sequential processing were compared in the same order:
`test/bench.js --isolated`, 72 files.

- **Sequential is not slower.** The sequential / isolated time ratio is ≤ 1.12 for every
  file; small files are faster in sequence because the JIT is warm. Heap after GC is
  6.0 → 7.0 MB over 72 files: no leak.
- **Causes found and fixed:**
  1. **Browser render queue poisoning.** After one render failed, every later render
     rejected. In a batch, one bad file made every following file fail validation.
     This is the one failure that shows up only in sequence. Reproduced, fixed, tested.
  2. **No timeout on DevTools commands.** A hung or crashed browser hung the run
     forever. Every command now has a timeout (60 s, `SVG_REFINE_BROWSER_TIMEOUT`), and
     a dead browser fails all pending calls.
  3. **Chrome as root.** Chrome exits unless it gets `--no-sandbox`, and the error was
     swallowed. The failure reason is now reported, and a failed launch is not retried
     on every call.
  4. **Unbounded crop cache** (section 5).
  5. During this audit, one new bug was introduced and caught by the full suite: an
     out-of-memory crash (2 GB heap) on `thin-stroke.svg`, caused by a degenerate
     ellipse fitted to a sliver (radius ≈ 10⁹ u). Fixed: a primitive must fit the
     outline's box before it is measured, and sampling is capped at 20 000 points.
- **Slowest files** (STRICT with Chromium, professional mode):
  - christmas-clock.svg 24.3 s
  - clock-14-marks.svg 7.2 s
  - bakery-icon.svg 6.8 s
  - winter-clothing-icon.svg 3.8 s
  - deer-frame-icon.svg 3.6 s

  christmas-clock took 12.8 s before this audit. It is slower now because 28 contours
  that were deleted as "probably hidden" are kept and processed (section 11).

## 5. Memory

- The crop cache is now **byte-bounded LRU** (`src/lru.js`, `MAX_CACHE_BYTES` = 48 MB),
  with gradual eviction and released after processing. On christmas-clock the old
  count cap held **122 MB** of crops (37 entries); now it holds **47.9 MB**, at +3.5 %
  time, with identical output.
- `src/memprobe.js` records the peak heapUsed / RSS / arrayBuffers / external where the
  most buffers are alive (region check, global check, final validation) and at every
  pass.
- **Peaks over all 72 files** (STRICT, Chromium, one process):

  | Metric | Peak |
  |---|---|
  | heapUsed | 47.4 MB |
  | RSS | 297.9 MB |
  | arrayBuffers | 124.0 MB |
  | external | 127.4 MB |
  | crop cache | 47.9 MB |

- **Whole test process (VmHWM):** 499 MB without a browser, 504 MB with Chromium,
  against 563 MB before.
- Most of the arrayBuffers peak is garbage not yet collected: after GC it is 21–30 MB.

## 6. Final validation: the exported file is what is judged

The chain (`src/validate.js`):

1. Original SVG
2. Candidate (history Final)
3. `exportSVG`
4. Integrity (XML, references, path data)
5. Re-parse
6. Protected elements unchanged
7. Topology of the re-parsed geometry against the validated state, and no new
   self-intersections
8. Internal render of the re-parsed file
9. Browser render of the exported text
10. Comparison with the original
11. Accept, or roll back the contours / elements under the differing pixels (with merge
    partners) and check again
12. If it still cannot be proven: the ORIGINAL

- **Browser reference:** the input text itself. The engine's own copy of the original
  is compared with it too (**fidelity**), so a writer bug cannot hide by rendering both
  sides through the same writer. It did hide one: the space between two `<tspan>`s was
  dropped.
- When the sanitizer removed something that renders (an external `<image>` shows
  Chrome's broken-image box), the difference is attributed to sanitization and the
  sanitized original is the reference.
- **Export-time changes are covered:** precision rounding (also validated per element
  in pass 10), merge, flatten, restructuring and number formatting are all in the
  exported text that is re-parsed and rendered.
- An intermediate history stage is written without rounding (it never went through the
  precision validation) and is labelled as not validated.

## 7. Repair vs optimization

`src/changes.js` classifies every accepted change. A change counts only if it is still
in the final output: a later rollback removes it, and a primitive reconstruction
supersedes the earlier changes of that contour.

Totals over the 72 files (professional, STRICT, Chromium):

| | Count | By type |
|---|---|---|
| **Repairs** | **17** | primitive reconstruction 10, broken continuity 3, accidental artifacts 2, geometry correction 1, topology repair 1 |
| **Optimizations** | **272** | node reduction 139, precision reduction 115, path normalization 14, redundant command removal 2, redundant element removal 2 |
| Rejected candidates | 511 | |
| Rolled-back changes | 47 | 43 of them in christmas-clock |

Real sample files (professional, STRICT with Chromium):

| File | Nodes | Size | Repairs | Optimizations | Rejected | Rolled back | Level | Visible diff internal / browser | Time | Peak RSS / arrayBuffers |
|---|---|---|---|---|---|---|---|---|---|---|
| bakery-icon.svg | 225 → 151 | 8.0 → 5.3 KB | 0 | 24 | 32 | 0 | browser-verified | 0.047 % / 0.054 % | 6.8 s | 248.9 / 101.8 MB |
| christmas-clock.svg | 1010 → 776 | 34.0 → 24.5 KB | 0 | 18 | 182 | 47 | browser-verified | 0.042 % / 0.047 % | 24.3 s | 297.9 / 121.4 MB |
| clock-14-marks.svg | 351 → 306 | 10.4 → 9.0 KB | 0 | 24 | 92 | 0 | browser-verified | 0.100 % / 0.151 % | 7.2 s | 297.8 / 124.0 MB |
| deer-frame-icon.svg | 134 → 127 | 4.3 → 3.5 KB | 0 | 7 | 30 | 0 | browser-verified | 0.005 % / 0.008 % | 3.6 s | 272.7 / 107.6 MB |
| features.svg | 29 → 23 | 1.4 → 1.1 KB | 0 | 5 | 3 | 0 | browser-verified | 0.000 % / 0.004 % | 1.5 s | 255.6 / 97.8 MB |
| winter-clothing-icon.svg | 99 → 91 | 3.0 → 2.5 KB | 0 | 7 | 20 | 0 | browser-verified | 0.066 % / 0.062 % | 3.8 s | 271.7 / 93.3 MB |

On the real sample files the count is **0 repairs**. Everything done there
is optimization. The 6 "circles rebuilt as real circles" in bakery-icon were already
circles within 0.1 u, so rewriting them is path normalization.

## 8. Defect fixtures (`test/defects/<name>/bad.svg` + `expected.svg`)

`expected.svg` is the corrected geometry. The test measures the output's distance to it
independently of the engine (dense samples, symmetric Hausdorff distance, in artwork
units u = 1/1000 of the larger viewBox side). It also checks structure, topology,
validation and that the repair was counted as a repair of the right type.
Professional mode, STRICT with Chromium: all browser-verified.

| Fixture | Distance to expected: bad → output | Repair counted |
|---|---|---|
| distorted-circle (72 traced points, ±0.4 % radius) | 1.452 → 0.251 u | primitive reconstruction |
| irregular-ellipse (wrong handle ratios) | 0.968 → 0.150 u | primitive reconstruction |
| rectangle-extra-points (bent sides) | 0.200 → 0.000 u | primitive reconstruction |
| outlier-control-point (2.4° kink) | 1.302 → 0.027 u | geometry correction |
| tiny-artifact (isolated speck) | 2 → 1 elements, then 0.000 u | accidental artifacts |
| duplicate-geometry | 2 → 1 elements | accidental artifacts |
| broken-continuity (stroke split at a node) | 2 → 1 contours | broken continuity |
| tiny-gap (filled + stroked, 0.4 u gaps) | 0.200 → 0.000 u | broken continuity ×2 |
| self-intersection (corner loop) | 1.500 → 0.000 u | topology repair |
| distorted-repeated-shapes (5 dots) | 0.573 → 0.227 u | primitive reconstruction ×5 (common radius) |

**Before this audit** (same fixtures): only the rectangle was repaired.
- distorted-repeated-shapes got **worse** (0.573 → 1.152 u) and outlier-control-point
  got **worse** (1.19 → 4.14 u): the output was smaller, and further from the correct
  geometry.
- The speck and the duplicate were removed by the "probably hidden" rule, for the wrong
  reason.

## 9. Clean SVG

`test/defects/clean.svg` holds exact arcs, straight sides and minimal cubics. In all
four modes: **0 repairs, 0 optimizations, geometry moved 0.000 u**. This is the
required "NO SIGNIFICANT REPAIR".

## 10. Shape reconstruction

The old gate was `recognize().confidence >= shapeSensitivity`. It is replaced by
measured evidence against the contour as drawn (`primitiveEvidence`):

- deviation ≤ the mode's maxDev, and ≤ `shapeMaxDev` of the primitive's size
- area and perimeter differences
- real corners (a circle may not replace them)
- regularity: the deviation smoothed along the outline must stay below
  `shapeSystematic`
- local and global render
- repetition: circles of one size ×3 or more get the common radius

An intentionally irregular shape is kept:
- egg and squircle (aggressive mode): kept, above the deviation limit
- a small three-lobed shape with a systematic departure of 1.6 %: kept, regularity
  1.05 % > 0.8 %
- a small circle with random noise of ±1.2 %: rebuilt, regularity 0.58 %

The limit is honest about what geometry can tell. A departure below the mode's
tolerance (0.16 % of the artwork in professional mode) that is not systematic is
treated as a drawing error.

## 11. Hidden geometry

A contour is removed only when it is **certainly** hidden:

- zero visible coverage at the working resolution
- zero again at 4x in its own neighbourhood
- only shapes the renderer draws exactly count as occluders (text, image, filter,
  pattern, marker and unsupported CSS hide nothing)
- the candidate render must not change **at all**

The old rule (`≤ 2 px or ≤ 1 %`) deleted a visible 0.2-unit ring. This is now tested
for r = 39.8 and 39.95 in three modes. On christmas-clock the old rule removed 36
contours; the new one removes 8. The other 28 had visible coverage.

## 12. Evidence-based confidence

- The hand-written confidences (0.99, 0.97, 0.96, 0.95, 0.94, 0.915, 0.92 …) and
  `minConfidence` are gone from every decision. The only other place they remained,
  `restore.js`, has them removed from its log.
- Every attempt logs an evidence object:
  - `featureSupport`
  - `topologyPreserved`
  - `geometry: { hausdorff, areaError, areaBand, perimeterError, curvatureError, size }`
  - `localVisualError`, `globalVisualError`, `solid`, `meanDE`
  - `score`: the margin to the closest limit, not a gate
- A candidate must also stay within maxDev of the **reference** contour (after
  structural cleanup), so small steps cannot add up.
- Numbers that remain hand-chosen are **tolerances per mode** (maxDev, regionMax,
  globalMax, maxAreaError, shape limits, micro size). They are limits that measurements
  are compared with, and they are listed in `MODES`. `recognize()` still returns a
  normalized fit score, used only to label shapes in the analysis. Primitives are tried
  in order of measured deviation.

## 13. Bugs fixed

Each has a regression test in `test/run.js` or `test/defects.js`:

1. Browser render queue stays rejected after one failure.
2. No DevTools command timeout; a dead browser is not detected.
3. Chrome as root never starts, and the reason is swallowed.
4. Browser "unavailable" gave `validation.ok = true`.
5. Visible slivers deleted as "hidden" (≤ 1 % rule).
6. Crop cache unbounded in bytes (400 entries of up to 8.6 MB each).
7. `geom.hausdorff` skipped grid cells (floating-point cell index).
8. The serializer dropped or added whitespace inside `<text>` (between `<tspan>`s).
9. `--no-structure` unwrapped a `<g>` styled by a `g { … }` rule.
10. Changed paths of intermediate stages written at 3 decimals, unvalidated.
11. The browser reference went through the same writer as the output (writer bugs
    invisible).
12. Measurement drift: each step was bounded only against the previous step. There is
    now a whole-chain bound against the reference contour.

## 14. Remaining limits and unsupported SVG features

- **Not drawn by the internal renderer** (`CAPS`):
  - patterns, filters, markers
  - text, image
  - `vector-effect: non-scaling-stroke`
  - `<switch>`

  Elements that need them are locked and their area is an uncertain region; they are
  validated only in the browser. Seen in the 72 files: image 3, text 1, filter 4,
  pattern 2, marker 2, dash 1, vector-effect 1.
- **CSS:** complex selectors, `@media`, `!important`, CSS `transform`, `var()` /
  `calc()` lock the whole document (6 + 2 + 1 files).
- **Topology:** the signature still has no pairwise relations between contours (AUDIT
  plan item 10, never implemented).
- **Loop repair** only cuts loops of straight segments. **Kink repair** only works at
  cubic–cubic joins. **Artifact removal** only removes isolated specks that do not
  repeat. **Ellipses** must be axis-aligned (`fitEllipse`); rotated ellipses are not
  recognized.
- **A defect larger than the mode's tolerance is not repaired**, because the input is
  the visual reference. With a source image (`restore.js`) the image is the reference
  instead.
- The page's own browser check keeps the original on failure but does not roll back
  single contours as the Node gate does.
- The last three limits are design limits, not bugs.

## 15. What this audit does not claim

It does not claim "production ready", "100 % accurate" or "fully validated". What the
evidence shows:

- The test results above (0 failures, skips counted).
- Browser-verified output for all 72 files when Chromium is present, in STRICT mode.
- Measured repairs moving geometry toward the correct drawing on the 10 defect cases.
- No change on clean geometry.
- Bounded memory.

Outside that, in particular for SVG features in section 14, the engine protects and
does not modify; it does not validate them internally.

## 16. Conformance table (internal renderer vs Chromium, 400 px on the long side)

| File | Visible diff | Pixels | Mean ΔE | Solid | Excluded | Result |
|---|---|---|---|---|---|---|
| bakery-icon.svg | 0.107 % | 0.254 % | 0.139 | 0 | 0 % | agrees |
| christmas-clock.svg | 0.178 % | 0.477 % | 0.214 | 0 | 0 % | agrees |
| clock-14-marks.svg | 0.177 % | 0.462 % | 0.213 | 0 | 0 % | agrees |
| deer-frame-icon.svg | 0.038 % | 0.083 % | 0.072 | 0 | 0 % | agrees |
| features.svg | 0.006 % | 0.013 % | 0.039 | 0 | 0 % | agrees |
| winter-clothing-icon.svg | 0.050 % | 0.118 % | 0.085 | 0 | 0 % | agrees |
| clip-bbox.svg | 0.005 % | 0.009 % | 0.010 | 0 | 0 % | agrees |
| clip-user-nested.svg | 0.015 % | 0.024 % | 0.014 | 0 | 0 % | agrees |
| compound-holes.svg | 0.000 % | 0.000 % | 0.000 | 0 | 0 % | agrees |
| css-descendant.svg | 0.000 % | 0.000 % | 0.000 | 0 | 100 % | not measured |
| css-important.svg | 0.000 % | 0.000 % | 0.000 | 0 | 100 % | not measured |
| css-media.svg | 0.000 % | 0.000 % | 0.000 | 0 | 100 % | not measured |
| css-pseudo.svg | 0.000 % | 0.000 % | 0.000 | 0 | 100 % | not measured |
| filter-css-function.svg | 0.000 % | 0.000 % | 0.000 | 0 | 100 % | not measured |
| filter-group.svg | 0.000 % | 0.000 % | 0.000 | 0 | 14 % | agrees |
| filter-shadow.svg | 0.000 % | 0.000 % | 0.000 | 0 | 24 % | agrees |
| gradient-linear.svg | 0.000 % | 0.000 % | 0.043 | 0 | 0 % | agrees |
| gradient-radial.svg | 0.000 % | 0.000 % | 0.069 | 0 | 0 % | agrees |
| gradient-userspace-spread.svg | 0.000 % | 0.000 % | 0.039 | 0 | 0 % | agrees |
| group-opacity.svg | 0.000 % | 0.000 % | 0.128 | 0 | 0 % | agrees |
| hidden-certain.svg | 0.000 % | 0.000 % | 0.000 | 0 | 0 % | agrees |
| hidden-sliver-ring.svg | 0.034 % | 0.054 % | 0.025 | 0 | 0 % | agrees |
| hidden-under-filter.svg | 0.000 % | 0.000 % | 0.000 | 0 | 24 % | agrees |
| hidden-under-mask.svg | 0.000 % | 0.000 % | 0.000 | 0 | 0 % | agrees |
| hidden-under-pattern.svg | 0.000 % | 0.000 % | 0.000 | 0 | 17 % | agrees |
| image-over-hidden.svg | 0.000 % | 0.000 % | 0.000 | 0 | 17 % | agrees |
| image-overlap.svg | 0.000 % | 0.000 % | 0.000 | 0 | 10 % | agrees |
| marker-css.svg | 0.000 % | 0.000 % | 0.000 | 0 | 16 % | agrees |
| marker-inherited.svg | 0.000 % | 0.000 % | 0.000 | 0 | 28 % | agrees |
| mask-bbox-alpha.svg | 0.000 % | 0.000 % | 0.053 | 0 | 0 % | agrees |
| mask-group-bbox.svg | 0.000 % | 0.000 % | 0.000 | 0 | 0 % | agrees |
| mask-group.svg | 0.000 % | 0.000 % | 0.066 | 0 | 0 % | agrees |
| mask-luminance.svg | 0.013 % | 0.037 % | 0.009 | 0 | 0 % | agrees |
| negative-coords.svg | 0.000 % | 0.000 % | 0.000 | 0 | 0 % | agrees |
| negative-scale.svg | 0.003 % | 0.007 % | 0.015 | 0 | 0 % | agrees |
| nested-svg-overflow.svg | 0.000 % | 0.000 % | 0.000 | 0 | 0 % | agrees |
| nested-svg.svg | 0.000 % | 0.000 % | 0.000 | 0 | 0 % | agrees |
| nested-transforms.svg | 0.000 % | 0.000 % | 0.005 | 0 | 0 % | agrees |
| non-uniform-scale-stroke.svg | 0.000 % | 0.000 % | 0.003 | 0 | 0 % | agrees |
| nonzero-holes.svg | 0.000 % | 0.000 % | 0.000 | 0 | 0 % | agrees |
| opacity-fill-stroke.svg | 0.000 % | 0.000 % | 0.174 | 0 | 0 % | agrees |
| overlapping-paths.svg | 0.000 % | 0.000 % | 0.030 | 0 | 0 % | agrees |
| par-meet-mismatch.svg | 0.000 % | 0.000 % | 0.000 | 0 | 0 % | agrees |
| par-none.svg | 0.010 % | 0.017 % | 0.021 | 0 | 0 % | agrees |
| par-slice.svg | 0.000 % | 0.000 % | 0.000 | 0 | 0 % | agrees |
| partially-hidden.svg | 0.000 % | 0.000 % | 0.000 | 0 | 0 % | agrees |
| pattern-fill.svg | 0.000 % | 0.000 % | 0.000 | 0 | 10 % | agrees |
| rotated-shapes.svg | 0.000 % | 0.000 % | 0.007 | 0 | 0 % | agrees |
| self-intersection.svg | 0.000 % | 0.000 % | 0.001 | 0 | 0 % | agrees |
| skew.svg | 0.010 % | 0.010 % | 0.008 | 0 | 0 % | agrees |
| stroke-dash.svg | 0.135 % | 0.147 % | 0.040 | 0 | 0 % | agrees |
| stroke-skew.svg | 0.000 % | 0.000 % | 0.002 | 0 | 0 % | agrees |
| text-overlap.svg | 0.000 % | 0.000 % | 0.000 | 0 | 30 % | agrees |
| thin-stroke.svg | 0.000 % | 0.000 % | 0.009 | 0 | 0 % | agrees |
| tiny-details.svg | 0.000 % | 0.000 % | 0.000 | 0 | 0 % | agrees |
| transform-css.svg | 0.000 % | 0.000 % | 0.000 | 0 | 100 % | not measured |
| transform-invalid.svg | 0.000 % | 0.000 % | 0.000 | 0 | 100 % | not measured |
| use-in-group.svg | 0.000 % | 0.000 % | 0.078 | 0 | 0 % | agrees |
| use-referenced.svg | 0.000 % | 0.000 % | 0.000 | 0 | 0 % | agrees |
| use-symbol.svg | 0.001 % | 0.009 % | 0.008 | 0 | 0 % | agrees |
| vector-effect.svg | 0.000 % | 0.000 % | 0.000 | 0 | 55 % | agrees |
| broken-continuity/bad.svg | 0.016 % | 0.022 % | 0.033 | 0 | 0 % | agrees |
| clean.svg | 0.011 % | 0.032 % | 0.028 | 0 | 0 % | agrees |
| distorted-circle/bad.svg | 0.001 % | 0.003 % | 0.012 | 0 | 0 % | agrees |
| distorted-repeated-shapes/bad.svg | 0.001 % | 0.003 % | 0.011 | 0 | 0 % | agrees |
| duplicate-geometry/bad.svg | 0.000 % | 0.000 % | 0.003 | 0 | 0 % | agrees |
| irregular-ellipse/bad.svg | 0.000 % | 0.009 % | 0.014 | 0 | 0 % | agrees |
| outlier-control-point/bad.svg | 0.004 % | 0.008 % | 0.013 | 0 | 0 % | agrees |
| rectangle-extra-points/bad.svg | 0.000 % | 0.000 % | 0.000 | 0 | 0 % | agrees |
| self-intersection/bad.svg | 0.000 % | 0.000 % | 0.000 | 0 | 0 % | agrees |
| tiny-artifact/bad.svg | 0.000 % | 0.000 % | 0.000 | 0 | 0 % | agrees |
| tiny-gap/bad.svg | 0.000 % | 0.015 % | 0.004 | 0 | 0 % | agrees |
