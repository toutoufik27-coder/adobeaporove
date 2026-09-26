# Final correctness audit (`refine/`)

Every number below was measured in this audit, by running the code. None is copied from
AUDIT.md or REPAIR-LOG.md; those were treated as claims to check (results: REPAIR-LOG.md,
phase 5). To reproduce: `npm test`, `node test/audit.js`,
`node --expose-gc test/bench.js --isolated`, `node test/before-after.js out-dir`.

After the first commit of this audit, the user reported that the deer icon needed
changing, and it did (section 18). The numbers below are for the current code; numbers
of the first commit are kept where they are compared, and marked as such.

**Environment:** Node v22.22.2, Linux container (4 cores, 16 GB), running as root.
Browser: Chromium 1194 (Playwright build, headless), started with `SVG_REFINE_BROWSER=/opt/pw-browsers/chromium`.
Chrome needs `--no-sandbox` when it runs as root; the oracle now adds it only in that case.

## 1. Tests (`npm test`, run to the end, default timeouts)

| Run | Passed | Failed | Skipped | Time | Peak RSS (VmHWM) |
|---|---|---|---|---|---|
| Before this audit, no browser | 105 | 0 | 1 line (hid 61 checks) | 82.5 s | not measured |
| Before this audit, Chromium | 166 | 0 | 0 | 95.2 s | 563 MB |
| After the audit's first commit, no browser | 137 | 0 | 65 | 140.6 s | 495 MB |
| After the audit's first commit, Chromium | 195 | 0 | 7 | 167.5 s | 498 MB |
| **Now (with section 18), no browser** | **155** | **0** | **70** | 171.2 s | 513 MB |
| **Now (with section 18), Chromium** | **218** | **0** | **7** | 211.7 s | 554 MB |

- The "before" run with Chromium used the original engine with one change: the oracle
  launch fix (`--no-sandbox` as root). Without that fix, Chromium does not start in
  this container.
- A skipped check is never counted as passed. Without a browser, every check that needs
  one is skipped: 61 conformance checks, 4 oracle and STRICT checks, the browser check
  of the recolour, and the 4 checks of the web page (`test/page.js`).
- With Chromium, the 7 skips are conformance rows where the whole image is an uncertain
  region, so nothing is compared. The old suite reported these as "agrees".
- The suite now takes longer mainly because it has more checks and processes more
  geometry. It no longer deletes "probably hidden" contours (section 11), so more
  contours go through every pass.
- The peak of the whole test process rose with the checks of section 18 (full-document
  runs and extra browser and internal renders); the per-file engine peaks (section 5)
  did not.

## 2. Browser validation: STRICT / FALLBACK

- `finalize(ctx, opts, { validation: 'strict' | 'fallback', browser })`. The CLI flag is
  `--validation strict|fallback` (default `strict`), plus `--no-browser`.
- **STRICT:** without the browser oracle, nothing is accepted. The result is
  `ok: false`, `level: 'original-kept'`, `browserVerified: false`, with the reason.
- **FALLBACK:** the internal renderer alone may accept the output. The result then says
  `browserVerified: false` and `level: 'internal-only'`.
- `certified` is true only for STRICT with a browser pass.
- After an intended change (restoration to the source image, repetition consistency)
  the reference is the corrected drawing, and the change itself must be confirmed in
  the browser first (section 6). STRICT without a browser keeps the **original input**,
  not the unverified correction (before the fix of section 18 it kept the correction and
  called it the original).
- The web worker runs FALLBACK. The page then draws both files in the browser itself
  before download. Intermediate stages are marked as not validated. `test/page.js`
  (part of `npm test` when a browser is present) loads the deer icon into the page in
  Chromium and checks that the page's own check passes against the corrected drawing
  and confirms the recolour.
- Tests cover STRICT without a browser, FALLBACK without a browser, STRICT with the
  browser, and recovery after a failed render.

## 3. Browser conformance: internal renderer vs Chromium

73 files (samples, fixtures, defect fixtures): **66 measured, 66 agree, 0 differ, 7 not
measured** (100 % of the image is uncertain: CSS selectors / `!important` / `@media`,
CSS filter, CSS transform, invalid transform). The agreement limit is unchanged:
visible ≤ 0.25 %, mean ΔE ≤ 0.6, 0 solid spots.

Largest differences: christmas-clock 0.178 % (mean ΔE 0.214), clock-14-marks 0.177 %,
stroke-dash 0.135 %, bakery-icon 0.107 %, winter-clothing-icon 0.050 %,
deer-frame-icon 0.038 %. All have 0 solid spots. The full table is in section 17.

## 4. Why a run can slow down or stop (findings)

