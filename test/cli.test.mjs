import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

import { stlEdgeTopology } from './stl-edge-topology.mjs';

const execFileAsync = promisify(execFile);

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const runCli = (args, opts = {}) =>
  execFileAsync('node', ['dist-cli/cli.mjs', ...args], {
    cwd: repoRoot,
    timeout: 120_000,
    ...opts,
  });

const parseStl = async (filePath) => {
  const buffer = await readFile(filePath);
  return new STLLoader().parse(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  );
};

// asserts the CLI's output STL is manifold: no open edges, no edges shared
// by more than two triangles (the failure mode a naive multi-body STEP
// merge across coincident planes produces, and that slicers reject)
const assertManifoldStl = async (filePath) => {
  const buffer = await readFile(filePath);
  const { open, sharedOverTwo } = stlEdgeTopology(buffer);
  assert.equal(open, 0, `${filePath}: expected 0 open edges, got ${open}`);
  assert.equal(
    sharedOverTwo,
    0,
    `${filePath}: expected 0 edges shared by >2 triangles, got ${sharedOverTwo}`
  );
};

test(
  'CLI regression: box415 + default gold produces a valid STL',
  { timeout: 150_000 },
  async (t) => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'gridfinity-rebase-test-'));
    t.after(() => rm(tmpDir, { recursive: true, force: true }));
    const outputPath = path.join(tmpDir, 'out.stl');

    const { stdout } = await runCli([
      '-o',
      outputPath,
      'test/fixtures/box415.stl',
      'public/default-gold-refined-3.stl',
    ]);

    assert.ok(stdout.includes(outputPath));

    const buffer = await readFile(outputPath);
    // Pins byte-identical behavior of the pure-STL pipeline: raw file bytes
    // go into OpenSCAD's virtual FS unchanged, so this hash should only
    // change if the STL read/write path itself changes.
    // Re-pinned deliberately for the "use lop-and-tile for all base swaps;
    // retire the seam-prone surgical branch" fix in scad-utils.ts (same-pitch
    // swaps now go through the lop-and-tile SCAD instead of the per-foot
    // simple_cut/preferred_bottom branch, changing output bytes).
    assert.equal(
      createHash('sha256').update(buffer).digest('hex'),
      'fbbf2de72476416a49e1109e90dc39a93c8f1f77be2c91c5c721e51b65d3d312'
    );

    const geometry = await parseStl(outputPath);

    const triangleCount = geometry.attributes.position.count / 3;
    assert.ok(
      triangleCount > 100,
      `expected > 100 triangles, got ${triangleCount}`
    );

    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const size = {
      x: bb.max.x - bb.min.x,
      y: bb.max.y - bb.min.y,
      z: bb.max.z - bb.min.z,
    };
    assert.ok(
      Math.abs(size.x - 41.5) < 0.01,
      `expected x extent 41.5, got ${size.x}`
    );
    assert.ok(
      Math.abs(size.y - 41.5) < 0.01,
      `expected y extent 41.5, got ${size.y}`
    );
    assert.ok(Math.abs(size.z - 10) < 0.01, `expected z extent 10, got ${size.z}`);

    await assertManifoldStl(outputPath);
  }
);

test(
  'CLI: STEP model + STL gold produces a valid STL',
  { timeout: 150_000 },
  async (t) => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'gridfinity-rebase-test-'));
    t.after(() => rm(tmpDir, { recursive: true, force: true }));
    const outputPath = path.join(tmpDir, 'out.stl');

    const { stdout, stderr } = await runCli([
      '-v',
      '-o',
      outputPath,
      'test/fixtures/box415.step',
      'public/default-gold-refined-3.stl',
    ]);

    assert.ok(stdout.includes(outputPath));
    // confirms OpenSCAD actually produced a watertight manifold from the
    // tessellated STEP geometry, not just that some STL got written
    assert.match(stderr, /Status:\s+NoError/);

    const geometry = await parseStl(outputPath);

    const triangleCount = geometry.attributes.position.count / 3;
    assert.ok(
      triangleCount > 100,
      `expected > 100 triangles, got ${triangleCount}`
    );

    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const size = {
      x: bb.max.x - bb.min.x,
      y: bb.max.y - bb.min.y,
    };
    assert.ok(
      Math.abs(size.x - 41.5) < 0.01,
      `expected x extent 41.5, got ${size.x}`
    );
    assert.ok(
      Math.abs(size.y - 41.5) < 0.01,
      `expected y extent 41.5, got ${size.y}`
    );

    await assertManifoldStl(outputPath);
  }
);

