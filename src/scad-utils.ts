import { Shape } from 'three';
import { getPitchForShape, getShapeBoundingBoxCentroid } from './hull-utils.ts';
import type { RotationType } from './hull-utils.ts';

import { v4 as uuidv4 } from 'uuid';

let scadWorker: Worker | null = null;

export const initSCADWorker = () => {
  scadWorker = new Worker(new URL('workers/scad-worker.ts', import.meta.url), {
    type: 'module',
  });
};

export const generateScadForShapes = (
  shapes: Shape[],
  zMin: number,
  rotation: {
    type: RotationType;
  },
  goldShapes: Shape[],
  goldZMin: number,
  goldRotation: {
    type: RotationType;
  },
  // wrap the result in perimeter walls up to `units` gridfinity height
  // units (7mm each) plus a standard stacking lip
  stackable?: { units: number }
) => {
  const centers = shapes.map((shape) => {
    return getShapeBoundingBoxCentroid(shape);
  });

  // 42 for full-size bases, 21 for half-size; the vertical profile (2.6 wall
  // top, 5.5 cut depth) is the same for both. the 42mm cell is the real
  // unit: half bases are just 4 feet inside one cell, so the cut always
  // works on the coarser of the two pitches
  const pitch = getPitchForShape(shapes[0]) ?? 42;
  const goldPitch = getPitchForShape(goldShapes[0]) ?? pitch;
  const cutPitch = Math.max(pitch, goldPitch);

  if (
    goldPitch !== pitch &&
    goldPitch !== 2 * pitch &&
    pitch !== 2 * goldPitch
  ) {
    throw new Error(
      `cannot fill ${pitch}mm-pitch bases with ${goldPitch}mm-pitch bases`
    );
  }

  const goldCenters = goldShapes.map(getShapeBoundingBoxCentroid);
  const hasGoldBaseAt = (x: number, y: number) =>
    goldCenters.some((c) => Math.abs(c[0] - x) < 1 && Math.abs(c[1] - y) < 1);

  // where in the gold file to sample one cutPitch-sized unit from: a single
  // base center, or the center of a 2x2 block of gold bases when the gold
  // is half the model's pitch. for mixed pitches, prefer a window ringed by
  // further bases (fully inside the gold module) so the gold's floor is
  // solid across it; a window at the gold's edge would leave the module's
  // 0.25mm wall clearance as a gap in the fill.
  let goldCenter: number[];
  if (goldPitch === pitch) {
    goldCenter = getShapeBoundingBoxCentroid(goldShapes[0]);
  } else if (pitch === 2 * goldPitch) {
    const blockCorner = (strict: boolean) =>
      goldCenters.find(
        ([x, y]) =>
          hasGoldBaseAt(x + goldPitch, y) &&
          hasGoldBaseAt(x, y + goldPitch) &&
          hasGoldBaseAt(x + goldPitch, y + goldPitch) &&
          (!strict ||
            (hasGoldBaseAt(x - goldPitch, y) &&
              hasGoldBaseAt(x, y - goldPitch) &&
              hasGoldBaseAt(x + 2 * goldPitch, y) &&
              hasGoldBaseAt(x, y + 2 * goldPitch)))
      );
    const corner = blockCorner(true) ?? blockCorner(false);
    if (!corner) {
      throw new Error(
        `the reference file has ${goldPitch}mm bases but no 2x2 block of them to fill a ${pitch}mm cell`
      );
    }
    goldCenter = [corner[0] + goldPitch / 2, corner[1] + goldPitch / 2];
  } else {
    const interior = goldCenters.find(
      ([x, y]) =>
        hasGoldBaseAt(x - goldPitch, y) &&
        hasGoldBaseAt(x + goldPitch, y) &&
        hasGoldBaseAt(x, y - goldPitch) &&
        hasGoldBaseAt(x, y + goldPitch)
    );
    goldCenter = interior ?? getShapeBoundingBoxCentroid(goldShapes[0]);
  }

  // where to put new feet. same pitch: on the model's own base centers.
  // mixed pitch: the whole underside is replaced, so tessellate the 42mm
  // grid over the model's footprint, pairing half-cells from the low
  // corner; a trailing half-cell gets an overhanging tile that the model's
  // outline trims to size.
  let tileCenters: number[][];
  if (goldPitch !== 2 * pitch) {
    tileCenters = centers;
  } else {
    const axisValues = (axis: 0 | 1) => {
      const sorted = [...new Set(centers.map((c) => Math.round(c[axis])))].sort(
        (a, b) => a - b
      );
      return sorted.filter((v, i) => i === 0 || v - sorted[i - 1] > 1);
    };
    const tileAxis = (values: number[]) =>
      Array.from(
        { length: Math.ceil(values.length / 2) },
        (_, i) => values[0] + pitch / 2 + i * cutPitch
      );
    tileCenters = tileAxis(axisValues(0)).flatMap((x) =>
      tileAxis(axisValues(1)).map((y) => [x, y])
    );
  }

  let stackShell = '';
  let stackShellCall = '';
  if (stackable) {
    // outer outline: bounding box of the base grid, with the standard
    // 0.25mm clearance per side
    const xs = centers.map((c) => c[0]);
    const ys = centers.map((c) => c[1]);
    const w = Math.max(...xs) - Math.min(...xs) + pitch - 0.5;
    const d = Math.max(...ys) - Math.min(...ys) + pitch - 0.5;
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;

    // the wall starts at the top of the bases (below that, anything at the
    // bin outline would collide with baseplate sockets) and runs to
    // units * 7mm, with a 4.4mm stacking lip on top. lip profile, bottom to
    // top: 0.7 chamfer (wall inset 2.6 -> 1.9), 1.8 vertical, 1.65 chamfer
    // (1.9 -> 0.25), 0.25 vertical rim. all chamfers 45 degrees.
    const baseHeight = 4.75;
    const zStart = zMin + baseHeight;
    const bodyH = stackable.units * 7 - baseHeight;
    const lipH = 4.4;
    // 3.75 regardless of pitch: spec-compliant half-grid keeps the
    // full-size corner radius (measured 3.8 on a reference half-grid module)
    const r0 = 3.75;
    const r = (inset: number) => Math.max(r0 - inset, 0.05);

    stackShell = `
module rrect(w, d, r) {
    offset(r = r) square([w - 2 * r, d - 2 * r], center = true);
}

module stack_shell() {
    translate([${cx}, ${cy}, ${zStart}]) difference() {
        linear_extrude(${bodyH + lipH}) rrect(${w}, ${d}, ${r0});

        // interior, up to the bottom of the lip
        translate([0, 0, -0.01])
            linear_extrude(${bodyH + 0.02})
            rrect(${w - 5.2}, ${d - 5.2}, ${r(2.6)});

        // stacking lip
        translate([0, 0, ${bodyH}]) {
            hull() {
                linear_extrude(0.01)
                    rrect(${w - 5.2}, ${d - 5.2}, ${r(2.6)});
                translate([0, 0, 0.7]) linear_extrude(0.01)
                    rrect(${w - 3.8}, ${d - 3.8}, ${r(1.9)});
            }
            translate([0, 0, 0.69]) linear_extrude(1.82)
                rrect(${w - 3.8}, ${d - 3.8}, ${r(1.9)});
            hull() {
                translate([0, 0, 2.5]) linear_extrude(0.01)
                    rrect(${w - 3.8}, ${d - 3.8}, ${r(1.9)});
                translate([0, 0, 4.15]) linear_extrude(0.01)
                    rrect(${w - 0.5}, ${d - 0.5}, ${r(0.25)});
            }
            translate([0, 0, 4.14]) linear_extrude(1.26)
                rrect(${w - 0.5}, ${d - 0.5}, ${r(0.25)});
        }
    }
}
`;
    stackShellCall = '    stack_shell();\n';
  }

  if (goldPitch === pitch) {
    // same-pitch swap: cut each base individually (42mm to 2.6, inner to
    // 5.5) and drop the gold base in. the ring between inner and the cell
    // edge above 2.6 is kept: old and new chamfers coincide there.
    const inner = cutPitch - 8;

    return `
$fs = 0.4;
$fa = 4;
${stackShell}
module simple_cut() {
    translate([-${cutPitch} / 2, -${cutPitch} / 2, 0]) cube([${cutPitch}, ${cutPitch}, 2.6]);
    translate([-${inner} / 2, -${inner} / 2, 0]) cube([${inner}, ${inner}, 5.5]);
}

module preferred_bottom() {
    intersection() {
        translate([-1 * ${goldCenter[0]},
                   -1 * ${goldCenter[1]},
                   -1 * ${goldZMin}]) {
          ${rotateSCADCodeForRotation(goldRotation.type)} {
            import("/gold.stl");
          }
        }
        simple_cut();
    }
}

union() {
    difference() {
        ${rotateSCADCodeForRotation(rotation.type)} import("/toFix.stl");

${tileCenters
  .map(
    (center) =>
      `        translate([${center[0]}, ${center[1]}, ${zMin}]) simple_cut();`
  )
  .join('\n')}
    }

${tileCenters
  .map(
    (center) =>
      `    translate([${center[0]}, ${center[1]}, ${zMin}]) preferred_bottom();`
  )
  .join('\n')}
${stackShellCall}}

`;
  }

  // mixed-pitch swap: lop the whole underside off (everything below 5.5),
  // tessellate the gold's cutPitch-sized unit across the footprint, and
  // trim the tiles to the model's silhouette (taken just above the lop
  // plane) so overhanging tiles end flush with the model's walls
  const xs = centers.map((c) => c[0]);
  const ys = centers.map((c) => c[1]);
  const lopX = Math.min(...xs) - pitch;
  const lopY = Math.min(...ys) - pitch;
  const lopW = Math.max(...xs) - Math.min(...xs) + 2 * pitch;
  const lopD = Math.max(...ys) - Math.min(...ys) + 2 * pitch;

  return `
$fs = 0.4;
$fa = 4;
${stackShell}
module gold_unit() {
    intersection() {
        translate([-1 * ${goldCenter[0]},
                   -1 * ${goldCenter[1]},
                   -1 * ${goldZMin}]) {
          ${rotateSCADCodeForRotation(goldRotation.type)} {
            import("/gold.stl");
          }
        }
        translate([-${cutPitch} / 2, -${cutPitch} / 2, 0])
            cube([${cutPitch}, ${cutPitch}, 5.5]);
    }
}

union() {
    difference() {
        ${rotateSCADCodeForRotation(rotation.type)} import("/toFix.stl");

        // top of the lop sits 0.01 below the tiles' 5.5 top, so the last
        // hair of the old floor overlaps the new one and they union into
        // one solid instead of resting coplanar
        translate([${lopX}, ${lopY}, ${zMin} - 0.01])
            cube([${lopW}, ${lopD}, 5.5]);
    }

    intersection() {
        union() {
${tileCenters
  .map(
    (center) =>
      `            translate([${center[0]}, ${center[1]}, ${zMin}]) gold_unit();`
  )
  .join('\n')}
        }
        translate([0, 0, ${zMin} - 0.01]) linear_extrude(5.52)
            projection(cut = true)
                translate([0, 0, -1 * (${zMin} + 5.75)])
                    ${rotateSCADCodeForRotation(rotation.type)} import("/toFix.stl");
    }
${stackShellCall}}

`;
};

