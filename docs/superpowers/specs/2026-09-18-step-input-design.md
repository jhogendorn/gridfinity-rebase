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
  (OpenCascade's STEP reader compiled to WASM, ~12MB, loaded lazily only
  when a STEP input is present), then merge every returned mesh
  (positions + indices per body) into one indexed `BufferGeometry`.
- anything else — error naming the accepted formats, exit 2.

Downstream detection code is untouched; it already operates on
`BufferGeometry`.

### Feeding OpenSCAD

Today the raw input file bytes are copied verbatim into the WASM FS as
`/toFix.stl` and `/gold.stl`. That stays true for STL inputs, so
pure-STL runs behave byte-identically to today.

For a STEP input, the loaded `BufferGeometry` is serialized to binary
STL by a small local writer (~30 lines; three's `STLExporter` is
ASCII-only with poor normal handling) and written under the same VFS
name. The generated SCAD source is unchanged.

### Multi-body files

A STEP file may contain multiple solids. All bodies tessellate into the
one `BufferGeometry` and therefore into the one VFS STL as disjoint
shells. Geometry is preserved end to end; body identity/names are not
(STL has no concept of bodies). This matches how multi-shell STL inputs
already flow through the pipeline, and holds for both the model and the
reference input. Disjoint shells survive OpenSCAD's boolean ops as
disjoint shells in the output STL.

### Tessellation quality

Fixed deflection: linear 0.01mm, angular ~12°. Fine enough that
gridfinity base geometry (0.8mm radii, 45° chamfers) is faithful within
print tolerance. No CLI flag; add one later only if a real model needs
it.

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
