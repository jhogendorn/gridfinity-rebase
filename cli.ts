#!/usr/bin/env node
// CLI for gridfinity-rebase: replace the gridfinity base(s) of an STL with
// the base from a reference ("gold") STL. Same pipeline as the web app.

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

import {
  getBestShapeHullsForGeometry,
  getPitchForShape,
  getZMinForGeometry,
} from './src/hull-utils.ts';
import { generateScadForShapes } from './src/scad-utils.ts';
import { loadStep } from './src/step-utils.ts';

// @ts-expect-error no declaration
import OpenSCAD from './src/openscad.js';

const usage = `gridfinity-rebase — swap the gridfinity base(s) of a model (STL or STEP)
for the base of a reference file (STL or STEP), and optionally wrap it in
stackable walls. Output is always written as STL.

Usage:
  gridfinity-rebase [options] <model> <reference>

Arguments:
  model            the model whose bases you want replaced (STL or STEP)
  reference        any gridfinity module whose base you want to copy
                   (STL or STEP; both 42mm full-size and 21mm half-size
                   bases work, but the two files must use the same size)

Options:
  -o, --output <file>       output path (default: <model>-rebased.stl)
  -s, --stackable <units>   wrap the model in perimeter walls up to
                            <units> gridfinity height units (7mm each),
                            topped with a standard stacking lip
      --no-rotate-input     don't try rotations of the model file
      --no-rotate-gold      don't try rotations of the reference file
      --scad <file>         also write the generated OpenSCAD source
      --ascii               write ASCII STL instead of binary
  -v, --verbose             print detection details
  -V, --version             print version
  -h, --help                show this help

Examples:
  gridfinity-rebase bin.stl nice-base.stl
  gridfinity-rebase -s 4 -o bin-stackable.stl bin.stl nice-base.stl
`;

const parseArgsOptions = {
  output: { type: 'string', short: 'o' },
  stackable: { type: 'string', short: 's' },
  'no-rotate-input': { type: 'boolean', default: false },
  'no-rotate-gold': { type: 'boolean', default: false },
  scad: { type: 'string' },
  ascii: { type: 'boolean', default: false },
  verbose: { type: 'boolean', short: 'v', default: false },
  version: { type: 'boolean', short: 'V', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

let parsed: ReturnType<
  typeof parseArgs<{ options: typeof parseArgsOptions; allowPositionals: true }>
>;
try {
  parsed = parseArgs({
    options: parseArgsOptions,
    allowPositionals: true,
  });
} catch (e) {
  console.error(`error: ${(e as Error).message}\n`);
  process.stderr.write(usage);
  process.exit(2);
}
const { values: opts, positionals } = parsed;

if (opts.help) {
  process.stdout.write(usage);
  process.exit(0);
}

if (opts.version) {
  // ./ when running cli.ts from the repo root, ../ from the dist-cli bundle
  for (const rel of ['./package.json', '../package.json']) {
    try {
      const pkg = JSON.parse(
        await readFile(new URL(rel, import.meta.url), 'utf8')
      );
      console.log(pkg.version);
      process.exit(0);
    } catch {
      // try the next location
    }
  }
  console.error('error: package.json not found');
  process.exit(1);
}

if (positionals.length !== 2) {
  console.error(
    `error: expected exactly 2 arguments (a model file and a reference file, STL or STEP), got ${positionals.length}\n`
  );
  process.stderr.write(usage);
  process.exit(2);
}

const readInputFile = async (filePath: string) => {
  try {
    return await readFile(filePath);
  } catch (e) {
    console.error(
      `error: cannot read ${filePath}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (e as Error).message}`
    );
    return process.exit(1);
  }
};

const [toFixPath, goldPath] = positionals;
const outputPath =
  opts.output ?? toFixPath.replace(/(\.stl|\.step|\.stp)?$/i, '-rebased.stl');

const log = (msg: string) => {
  if (opts.verbose) console.error(msg);
};

// next to the bundle in dist-cli, or under src/ when run from the repo root
const createOpenScadInstance = async () => {
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const wasmPath = [
    path.join(cliDir, 'openscad.wasm'),
    path.join(cliDir, 'src', 'openscad.wasm'),
  ].find((p) => existsSync(p));
  if (!wasmPath) {
    console.error(`error: openscad.wasm not found next to ${cliDir}`);
    process.exit(1);
  }

  const errorStatements: string[] = [];
  const instance = await OpenSCAD({
    noInitialRun: true,
    wasmBinary: (await readFile(wasmPath)).buffer,
    print: (s: string) => log(`openscad: ${s}`),
    printErr: (s: string) => {
      errorStatements.push(s);
      log(`openscad: ${s}`);
    },
  });
  return { instance, errorStatements };
};

// Multiple bodies from one STEP file tessellate independently, so bodies
// that touch at an exact plane (e.g. z=0) end up with two mismatched
// triangulations on the same coincident surface once merged into one
// polygon soup. OpenSCAD's Manifold backend accepts that soup, but the
// exported STL is non-manifold (edges shared by more than two triangles)
// and slicers reject it. Unioning each body as its own separate manifold
// solid first produces a clean result.
const preUnionBodyStls = async (
  filePath: string,
  bodyStls: Uint8Array[]
): Promise<Uint8Array> => {
  const { instance, errorStatements } = await createOpenScadInstance();
  bodyStls.forEach((stl, i) => instance.FS.writeFile(`/body-${i}.stl`, stl));
  const scadSrc = `union() {\n${bodyStls
    .map((_, i) => `  import("/body-${i}.stl");`)
    .join('\n')}\n}\n`;
  instance.FS.writeFile('/u.scad', scadSrc);

  try {
    instance.callMain([
      '/u.scad',
      '--backend=manifold',
      '--export-format=binstl',
      '-o',
      '/u.stl',
    ]);
  } catch {
    throw new Error(
      `OpenSCAD failed to union the ${bodyStls.length} bodies in ${filePath}:\n${errorStatements.join('\n')}`
    );
  }

  const realErrors = errorStatements.filter((e) => e.includes('ERROR:'));
  if (realErrors.length > 0) {
    throw new Error(
      `OpenSCAD reported errors unioning the ${bodyStls.length} bodies in ${filePath}:\n${realErrors.join('\n')}`
    );
  }

  return instance.FS.readFile('/u.stl');
};

const loadModel = async (filePath: string) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.stl' && ext !== '.step' && ext !== '.stp') {
    console.error(
      ext === ''
        ? `error: no file extension on ${filePath}: accepted formats are .stl, .step, .stp`
        : `error: unsupported file extension '${ext}' for ${filePath}: accepted formats are .stl, .step, .stp`
    );
    return process.exit(2);
  }

  const buffer = await readInputFile(filePath);
  if (ext === '.stl') {
    const geometry = new STLLoader().parse(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    );
    return { geometry, stlBytes: buffer };
  }
  const { geometry, bodyStls } = await loadStep(buffer);
  const stlBytes =
    bodyStls.length === 1
      ? bodyStls[0]
      : await preUnionBodyStls(filePath, bodyStls);
  return { geometry, stlBytes };
};