// i thought about 'undoing' the rotation, but frankly i think it's unlikely you'll
// have magnet hole preferences and _not_ want to have a consistent rotation when printing
// (e.g. because you're dropping magnets in the print or have specific slicer settings)
const rotateSCADCodeForRotation = (type: RotationType): string => {
  switch (type) {
    case 'x+':
      return 'rotate([90, 0, 0])';
    case 'x-':
      return 'rotate([-90, 0, 0])';
    case 'y+':
      return 'rotate([0, 90, 0])';
    case 'y-':
      return 'rotate([0, -90, 0])';
    // the '180' candidate is built with makeRotationY(PI) in hull-utils, so
    // the SCAD rotation must also be about Y, not Z
    case '180':
      return 'rotate([0, 180, 0])';
    default:
      return '';
  }
};

export const runOpenSCAD = (
  scadSrc: string,
  toFixStl: ArrayBuffer,
  goldStl: ArrayBuffer
): Promise<{
  blob: Blob | null;
  errors: string[];
}> => {
  return new Promise<{
    blob: Blob | null;
    errors: string[];
  }>((resolve) => {
    try {
      if (!scadWorker) {
        throw new Error('SCAD worker not initialized');
      }

      const requestId = uuidv4();

      scadWorker.postMessage({
        scadSrc,
        toFixStl,
        goldStl,
        requestId,
      });

      // i guess this is a memory leak if aborting for another
      scadWorker.onmessage = (e) => {
        if (e.data.requestId !== requestId) {
          return;
        }

        resolve({
          blob: e.data.blob as Blob | null,
          errors: e.data.errors as string[],
        });
      };
    } catch (e) {
      resolve({
        blob: null,
        errors: [(e as Error).message],
      });
    }
  });
};