Individual and sequential processing were compared in the same order:
`test/bench.js --isolated`, 73 files (re-run on the current code).

- **Sequential is not slower.** The sequential / isolated time ratio is ≤ 1.00 for 71
  files; small files are faster in sequence because the JIT is warm. Two heavy defect
  files read 1.23 (distorted-circle) and 1.21 (distorted-repeated-shapes) in this run
  (1.08 and 1.32 in a run disturbed by other work; 1.09 and 1.12 at the first commit).
  Their sequential times are the same as at the first commit (1.43 vs 1.53 s, 1.10 vs
  1.11 s); what varies between runs is the isolated time. Heap after GC is 6.1 → 7.2 MB
  over 73 files: no leak.
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
- **Slowest files** (STRICT with Chromium, professional mode, `test/audit.js`):
  - christmas-clock.svg 24.1 s
  - clock-14-marks.svg 7.3 s
  - bakery-icon.svg 6.7 s
  - winter-clothing-icon.svg 3.9 s
  - deer-frame-icon.svg 3.7 s

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
- **Peaks over all 73 files** (STRICT, Chromium, one process, `node test/audit.js`):

  | Metric | Peak (first commit, 72 files) | Peak (now, 73 files) |
  |---|---|---|
  | heapUsed | 47.4 MB | 43.6 MB |
  | RSS | 297.9 MB | 298.1 MB |
  | arrayBuffers | 124.0 MB | 124.3 MB |
  | external | 127.4 MB | 127.7 MB |
  | crop cache | 47.9 MB | 47.9 MB |

- **Whole test process (VmHWM):** 495 MB without a browser and 498 MB with Chromium at
  the first commit, against 563 MB before the audit; now 513 MB and 554 MB (section 1).
- The new repetition-consistency grouping builds distance grids only for contours that
  pass a box test and searches them only as far as the tolerance: 0.29 s on
  christmas-clock, and the peaks stay as above. (A first version that built a grid for
  every contour raised christmas-clock's peaks by 18 MB RSS and 17 MB arrayBuffers; it
  was replaced before this commit.)
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

Before step 2, when an intended change made the corrected drawing the reference
(`src/intended.js`): the original and the corrected drawing are drawn by the browser
and, from the same two texts, by the internal renderer. Every difference the browser
shows must lie within 2 px of one the internal renderer shows (nothing changes
elsewhere), and inside the change (pixels whose 3 × 3 neighbourhood all changed) the
browser must draw the corrected drawing in the internal renderer's colour. Not
confirmed: the original input is kept. The page runs the same check in the user's
browser, and compares the output with the corrected drawing, not with the original.

- **Browser reference:** the input text itself. The engine's own copy of the original
  is compared with it too (**fidelity**), so a writer bug cannot hide by rendering both
  sides through the same writer. It did hide one: the space between two `<tspan>`s was
  dropped. The fidelity check now runs in every case; it was skipped whenever an
  intended stage existed (section 18).
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

Totals over the 73 files (professional, STRICT, Chromium; all 73 browser-verified):

| | Count | By type |
|---|---|---|
| **Repairs** | **19** | primitive reconstruction 10, broken continuity 3, repetition consistency 2, accidental artifacts 2, geometry correction 1, topology repair 1 |
| **Optimizations** | **274** | node reduction 139, precision reduction 117, path normalization 14, redundant command removal 2, redundant element removal 2 |
| Rejected candidates | 520 | |
| Rolled-back changes | 47 | all in christmas-clock |

(At the first commit, over 72 files: 17 repairs, 272 optimizations, 511 rejected.)

Real sample files (professional, STRICT with Chromium):

| File | Nodes | Size | Repairs | Optimizations | Rejected | Rolled back | Level | Visible diff internal / browser | Time | Peak RSS / arrayBuffers |
|---|---|---|---|---|---|---|---|---|---|---|
| bakery-icon.svg | 225 → 151 | 8.0 → 5.3 KB | 0 | 24 | 32 | 0 | browser-verified | 0.047 % / 0.054 % | 6.7 s | 246.0 / 104.7 MB |
| christmas-clock.svg | 1010 → 776 | 34.0 → 24.5 KB | 0 | 18 | 182 | 47 | browser-verified | 0.042 % / 0.047 % | 24.1 s | 298.1 / 120.0 MB |
| clock-14-marks.svg | 351 → 306 | 10.4 → 9.0 KB | 0 | 24 | 92 | 0 | browser-verified | 0.100 % / 0.151 % | 7.3 s | 297.5 / 124.3 MB |
| deer-frame-icon.svg | 134 → 127 | 4.3 → 3.5 KB | 1 | 7 | 30 | 0 | browser-verified | 0.004 % / 0.008 % | 3.7 s | 292.6 / 98.9 MB |
| features.svg | 29 → 23 | 1.4 → 1.1 KB | 0 | 5 | 3 | 0 | browser-verified | 0.000 % / 0.004 % | 1.4 s | 265.8 / 87.9 MB |
| winter-clothing-icon.svg | 99 → 91 | 3.0 → 2.5 KB | 0 | 7 | 20 | 0 | browser-verified | 0.066 % / 0.062 % | 3.9 s | 284.5 / 91.0 MB |

