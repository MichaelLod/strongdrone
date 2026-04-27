import * as THREE from 'three';
import type { Vec3 } from '../types';
import { buildGroundTargetMesh } from './meshes/ground-target';

export type GateRefs = {
  meshes: THREE.Mesh[];
  groups: THREE.Group[];
};

export function buildGates(scene: THREE.Scene, positions: readonly Vec3[]): GateRefs {
  const meshes: THREE.Mesh[] = [];
  const groups: THREE.Group[] = [];
  for (const p of positions) {
    const group = buildGroundTargetMesh();
    group.position.set(p.x, 0, p.z);
    group.rotation.y = Math.random() * Math.PI * 2;
    scene.add(group);
    groups.push(group);

    // Tracking beacon floats well above the comms tower (~2.5 m tall), so the
    // current/next/done state colour reads from anywhere in the play area.
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.20, 16, 12),
      new THREE.MeshStandardMaterial({
        color: 0x9aa0a8,
        emissive: 0x000000,
        roughness: 0.35,
        metalness: 0.2,
      })
    );
    beacon.position.set(p.x, p.y + 3.4, p.z);
    scene.add(beacon);
    meshes.push(beacon);
  }
  return { meshes, groups };
}

export function disposeGates(scene: THREE.Scene, gates: GateRefs) {
  for (const mesh of gates.meshes) {
    scene.remove(mesh);
    mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[];
    if (Array.isArray(mat)) {
      for (const m of mat) m.dispose();
    } else {
      mat.dispose();
    }
  }
  for (const group of gates.groups) {
    scene.remove(group);
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const m = obj.material as THREE.Material | THREE.Material[];
        if (Array.isArray(m)) for (const mm of m) mm.dispose();
        else m.dispose();
      }
    });
  }
  gates.meshes.length = 0;
  gates.groups.length = 0;
}

export function updateGates(gates: GateRefs, currentIdx: number, isRunning: boolean) {
  for (let i = 0; i < gates.meshes.length; i++) {
    const beacon = gates.meshes[i];
    const mat = beacon.material as THREE.MeshStandardMaterial;
    const group = gates.groups[i];

    if (!isRunning) {
      mat.color.setHex(0x444444);
      mat.emissive.setHex(0x000000);
      beacon.visible = !group.userData.destroyed;
    } else if (i < currentIdx) {
      mat.color.setHex(0x55cc44);
      mat.emissive.setHex(0x114422);
      beacon.visible = false;
      if (!group.userData.destroyed) {
        group.userData.destroyed = true;
        group.rotation.x = (Math.random() > 0.5 ? 1 : -1) * (Math.PI / 3 + Math.random() * 0.3);
        group.rotation.z = (Math.random() - 0.5) * (Math.PI / 3);
        group.position.y = -0.05;
        group.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            const m = obj.material as THREE.MeshStandardMaterial;
            if (m.color) m.color.multiplyScalar(0.5);
          }
        });
      }
    } else if (i === currentIdx) {
      mat.color.setHex(0xffd844);
      mat.emissive.setHex(0x553300);
      beacon.visible = true;
    } else {
      mat.color.setHex(0x9aa0a8);
      mat.emissive.setHex(0x000000);
      beacon.visible = true;
    }
  }
}
