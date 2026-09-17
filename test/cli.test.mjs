import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

const execFileAsync = promisify(execFile);

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test(
  'CLI regression: box415 + default gold produces a valid STL',
  { timeout: 150_000 },
  async (t) => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'gridfinity-rebase-test-'));
    t.after(() => rm(tmpDir, { recursive: true, force: true }));
    const outputPath = path.join(tmpDir, 'out.stl');

    const { stdout } = await execFileAsync(
      'node',
      [
        'dist-cli/cli.mjs',
        '-o',
        outputPath,
        'test/fixtures/box415.stl',
        'public/default-gold-refined-3.stl',
      ],
      { cwd: repoRoot, timeout: 120_000 }
    );

    assert.ok(stdout.includes(outputPath));

    const buffer = await readFile(outputPath);
    const geometry = new STLLoader().parse(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    );

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
  }
);
