# STEP Input Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CLI accepts `.step`/`.stp` files as either or both inputs, in any mix with STL; output stays STL.

**Architecture:** STEP files are tessellated once up front with `occt-import-js` (OpenCascade WASM) into a non-indexed three.js `BufferGeometry`, which feeds both base detection and (serialized to binary STL) OpenSCAD's virtual filesystem. STL inputs are untouched — byte-identical behavior to today.

**Tech Stack:** TypeScript, three.js, occt-import-js, esbuild, node:test (node v24).

**Spec:** `docs/superpowers/specs/2026-09-18-step-input-design.md` (buddysystem-converged). Read it before starting.

---

## Verified facts (checked against the installed packages — trust these)

- `occt-import-js` is installed and in `package.json` dependencies. API:
  `const occt = await occtimportjs(moduleOverrides)` (default export, CJS,
  emscripten factory — accepts `{ wasmBinary }` like `src/openscad.js` does);
  `occt.ReadStepFile(new Uint8Array(buf), params)` returns
  `{ success: boolean, meshes: [{ name, attributes: { position: { array } }, index: { array } }] }`.
  Meshes are **indexed** (verified: 10mm cube fixture → 72 position floats, 36 indices).
- Tessellation params (exact spelling, from the package README):
  `{ linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.01, angularDeflection: 0.2 }`.
