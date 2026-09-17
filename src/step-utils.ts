// STEP file loading for the CLI. Not part of the web app: importing
// occt-import-js here would pull its WASM into the vite bundle.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import { BufferAttribute, BufferGeometry, Mesh } from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
// @ts-expect-error no declarations
import occtimportjs from 'occt-import-js';

const OCCT_PARAMS = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'absolute_value',
  linearDeflection: 0.01,
  angularDeflection: 0.2,
};

interface OcctMesh {
  attributes: { position: { array: number[] } };
  index: { array: number[] };
}

interface OcctReadStepResult {
  success: boolean;
  meshes: OcctMesh[];
}

interface OcctModule {
  ReadStepFile(
    data: Uint8Array,
    params: typeof OCCT_PARAMS
  ): OcctReadStepResult;
}

// next to the bundle (dist-cli/, once build:cli copies it there), or under
// node_modules when run unbundled (src/) or from a bundled test (dist-test/)
const resolveOcctWasmPath = (): string => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const wasmPath = [
    path.join(moduleDir, 'occt-import-js.wasm'),
    path.join(
      moduleDir,
      '..',
      'node_modules',
      'occt-import-js',
      'dist',
      'occt-import-js.wasm'
    ),
  ].find((p) => existsSync(p));
  if (!wasmPath) {
    throw new Error(`occt-import-js.wasm not found next to ${moduleDir}`);
  }
  return wasmPath;
};

let occtPromise: Promise<OcctModule> | null = null;

const getOcct = (): Promise<OcctModule> => {
  if (!occtPromise) {
    occtPromise = (async () => {
      const wasmBinary = (await readFile(resolveOcctWasmPath())).buffer;
      return occtimportjs({ wasmBinary });
    })();
  }
  return occtPromise;
};

export async function loadStepGeometry(
  data: Uint8Array
): Promise<BufferGeometry> {
  const occt = await getOcct();
  const result = occt.ReadStepFile(data, OCCT_PARAMS);
  if (!result.success || result.meshes.length === 0) {
    throw new Error('failed to parse STEP file');
  }

  const vertexCount = result.meshes.reduce(
    (sum, mesh) => sum + mesh.index.array.length,
    0
  );
  const positions = new Float32Array(vertexCount * 3);
  let offset = 0;
  for (const mesh of result.meshes) {
    const meshPositions = mesh.attributes.position.array;
    for (const vertexIndex of mesh.index.array) {
      positions[offset++] = meshPositions[vertexIndex * 3];
      positions[offset++] = meshPositions[vertexIndex * 3 + 1];
      positions[offset++] = meshPositions[vertexIndex * 3 + 2];
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  return geometry;
}

export function geometryToBinaryStl(geometry: BufferGeometry): Uint8Array {
  const mesh = new Mesh(geometry);
  const dataView = new STLExporter().parse(mesh, { binary: true });
  return new Uint8Array(
    dataView.buffer,
    dataView.byteOffset,
    dataView.byteLength
  );
}