On the real sample files (without their source images) the count is **1 repair**: the
recolour of the deer's fourth corner piece (section 18). At the first commit it was 0,
and this document said everything done there was optimization; that was wrong for the
deer. The visible difference of the deer is measured against the corrected drawing.
Everything else done on the samples is optimization. The 6 "circles rebuilt as real
circles" in bakery-icon were already circles within 0.1 u, so rewriting them is path
normalization.

## 8. Defect fixtures (`test/defects/<name>/bad.svg` + `expected.svg`)

`expected.svg` is the corrected drawing. The test measures the output's distance to it
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
| inconsistent-repeat (one of four mirrored corner pieces in the panels' colour) | paint by paint: far (≥ 64 u) → 0.000 u | repetition consistency |

The distance is also measured **paint by paint** (`paintDistance`: the same Hausdorff
distance between the outlines of each fill / stroke colour), so a shape in the wrong
colour counts as far from its place. For inconsistent-repeat the plain distance is 0
before and after (the geometry is right, the colour is not); paint by paint the
triangle in the panels' colour is farther than the 64 u search reach from any
panel-coloured outline of the expected drawing, and 0.000 u after the repair. Every
fixture must now get closer on both measures.

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
13. Restoration to the source image left a **spike** (the outline turned back by 163°)
    in one corner of the deer frame. It improved the pixel error, so it was accepted.
    Found by the before / after check (section 16). Snapped outlines now lose their
    spurs before the rebuild, and a candidate that still adds a spike is rejected. The
    test fails on the old code and passes now.

Found after the user reported that the deer icon needed changing (section 18):

14. Restoration accepted an outline only when the count of wrong pixels improved. That
    count is dominated by the anti-aliased band along every edge, so it rejected
    corner pieces 43–47 % closer to the image's edges.
15. The writer-fidelity check was skipped whenever an intended stage existed.
16. STRICT without a browser returned the unverified corrected drawing as
    "original-kept".
17. An intended change was never drawn by the browser.
18. The page's own browser check compared the output with the original, so a correction
    that is visible by design fails it. Measured on the deer: 415 spot px against a limit
    of 8, so the page would have shown and offered the original instead of the fix.
19. `record()` counted informational log entries as rejected.
20. The analysis recommended "safe: the geometry is already clean" for the deer, whose
    fourth corner piece has the wrong colour.

## 14. Remaining limits and unsupported SVG features

- **Not drawn by the internal renderer** (`CAPS`):
  - patterns, filters, markers
  - text, image
  - `vector-effect: non-scaling-stroke`
  - `<switch>`

  Elements that need them are locked and their area is an uncertain region; they are
  validated only in the browser. Seen in the 73 files: image 3, text 1, filter 4,
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
- **Repetition consistency** (section 18) only groups mirror copies about the drawing's
  centre (vertical axis, horizontal axis, or a half turn). Copies repeated by
  translation or by other rotations (a row of icons, a ring of marks) are not grouped.
  It needs at least 3 copies of one colour making at least 3/4 of the group (2 against
  2 is left alone), solid opaque unstroked fills in one coordinate system, and a copy
  that nothing covers. Without the source image the decision rests on the repetition
  alone. It changes a colour, so it is off in the safe and balanced modes and can be
  turned off (setting, `--no-consistency`).
- **Restoration follows a blurred picture.** Restored outlines are about 0.2 px (mean)
  from the picture's edges; a straight edge can come out with a bow of that size (the
  top edge of the deer's top-left corner piece bows by 0.15 px).

## 15. What this audit does not claim

It does not claim "production ready", "100 % accurate" or "fully validated". What the
evidence shows:

- The test results above (0 failures, skips counted).
- Browser-verified output for all 73 files when Chromium is present, in STRICT mode.
- Measured repairs moving geometry (and, for one case, colour) toward the correct
  drawing on the 11 defect cases.
- No change on clean geometry.
- Bounded memory.

Outside that, in particular for SVG features in section 14, the engine protects and
does not modify; it does not validate them internally.

## 16. Before / after on the sample with its source image

`node test/before-after.js out-dir` (needs a browser). `deer-frame-icon.svg` is traced
from `deer-frame-source.png`; professional mode: restoration to the image, repetition
consistency, STRICT. The first column of "after" is this audit's first commit; the
second is the current code (section 18).

| | Before | After (first) | After (now) |
|---|---|---|---|
| Wrong pixels against the source image (ΔE > 20) | 4.00 % | 3.90 % | 3.89 % |
| Mean ΔE against the source image | 4.72 | 4.67 | 4.67 |
| Corner pieces whose inner edge follows the picture's arc | 0 of 4 | 2 of 4 | 4 of 4 |
| Corner pieces in the corner colour | 3 of 4 | 3 of 4 | 4 of 4 |
| Nodes | 134 | 130 | 129 |
| Size | 4.3 KB | 3.8 KB | 3.9 KB |
| Repairs | — | 4 | 8 (geometry correction 7, repetition consistency 1) |
| Optimizations | — | 6 | 4 |
| Final validation | — | browser-verified | browser-verified; the intended change confirmed in the browser (4 772 px changed, 0 outside the change, 0 in another colour); visible difference to the corrected drawing 0.001 % internal / 0.008 % browser |

- **Frame corner:** the straight diagonal became the arc the image shows.
- **The rest of the error:** the improvement in wrong pixels is small. Most of what is
  left is the soft, blurred edges of the image, not the drawing.
- **The spike:** a first run of this check showed a spike in another corner. It is
  fixed (bug 13).
- The first version of this section called the result good enough. It was not: see
  section 18.

## 17. Conformance table (internal renderer vs Chromium, 400 px on the long side)

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
| inconsistent-repeat/bad.svg | 0.000 % | 0.000 % | 0.000 | 0 | 0 % | agrees |

## 18. The deer icon needed changing (user report)

After section 16 the icon came out almost unchanged, and the analysis recommended the
safe mode because "the geometry is already clean". The user said the shape needed
changing. Checked against the source image, it did.

**What was wrong**

- **The colour of one corner piece.** The four corner pieces are mirror copies of one
  shape. Three are `#b1dcfe`; the bottom-left one is `#def1fe`, the colour of the side
  panels. The picture is lit a little unevenly: the median colour inside the four pieces
  is `#afdefb`, `#b4e4fb`, `#bee5fc` and `#c6eafc`. The bottom-left piece is the
  lightest, and the tracer put it on the neighbouring palette colour.
- **The shape of the corner pieces.** Their inner edge is a straight diagonal in the SVG
  and an arc in the picture.

**Why the engine did not fix them**

- It never compared the colours of repeated parts. No pass did.
- Restoration rejected the arc for two of the four pieces (bug 14): the count of wrong
  pixels got worse (116 → 130 and 95 → 101) although the outlines moved 43–47 % closer
  to the picture's edges (0.293 → 0.166 px and 0.392 → 0.209 px).

**What it does now**

- Restoration also measures the distance from the outline to the picture's edges.
  Either measure may accept; the other must not get clearly worse. All four pieces now
  follow the arc. An outline farther from both measures is still rejected.
- `src/consistency.js`, **repetition consistency** (a repair). Contours that are mirror
  images of each other about the drawing's centre form a group. When at least 3 copies
  share a colour and make at least 3/4 of the group, an odd copy is moved into an
  element of that colour, if:
  - the render around it does not change outside the copy, and inside it becomes
    exactly the majority colour (paint order included; a copy covered by another shape
    is left alone);
  - with the source image, the picture does not contradict it: inside the odd copy the
    picture must look like one of the other copies (ΔE to the nearest one at most the
    spread among the others + 2). Deer: 2.8 to the nearest, 5.3 among the others.
  - two members of the group are never in one place (stacked layers are not repeats).
- The recolour is an intended change: it becomes a history stage ("Consistent") and the
  reference of the later passes, and it is checked in the browser (section 6).
- The analysis reports "1 repeated mirrored part drawn in another colour than its
  copies" and recommends the professional mode.

**The picture alone does not decide the colour.** Inside the bottom-left piece the
picture is a little closer to `#def1fe` (ΔE 6.8) than to `#b1dcfe` (ΔE 9.9). What
decides is the repetition: four copies of one part, three of them `#b1dcfe`, and in the
picture the fourth looks like its neighbours as much as they look like each other.
That is a design judgment, so the pass is off in the safe and balanced modes and can be
turned off.

**Results** (STRICT, Chromium): with the source image, see the table in section 16.
Without it (the SVG alone): the recolour only, 1 repair; confirmed in the browser
(598 px changed, 0 outside the piece, 408 interior px in the engine's colour).
Checked on all 73 files in aggressive mode: the deer and the new defect fixture are
the only files where a colour changes.
