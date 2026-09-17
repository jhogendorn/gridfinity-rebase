// Edge-topology check for a binary STL. A manifold solid has every edge
// shared by exactly two triangles; this counts edges shared by only one
// (open/boundary edges) and edges shared by more than two (the topology a
// naive multi-body merge across coincident planes produces — OpenSCAD's
// Manifold backend accepts that soup, but slicers reject the STL it
// exports). Takes the raw bytes of a binary STL (Buffer or Uint8Array).
export function stlEdgeTopology(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = view.getUint32(80, true);
  const edges = new Map();
  for (let i = 0; i < triangleCount; i++) {
    const base = 84 + i * 50 + 12;
    const verts = [];
    for (let j = 0; j < 3; j++) {
      const o = base + j * 12;
      verts.push(
        `${view.getFloat32(o, true)},${view.getFloat32(o + 4, true)},${view.getFloat32(o + 8, true)}`
      );
    }
    for (let e = 0; e < 3; e++) {
      const a = verts[e];
      const b = verts[(e + 1) % 3];
      const key = a < b ? `${a}>${b}` : `${b}>${a}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  let open = 0;
  let sharedOverTwo = 0;
  for (const count of edges.values()) {
    if (count === 1) open++;
    else if (count > 2) sharedOverTwo++;
  }
  return { triangleCount, open, sharedOverTwo };
}
