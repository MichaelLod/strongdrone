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
  /** When set, instances bunch around N seed points (each `radius` wide) instead
   *  of spreading uniformly. Used for grass/wildflower patches so the pasture
   *  reads as real meadow clumps rather than uniform noise. */
  clusters?: { count: number; radius: number };
  /** Vertex-shader wind sway amplitude in local source-mesh units. Top of the
   *  mesh sways by `sway × scale`; bottom doesn't move. 0 = no sway (stumps,
   *  dead wood, moss). Tall trees use ~0.06, ground cover ~0.025. */
  sway?: number;
};

// Voronoi-partitioned farmland: trees only render inside FOREST patches,
// flowers/grass only in PASTURE/WHEAT, etc. Placement scatters across the
// whole 0–95 m disc and drops instances that don't land in a matching patch,
// so the visual density of each species automatically follows the field map.
const FOREST_ONLY = [FieldType.FOREST];
const PASTURE_OR_WHEAT = [FieldType.PASTURE, FieldType.WHEAT];

// Stylized-realism pass: lean on the HDRI sky + ground fog to do the visual
// heavy lifting and keep nature placements intentionally sparse. One tree
// species at varied scales reads as a real forest at distance — ground fog
// hides the gaps. Total instance count was ~2400, now ~600.
const PLACEMENTS: PlacementSpec[] = [
  // Canopy layer (scaled-up firs) — sets the skyline silhouette.
  { slug: 'fir_sapling_medium',       count: 110, minR: 6,  maxR: 95, scaleMin: 2.6, scaleMax: 3.8, castShadow: true,  optimized: true, fields: FOREST_ONLY, sway: 0.05 },
  // Mid layer (saplings at native scale) for forest-floor depth.
  { slug: 'fir_sapling_medium',       count: 90,  minR: 4,  maxR: 95, scaleMin: 1.0, scaleMax: 1.8, optimized: true,                     fields: FOREST_ONLY, sway: 0.04 },
  { slug: 'pine_sapling_small',       count: 50,  minR: 4,  maxR: 95, scaleMin: 1.0, scaleMax: 1.8, optimized: true,                     fields: FOREST_ONLY, sway: 0.04 },

  // Occasional accents — a few stumps + standing dead wood, that's it.
  { slug: 'dead_tree_trunk',          count: 8,   minR: 6,  maxR: 95, scaleMin: 0.9, scaleMax: 1.3, fields: FOREST_ONLY },
  { slug: 'tree_stump_01',            count: 8,   minR: 4,  maxR: 95, scaleMin: 0.8, scaleMax: 1.2, fields: FOREST_ONLY },

  // Forest floor — one fern species + moss patches.
  { slug: 'fern_02',                  count: 110, minR: 4,  maxR: 95, scaleMin: 0.8, scaleMax: 1.4, fields: FOREST_ONLY, sway: 0.025 },
  { slug: 'moss_01',                  count: 50,  minR: 4,  maxR: 95, scaleMin: 0.8, scaleMax: 1.4, fields: FOREST_ONLY },

  // Pasture wildflower patches.
  { slug: 'grass_medium_02',          count: 180, minR: 8,  maxR: 95, scaleMin: 0.8, scaleMax: 1.3, fields: PASTURE_OR_WHEAT, clusters: { count: 12, radius: 2.5 }, sway: 0.03 },
  { slug: 'dandelion_01',             count: 100, minR: 8,  maxR: 95, scaleMin: 0.9, scaleMax: 1.4, fields: [FieldType.PASTURE],         clusters: { count: 8,  radius: 1.8 }, sway: 0.025 },
];

// Shared time uniform — every wind-enabled material reads from this so we can
// drive the whole forest with one assignment per frame.
const windTime = { value: 0 };

function applyWindSway(material: THREE.Material, sway: number): void {
  if (sway <= 0) return;
  if (!(material instanceof THREE.MeshStandardMaterial)) return;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = windTime;
    shader.uniforms.uSway = { value: sway };
    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      `uniform float uWindTime;
       uniform float uSway;
       void main() {`
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       float swayH = max(0.0, position.y - 0.05);
       float phase = instanceMatrix[3].x * 0.13 + instanceMatrix[3].z * 0.17;
       float wind = sin(uWindTime * 1.5 + phase) * 0.6
                  + sin(uWindTime * 0.8 + phase * 1.7) * 0.4;
       transformed.x += wind * swayH * uSway;
       transformed.z += wind * swayH * uSway * 0.4;
      `
    );
  };
  material.needsUpdate = true;
}

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
          if (spec.sway) {
            const m = im.material as THREE.Material | THREE.Material[];
            if (Array.isArray(m)) m.forEach((mm) => applyWindSway(mm, spec.sway!));
            else applyWindSway(m, spec.sway);
          }
          scene.add(im);
          instancedMeshes.push(im);
        }
      },
      undefined,
      (err) => console.warn(`[nature] failed ${url}`, err)
    );
  }

  return {
    update(t: number) {
      windTime.value = t;
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

  // Pre-roll cluster centres in a valid field so each instance can pick one
  // and sample a small offset, producing visible patches.
  const clusterCenters: [number, number][] = [];
  if (spec.clusters) {
    let safety = 0;
    while (clusterCenters.length < spec.clusters.count && safety++ < spec.clusters.count * 40) {
      const angle = Math.random() * Math.PI * 2;
      const r = spec.minR + Math.pow(Math.random(), 0.6) * (spec.maxR - spec.minR);
      const cx = Math.cos(angle) * r;
      const cz = Math.sin(angle) * r;
      if (!spec.fields || spec.fields.includes(fieldTypeAt(cx, cz))) {
        clusterCenters.push([cx, cz]);
      }
    }
  }

  const dummy = new THREE.Object3D();
  let placed = 0;
  for (let i = 0; i < spec.count; i++) {
    let x = 0, z = 0;
    let ok = false;
    // Reject-sample until we land in an allowed field. Up to 30 attempts so a
    // species with very few matching patches doesn't infinite-loop.
    for (let attempt = 0; attempt < 30; attempt++) {
      if (clusterCenters.length > 0 && spec.clusters) {
        const [cx, cz] = clusterCenters[(Math.random() * clusterCenters.length) | 0];
        const r = Math.sqrt(Math.random()) * spec.clusters.radius;
        const a = Math.random() * Math.PI * 2;
        x = cx + Math.cos(a) * r;
        z = cz + Math.sin(a) * r;
      } else {
        const angle = Math.random() * Math.PI * 2;
        const r = spec.minR + Math.pow(Math.random(), 0.6) * (spec.maxR - spec.minR);
        x = Math.cos(angle) * r;
        z = Math.sin(angle) * r;
      }
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
