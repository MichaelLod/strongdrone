import * as THREE from 'three';
import { buildDroneMesh } from './drone';

// Red-accent variant of the player drone. Reuses the same geometry so the
// silhouette reads as "another drone" — only the emissive accents and their
// dim diffuse pair flip from cyan/amber to hostile red, which keeps "us vs
// them" colour grammar consistent with the gate beacons.

export function buildTargetDroneMesh(): { group: THREE.Group; propellers: THREE.Mesh[] } {
  const refs = buildDroneMesh();
  refs.group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mat = obj.material;
    if (!(mat instanceof THREE.MeshStandardMaterial)) return;
    if (mat.emissive && mat.emissive.getHex() !== 0x000000) {
      mat.emissive.setHex(0xff2210);
      mat.color.setHex(0x2a0606);
    }
  });
  return refs;
}
