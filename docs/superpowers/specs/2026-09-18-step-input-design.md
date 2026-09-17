# STEP input support for the CLI

Date: 2026-09-18
Status: approved design, pending implementation plan

## Goal

`gridfinity-rebase` (the CLI only — the web app is out of scope) accepts
STEP files (`.step`, `.stp`) as either or both of its two inputs, in any
mix with STL. Output remains STL in all cases.

## Constraint that shapes the design

OpenSCAD, including the WASM build bundled here, cannot import STEP.
The pipeline consumes triangle meshes twice:

1. Base detection runs on a three.js `BufferGeometry`.
2. The generated SCAD does `import("/toFix.stl")` / `import("/gold.stl")`
   from OpenSCAD's virtual filesystem.

So STEP support means tessellating the STEP to a mesh once, up front, and
feeding that mesh to both consumers. Because each of the two inputs
converts independently, mixed STL/STEP invocations need no extra logic.

BREP output is not achievable: the boolean work happens in mesh domain
(manifold backend), so STEP in always means STL out.

## Design

### Loading (`cli.ts`)

`loadGeometry` branches on file extension, case-insensitively:

- `.stl` — current `STLLoader` path, unchanged.
- `.step` / `.stp` — new `loadStepGeometry`: parse with `occt-import-js`
  (OpenCascade's STEP reader compiled to WASM, a few MB depending on
  version, loaded lazily only when a STEP input is present), then merge
  every returned mesh into one **non-indexed** `BufferGeometry` —
  index buffers expanded to flat position triples. This matters: base
  detection (`src/hull-utils.ts`) walks `position` in vertex triples and
  ignores `geometry.index`, which is only correct for non-indexed
  STL-style geometry.
- anything else — error naming the accepted formats, exit 2.

With the geometry de-indexed, downstream detection code is untouched.

### Bundling the OCCT WASM

`occt-import-js` is added as a regular (runtime) dependency in
`package.json` and locked in `package-lock.json`, so `npm install`,
`npm link`, and the `prepare` build stay reproducible.

`build:cli` today copies only `src/openscad.wasm` into `dist-cli/`. It
must also copy `occt-import-js.wasm` (from
`node_modules/occt-import-js/dist/`), and `loadStepGeometry` must
resolve it the same way `cli.ts` resolves `openscad.wasm`: next to the
bundle in `dist-cli/`, falling back to `node_modules` when run from the
repo root.

Licensing: the README documents the bundled OpenSCAD artifacts as GPLv3.
Add an equivalent note beside it for the new bundled artifact —
`occt-import-js` and the Open CASCADE Technology it embeds are both
LGPL-2.1 (the package's own `license` field is LGPL-2.1, not MIT).

### Feeding OpenSCAD

Today the raw input file bytes are copied verbatim into the WASM FS as
`/toFix.stl` and `/gold.stl`. That stays true for STL inputs, so
pure-STL runs behave byte-identically to today.

For a STEP input, the loaded `BufferGeometry` is serialized to binary
STL with three's `STLExporter` (`parse(mesh, { binary: true })`, the
geometry wrapped in a throwaway `Mesh`) and written under the same VFS
name. The generated SCAD source is unchanged. (This is the single-body
case; see "Multi-body files" below for >1 body, where each body is
serialized separately and pre-unioned before it reaches this step.)

### Multi-body files

A STEP file may contain multiple solids. `loadStep` tessellates every
body (for base detection, all bodies are still merged into the one
non-indexed `BufferGeometry`, exactly as before), but each body is *also*
de-indexed and serialized to its own binary STL.

The naive approach — merge all bodies into one `BufferGeometry` and
write one VFS STL — turned out to be unsafe when bodies **touch at an
exact plane**, which real gridfinity STEP exports do (e.g. a base body
spanning z 0–12 and foot bodies spanning z −4.75–0, meeting exactly at
z=0). Each body is tessellated independently by occt, so the two
surfaces sharing that plane get independently-generated, mismatched
triangulations. Merged into one polygon soup and imported as a single
`import()`, OpenSCAD's Manifold backend still reports `Status: NoError`
(it happily unions a self-consistent soup), but the *exported STL* ends
up with edges shared by more than two triangles — non-manifold by the
STL edge-topology definition, even though OpenSCAD's own manifold check
passed. Slicers reject that output. (Confirmed on a real 7-body
screwdriver-holder export: 68 such edges; a denser 42mm example: 1266.)
Disjoint (non-touching) shells were never affected — this only bites
bodies that share a coincident surface.

The fix: when a STEP file has more than one body, `cli.ts` writes each
body's STL into the OpenSCAD VFS separately (`/body-0.stl`,
`/body-1.stl`, ...) and runs a small pre-pass — `union() { import(...);
... }` through the same manifold backend — before the body ever reaches
the main SCAD program. Two exactly-touching separate manifold solids
union cleanly into one manifold solid; a single soup of coincident
shells does not. The result of that pre-union becomes `stlBytes`, i.e.
the file that's written to `/toFix.stl` or `/gold.stl` for the real
render, same as the single-body/STL case. (Verified on the same
screwdriver file: pre-union output has 17440 triangles, 0 open edges, 0
edges shared by more than two triangles.) A single-body STEP file
(the common case) is unaffected — `stlBytes` is just that one body's
STL, with no extra OpenSCAD pass.

Body identity/names are not preserved (STL has no concept of bodies) —
same as today. This matches how multi-shell STL inputs already flow
through the pipeline, and holds for both the model and the reference
input.

Assumption, inherited from the existing detector: bases are detected
only on faces within 0.001mm of the model's **global** minimum Z
(`hull-utils.ts`). Bodies whose bottom sits above that plane are carried
through geometrically untouched but never get a base swap. Fine for the
intended case (all gridfinity feet on one plane); a model with feet at
different heights is out of scope, same as it is today for multi-shell
STLs.

### Tessellation quality

Fixed deflection, passed to `occt-import-js` explicitly — its default
`linearDeflectionType` is `bounding_box_ratio`, not millimetres:

```
linearUnit: "millimeter"
linearDeflectionType: "absolute_value"
linearDeflection: 0.01
angularDeflection: 0.2   (radians, ~11.5°)
```

Fine enough that gridfinity base geometry (0.8mm radii, 45° chamfers)
is faithful within print tolerance. No CLI flag; add one later only if
a real model needs it.

### CLI surface

- `-o` default for a STEP model: `<model>-rebased.stl` (extension
  replaced, not appended).
- Help text and README: STEP accepted as input, output is STL only.
- No new flags.

## Testing

1. Round trip: a STEP file of a gridfinity bin runs through the CLI,
   bases detected, output STL is watertight.
2. Mixed formats: STEP model + STL reference, and STL model + STEP
   reference.
3. Multi-body STEP: all bodies present in the output as disjoint shells.
4. Regression: a pure-STL run produces the same output as before the
   change.

## Rejected alternatives

- **Shelling out to FreeCAD/Mayo for conversion** — zero bundle growth,
  but adds a system dependency the user must install plus cross-platform
  detection; poor fit for an npm-installable CLI.
- **Full `opencascade.js`** — much larger WASM and API surface than
  needed; `occt-import-js` is purpose-built for import.
- **Body-identity-preserving output (3MF / per-body STLs)** — rejected
  in design review; disjoint shells in one STL are sufficient.
