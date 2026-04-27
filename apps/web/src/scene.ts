import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Vec3 } from './types';

export type SceneRefs = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  drone: THREE.Group;
  controls: OrbitControls;
};

export type GateRefs = {
  meshes: THREE.Mesh[];
};

export function createScene(): SceneRefs {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1218);
  scene.fog = new THREE.Fog(0x0d1218, 30, 120);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(5, 4, 7);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(15, 25, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -20;
  sun.shadow.camera.right = 20;
  sun.shadow.camera.top = 20;
  sun.shadow.camera.bottom = -20;
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0x1a2028, roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(200, 200, 0x2a3340, 0x1a2028);
  scene.add(grid);

  const drone = buildDroneMesh();
  scene.add(drone);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 1.5;
  controls.maxDistance = 80;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.target.set(0, 1.5, 0);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { scene, camera, renderer, drone, controls };
}

export function buildGates(scene: THREE.Scene, positions: readonly Vec3[]): GateRefs {
  const meshes: THREE.Mesh[] = [];
  for (const p of positions) {
    const geo = new THREE.TorusGeometry(0.8, 0.06, 16, 48);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x9aa0a8,
      emissive: 0x000000,
      roughness: 0.4,
      metalness: 0.1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(p.x, p.y, p.z);
    mesh.rotation.y = Math.PI / 2;
    mesh.castShadow = true;
    scene.add(mesh);
    meshes.push(mesh);
  }
  return { meshes };
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
  gates.meshes.length = 0;
}

export function updateGates(gates: GateRefs, currentIdx: number, isRunning: boolean) {
  for (let i = 0; i < gates.meshes.length; i++) {
    const mat = gates.meshes[i].material as THREE.MeshStandardMaterial;
    if (!isRunning) {
      mat.color.setHex(0x444444);
      mat.emissive.setHex(0x000000);
    } else if (i < currentIdx) {
      mat.color.setHex(0x44dd66);
      mat.emissive.setHex(0x002211);
    } else if (i === currentIdx) {
      mat.color.setHex(0xffd844);
      mat.emissive.setHex(0x553300);
    } else {
      mat.color.setHex(0x9aa0a8);
      mat.emissive.setHex(0x000000);
    }
  }
}

function buildDroneMesh(): THREE.Group {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.08, 0.3),
    new THREE.MeshStandardMaterial({ color: 0xff5544, roughness: 0.5, metalness: 0.2 })
  );
  body.castShadow = true;
  group.add(body);

  const armMat = new THREE.MeshStandardMaterial({ color: 0x202830, roughness: 0.6 });
  const arm1 = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.02, 0.04), armMat);
  arm1.rotation.y = Math.PI / 4;
  arm1.castShadow = true;
  group.add(arm1);
  const arm2 = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.02, 0.04), armMat);
  arm2.rotation.y = -Math.PI / 4;
  arm2.castShadow = true;
  group.add(arm2);

  const rotorMat = new THREE.MeshStandardMaterial({ color: 0x444c56, roughness: 0.4 });
  const rotorPositions: [number, number, number][] = [
    [0.16, 0.05, 0.16],
    [0.16, 0.05, -0.16],
    [-0.16, 0.05, 0.16],
    [-0.16, 0.05, -0.16],
  ];
  for (const [x, y, z] of rotorPositions) {
    const rotor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.09, 0.015, 24),
      rotorMat
    );
    rotor.position.set(x, y, z);
    rotor.castShadow = true;
    group.add(rotor);
  }

  return group;
}