- The WASM lives at `node_modules/occt-import-js/dist/occt-import-js.wasm`.
  Licenses beside it: `license.occt.txt` and `license.occt-import-js.txt`, both LGPL-2.1 (the package's own `license` field is LGPL-2.1, not MIT).
- Base detection (`src/hull-utils.ts:38`) walks `position` in vertex triples
  and ignores `geometry.index` — STEP geometry MUST be de-indexed
  (`BufferGeometry.toNonIndexed()` or merge-time expansion) before detection.
- three's `STLExporter` (`three/examples/jsm/exporters/STLExporter.js`)
  supports `parse(mesh, { binary: true })` → `DataView`. It takes a `Mesh`/`Object3D`, not a bare geometry.
- A plain 41.5mm box IS detected as a 42mm-pitch gridfinity base and runs the
  full pipeline successfully (verified with an STL probe against
  `public/default-gold-refined-3.stl`). `test/fixtures/box415.step` (41.5mm
  box, already on disk, untracked) parses via occt: 1 mesh, 41.5×41.5×41.5.
- Multi-body STEP fixture for unit tests:
  `node_modules/occt-import-js/test/testfiles/cax-if/dm1-id-214.stp` → 7 meshes
  (ships inside the npm package; reference it from `node_modules`, don't vendor).
- The CLI is black-box testable: `node dist-cli/cli.mjs -o <out> <model> <gold>`
  exits 0 and prints the output path on success. `npm run build:cli` rebuilds it.

## File structure

- Create `src/step-utils.ts` — STEP loading + STL serialization. CLI-only; the
  web app must never import it (keeps the WASM out of the vite bundle).
- Modify `cli.ts` — extension dispatch, VFS write switch, default output name, usage text.
- Modify `package.json` — `test` script; `build:cli` copies the OCCT wasm.
- Modify `README.md` — usage + license note.
- Create `test/cli.test.mjs` (black-box CLI tests), `test/step-utils.test.ts`
  (unit tests), `test/fixtures/box415.step` + `test/fixtures/box415.stl`.

---

### Task 1: Test harness, fixtures, STL regression baseline

**Files:**
- Create: `test/cli.test.mjs`, `test/fixtures/box415.stl`
- Add (exists untracked): `test/fixtures/box415.step`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Create `test/fixtures/box415.stl`** — an ASCII STL of a
  41.5×41.5×10mm box sitting on z=0 (8 vertices, 12 triangles, normals may be
  `0 0 0`; the pipeline doesn't read them). Verify by parsing with three's
  `STLLoader` in a `node -e` one-liner: bounding box 41.5×41.5×10.
- [ ] **Step 2: Add test script to `package.json`:**
  `"test": "npm run build:cli && esbuild test/step-utils.test.ts --bundle --platform=node --format=esm --outfile=dist-test/step-utils.test.mjs 2>/dev/null; node --test test/ dist-test/"`
  — adjust freely if a cleaner split works, but the contract is: `npm test`
  rebuilds the CLI, bundles any TS tests, and runs everything under node:test.
  (Until Task 2 exists, the esbuild half may no-op — hence the `;`.)
- [ ] **Step 3: Write `test/cli.test.mjs`** with one regression test: spawn
  `node dist-cli/cli.mjs -o <tmpdir>/out.stl test/fixtures/box415.stl public/default-gold-refined-3.stl`
  (use `node:child_process` `execFile`, cwd = repo root). Assert: exit 0,
  output file exists, `STLLoader` parses it, and it has > 0 triangles.
- [ ] **Step 4: Run `npm test`** — expected: the regression test PASSES
  (this is a baseline over existing behavior, not TDD red).
- [ ] **Step 5: Commit** — `test: add CLI test harness, box fixtures, STL regression baseline`

### Task 2: `src/step-utils.ts` — STEP → BufferGeometry, geometry → binary STL

**Files:**
- Create: `src/step-utils.ts`, `test/step-utils.test.ts`

Interface (exact):

```ts
export async function loadStepGeometry(data: Uint8Array): Promise<BufferGeometry>
export function geometryToBinaryStl(geometry: BufferGeometry): Uint8Array
```

Behavior:
- `loadStepGeometry` locates `occt-import-js.wasm` the same way `cli.ts`
  locates `openscad.wasm` (next to the bundle dir, then
  `node_modules/occt-import-js/dist/` when run from the repo root), passes it
  as `wasmBinary`, calls `ReadStepFile` with the exact params from Verified
  facts, throws on `success: false` or zero meshes, merges ALL meshes into one
  `BufferGeometry`, and returns it **non-indexed** (`getIndex() === null`).
  Load the occt module lazily and at most once (module-level memo) — a
  session may call it for both inputs.
- `geometryToBinaryStl` wraps the geometry in a throwaway `Mesh` and uses
  `STLExporter.parse(mesh, { binary: true })`; return a `Uint8Array` view of
  the resulting buffer.

- [ ] **Step 1: Write `test/step-utils.test.ts` (failing)** with these cases:
  - box415.step → 1 mesh, non-indexed (`getIndex() === null`), 36 vertices
    (12 triangles), bounding box 41.5³ (±0.01).
  - `node_modules/occt-import-js/test/testfiles/cax-if/dm1-id-214.stp` →
    merged geometry, non-indexed, vertex count = 3 × (sum of every mesh's
    `index.array.length` / 3) — i.e. all 7 bodies present.
  - garbage bytes → rejects (throws).
  - roundtrip: `geometryToBinaryStl(loadStepGeometry(box415.step))` parses
    via `STLLoader` with the same triangle count and bounding box.
- [ ] **Step 2: Run `npm test`** — expected: new tests FAIL (module missing).
- [ ] **Step 3: Implement `src/step-utils.ts`** to the interface above.
  Gotcha: esbuild must bundle the CJS occt module into the ESM CLI bundle;
  since `wasmBinary` is passed explicitly, occt's own `__dirname` wasm lookup
  is never used. If bundling still trips, fallback decision: mark
  `occt-import-js` external in `build:cli` (it's a runtime dep, so it resolves
  from `node_modules` at run time) — note which path was taken in the commit.
- [ ] **Step 4: Run `npm test`** — expected: all PASS.
- [ ] **Step 5: Commit** — `feat: add STEP loading and binary STL serialization (step-utils)`

### Task 3: CLI wiring — extension dispatch, VFS switch, output name, usage

**Files:**
- Modify: `cli.ts`
- Modify: `test/cli.test.mjs` (new E2E cases)

Decisions:
- Replace `loadGeometry` with a dispatcher returning both what detection needs
  and what OpenSCAD needs: `{ geometry: BufferGeometry, stlBytes: Uint8Array }`.
  For `.stl` (case-insensitive): geometry from `STLLoader` as today, `stlBytes`
  = the raw file bytes (pure-STL runs stay byte-identical). For `.step`/`.stp`:
  `loadStepGeometry` + `geometryToBinaryStl`. Any other extension: error naming
  accepted formats (`.stl`, `.step`, `.stp`), exit 2.
- The two `instance.FS.writeFile('/gold.stl' | '/toFix.stl', ...)` calls at
  `cli.ts:241-242` currently re-read the input files from disk — switch them to
  the dispatcher's `stlBytes` so STEP inputs land as tessellated STL. SCAD
  source is unchanged.
- Default output name: strip a trailing `.stl`/`.step`/`.stp` (case-insensitive)
  and append `-rebased.stl` (today's regex `/(\.stl)?$/i` only knows `.stl`).
- Usage text: model/reference lines say STL or STEP accepted; note output is
  always STL.

- [ ] **Step 1: Add failing E2E tests to `test/cli.test.mjs`:**
  - STEP model: `box415.step` + `public/default-gold-refined-3.stl` → exit 0, parseable STL out.
  - STEP gold, STL model: `box415.stl` + `box415.step` → exit 0, parseable STL out.
  - default output name: run with `box415.step` and no `-o` (in a tmpdir copy) → creates `box415-rebased.stl`.
  - unknown extension (`.obj` file) → exit 2, stderr names accepted formats.
- [ ] **Step 2: Run `npm test`** — expected: new cases FAIL.
- [ ] **Step 3: Implement the `cli.ts` changes.**
- [ ] **Step 4: Run `npm test`** — expected: all PASS, including Task 1 regression.
- [ ] **Step 5: Commit** — `feat: accept STEP input (either or both files) in the CLI`

### Task 4: Build, docs, licensing

**Files:**
- Modify: `package.json` (`build:cli`), `README.md`

- [ ] **Step 1:** `build:cli` also copies
  `node_modules/occt-import-js/dist/occt-import-js.wasm` to `dist-cli/`
  (skip if Task 3 took the "external" fallback AND resolution from
  node_modules is the chosen strategy — then instead document that occt
  resolves from node_modules; the spec's preference is the copy).
- [ ] **Step 2:** README: add STEP to the CLI usage section; beside the
  existing "OpenSCAD is GPL software" note (README.md:12), add: bundled
  `occt-import-js` and the Open CASCADE Technology it embeds are LGPL-2.1,
  license texts in `node_modules/occt-import-js/dist/`
  (or `dist-cli/` if copied).
- [ ] **Step 3:** Clean rebuild proof: `rm -rf dist-cli dist-test && npm test`
  — expected: everything rebuilds and passes.
- [ ] **Step 4: Commit** — `build+docs: ship OCCT wasm with the CLI, document STEP support and licensing`

## Self-review notes

- Spec coverage: loading/dispatch (T3), de-indexing (T2), VFS feeding (T3),
  multi-body (T2 unit test), tessellation params (T2), bundling (T2/T4),
  dependency pinning (done — occt-import-js already installed), output name +
  usage (T3), licensing (T4), regression + mixed-format + round-trip tests (T1/T3).
- Multi-body E2E through the CLI success path is deliberately unit-level only:
  no multi-body fixture with coplanar 41.5mm bases exists, and hand-authoring
  one in STEP text is not worth it. The spec's min-Z assumption section covers
  the semantics.
