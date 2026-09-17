import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { BufferGeometry } from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
// @ts-expect-error no declarations
import occtimportjs from 'occt-import-js';

import { loadStepGeometry, geometryToBinaryStl } from '../src/step-utils.ts';

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
  const data = new Uint8Array(await readFile('test/fixtures/box415.step'));
  const geometry = await loadStepGeometry(data);

  assert.equal(geometry.getIndex(), null);
  assert.equal(geometry.attributes.position.count, 36);

  const size = boundingBoxSize(geometry);
  assert.ok(Math.abs(size.x - 41.5) < 0.01, `x extent ${size.x}`);
  assert.ok(Math.abs(size.y - 41.5) < 0.01, `y extent ${size.y}`);
  assert.ok(Math.abs(size.z - 41.5) < 0.01, `z extent ${size.z}`);
});

test('loadStepGeometry: multi-body STEP merges every body', async () => {
  const stepPath =
    'node_modules/occt-import-js/test/testfiles/cax-if/dm1-id-214.stp';
  const data = new Uint8Array(await readFile(stepPath));

  // Compute the expected vertex count independently of loadStepGeometry, by
  // calling ReadStepFile directly with the same params.
  const wasmBinary = (
    await readFile('node_modules/occt-import-js/dist/occt-import-js.wasm')
  ).buffer;
  const occt = await occtimportjs({ wasmBinary });
  const reference = occt.ReadStepFile(data, OCCT_PARAMS);
  assert.ok(reference.success);
  assert.equal(reference.meshes.length, 7, 'fixture should have 7 bodies');
  const expectedVertexCount = reference.meshes.reduce(
    (sum: number, mesh: { index: { array: number[] } }) =>
      sum + mesh.index.array.length,
    0
  );

  const geometry = await loadStepGeometry(data);
  assert.equal(geometry.getIndex(), null);
  assert.equal(geometry.attributes.position.count, expectedVertexCount);
});

test('loadStepGeometry: garbage bytes reject', async () => {
  const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  await assert.rejects(() => loadStepGeometry(data));
});

test('geometryToBinaryStl: roundtrips through STLLoader', async () => {
  const data = new Uint8Array(await readFile('test/fixtures/box415.step'));
  const geometry = await loadStepGeometry(data);
  const stlBytes = geometryToBinaryStl(geometry);

  const parsed = new STLLoader().parse(
    stlBytes.buffer.slice(
      stlBytes.byteOffset,
      stlBytes.byteOffset + stlBytes.byteLength
    )
  );

  assert.equal(
    parsed.attributes.position.count,
    geometry.attributes.position.count
  );

  const originalSize = boundingBoxSize(geometry);
  const parsedSize = boundingBoxSize(parsed);
  assert.ok(Math.abs(originalSize.x - parsedSize.x) < 0.01);
  assert.ok(Math.abs(originalSize.y - parsedSize.y) < 0.01);
  assert.ok(Math.abs(originalSize.z - parsedSize.z) < 0.01);
});
