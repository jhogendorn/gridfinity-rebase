import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BufferGeometry } from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
// @ts-expect-error no declarations
import occtimportjs from 'occt-import-js';

import { loadStepGeometry, geometryToBinaryStl } from '../src/step-utils.ts';

// this file is bundled to dist-test/step-utils.test.mjs before running, so
// paths must be computed from import.meta.url rather than assumed cwd
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixturePath = (...segments: string[]) => path.join(repoRoot, ...segments);

const OCCT_PARAMS = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'absolute_value',
  linearDeflection: 0.01,
  angularDeflection: 0.2,
};

const boundingBoxSize = (geometry: BufferGeometry) => {
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox!;
  return {
    x: bb.max.x - bb.min.x,
    y: bb.max.y - bb.min.y,
    z: bb.max.z - bb.min.z,
  };
};

test('loadStepGeometry: box415.step is a non-indexed 41.5mm cube', async () => {
  const data = new Uint8Array(
    await readFile(fixturePath('test/fixtures/box415.step'))
  );
  const geometry = await loadStepGeometry(data);

  assert.equal(geometry.getIndex(), null);
  assert.equal(geometry.attributes.position.count, 36);

  const size = boundingBoxSize(geometry);
  assert.ok(Math.abs(size.x - 41.5) < 0.01, `x extent ${size.x}`);
  assert.ok(Math.abs(size.y - 41.5) < 0.01, `y extent ${size.y}`);
  assert.ok(Math.abs(size.z - 41.5) < 0.01, `z extent ${size.z}`);
});

test('loadStepGeometry: multi-body STEP merges every body', async () => {
  const stepPath = fixturePath(
    'node_modules/occt-import-js/test/testfiles/cax-if/dm1-id-214.stp'
  );
  const data = new Uint8Array(await readFile(stepPath));

  // Compute the expected de-indexed positions independently of
  // loadStepGeometry, by calling ReadStepFile directly with the same params
  // and expanding indices the same way — this catches a merge that drops a
  // body, or that reads indices against the wrong mesh's position array,
  // neither of which a plain vertex-count check would catch.
  const wasmBinary = (
    await readFile(
      fixturePath('node_modules/occt-import-js/dist/occt-import-js.wasm')
    )
  ).buffer;
  const occt = await occtimportjs({ wasmBinary });
  const reference = occt.ReadStepFile(data, OCCT_PARAMS);
  assert.ok(reference.success);
  assert.equal(reference.meshes.length, 7, 'fixture should have 7 bodies');

  type ReferenceMesh = {
    attributes: { position: { array: number[] } };
    index: { array: number[] };
  };
  const referenceMeshes = reference.meshes as ReferenceMesh[];
  const expectedVertexCount = referenceMeshes.reduce(
    (sum, mesh) => sum + mesh.index.array.length,
    0
  );
  const expectedPositions = new Float32Array(expectedVertexCount * 3);
  let offset = 0;
  for (const mesh of referenceMeshes) {
    const meshPositions = mesh.attributes.position.array;
    for (const vertexIndex of mesh.index.array) {
      expectedPositions[offset++] = meshPositions[vertexIndex * 3];
      expectedPositions[offset++] = meshPositions[vertexIndex * 3 + 1];
      expectedPositions[offset++] = meshPositions[vertexIndex * 3 + 2];
    }
  }

  const geometry = await loadStepGeometry(data);
  assert.equal(geometry.getIndex(), null);

  const actualPositions = geometry.attributes.position.array as Float32Array;
  assert.deepStrictEqual(actualPositions, expectedPositions);
  assert.ok(
    Array.from(actualPositions).every((v) => !Number.isNaN(v)),
    'merged positions must not contain NaN'
  );
});

test('loadStepGeometry: garbage bytes reject', async () => {
  const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  await assert.rejects(() => loadStepGeometry(data), /failed to parse STEP file:/);
});

test('geometryToBinaryStl: roundtrips through STLLoader', async () => {
  const data = new Uint8Array(
    await readFile(fixturePath('test/fixtures/box415.step'))
  );
  const geometry = await loadStepGeometry(data);
  const stlBytes = geometryToBinaryStl(geometry);

  const parsed = new STLLoader().parse(
    stlBytes.buffer.slice(
      stlBytes.byteOffset,
      stlBytes.byteOffset + stlBytes.byteLength
    )
  );

  // binary STL stores float32 vertices, same as the source geometry, so the
  // roundtrip is bitwise-exact — no tolerance needed, and exact equality
  // also catches axis permutations the cubic fixture's bounding box hides
  assert.deepStrictEqual(
    parsed.attributes.position.array,
    geometry.attributes.position.array
  );
});
