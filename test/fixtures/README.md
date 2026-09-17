# Test fixtures

- `box415.step` — derived from occt-import-js's `test/testfiles/cube-10x10mm/Cube 10x10.stp`,
  scaled x4.15 to a 41.5mm cube, centred at X/Z in [-20.75, 20.75] and Y in [0, 41.5].
- `box415.stl` — a 41.5x41.5x10mm box with a corner at the origin.

Both share the same 41.5x41.5mm base footprint (the property base detection cares about),
but `box415.stl` is a different shape from `box415.step` (different height, different
position/centring) — they are NOT geometrically equivalent.
