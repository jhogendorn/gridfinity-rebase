Gridfinity Rebase lives at [https://gridfinity.tools/rebase](https://gridfinity.tools/rebase).

This is a React project bundled with Vite.

To run it locally:

```
npm install
npm run dev
```

OpenSCAD is GPL software. `openscad.wasm` and `openscad.js` are distributed under the GPL, version 3.

The bundled `occt-import-js` and the Open CASCADE Technology code it
embeds are LGPL-2.1 (license texts `license.occt.txt` and
`license.occt-import-js.txt`, copied into `dist-cli/` by `build:cli`);
compatible with this project's GPLv3.

## CLI

```
npm install
npm link        # puts `gridfinity-rebase` on your PATH
gridfinity-rebase [options] <model> <reference>
```

Inputs may be `.stl`, `.step`, or `.stp`, in any mix; output is always
written as STL. Writes `<model>-rebased.stl` (binary STL) by default; see
`gridfinity-rebase --help` for options. Both full-size (42mm) and
half-size (21mm) gridfinity bases are supported, in any combination.
The 42mm cell is the unit: for mixed pitches the whole underside is
sliced off and a 42mm unit sampled from the reference is tessellated
across the footprint, trimmed flush at overhangs (e.g. a 2.5-cell-wide
model gets half-width feet on the odd row). `--stackable <units>`
wraps the model in perimeter walls up to `<units>` × 7mm, topped with a
standard gridfinity stacking lip.

For development, `node cli.ts ...` runs the same thing from the repo
without the bundle step (Node ≥ 22.18).
