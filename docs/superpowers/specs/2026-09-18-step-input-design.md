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

`build:cli` today copies only `src/openscad.wasm` into `dist-cli/`. It
must also copy `occt-import-js.wasm` (from
`node_modules/occt-import-js/dist/`), and `loadStepGeometry` must
resolve it the same way `cli.ts` resolves `openscad.wasm`: next to the
bundle in `dist-cli/`, falling back to `node_modules` when run from the
repo root.

### Feeding OpenSCAD

Today the raw input file bytes are copied verbatim into the WASM FS as
`/toFix.stl` and `/gold.stl`. That stays true for STL inputs, so
pure-STL runs behave byte-identically to today.

For a STEP input, the loaded `BufferGeometry` is serialized to binary
STL with three's `STLExporter` (`parse(mesh, { binary: true })`, the
geometry wrapped in a throwaway `Mesh`) and written under the same VFS
name. The generated SCAD source is unchanged.

### Multi-body files

A STEP file may contain multiple solids. All bodies tessellate into the
one `BufferGeometry` and therefore into the one VFS STL as disjoint
shells. Geometry is preserved end to end; body identity/names are not
(STL has no concept of bodies). This matches how multi-shell STL inputs
already flow through the pipeline, and holds for both the model and the
reference input. Disjoint shells survive OpenSCAD's boolean ops as
disjoint shells in the output STL.

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
