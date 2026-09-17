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
  meshes?: OcctMesh[];
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

interface OcctSession {
  occt: OcctModule;
  // recent print/printErr lines, cleared before each ReadStepFile call, so a
  // failure can report why instead of a contentless error
  diagnostics: string[];
}

let sessionPromise: Promise<OcctSession> | null = null;

const getOcctSession = (): Promise<OcctSession> => {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const wasmBinary = (await readFile(resolveOcctWasmPath())).buffer;
      const diagnostics: string[] = [];
      const capture = (line: string) => {
        diagnostics.push(line);
      };
      const occt: OcctModule = await occtimportjs({
        wasmBinary,
        print: capture,
        printErr: capture,
      });
      return { occt, diagnostics };
    })();
  }
  return sessionPromise;
};

// De-indexes a single occt mesh into a flat position array (vertex triples,
// no index buffer) — the layout base detection and STL export both expect.
function deindexMesh(mesh: OcctMesh): Float32Array {
  const meshPositions = mesh.attributes.position.array;
  const positions = new Float32Array(mesh.index.array.length * 3);
  let offset = 0;
  for (const vertexIndex of mesh.index.array) {
    positions[offset++] = meshPositions[vertexIndex * 3];
    positions[offset++] = meshPositions[vertexIndex * 3 + 1];
    positions[offset++] = meshPositions[vertexIndex * 3 + 2];
  }
  return positions;
}

export async function loadStep(
  data: Uint8Array
): Promise<{ geometry: BufferGeometry; bodyStls: Uint8Array[] }> {
  const { occt, diagnostics } = await getOcctSession();
  diagnostics.length = 0;
  const result = occt.ReadStepFile(data, OCCT_PARAMS);
  if (!result.success) {
    throw new Error(
      `failed to parse STEP file: ${diagnostics.join('\n') || '(no diagnostics)'}`
    );
  }
  if (!result.meshes?.length) {
    throw new Error('STEP file contains no solid bodies');
  }
  const meshes = result.meshes;

  const bodyPositions = meshes.map(deindexMesh);

  const vertexCount = bodyPositions.reduce((sum, p) => sum + p.length, 0);
  const positions = new Float32Array(vertexCount);
  let offset = 0;
  for (const p of bodyPositions) {
    positions.set(p, offset);
    offset += p.length;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));

  const bodyStls = bodyPositions.map((p) => {
    const bodyGeometry = new BufferGeometry();
    bodyGeometry.setAttribute('position', new BufferAttribute(p, 3));
    return geometryToBinaryStl(bodyGeometry);
  });

  return { geometry, bodyStls };
}

export async function loadStepGeometry(
  data: Uint8Array
): Promise<BufferGeometry> {
  return (await loadStep(data)).geometry;
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
