import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { fieldTypeAt, FieldType } from './fields';

export type NatureRefs = {
  update(elapsedSeconds: number): void;
  dispose(): void;
};

type PlacementSpec = {
  slug: string;
  count: number;
  minR: number;
  maxR: number;
  scaleMin: number;
  scaleMax: number;
  yJitter?: number;
  /** Default false: photoscanned plant geometry is dense (100k–1.5M tris each)
   *  and casting shadows for hundreds of instances dominates the frame. */
  castShadow?: boolean;
  /** When true, load `<slug>_1k.glb` instead of `<slug>_1k.gltf`. Decimated
   *  assets ship as meshopt-compressed glb (10x smaller, 10x fewer tris). */
  optimized?: boolean;
  /** Restrict instances to these field types. Placement retries up to 30 times
   *  to find a valid spot; instances that can't be placed are dropped. */
  fields?: FieldType[];
};

// Voronoi-partitioned farmland: trees only render inside FOREST patches,
// flowers/grass only in PASTURE/WHEAT, etc. Placement scatters across the
// whole 0–95 m disc and drops instances that don't land in a matching patch,
// so the visual density of each species automatically follows the field map.
const FOREST_ONLY = [FieldType.FOREST];
const PASTURE_OR_WHEAT = [FieldType.PASTURE, FieldType.WHEAT];

const PLACEMENTS: PlacementSpec[] = [
  // Trees fill the FOREST patches.
  { slug: 'fir_sapling_medium',       count: 220, minR: 4,  maxR: 95, scaleMin: 1.1, scaleMax: 1.9, castShadow: true, optimized: true, fields: FOREST_ONLY },
  { slug: 'fir_sapling',              count: 180, minR: 4,  maxR: 95, scaleMin: 0.9, scaleMax: 1.6, optimized: true, fields: FOREST_ONLY },
  { slug: 'pine_sapling_small',       count: 100, minR: 4,  maxR: 95, scaleMin: 1.0, scaleMax: 1.8, optimized: true, fields: FOREST_ONLY },

  // Forest understory.
  { slug: 'fern_02',                  count: 220, minR: 4,  maxR: 95, scaleMin: 0.8, scaleMax: 1.4, fields: FOREST_ONLY },
  { slug: 'shrub_01',                 count: 90,  minR: 4,  maxR: 95, scaleMin: 0.6, scaleMax: 1.2, fields: FOREST_ONLY },
  { slug: 'shrub_03',                 count: 70,  minR: 4,  maxR: 95, scaleMin: 0.7, scaleMax: 1.3, fields: FOREST_ONLY },
  { slug: 'tree_stump_01',            count: 14,  minR: 4,  maxR: 95, scaleMin: 0.8, scaleMax: 1.3, fields: FOREST_ONLY },
  { slug: 'dry_branches_medium_01',   count: 40,  minR: 4,  maxR: 95, scaleMin: 0.7, scaleMax: 1.2, fields: FOREST_ONLY },
  { slug: 'bark_debris_01',           count: 60,  minR: 4,  maxR: 95, scaleMin: 0.7, scaleMax: 1.3, fields: FOREST_ONLY },

  // Grass tufts and flowers fill the open field patches (pasture + wheat).
  { slug: 'grass_bermuda_01',         count: 600, minR: 2,  maxR: 95, scaleMin: 0.8, scaleMax: 1.3, fields: PASTURE_OR_WHEAT },
  { slug: 'grass_medium_01',          count: 220, minR: 3,  maxR: 95, scaleMin: 0.8, scaleMax: 1.2, fields: PASTURE_OR_WHEAT },
  { slug: 'grass_medium_02',          count: 220, minR: 3,  maxR: 95, scaleMin: 0.8, scaleMax: 1.3, fields: PASTURE_OR_WHEAT },
  { slug: 'dandelion_01',             count: 220, minR: 3,  maxR: 95, scaleMin: 0.9, scaleMax: 1.4, fields: [FieldType.PASTURE] },
  { slug: 'celandine_01',             count: 160, minR: 3,  maxR: 95, scaleMin: 0.9, scaleMax: 1.3, fields: [FieldType.PASTURE] },
];

export function buildNature(scene: THREE.Scene): NatureRefs {
  const loader = new GLTFLoader();
  // Required for assets shipped with EXT_meshopt_compression (our decimated trees).
  loader.setMeshoptDecoder(MeshoptDecoder);
  const instancedMeshes: THREE.InstancedMesh[] = [];

  for (const spec of PLACEMENTS) {
    const ext = spec.optimized ? 'glb' : 'gltf';
    const url = `/assets/nature/${spec.slug}/${spec.slug}_1k.${ext}`;
    loader.load(
      url,
      (gltf) => {
        const sourceMeshes: THREE.Mesh[] = [];
        gltf.scene.traverse((obj) => {
          if (obj instanceof THREE.Mesh) sourceMeshes.push(obj);
        });
        if (sourceMeshes.length === 0) {
          console.warn(`[nature] no mesh in ${url}`);
          return;
        }
        for (const mesh of sourceMeshes) {
          const im = makeInstanced(mesh, spec);
          scene.add(im);
          instancedMeshes.push(im);
        }
      },
      undefined,
      (err) => console.warn(`[nature] failed ${url}`, err)
    );
  }

  return {
    update(_t: number) {
      // Wind animation reserved for a follow-up — PolyHaven materials are
      // standard PBR so vertex sway needs onBeforeCompile injection per mat.
    },
    dispose() {
      for (const im of instancedMeshes) {
        scene.remove(im);
        im.geometry.dispose();
        const mat = im.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    },
  };
}

function makeInstanced(source: THREE.Mesh, spec: PlacementSpec): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(source.geometry, source.material, spec.count);
  im.castShadow = spec.castShadow ?? false;
  im.receiveShadow = true;
  // PolyHaven plant geometry is centred at the trunk base, so identity Y
  // already sits flush on the terrain. Per-instance translation handled below.

  const dummy = new THREE.Object3D();
  let placed = 0;
  for (let i = 0; i < spec.count; i++) {
    let x = 0, z = 0;
    let ok = false;
    // Reject-sample until we land in an allowed field. Up to 30 attempts so a
    // species with very few matching patches doesn't infinite-loop.
    for (let attempt = 0; attempt < 30; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const r = spec.minR + Math.pow(Math.random(), 0.6) * (spec.maxR - spec.minR);
      x = Math.cos(angle) * r;
      z = Math.sin(angle) * r;
      if (!spec.fields || spec.fields.includes(fieldTypeAt(x, z))) {
        ok = true;
        break;
      }
    }
    if (!ok) continue;

    const yJ = spec.yJitter ? (Math.random() - 0.5) * spec.yJitter : 0;
    const scale = spec.scaleMin + Math.random() * (spec.scaleMax - spec.scaleMin);
    dummy.position.set(x, yJ, z);
    dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    im.setMatrixAt(placed++, dummy.matrix);
  }
  // Hide unused instance slots by zero-scaling them past the placed count.
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = placed; i < spec.count; i++) im.setMatrixAt(i, zero);
  im.instanceMatrix.needsUpdate = true;
  return im;
}
