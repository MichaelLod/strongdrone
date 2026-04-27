import * as THREE from 'three';

// Voronoi-partitioned field zones for the 400×400 m terrain. Each random seed
// owns the region nearest to it and carries a field type. The shape grid is
// what gives the satellite-image "patchwork" look.

export const enum FieldType {
  WHEAT = 0,
  PASTURE = 1,
  PLOWED = 2,
  FOREST = 3,
}

const TERRAIN_SIZE = 400;
const MAP_SIZE = 512;
const SEED_GRID = 8; // 8×8 jittered grid → 64 patches across the terrain
const SPAWN_RADIUS = 16;

// Tint colors approximated from Hungarian/W. Pannonian satellite imagery.
// FOREST is a forest-floor duff brown (dead leaves + pine needles), not the
// green of the canopy — the canopy color comes from the trees themselves.
const TINT: Record<FieldType, [number, number, number]> = {
  [FieldType.WHEAT]:   [0.83, 0.72, 0.47],
  [FieldType.PASTURE]: [0.48, 0.65, 0.32],
  [FieldType.PLOWED]:  [0.43, 0.31, 0.19],
  [FieldType.FOREST]:  [0.34, 0.26, 0.16],
};

type Seed = { x: number; z: number; type: FieldType };
const seeds: Seed[] = [];

(function generateSeeds() {
  // Seeded LCG so the layout is deterministic across reloads.
  let s = 0x9e3779b9;
  const rng = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  const cell = TERRAIN_SIZE / SEED_GRID;
  for (let j = 0; j < SEED_GRID; j++) {
    for (let i = 0; i < SEED_GRID; i++) {
      const cx = (i + 0.5) * cell - TERRAIN_SIZE / 2;
      const cz = (j + 0.5) * cell - TERRAIN_SIZE / 2;
      // 0.7×cell jitter keeps boundaries chunky without crossing neighbors
      const x = cx + (rng() - 0.5) * cell * 0.7;
      const z = cz + (rng() - 0.5) * cell * 0.7;
      const r = rng();
      let type: FieldType;
      if      (r < 0.30) type = FieldType.FOREST;
      else if (r < 0.55) type = FieldType.WHEAT;
      else if (r < 0.83) type = FieldType.PASTURE;
      else               type = FieldType.PLOWED;
      seeds.push({ x, z, type });
    }
  }
})();

export function fieldTypeAt(worldX: number, worldZ: number): FieldType {
  // Spawn area is always pasture so the drone doesn't materialise inside trees.
  if (worldX * worldX + worldZ * worldZ < SPAWN_RADIUS * SPAWN_RADIUS) {
    return FieldType.PASTURE;
  }
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < seeds.length; i++) {
    const dx = worldX - seeds[i].x;
    const dz = worldZ - seeds[i].z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  return seeds[best].type;
}

/** Bake the field tint colors into a 512² RGB texture for the terrain shader. */
export function buildFieldTexture(): THREE.DataTexture {
  const data = new Uint8Array(MAP_SIZE * MAP_SIZE * 4);
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const wx = (x / MAP_SIZE - 0.5) * TERRAIN_SIZE;
      const wz = (y / MAP_SIZE - 0.5) * TERRAIN_SIZE;
      const type = fieldTypeAt(wx, wz);
      const tint = TINT[type];
      const idx = (y * MAP_SIZE + x) * 4;
      data[idx]     = Math.round(tint[0] * 255);
      data[idx + 1] = Math.round(tint[1] * 255);
      data[idx + 2] = Math.round(tint[2] * 255);
      data[idx + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, MAP_SIZE, MAP_SIZE, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