const loadModels = async () => {
  try {
    return await Promise.all([loadModel(toFixPath), loadModel(goldPath)]);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return process.exit(1);
  }
};
const [toFix, gold] = await loadModels();
const toFixGeometry = toFix.geometry;
const goldGeometry = gold.geometry;

const { shapes, rotation, badness } = getBestShapeHullsForGeometry(
  toFixGeometry,
  opts['no-rotate-input']
);
log(
  `input: ${shapes.length} base(s) detected, rotation=${rotation.type}, bad hulls=${badness}`
);

const {
  shapes: goldShapes,
  rotation: goldRotation,
  badness: goldBadness,
} = getBestShapeHullsForGeometry(goldGeometry, opts['no-rotate-gold']);
log(
  `gold: ${goldShapes.length} base(s) detected, rotation=${goldRotation.type}, bad hulls=${goldBadness}`
);

if (shapes.length === 0) {
  console.error('error: no bases detected in input file');
  process.exit(1);
}
if (goldShapes.length === 0) {
  console.error('error: no base detected in gold file');
  process.exit(1);
}
if (goldShapes.length > 1) {
  log(`gold: using the first of ${goldShapes.length} bases`);
}

const inputPitch = getPitchForShape(shapes[0]);
const goldPitch = getPitchForShape(goldShapes[0]);
log(`input pitch: ${inputPitch}mm, gold pitch: ${goldPitch}mm`);
if (inputPitch !== null && goldPitch !== null && goldPitch !== inputPitch) {
  log(
    goldPitch < inputPitch
      ? `filling each ${inputPitch}mm base with a 2x2 block of ${goldPitch}mm bases`
      : `replacing 2x2 blocks of ${inputPitch}mm feet with single ${goldPitch}mm bases`
  );
}

let stackable: { units: number } | undefined;
if (opts.stackable !== undefined) {
  const units = Number(opts.stackable);
  if (!Number.isInteger(units) || units < 1) {
    console.error('error: --stackable takes a positive whole number of units');
    process.exit(2);
  }

  rotation.geometry.computeBoundingBox();
  const modelHeight =
    rotation.geometry.boundingBox!.max.z - rotation.geometry.boundingBox!.min.z;
  if (units * 7 < modelHeight) {
    console.error(
      `warning: model is ${modelHeight.toFixed(1)}mm tall but --stackable ${units} walls end at ${units * 7}mm; the model will poke through the stacking lip`
    );
  }

  stackable = { units };
}

let scadSrc: string;
try {
  scadSrc = generateScadForShapes(
    shapes,
    getZMinForGeometry(rotation.geometry),
    rotation,
    goldShapes,
    getZMinForGeometry(goldRotation.geometry),
    goldRotation,
    stackable
  );
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}

if (opts.scad) {
  await writeFile(opts.scad, scadSrc);
  log(`wrote ${opts.scad}`);
}

const { instance, errorStatements } = await createOpenScadInstance();

instance.FS.writeFile('/input.scad', scadSrc);
instance.FS.writeFile('/gold.stl', gold.stlBytes);
instance.FS.writeFile('/toFix.stl', toFix.stlBytes);

let output: Uint8Array;
try {
  instance.callMain([
    '/input.scad',
    '--backend=manifold',
    ...(opts.ascii ? [] : ['--export-format=binstl']),
    '-o',
    '/fixed.stl',
  ]);
  output = instance.FS.readFile('/fixed.stl');
} catch (e) {
  console.error('error: OpenSCAD failed');
  for (const line of errorStatements) console.error(`  ${line}`);
  process.exit(1);
}

const realErrors = errorStatements.filter((e) => e.includes('ERROR:'));
if (realErrors.length > 0) {
  console.error('error: OpenSCAD reported errors');
  for (const line of realErrors) console.error(`  ${line}`);
  process.exit(1);
}

await writeFile(outputPath, output);
console.log(outputPath);
