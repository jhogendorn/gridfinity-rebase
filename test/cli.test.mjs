import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

const execFileAsync = promisify(execFile);

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('CLI regression: box415 + default gold produces a valid STL', async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'gridfinity-rebase-test-'));
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

  const stats = await stat(outputPath);
  assert.ok(stats.isFile());

  const buffer = await readFile(outputPath);
  const geometry = new STLLoader().parse(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  );

  const triangleCount = geometry.attributes.position.count / 3;
  assert.ok(triangleCount > 0, `expected > 0 triangles, got ${triangleCount}`);
});
