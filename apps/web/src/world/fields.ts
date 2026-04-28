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

// All field types now share the same pasture tint — the ground reads as one
// continuous meadow. The Voronoi system still routes tree placement (FOREST
// patches concentrate trees) but no longer paints the terrain. Per-pixel
// noise drift in buildFieldTexture() gives the only colour variation.
const PASTURE_TINT: [number, number, number] = [0.50, 0.62, 0.34];
const TINT: Record<FieldType, [number, number, number]> = {
  [FieldType.PASTURE]: PASTURE_TINT,
  [FieldType.FOREST]:  PASTURE_TINT,
  [FieldType.WHEAT]:   PASTURE_TINT,
  [FieldType.PLOWED]:  PASTURE_TINT,
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
      // Binary forest mask. Open ground is uniformly pasture so we don't get
      // painted-on field stripes; the visual interest comes from forest
      // patches breaking up the meadow + the HDRI sky doing colour work.
      const r = rng();
      const type: FieldType = r < 0.30 ? FieldType.FOREST : FieldType.PASTURE;
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

/** Bake the field tint colors into a 512² RGB texture for the terrain shader.
 *  Adds slow FBM variation on top of the type tint so even within a single
 *  pasture patch the colour drifts ±3 %, breaking up flat-uniform regions. */
export function buildFieldTexture(): THREE.DataTexture {
  const data = new Uint8Array(MAP_SIZE * MAP_SIZE * 4);
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const wx = (x / MAP_SIZE - 0.5) * TERRAIN_SIZE;
      const wz = (y / MAP_SIZE - 0.5) * TERRAIN_SIZE;
      const type = fieldTypeAt(wx, wz);
      const tint = TINT[type];
      // Two octaves of value noise, blended → smooth organic drift.
      const n = 0.6 * vnoise(wx * 0.040, wz * 0.040)
              + 0.4 * vnoise(wx * 0.115, wz * 0.115);
      const drift = (n - 0.5) * 0.10;
      const idx = (y * MAP_SIZE + x) * 4;
      data[idx]     = clamp255((tint[0] + drift) * 255);
      data[idx + 1] = clamp255((tint[1] + drift * 0.85) * 255);
      data[idx + 2] = clamp255((tint[2] + drift * 0.55) * 255);
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

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function vnoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash2(ix,     iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix,     iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function hash2(x: number, y: number): number {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 0xffffffff;
}