test(
  'CLI: STL model + STEP gold produces a valid STL',
  { timeout: 150_000 },
  async (t) => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'gridfinity-rebase-test-'));
    t.after(() => rm(tmpDir, { recursive: true, force: true }));
    const outputPath = path.join(tmpDir, 'out.stl');

    const { stdout } = await runCli([
      '-o',
      outputPath,
      'test/fixtures/box415.stl',
      'test/fixtures/box415.step',
    ]);

    assert.ok(stdout.includes(outputPath));

    const geometry = await parseStl(outputPath);

    const triangleCount = geometry.attributes.position.count / 3;
    assert.ok(triangleCount > 0, `expected a parseable STL, got ${triangleCount} triangles`);

    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const size = {
      x: bb.max.x - bb.min.x,
      y: bb.max.y - bb.min.y,
    };
    assert.ok(
      Math.abs(size.x - 41.5) < 0.01,
      `expected x extent 41.5, got ${size.x}`
    );
    assert.ok(
      Math.abs(size.y - 41.5) < 0.01,
      `expected y extent 41.5, got ${size.y}`
    );

    await assertManifoldStl(outputPath);
  }
);

test(
  'CLI: STEP model + STEP gold produces a valid STL',
  { timeout: 150_000 },
  async (t) => {
    // both inputs are STEP: exercises the shared memoized OCCT session and
    // its per-call diagnostics buffer under the real Promise.all concurrency
    // in loadModels(), not just a single loadStepGeometry call at a time.
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'gridfinity-rebase-test-'));
    t.after(() => rm(tmpDir, { recursive: true, force: true }));
    const outputPath = path.join(tmpDir, 'out.stl');

    const { stdout } = await runCli([
      '-o',
      outputPath,
      'test/fixtures/box415.step',
      'test/fixtures/box415.step',
    ]);

    assert.ok(stdout.includes(outputPath));

    const geometry = await parseStl(outputPath);

    const triangleCount = geometry.attributes.position.count / 3;
    assert.ok(triangleCount > 0, `expected a parseable STL, got ${triangleCount} triangles`);

    await assertManifoldStl(outputPath);
  }
);

test(
  'CLI: default output name strips .step extension',
  { timeout: 150_000 },
  async (t) => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'gridfinity-rebase-test-'));
    t.after(() => rm(tmpDir, { recursive: true, force: true }));
    const modelPath = path.join(tmpDir, 'box415.step');
    await copyFile(path.join(repoRoot, 'test/fixtures/box415.step'), modelPath);
    const goldPath = path.join(repoRoot, 'public', 'default-gold-refined-3.stl');
    const expectedOutputPath = path.join(tmpDir, 'box415-rebased.stl');

    const { stdout } = await runCli([modelPath, goldPath]);

    assert.ok(stdout.includes(expectedOutputPath));
    const buffer = await readFile(expectedOutputPath);
    assert.ok(buffer.length > 0);

    await assertManifoldStl(expectedOutputPath);
  }
);

test('CLI: unknown extension exits 2 and names accepted formats', async (t) => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'gridfinity-rebase-test-'));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));
  const modelPath = path.join(tmpDir, 'box415.obj');
  await copyFile(path.join(repoRoot, 'test/fixtures/box415.stl'), modelPath);
  const goldPath = path.join(repoRoot, 'public', 'default-gold-refined-3.stl');

  await assert.rejects(
    runCli([modelPath, goldPath], { timeout: 30_000 }),
    (err) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr, /\.stl/i);
      assert.match(err.stderr, /\.step/i);
      assert.match(err.stderr, /\.stp/i);
      return true;
    }
  );
});

test('CLI: corrupt STEP input reports a clean error', async (t) => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'gridfinity-rebase-test-'));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));
  const modelPath = path.join(tmpDir, 'garbage.step');
  await writeFile(modelPath, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  const goldPath = path.join(repoRoot, 'public', 'default-gold-refined-3.stl');

  await assert.rejects(
    runCli([modelPath, goldPath], { timeout: 30_000 }),
    (err) => {
      assert.notEqual(err.code, 0);
      assert.match(err.stderr, /^error: /m);
      assert.doesNotMatch(err.stderr, /\bat async\b/);
      return true;
    }
  );
});
